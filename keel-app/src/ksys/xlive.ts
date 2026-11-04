import { BrokerAdapter } from '../core/types';
import { RiskGuard } from '../core/risk';
import { OrderDesk, KConfig } from './live';
import { XSTRATEGIES, XStrategy, XOrder, toXBars, xOrders, xSimulate, XTICK } from './extra';
import { wallOf, utcOf, sessionKey } from './time';

/** One K8 / K9 / P1-P3 trade Keel is running (or its entry order still waiting). Saved so a restart picks it up. */
export interface XLiveTrade {
  key: string;                         // strategy + candle / day: one trade per setup
  id: string; sym: string; orderSym: string; dir: 'long' | 'short'; qty: number;
  state: 'working' | 'open';
  entryOrder: string | null; limitPx: number | null; liveUntil: number;   // working entry (limit) and when it is cancelled
  stopPts: number; tgtPts: number; endAt: number | null;                  // brackets measured from the real fill; forced exit time
  entry: number | null; stop: number | null; target: number | null; stopOrder: string | null; targetOrder: string | null;
  placed: number;
}
export interface XStore { load(): { trades: XLiveTrade[]; done: string[] }; save(x: { trades: XLiveTrade[]; done: string[] }): void }
export interface XDeps {
  data: BrokerAdapter; desk: OrderDesk; risk: RiskGuard; dailyPnL: () => Promise<number>;
  store: XStore; note: (msg: string, kind?: 'trade' | 'warn' | 'info') => void;
  /** True when a K1-K7 trade holds this market (one position per market across all of Keel's systems). */
  kHolds: (sym: string) => boolean;
  now?: () => number;
}
const MICRO: Record<string, string> = { NQ: 'MNQ', GC: 'MGC' }, MICRO_PT: Record<string, number> = { NQ: 2, GC: 10 };
const HIST: Record<number, { unit: 'min5' | 'hour' | 'day'; count: number }> = { 5: { unit: 'min5', count: 3000 }, 60: { unit: 'hour', count: 600 }, 1440: { unit: 'day', count: 320 } };
const SETTLE_MS = 20_000;
const mins = (utc: number) => { const w = new Date(wallOf(utc)); return w.getUTCHours() * 60 + w.getUTCMinutes(); };

/**
 * Runs K8, K9 and P1-P3. After each bar closes (5-minute bars for P1-P3, hourly for K9, the 18:00 reopen for K8) it rebuilds the
 * strategy from broker history and runs the same simulator that reproduces the research trade for trade. When the simulator
 * says an order is working now, Keel sends it:
 *  - PO3: a resting LIMIT entry at the exact level, cancelled when its window ends (the research's 3-hour window / 15:55 ET);
 *  - Fractal: a market entry at the 18:00 reopen.
 * As soon as an entry fills, the stop (and target) go to the broker, measured from the real fill price.
 * Exits: stop / target at the broker, the 4h candle's close, or the flat-by time. Never chases a missed entry.
 * One position per market across K1-K9 and P1-P3: a market already held (or with a working entry) is skipped.
 */
export class XLive {
  trades: XLiveTrade[]; done: Set<string>;
  lastScan: Record<string, number> = {}; lastError = ''; private busy = false; private timer?: ReturnType<typeof setInterval>;
  private warned = new Set<string>(); private stopMissing = new Map<string, number>();
  status: Record<string, { lastScan: number; working: string | null; note: string }> = {};

  constructor(private cfg: KConfig, private d: XDeps) { const s = d.store.load(); this.trades = s.trades; this.done = new Set(s.done); }
  setConfig(c: KConfig) { this.cfg = c; }
  private now() { return this.d.now ? this.d.now() : Date.now(); }
  private save() { this.d.store.save({ trades: this.trades, done: [...this.done].slice(-400) }); }
  holds(sym: string) { return this.trades.some(t => t.sym === sym); }
  start(everyMs = 5_000) { this.timer = setInterval(() => void this.tick(), everyMs); (this.timer as any).unref?.(); void this.tick(); }
  stop() { clearInterval(this.timer); }
  forgetAll() { this.trades = []; this.save(); }

  async tick() {
    if (this.busy || this.d.risk.halted) return;
    this.busy = true;
    try {
      await this.sync();
      for (const S of XSTRATEGIES) if (this.cfg.enabled[S.id]) await this.scan(S);
      this.lastError = '';
    } catch (e) {
      const m = (e as Error).message;
      if (m !== this.lastError) this.d.note(`PO3/Fractal: ${m}`, 'warn');
      this.lastError = m;
    } finally { this.busy = false; }
  }

