import { BrokerAdapter, Order, Position, WorkingOrder } from '../core/types';
import type { CloseReport } from '../core/journal';
import { RiskGuard } from '../core/risk';
import { buildSeries, fromHistory, dailyFromHistory, Series } from './series';
import { simulate, planEntry, STRATEGIES, INSTRUMENTS, PRIORITY, SimOptions, SimResult, Dir, KStrategy } from './sim';
import { wallOf } from './time';
import { XSTRATEGIES } from './extra';

/** K system settings, saved by the app. */
export interface KConfig {
  mode: 'off' | 'paper' | 'live';
  enabled: Record<string, boolean>;
  sizing: 'fixed' | 'cushion';      // fixed = riskUsd per trade; cushion = (equity - drawdown floor) / divisor, $150-$750
  riskUsd: number; divisor: number;
  capMult: number;                  // total open risk <= capMult x per-trade risk
  pauseOn: boolean;                 // pause a strategy when its rolling 30-trade average R < -0.2
  countFrom: number;                // pause rule counts trades entered from this time (ms UTC), e.g. go-live day
  /** Prop-firm daily cut-off, New York hour (Topstep: flat by 3:10 PM CT = 4:10 PM ET, so 16). Every K trade, swing ones
   *  included, is closed 3 minutes before it and nothing opens until the 18:00 reopen. null = no cut-off: session-end
   *  strategies are still closed at 16:57 because the market halts at 17:00. */
  flatByHour: number | null;
  /** Use the full-size contract (NQ, GC) instead of micros when the risk budget covers at least one; micros otherwise. */
  allowMinis: boolean;
}
export const DEFAULT_KCONFIG: KConfig = {
  mode: 'off', enabled: { ...Object.fromEntries(STRATEGIES.map(s => [s.id, s.id !== 'K2'])), ...Object.fromEntries(XSTRATEGIES.map(s => [s.id, false])) }, sizing: 'fixed', riskUsd: 350, divisor: 12, capMult: 3, pauseOn: true, countFrom: 0,
  allowMinis: false,
  flatByHour: 16   // K2's edge needs overnight holds; with a 4 PM flat-by its test year was ~breakeven, so it starts switched off
};
export function parseKConfig(x: any): KConfig {
  const c = { ...DEFAULT_KCONFIG, enabled: { ...DEFAULT_KCONFIG.enabled } };
  if (!x || typeof x !== 'object') return c;
  if (['off', 'paper', 'live'].includes(x.mode)) c.mode = x.mode;
  for (const s of [...STRATEGIES, ...XSTRATEGIES]) if (typeof x.enabled?.[s.id] === 'boolean') c.enabled[s.id] = x.enabled[s.id];
  if (x.sizing === 'fixed' || x.sizing === 'cushion') c.sizing = x.sizing;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
  c.riskUsd = num(x.riskUsd, 50, 5000, c.riskUsd); c.divisor = num(x.divisor, 4, 40, c.divisor); c.capMult = num(x.capMult, 1, 10, c.capMult);
  c.pauseOn = x.pauseOn !== false; c.countFrom = num(x.countFrom, 0, 1e15, 0);
  c.allowMinis = x.allowMinis === true;
  c.flatByHour = x.flatByHour === null ? null : num(x.flatByHour, 12, 17, DEFAULT_KCONFIG.flatByHour as number);
  return c;
}