  /** Is it time to look at this strategy again? Once per completed bar, ~15 s after it closes. */
  private due(S: XStrategy): boolean {
    const now = this.now(), last = this.lastScan[S.id] ?? 0;
    if (S.kind === 'fractal') {                       // once a day, 18:00:15-18:10 ET, right after the reopen
      const m = mins(now); return m >= 18 * 60 && m < 18 * 60 + 10 && now - last > 20 * 60_000 && (m > 18 * 60 || new Date(now).getUTCSeconds() >= 15);
    }
    const ms = S.barMinutes * 60_000, barClose = Math.floor(now / ms) * ms;
    return now - barClose >= 15_000 && last < barClose;
  }

  private async scan(S: XStrategy) {
    if (!this.due(S)) return;
    const now = this.now(); this.lastScan[S.id] = now;
    if (S.paperOnly && this.cfg.mode === 'live') {
      if (!this.warned.has('paper' + S.id)) this.d.note(`${S.id} (${S.name}) is paper only (${S.evidence}), so it does not trade in live mode.`, 'info');
      this.warned.add('paper' + S.id); return;
    }
    if (!this.d.data.getHistory) throw new Error('this connection has no price history.');
    const h = HIST[S.barMinutes], ms = S.barMinutes * 60_000;
    const raw = await this.d.data.getHistory(S.symbol, h.unit, h.count);
    const X = toXBars(S.kind === 'fractal' ? raw : raw.filter(b => b.t + ms <= now));
    if (X.length < (S.kind === 'fractal' ? 120 : 200)) throw new Error(`only ${X.length} bars of ${S.symbol} history came back for ${S.id}.`);
    const last = X[X.length - 1];
    if (S.kind === 'fractal' && last.day !== sessionKey(wallOf(now - 2 * 3_600_000))) { this.status[S.id] = { lastScan: now, working: null, note: 'yesterday\'s daily bar is not in yet' }; return; }
    if (S.kind !== 'fractal' && now - (last.utc + ms) > 10 * 60_000) { this.status[S.id] = { lastScan: now, working: null, note: 'history is behind; waiting' }; return; }
    // The fractal's daily trades are independent (as in the research): today's order is simply the one due at the next bar.
    const orders = xOrders(S, X), sim = S.kind === 'fractal' ? { working: orders.filter(o => o.i === X.length).map(order => ({ order, k: -1 })) } : xSimulate(X, S.symbol, orders);
    const w = sim.working[sim.working.length - 1];
    this.status[S.id] = { lastScan: now, working: w ? `${w.order.side > 0 ? 'long' : 'short'} ${w.order.type ? 'limit ' + w.order.px.toFixed(2) : 'market'}` : null, note: '' };
    for (const { order } of sim.working) await this.place(S, X, order);
  }