/** One K trade Keel is running at the broker (or on paper). Saved to disk so a restart picks it up. */
export interface LiveTrade {
  id: string; sym: string; orderSym: string; dir: Dir; qty: number; entry: number; entryUtc: number; signalUtc: number;
  stop: number; target: number | null; stopOrder: string | null; targetOrder: string | null; opened: number;
}
/** Where orders go: the real broker (live) or PaperOrders (paper). */
export interface OrderDesk {
  placeOrder(o: Order): Promise<string>;
  getOpenOrders(): Promise<WorkingOrder[]>;
  modifyOrder(id: string, change: { price: number }): Promise<void>;
  cancelOrder(id: string): Promise<void>;
  getPositions(): Promise<Position[]>;
}
export interface KDeps {
  data: BrokerAdapter;                                         // prices and history
  desk: OrderDesk;                                             // orders
  risk: RiskGuard;                                             // every entry passes Keel's risk limits
  dailyPnL: () => Promise<number>;                             // today's P&L (throws if unknown: then no new trades)
  account: () => { equity: number; floor: number } | null;    // for cushion sizing
  store: { load(): LiveTrade[]; save(t: LiveTrade[]): void };
  note: (msg: string, kind?: 'trade' | 'warn' | 'info') => void;
  /** Log file only (not the activity feed): one line per completed hourly check, so the log shows the check ran. */
  log?: (msg: string) => void;
  /** Every entry decision, for the daily signal audit. */
  decide?: (d: Decision) => void;
  now?: () => number;                                          // for tests
  xHolds?: (sym: string) => boolean;                           // a K8/K9/P1-P3 trade (or working entry) holds this market
  /** Last word before an entry is sent: news pause and the optional Claude entry check. */
  gate?: (ctx: EntryContext) => Promise<{ ok: boolean; reason?: string }>;
  /** Called once for every trade that closes (the trade journal). */
  record?: (t: CloseReport) => void;
}
/** What happened to one strategy signal (the daily signal audit). */
export interface Decision { id: string; dir: 'long' | 'short'; signalUtc: number; outcome: 'entered' | 'skipped' | 'blocked' | 'vetoed' | 'late' | 'failed' | 'working' | 'filled' | 'not filled'; why: string }
export interface EntryContext { system: string; id: string; name: string; symbol: string; dir: 'long' | 'short'; price: number; stop: number; target: number | null; qty: number; orderSym: string;
  /** market = fills now near lastPrice; limit = rests at `price` and fills only if the market trades back to it (stop and risk are measured from `price`). */
  entryType: 'market' | 'limit'; lastPrice: number; riskUsd: number;
  bars: { t: string; o: number; h: number; l: number; c: number }[] }

const H = 3_600_000;
/** Dollars per point of the contract actually traded (the mini itself, or its micro). */
const pointValue = (sym: string, orderSym: string) => (orderSym === sym ? INSTRUMENTS[sym].usd_per_point_mini : INSTRUMENTS[sym].usd_per_point_micro);
const HOURLY_BARS = 1500, DAILY_BARS = 150, ENTRY_WINDOW = 10 * 60_000, SETTLE_MS = 60_000;
// Late entries (backtest: entering up to an hour late kept the edge when price was within 25% of the stop distance
// of the planned entry: 0.19R vs 0.19R on time over 401 trades; it fell off beyond that).
const LATE_MAX = 50 * 60_000, LATE_TOL = 0.25;

/**
 * Runs K1-K7 live. Every hour, right after a bar closes, it rebuilds the indicators from broker history and re-runs the same
 * simulator that was validated against the research backtest. The simulator is the source of truth:
 *  - an entry due at this bar's open becomes a market order, with a stop order (and target limit) resting at the broker at once;
 *  - a stop moved by breakeven or the trail is modified at the broker;
 *  - an exit by time stop, session end, or any reason the simulator no longer holds the trade is closed at market.
 * Between bar closes it watches positions every few seconds, and cancels the leftover order when a stop or target fills.
 * It never re-enters to chase the simulator: if live and simulated trades disagree, it only closes.
 * One K trade per instrument at a time (spec "priority" netting), so resting orders can never flip a netted position.
 */
export class KLive {
  trades: LiveTrade[];
  sim: SimResult | null = null;
  series: Record<string, Series> = {};
  lastBarUtc = 0; lastRun = 0; nextCheck = 0; lastError = '';
  private busy = false; private timer?: ReturnType<typeof setInterval>;
  private staleWarned = 0;
  private stopMissing = new Map<LiveTrade, number>();

  constructor(private cfg: KConfig, private d: KDeps) { this.trades = d.store.load(); }

  private now() { return this.d.now ? this.d.now() : Date.now(); }
  setConfig(cfg: KConfig) { this.cfg = cfg; }
  start(everyMs = 15_000) { this.timer = setInterval(() => void this.tick(), everyMs); (this.timer as any).unref?.(); void this.tick(); }
  stop() { clearInterval(this.timer); }

  /** Called by the kill switch after the broker flattened everything. */
  forgetAll() { this.trades = []; this.d.store.save(this.trades); }

  async tick() {
    if (this.busy || this.d.risk.halted) return;
    this.busy = true;
    try {
      await this.syncFills();
      await this.flatByGuard();
      if (this.now() >= this.nextCheck) {
        await this.hourly();
        this.d.log?.(`K system: hourly check done${this.lastError ? ' (working again after: ' + this.lastError + ')' : ''}. Entries, skips and blocks are listed as their own lines; none means no signals.`);
      }
      this.lastError = '';
    } catch (e) {
      const m = (e as Error).message;
      if (m !== this.lastError) this.d.note(`K system: ${m}`, 'warn');
      this.lastError = m;
    } finally { this.busy = false; }
  }

  // ---------- hourly: rebuild, simulate, reconcile ----------
  async hourly() {
    const now = this.now(), hourStart = Math.floor(now / H) * H;
    if (!this.d.data.getHistory) throw new Error('this connection has no price history, so the K system cannot run on it.');
    const syms = [...new Set(STRATEGIES.map(s => s.symbol))];
    const fresh: Record<string, Series> = {};
    for (const sym of syms) {
      const [hb, db] = await Promise.all([this.d.data.getHistory(sym, 'hour', HOURLY_BARS), this.d.data.getHistory(sym, 'day', DAILY_BARS).catch(() => [])]);
      const bars = fromHistory(hb.filter(b => b.t + H <= now));            // completed bars only
      if (bars.length < 300) throw new Error(`only ${bars.length} hourly bars of ${sym} history came back (need 300+).`);
      fresh[sym] = buildSeries(sym, INSTRUMENTS[sym].tick, bars, db.length ? dailyFromHistory(db.filter(b => b.t < hourStart)) : undefined);
    }
    const lastT = Math.max(...Object.values(fresh).map(X => X.bars[X.bars.length - 1].utc));
    if (lastT <= this.lastBarUtc) {                       // the new bar is not in yet: try again shortly, give up 10 min into the hour
      this.nextCheck = now - hourStart > ENTRY_WINDOW ? hourStart + H + 15_000 : now + 20_000;
      return;
    }
    this.series = fresh; this.lastBarUtc = lastT; this.lastRun = now; this.nextCheck = hourStart + H + 15_000;
    const risk = this.riskNow();
    const opt: SimOptions = { sizing: 'fixed', riskUsd: risk, divisor: this.cfg.divisor, startEquity: 50000, maxLoss: 2000, netting: 'priority',
      capMult: this.cfg.capMult, feePerSide: 0.75, enabled: this.cfg.enabled, flatByHour: this.cfg.flatByHour,
      pause: { on: this.cfg.pauseOn, window: 30, below: -0.2, countFrom: this.cfg.countFrom, resumed: {} } };
    this.sim = simulate(fresh, opt);
    await this.reconcile(this.sim, now, risk);
  }

  /** Closes K trades 3 minutes before the prop-firm cut-off (or before the 17:00 halt for session-end strategies). */
  private async flatByGuard() {
    if (!this.trades.length) return;
    const w = wallOf(this.now()), mins = new Date(w).getUTCHours() * 60 + new Date(w).getUTCMinutes();
    for (const t of [...this.trades]) {
      const S = STRATEGIES.find(s => s.id === t.id)!;
      const cut = this.cfg.flatByHour !== null ? this.cfg.flatByHour : S.flat_at_session_end ? 17 : null;
      if (cut !== null && mins >= cut * 60 - 3 && mins < 18 * 60) await this.exit(t, this.cfg.flatByHour !== null ? 'flat-by time' : 'session end');
    }
  }