  private async place(S: XStrategy, X: ReturnType<typeof toXBars>, o: XOrder) {
    const n = X.length, last = X[n - 1], ms = S.barMinutes * 60_000, now = this.now();
    const key = `${S.id}:${S.kind === 'fractal' ? last.day : o.grp + ':' + (o.candleStart ?? 0)}`;
    if (this.done.has(key) || this.trades.some(t => t.key === key)) return;
    this.done.add(key); this.save();                                  // decided once: never re-sent, even after a skip
    const say = (m: string, k: 'info' | 'warn' = 'info') => this.d.note(`${S.id}: ${m}`, k);
    const m = mins(now);
    if (this.cfg.flatByHour !== null && m >= this.cfg.flatByHour * 60 - 10 && m < 18 * 60) return say('skipped, too close to the flat-by time.');
    if (this.d.kHolds(S.symbol) || this.holds(S.symbol)) return say(`skipped, another Keel trade already holds ${S.symbol}.`);
    const side = o.side, dir = side > 0 ? 'long' as const : 'short' as const, T = XTICK[S.symbol], orderSym = MICRO[S.symbol];
    const risk = this.cfg.riskUsd, perContract = o.stop * MICRO_PT[S.symbol];
    let qty = Math.floor(risk / perContract);
    if (qty < 1) { if (perContract <= 1.5 * risk) qty = 1; else return say(`skipped, the stop (${o.stop.toFixed(2)} pts = $${perContract.toFixed(0)} per ${orderSym}) is too wide for $${risk} risk.`); }
    let pnl: number;
    try { pnl = await this.d.dailyPnL(); } catch { return say("blocked, today's P&L can't be read.", 'warn'); }
    const positions = await this.d.desk.getPositions();
    if (positions.some(p => p.symbol === orderSym && p.qty !== 0)) return say(`skipped, there is already an open ${orderSym} position.`);
    const verdict = this.d.risk.check({ symbol: orderSym, side: side > 0 ? 'buy' : 'sell', qty, source: 'strategy', strategyId: S.id, from: S.id },
      { dailyPnL: pnl, openPositions: positions.filter(p => p.qty !== 0).length, positions });
    if (!verdict.ok) return say(`blocked: ${verdict.reason}`, 'warn');
    // Window: the research keeps the order live from bar o.i through bar o.i + o.exp; nothing new from 15:55 ET.
    const liveUntil = last.utc + (o.i + o.exp - (n - 1) + 1) * ms;
    let endAt: number | null = null;
    if (S.kind === 'po3' && o.candleStart) {
      const start = o.candleStart - (((new Date(o.candleStart).getUTCHours() - 18 + 24) % 24) % 4) * 3_600_000 - new Date(o.candleStart).getUTCMinutes() * 60_000;
      endAt = utcOf(start + 4 * 3_600_000, 'America/New_York');
    }
    const t: XLiveTrade = { key, id: S.id, sym: S.symbol, orderSym, dir, qty, state: 'working', entryOrder: null, limitPx: null, liveUntil, stopPts: o.stop, tgtPts: o.tgt,
      endAt, entry: null, stop: null, target: null, stopOrder: null, targetOrder: null, placed: now };
    if (o.type === 1) {
      // exact level, rounded to a tick in the safe direction (never a better price than the research level)
      const px = side > 0 ? Math.floor(o.px / T + 1e-9) * T : Math.ceil(o.px / T - 1e-9) * T;
      t.limitPx = px;
      t.entryOrder = await this.d.desk.placeOrder({ symbol: orderSym, side: side > 0 ? 'buy' : 'sell', qty, type: 'limit', price: px });
      this.trades.push(t); this.save();
      say(`working ${dir} limit ${qty} ${orderSym} @ ${px.toFixed(2)} until ${new Date(wallOf(liveUntil)).toISOString().slice(11, 16)} ET (stop ${o.stop.toFixed(2)} pts${o.tgt ? `, target ${o.tgt.toFixed(2)} pts` : ''}).`);
    } else {
      if (now - (last.utc + ms) > 10 * 60_000 && S.kind !== 'fractal') return say('skipped, more than 10 minutes late for the market entry.');
      await this.d.desk.placeOrder({ symbol: orderSym, side: side > 0 ? 'buy' : 'sell', qty, type: 'market' });
      this.trades.push(t); this.save();
      say(`sent ${dir} market ${qty} ${orderSym}.`, 'info');
      await this.onFilled(t);
    }
  }

  /** Entry filled: put the stop (and target) at the broker, measured from the real average fill price. */
  private async onFilled(t: XLiveTrade) {
    const d = t.dir === 'long' ? 1 : -1, T = XTICK[t.sym], exit = d > 0 ? 'sell' as const : 'buy' as const;
    if (t.entryOrder) { await this.d.desk.cancelOrder(t.entryOrder).catch(() => {}); t.entryOrder = null; }   // a partial fill keeps what filled
    const pos = (await this.d.desk.getPositions()).find(p => p.symbol === t.orderSym && Math.sign(p.qty) === d);
    if (!pos) { this.d.note(`${t.id}: entry sent but no position showed up; nothing to protect.`, 'warn'); this.trades = this.trades.filter(x => x !== t); this.save(); return; }
    t.qty = Math.abs(pos.qty); t.entry = Number.isFinite(pos.avgPrice) ? pos.avgPrice : (t.limitPx ?? 0);
    t.stop = Math.round((t.entry - d * t.stopPts) / T) * T; t.target = t.tgtPts > 0 ? Math.round((t.entry + d * t.tgtPts) / T) * T : null;
    t.state = 'open'; t.placed = this.now();
    try { t.stopOrder = await this.d.desk.placeOrder({ symbol: t.orderSym, side: exit, qty: t.qty, type: 'stop', price: t.stop }); }
    catch (e) {
      await this.d.desk.placeOrder({ symbol: t.orderSym, side: exit, qty: t.qty, type: 'market' }).catch(() => {});
      this.d.note(`${t.id} was closed right away because its stop could not be placed (${(e as Error).message}). Check your platform.`, 'warn');
      this.trades = this.trades.filter(x => x !== t); this.save(); return;
    }
    if (t.target !== null) { try { t.targetOrder = await this.d.desk.placeOrder({ symbol: t.orderSym, side: exit, qty: t.qty, type: 'limit', price: t.target }); } catch { this.d.note(`${t.id}: target order failed; the stop is in place.`, 'warn'); } }
    this.save();
    this.d.note(`${t.id} filled ${t.dir} ${t.qty} ${t.orderSym} @ ${t.entry.toFixed(2)}: stop ${t.stop.toFixed(2)}${t.target !== null ? `, target ${t.target.toFixed(2)}` : ''}${t.endAt ? `, out by ${new Date(wallOf(t.endAt)).toISOString().slice(11, 16)} ET` : ''}.`, 'trade');
  }