  riskNow(): number {
    if (this.cfg.sizing === 'cushion') {
      const a = this.d.account();
      if (a) return Math.max(150, Math.min(750, (a.equity - a.floor) / this.cfg.divisor));
    }
    return this.cfg.riskUsd;
  }

  private async reconcile(sim: SimResult, now: number, risk: number) {
    // 1. trades the simulator no longer holds are closed; stops it moved are moved at the broker
    for (const t of [...this.trades]) {
      const sp = sim.open.find(o => o.id === t.id && o.entryUtc === t.entryUtc);
      if (!sp) {
        const done = sim.trades.find(x => x.id === t.id && x.entryUtc === t.entryUtc);
        await this.exit(t, done ? `${done.why}` : 'the strategy is not in this trade');
        continue;
      }
      if (sp.stop !== sp.stop0) {
        const T = INSTRUMENTS[t.sym].tick, long = t.dir === 'long';
        const want = Math.round((sp.stop + (t.entry - sp.entry)) / T) * T;   // same move, measured from the real fill
        if (long ? want > t.stop + T / 2 : want < t.stop - T / 2) await this.moveStop(t, want);
      }
    }
    // 2. entries due at the open of the bar that has just started
    // Same priority order as the simulator (spec section 6): when two strategies want the same instrument, the higher one wins.
    const rank = (id: string) => Object.values(PRIORITY).map(l => l.indexOf(id)).find(i => i >= 0) ?? 99;
    const due = sim.pending.filter(p => p.kind === 'entry').sort((a, b) => rank(a.id) - rank(b.id));
    if (!due.length) return;
    const nextOpen = this.lastBarUtc + H, openHour = new Date(wallOf(nextOpen)).getUTCHours();
    // Same rule as the simulator: nothing opens from the flat-by hour until the 18:00 reopen.
    if (this.cfg.flatByHour !== null && openHour >= this.cfg.flatByHour && openHour < 18) return;
    if (now - nextOpen > ENTRY_WINDOW && now - nextOpen <= LATE_MAX && this.d.data.getHistory) {
      if (this.staleWarned === nextOpen) return;   // decided once per entry time
      this.staleWarned = nextOpen;
      for (const p of due) {
        const S = STRATEGIES.find(s => s.id === p.id)!;
        if (!this.cfg.enabled[S.id] || this.trades.some(t => t.id === S.id && t.signalUtc === p.signalUtc)) continue;
        if (this.trades.some(t => t.sym === S.symbol) || this.d.xHolds?.(S.symbol)) { this.d.note(`K system: skipped ${S.id}, another Keel trade already holds ${S.symbol}.`, 'info'); this.d.decide?.({ id: S.id, dir: p.dir, signalUtc: p.signalUtc, outcome: 'skipped', why: `another Keel trade already held ${S.symbol}` }); continue; }
        const late = await this.lateCheck(S, p.dir, p.signalUtc, nextOpen, now, risk);
        const mins = Math.round((now - nextOpen) / 60_000);
        if ('why' in late) { this.d.note(`K system: ${S.id} is ${mins} min late for its entry and ${late.why}, so it was skipped.`, 'warn'); this.d.decide?.({ id: S.id, dir: p.dir, signalUtc: p.signalUtc, outcome: 'late', why: `${mins} min late, ${late.why}` }); continue; }
        this.d.note(`K system: ${S.id} is ${mins} min late for its entry, but price is still within ${Math.round(LATE_TOL * 100)}% of its stop distance and its stop and target were not touched, so it enters now with the original stop.`, 'info');
        await this.enter(S, p.dir, p.signalUtc, risk, late);
      }
      return;
    }
    if (now - nextOpen > ENTRY_WINDOW) {
      if (this.staleWarned !== nextOpen) { this.d.note(`K system: ${due.map(p => p.id).join(', ')} had an entry at ${new Date(nextOpen).toISOString().slice(11, 16)} UTC but Keel got there more than 10 minutes late, so it was skipped.`, 'warn');
        for (const p of due) if (this.cfg.enabled[p.id]) this.d.decide?.({ id: p.id, dir: p.dir, signalUtc: p.signalUtc, outcome: 'late', why: 'Keel got to the entry more than 10 minutes late' }); }
      this.staleWarned = nextOpen; return;
    }
    for (const p of due) {
      const S = STRATEGIES.find(s => s.id === p.id)!;
      if (!this.cfg.enabled[S.id] || this.trades.some(t => t.id === S.id && t.signalUtc === p.signalUtc)) continue;
      if (this.trades.some(t => t.sym === S.symbol) || this.d.xHolds?.(S.symbol)) { this.d.note(`K system: skipped ${S.id}, another Keel trade already holds ${S.symbol}.`, 'info'); this.d.decide?.({ id: S.id, dir: p.dir, signalUtc: p.signalUtc, outcome: 'skipped', why: `another Keel trade already held ${S.symbol}` }); continue; }
      await this.enter(S, p.dir, p.signalUtc, risk);
    }
  }

  /** Late entry check: the missed minutes (5-minute bars since the planned open) must not have touched the planned stop or
   *  target, and the price now must be within LATE_TOL of the stop distance from the planned entry. */
  private async lateCheck(S: KStrategy, dir: Dir, signalUtc: number, openUtc: number, now: number, risk: number): Promise<{ stop: number; target: number | null } | { why: string }> {
    const X = this.series[S.symbol], sig = X.bars.findIndex(b => b.utc === signalUtc), I = INSTRUMENTS[S.symbol], d = dir === 'long' ? 1 : -1;
    if (sig < 0) return { why: 'its signal bar is not in the history' };
    let bars: { t: number; o: number; h: number; l: number; c: number }[] = [];
    try { bars = (await this.d.data.getHistory!(S.symbol, 'min5', 24)).filter(b => b.t >= openUtc && b.t < now); } catch { /* checked below */ }
    if (!bars.length) return { why: "the missed minutes can't be checked (no 5-minute history)" };
    const E0 = bars[0].o, plan = planEntry(S, X, sig, dir, E0 + d * I.tick, risk, I.usd_per_point_micro);
    if ('skip' in plan) return { why: plan.skip };
    const hitStop = bars.some(b => (d > 0 ? b.l <= plan.stop : b.h >= plan.stop)), hitTgt = plan.target !== null && bars.some(b => (d > 0 ? b.h >= plan.target! : b.l <= plan.target!));
    if (hitStop) return { why: 'its stop was already hit in the missed minutes' };
    if (hitTgt) return { why: 'its target was already reached in the missed minutes' };
    const px = this.d.data.lastPrice?.(I.micro) ?? this.d.data.lastPrice?.(S.symbol);
    if (px === undefined) return { why: 'there is no live price' };
    const moved = Math.abs(px - E0) / plan.R;
    if (moved > LATE_TOL) return { why: `price has moved ${Math.round(moved * 100)}% of the stop distance from the planned entry (limit ${Math.round(LATE_TOL * 100)}%)` };
    return { stop: plan.stop, target: plan.target };
  }