  private async exit(t: XLiveTrade, why: string) {
    for (const id of [t.entryOrder, t.stopOrder, t.targetOrder]) if (id) await this.d.desk.cancelOrder(id).catch(() => {});
    const d = t.dir === 'long' ? 1 : -1, pos = (await this.d.desk.getPositions()).find(p => p.symbol === t.orderSym);
    const open = pos ? Math.max(0, Math.min(t.qty, pos.qty * d)) : 0;
    try { if (open > 0) await this.d.desk.placeOrder({ symbol: t.orderSym, side: d > 0 ? 'sell' : 'buy', qty: open, type: 'market' }); }
    catch { this.d.note(`${t.id}: could not close ${t.orderSym}. Check your platform now.`, 'warn'); return; }
    if (open > 0 || t.state === 'open') this.d.note(`${t.id}: closed ${t.dir} ${t.qty} ${t.orderSym} (${why}).`, 'trade');
    else this.d.note(`${t.id}: entry order cancelled (${why}).`, 'info');
    this.trades = this.trades.filter(x => x !== t); this.save();
  }

  /** Every few seconds: fills of working entries, stops/targets that filled, forced exits, flat-by. */
  async sync() {
    if (!this.trades.length) return;
    const now = this.now(), m = mins(now);
    const [positions, working] = await Promise.all([this.d.desk.getPositions(), this.d.desk.getOpenOrders()]);
    const ids = new Set(working.map(o => o.id));
    const flatCut = this.cfg.flatByHour !== null ? this.cfg.flatByHour * 60 : 17 * 60;
    for (const t of [...this.trades]) {
      const d = t.dir === 'long' ? 1 : -1, pos = positions.find(p => p.symbol === t.orderSym), held = pos ? pos.qty * d : 0;
      if (t.state === 'working') {
        if (held > 0) { await this.onFilled(t); continue; }
        const late = now >= t.liveUntil || (m >= 15 * 60 + 55 && m < 18 * 60) || (m >= flatCut - 10 && m < 18 * 60);
        if (late || (t.entryOrder && !ids.has(t.entryOrder) && now - t.placed > SETTLE_MS)) {
          if (t.entryOrder) await this.d.desk.cancelOrder(t.entryOrder).catch(() => {});
          const again = (await this.d.desk.getPositions()).find(p => p.symbol === t.orderSym);   // filled while cancelling?
          if (again && again.qty * d > 0) { await this.onFilled(t); continue; }
          this.d.note(`${t.id}: entry ${late ? 'window over' : 'order gone'}, no fill.`, 'info');
          this.trades = this.trades.filter(x => x !== t); this.save();
        }
        continue;
      }
      if (now - t.placed < SETTLE_MS) continue;
      if (m >= flatCut - 3 && m < 18 * 60) { await this.exit(t, 'flat-by time'); continue; }
      if (t.endAt !== null && now >= t.endAt) { await this.exit(t, '4h candle closed'); continue; }
      if (held > 0) {
        const missing = !t.stopOrder || !ids.has(t.stopOrder), c = missing ? (this.stopMissing.get(t.key) ?? 0) + 1 : 0;
        this.stopMissing.set(t.key, c);
        if (missing && c >= 2 && t.stop !== null) {
          this.d.note(`${t.id} had no working stop, placing it again.`, 'warn'); this.stopMissing.set(t.key, 0);
          try { t.stopOrder = await this.d.desk.placeOrder({ symbol: t.orderSym, side: d > 0 ? 'sell' : 'buy', qty: t.qty, type: 'stop', price: t.stop }); this.save(); }
          catch { await this.exit(t, 'stop could not be replaced'); }
        }
        continue;
      }
      for (const id of [t.stopOrder, t.targetOrder]) if (id && ids.has(id)) await this.d.desk.cancelOrder(id).catch(() => {});
      const hitTarget = t.targetOrder !== null && !ids.has(t.targetOrder) && (t.stopOrder === null || ids.has(t.stopOrder));
      this.d.note(`${t.id} ${t.dir} ${t.qty} ${t.orderSym} closed at its ${hitTarget ? 'target' : 'stop'}.`, 'trade');
      this.trades = this.trades.filter(x => x !== t); this.save();
    }
  }

  view() {
    return XSTRATEGIES.map(S => ({ id: S.id, name: S.name, symbol: S.symbol, orderSymbol: MICRO[S.symbol], enabled: !!this.cfg.enabled[S.id], paperOnly: S.paperOnly, evidence: S.evidence,
      trade: this.trades.find(t => t.id === S.id) ?? null, ...(this.status[S.id] ?? { lastScan: 0, working: null, note: '' }) }));
  }
}