  private async enter(S: KStrategy, dir: Dir, signalUtc: number, risk: number, late?: { stop: number; target: number | null }) {
    const X = this.series[S.symbol], sig = X.bars.findIndex(b => b.utc === signalUtc), I = INSTRUMENTS[S.symbol];
    const dec = (outcome: Decision['outcome'], why: string) => this.d.decide?.({ id: S.id, dir, signalUtc, outcome, why });
    let orderSym = I.micro;
    const d = dir === 'long' ? 1 : -1, side = dir === 'long' ? 'buy' as const : 'sell' as const, exitSide = dir === 'long' ? 'sell' as const : 'buy' as const;
    const px = this.d.data.lastPrice?.(orderSym) ?? this.d.data.lastPrice?.(S.symbol);
    if (sig < 0 || px === undefined) { this.d.note(`K system: skipped ${S.id}, no live price for ${orderSym}.`, 'warn'); dec('skipped', `no live price for ${orderSym}`); return; }
    const plan = planEntry(S, X, sig, dir, px + d * I.tick, risk, I.usd_per_point_micro);
    if (late && !('skip' in plan)) {
      plan.stop = late.stop; plan.target = late.target; plan.R = Math.abs(px + d * I.tick - late.stop);
      plan.qty = Math.floor(risk / (plan.R * I.usd_per_point_micro));
      if (!(plan.R > 0) || (px + d * I.tick - late.stop) * d <= 0) { this.d.note(`K system: skipped ${S.id}, price is beyond its stop.`, 'info'); dec('skipped', 'price beyond its stop'); return; }
      if (plan.qty < 1) { this.d.note(`K system: skipped ${S.id} ${dir}: stop too wide for the risk.`, 'info'); dec('skipped', 'stop too wide for the risk'); return; }
    }
    if ('skip' in plan) { this.d.note(`K system: skipped ${S.id} ${dir}: ${plan.skip}.`, 'info'); dec('skipped', plan.skip); return; }
    // Minis when the budget covers at least one full contract (and minis are allowed), micros otherwise.
    const miniQty = Math.floor(risk / (plan.R * I.usd_per_point_mini));
    if (this.cfg.allowMinis && miniQty >= 1) { orderSym = S.symbol; plan.qty = miniQty; }
    const openRisk = this.trades.reduce((a, t) => a + Math.abs(t.entry - t.stop) * pointValue(t.sym, t.orderSym) * t.qty, 0);
    if (openRisk + plan.R * pointValue(S.symbol, orderSym) * plan.qty > this.cfg.capMult * risk) { this.d.note(`K system: skipped ${S.id}, total open risk cap.`, 'info'); dec('skipped', 'total open risk cap'); return; }
    // Keel's own risk limits (daily loss, contract caps, allowed symbols) have the last word.
    let pnl: number;
    try { pnl = await this.d.dailyPnL(); } catch { this.d.note(`K system: blocked ${S.id}, today's P&L can't be read.`, 'warn'); dec('blocked', "today's P&L couldn't be read"); return; }
    const positions = await this.d.desk.getPositions();
    const verdict = this.d.risk.check({ symbol: orderSym, side, qty: plan.qty, source: 'strategy', strategyId: S.id, from: S.id }, { dailyPnL: pnl, openPositions: positions.filter(p => p.qty !== 0).length, positions });
    if (!verdict.ok) { this.d.note(`K system: blocked ${S.id}: ${verdict.reason}`, 'warn'); dec('blocked', verdict.reason ?? 'risk limits'); return; }
    if (this.d.gate) {
      const g = await this.d.gate({ system: 'K', id: S.id, name: S.name, symbol: S.symbol, dir, price: px, stop: plan.stop, target: plan.target, qty: plan.qty, orderSym,
        entryType: 'market', lastPrice: px, riskUsd: Math.round(plan.R * pointValue(S.symbol, orderSym) * plan.qty),
        bars: X.bars.slice(-36).map(b => ({ t: new Date(b.utc).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c })) });
      if (!g.ok) { this.d.note(`K system: ${S.id} not entered: ${g.reason}`, 'warn'); dec('vetoed', g.reason ?? 'entry check'); return; }
    }

    await this.d.desk.placeOrder({ symbol: orderSym, side, qty: plan.qty, type: 'market' });
    // Re-anchor stop and target on the real fill (average price), with the same rules.
    const pos = (await this.d.desk.getPositions()).find(p => p.symbol === orderSym && Math.sign(p.qty) === d);
    const fill = pos && Number.isFinite(pos.avgPrice) ? pos.avgPrice : px + d * I.tick;
    const fin = planEntry(S, X, sig, dir, fill, risk, pointValue(S.symbol, orderSym), plan.qty);
    const stop = late ? late.stop : 'skip' in fin ? plan.stop : fin.stop, target = late ? late.target : 'skip' in fin ? plan.target : fin.target;
    const t: LiveTrade = { id: S.id, sym: S.symbol, orderSym, dir, qty: plan.qty, entry: fill, entryUtc: this.lastBarUtc + H, signalUtc, stop, target, stopOrder: null, targetOrder: null, opened: this.now() };
    try {
      t.stopOrder = await this.d.desk.placeOrder({ symbol: orderSym, side: exitSide, qty: t.qty, type: 'stop', price: stop });
    } catch (e) {   // never leave a position without its stop
      await this.d.desk.placeOrder({ symbol: orderSym, side: exitSide, qty: t.qty, type: 'market' }).catch(() => {});
      this.d.note(`K system: ${S.id} was closed right away because its stop could not be placed (${(e as Error).message}). Check your platform.`, 'warn');
      dec('failed', `its stop could not be placed (${(e as Error).message})`);
      return;
    }
    if (target !== null) { try { t.targetOrder = await this.d.desk.placeOrder({ symbol: orderSym, side: exitSide, qty: t.qty, type: 'limit', price: target }); } catch { this.d.note(`K system: ${S.id} target order failed; the stop is in place.`, 'warn'); } }
    this.trades.push(t); this.d.store.save(this.trades);
    dec('entered', `${dir} ${t.qty} ${orderSym} @ ${fill.toFixed(2)}${late ? ' (late entry)' : ''}`);
    this.d.note(`Sent ${side} ${t.qty} ${orderSym} (${S.id} ${S.name}): stop ${stop.toFixed(2)}${target !== null ? `, target ${target.toFixed(2)}` : ''}.`, 'trade');
  }

  /** Move a K trade's stop TIGHTER only (never wider). Returns '' when moved, else why not. */
  async tightenStop(id: string, price: number, why: string): Promise<string> {
    const t = this.trades.find(x => x.id === id); if (!t) return 'the trade is no longer open';
    if (t.dir === 'long' ? price <= t.stop : price >= t.stop) return 'the stop is already at or past that price';
    this.d.note(`K system: ${t.id} stop to ${price.toFixed(2)} (${why}).`, 'info');
    await this.moveStop(t, price); return t.stop === price ? '' : 'the broker did not accept the move';
  }

  private async moveStop(t: LiveTrade, price: number) {
    try {
      if (t.stopOrder) await this.d.desk.modifyOrder(t.stopOrder, { price });
      else t.stopOrder = await this.d.desk.placeOrder({ symbol: t.orderSym, side: t.dir === 'long' ? 'sell' : 'buy', qty: t.qty, type: 'stop', price });
      this.d.note(`K system: ${t.id} stop moved to ${price.toFixed(2)}.`, 'info');
      t.stop = price; this.d.store.save(this.trades);
    } catch (e) { this.d.note(`K system: could not move the ${t.id} stop (${(e as Error).message}). The old stop is still working.`, 'warn'); }
  }

  private journal(t: LiveTrade, how: CloseReport['how'], exit: number | null, why: string, approx: boolean) {
    if (!this.d.record) return;
    try { this.d.record({ system: 'K', id: t.id, sym: t.sym, orderSym: t.orderSym, dir: t.dir, qty: t.qty, entry: t.entry, exit, how, why, approx, openedAt: t.opened, closedAt: this.now() }); } catch { /* best effort */ }
  }
  private async exit(t: LiveTrade, why: string) {
    for (const id of [t.stopOrder, t.targetOrder]) if (id) await this.d.desk.cancelOrder(id).catch(() => {});
    const pos = (await this.d.desk.getPositions()).find(p => p.symbol === t.orderSym);
    const d = t.dir === 'long' ? 1 : -1, open = pos ? Math.max(0, Math.min(t.qty, pos.qty * d)) : 0;
    try {
      if (open > 0) await this.d.desk.placeOrder({ symbol: t.orderSym, side: t.dir === 'long' ? 'sell' : 'buy', qty: open, type: 'market' });
      this.d.note(`K system: closed ${t.id} ${t.dir} ${t.qty} ${t.orderSym} (${why}).`, 'trade');
      this.journal(t, 'forced', this.d.data.lastPrice?.(t.orderSym) ?? this.d.data.lastPrice?.(t.sym) ?? null, why, true);
    } catch { this.d.note(`K system: could not close ${t.id} on ${t.orderSym}. Check your platform now.`, 'warn'); return; }
    this.trades = this.trades.filter(x => x !== t); this.d.store.save(this.trades);
  }

  /** Between bars: a stop or target that filled at the broker closes the trade, and the other order is cancelled. */
  async syncFills() {
    if (!this.trades.length) return;
    const [positions, working] = await Promise.all([this.d.desk.getPositions(), this.d.desk.getOpenOrders()]);
    const ids = new Set(working.map(o => o.id));
    for (const t of [...this.trades]) {
      // Brokers take a moment to show a new position and its new orders: leave a fresh trade alone for a minute,
      // so a lagging report is never read as "closed" (which would cancel its stop) or "stop missing" (a duplicate stop).
      if (this.now() - t.opened < SETTLE_MS) continue;
      const pos = positions.find(p => p.symbol === t.orderSym), d = t.dir === 'long' ? 1 : -1;
      const open = pos ? pos.qty * d : 0;
      if (open > 0) {
        const missing = !t.stopOrder || !ids.has(t.stopOrder);
        this.stopMissing.set(t, missing ? (this.stopMissing.get(t) ?? 0) + 1 : 0);
        if (missing && (this.stopMissing.get(t) ?? 0) >= 2) {
          // Gone on two checks in a row while the position is still open (rejected, expired or cancelled by hand): put it back.
          this.d.note(`K system: ${t.id} had no working stop, placing it again.`, 'warn');
          t.stopOrder = null; this.stopMissing.set(t, 0); await this.moveStop(t, t.stop);
        }
        continue;
      }
      for (const id of [t.stopOrder, t.targetOrder]) if (id && ids.has(id)) await this.d.desk.cancelOrder(id).catch(() => {});
      const hitTarget = t.targetOrder !== null && !ids.has(t.targetOrder) && (t.stopOrder === null || ids.has(t.stopOrder));
      this.d.note(`K system: ${t.id} ${t.dir} ${t.qty} ${t.orderSym} closed at its ${hitTarget ? 'target' : 'stop'}.`, 'trade');
      this.journal(t, hitTarget ? 'target' : 'stop', hitTarget ? t.target : t.stop, hitTarget ? 'target filled' : 'stop filled', false);
      this.trades = this.trades.filter(x => x !== t); this.d.store.save(this.trades);
    }
  }

  /** For the screen. */
  status() {
    const sim = this.sim, since = this.cfg.countFrom;
    return {
      mode: this.cfg.mode, lastBarUtc: this.lastBarUtc, lastRun: this.lastRun, nextCheck: this.nextCheck, error: this.lastError, riskNow: this.riskNow(),
      strategies: STRATEGIES.map(S => {
        const rec = (sim?.trades ?? []).filter(t => t.id === S.id && t.entryUtc >= since).slice(-30);
        return {
          id: S.id, name: S.name, symbol: S.symbol, orderSymbol: INSTRUMENTS[S.symbol].micro, enabled: !!this.cfg.enabled[S.id],
          paused: sim?.paused[S.id] ?? null, live: this.trades.find(t => t.id === S.id) ?? null,
          pending: sim?.pending.find(p => p.id === S.id) ?? null, rollingR: rec.length ? rec.reduce((a, t) => a + t.r, 0) / rec.length : null, rollingN: rec.length,
          ...(() => { const all = [...(sim?.trades ?? []), ...(sim?.open ?? []), ...(sim?.pending ?? [])].filter(t => t.id === S.id && Number.isFinite(t.signalUtc)).sort((a, b) => a.signalUtc - b.signalUtc), l = all[all.length - 1];
            return { lastSignal: l ? l.signalUtc : null, lastSignalDir: l ? l.dir : null }; })()
        };
      })
    };
  }
}
