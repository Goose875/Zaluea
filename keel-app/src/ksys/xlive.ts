import { BrokerAdapter } from '../core/types';
import { RiskGuard } from '../core/risk';
import { OrderDesk, KConfig, EntryContext } from './live';
import { XSTRATEGIES, XStrategy, XOrder, toXBars, xOrders, xSimulate, XTICK } from './extra';
import { wallOf, utcOf, sessionKey } from './time';
import { tick as tickOf } from '../core/contracts';
import type { CloseReport } from '../core/journal';

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
  gate?: (ctx: EntryContext) => Promise<{ ok: boolean; reason?: string }>;
  now?: () => number;
  /** Called once for every trade that closes (the trade journal). */
  record?: (t: CloseReport) => void;
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
  private px(t: XLiveTrade) { const d = this.d.data; return d.lastPrice?.(t.orderSym) ?? d.lastPrice?.(t.sym); }
  /** Hands a closed trade to the journal (never throws: the journal must not stop trading). */
  private journal(t: XLiveTrade, how: CloseReport['how'], exit: number | null, why: string, approx: boolean) {
    if (!this.d.record || t.entry === null) return;
    try { this.d.record({ id: t.id, sym: t.sym, orderSym: t.orderSym, dir: t.dir, qty: t.qty, entry: t.entry, exit: exit ?? null, how, why, approx, openedAt: t.placed, closedAt: this.now() }); } catch { /* best effort */ }
  }
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
    if (this.d.gate) {
      const ref = o.type === 1 ? o.px : last.c, d = side;
      const g = await this.d.gate({ system: 'PO3/Fractal', id: S.id, name: S.name, symbol: S.symbol, dir: d > 0 ? 'long' : 'short', price: ref, stop: ref - d * o.stop,
        target: o.tgt ? ref + d * o.tgt : null, qty, orderSym, bars: X.slice(-36).map(b => ({ t: new Date(b.utc).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c })) });
      if (!g.ok) return say(`not entered: ${g.reason}`, 'warn');
    }
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

  /** Claude's news trade: one market entry with the same checks as every other entry, stop at the broker, out by endAt / flat-by. */
  async manual(sym: 'NQ' | 'GC', dir: 'long' | 'short', stopPts: number, tgtPts: number, endAt: number, why: string): Promise<string> {
    const now = this.now(), m = mins(now), orderSym = MICRO[sym];
    if (this.cfg.flatByHour !== null && m >= this.cfg.flatByHour * 60 - 10 && m < 18 * 60) return 'too close to the flat-by time';
    if (this.d.kHolds(sym) || this.holds(sym)) return `another Keel trade already holds ${sym}`;
    const qty = Math.floor(this.cfg.riskUsd / (stopPts * MICRO_PT[sym]));
    if (qty < 1) return `the ${stopPts}-point stop is too wide for $${this.cfg.riskUsd} risk`;
    let pnl: number; try { pnl = await this.d.dailyPnL(); } catch { return "today's P&L can't be read"; }
    const positions = await this.d.desk.getPositions();
    if (positions.some(p => p.symbol === orderSym && p.qty !== 0)) return `there is already an open ${orderSym} position`;
    const v = this.d.risk.check({ symbol: orderSym, side: dir === 'long' ? 'buy' : 'sell', qty, source: 'strategy', strategyId: 'AI', from: 'AI' },
      { dailyPnL: pnl, openPositions: positions.filter(p => p.qty !== 0).length, positions });
    if (!v.ok) return v.reason ?? 'blocked by your risk limits';
    const t: XLiveTrade = { key: `AI:${new Date(wallOf(now)).toISOString().slice(0, 10)}`, id: 'AI', sym, orderSym, dir, qty, state: 'working', entryOrder: null, limitPx: null, liveUntil: now,
      stopPts, tgtPts, endAt, entry: null, stop: null, target: null, stopOrder: null, targetOrder: null, placed: now };
    await this.d.desk.placeOrder({ symbol: orderSym, side: dir === 'long' ? 'buy' : 'sell', qty, type: 'market' });
    this.trades.push(t); this.save(); this.d.note(`AI news trade: sent ${dir} market ${qty} ${orderSym}. ${why}`, 'trade');
    await this.onFilled(t); return '';
  }

  /** A trade placed by you from the chart: market or limit entry, optional stop / target in points (placed at the broker as soon
   *  as it fills), same risk limits as every Keel entry, out at the stop / target / flat-by. Refused if a Keel trade holds the market. */
  async manualOrder(o: { orderSym: string; dir: 'long' | 'short'; qty: number; type: 'market' | 'limit'; price?: number; stopPts: number; tgtPts: number }): Promise<string> {
    const now = this.now(), m = mins(now), root = o.orderSym.replace(/^M(?=NQ|ES|GC|YM|CL)/, '');
    if (!Number.isInteger(o.qty) || o.qty < 1 || o.qty > 100) return 'quantity must be a whole number from 1 to 100';
    if (this.cfg.flatByHour !== null && m >= this.cfg.flatByHour * 60 - 5 && m < 18 * 60) return 'too close to the flat-by time';
    if (this.d.kHolds(root) || this.holds(root)) return `a Keel trade already holds ${root}`;
    let pnl: number; try { pnl = await this.d.dailyPnL(); } catch { return "today's P&L can't be read"; }
    const positions = await this.d.desk.getPositions();
    if (positions.some(p => p.symbol.replace(/^M(?=NQ|ES|GC|YM|CL)/, '') === root && p.qty !== 0)) return `there is already an open ${root} position`;
    const side = o.dir === 'long' ? 'buy' as const : 'sell' as const;
    const v = this.d.risk.check({ symbol: o.orderSym, side, qty: o.qty, source: 'strategy', strategyId: 'MANUAL', from: 'chart' }, { dailyPnL: pnl, openPositions: positions.filter(p => p.qty !== 0).length, positions });
    if (!v.ok) return v.reason ?? 'blocked by your risk limits';
    const T = tickOf(o.orderSym), flat = this.cfg.flatByHour !== null ? this.cfg.flatByHour : 17;
    const w = new Date(wallOf(now)), cutWall = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), flat, 0) - 5 * 60_000;
    const liveUntil = m < 18 * 60 ? utcOf(cutWall, 'America/New_York') : utcOf(cutWall + 86_400_000, 'America/New_York');
    const t: XLiveTrade = { key: `MAN:${now}:${o.orderSym}`, id: 'MANUAL', sym: root, orderSym: o.orderSym, dir: o.dir, qty: o.qty, state: 'working', entryOrder: null, limitPx: null,
      liveUntil, stopPts: Math.max(0, o.stopPts || 0), tgtPts: Math.max(0, o.tgtPts || 0), endAt: null, entry: null, stop: null, target: null, stopOrder: null, targetOrder: null, placed: now };
    if (o.type === 'limit') {
      if (!(Number.isFinite(o.price) && (o.price as number) > 0)) return 'a limit order needs a price';
      t.limitPx = Math.round((o.price as number) / T) * T;
      t.entryOrder = await this.d.desk.placeOrder({ symbol: o.orderSym, side, qty: o.qty, type: 'limit', price: t.limitPx });
      this.trades.push(t); this.save(); this.d.note(`Chart order: ${o.dir} limit ${o.qty} ${o.orderSym} @ ${t.limitPx.toFixed(2)} working.`, 'trade');
      return '';
    }
    await this.d.desk.placeOrder({ symbol: o.orderSym, side, qty: o.qty, type: 'market' });
    this.trades.push(t); this.save(); this.d.note(`Chart order: ${o.dir} market ${o.qty} ${o.orderSym} sent.`, 'trade');
    await this.onFilled(t); return '';
  }
  /** Flatten one market on this account: cancel its working orders, close the position, forget Keel's trades there. */
  async flattenMarket(root: string): Promise<string> {
    const same = (s: string) => s.replace(/^M(?=NQ|ES|GC|YM|CL)/, '') === root;
    for (const o of (await this.d.desk.getOpenOrders()).filter(o => same(o.symbol))) await this.d.desk.cancelOrder(o.id).catch(() => {});
    let closed = '';
    for (const p of (await this.d.desk.getPositions()).filter(p => same(p.symbol) && p.qty !== 0)) {
      await this.d.desk.placeOrder({ symbol: p.symbol, side: p.qty > 0 ? 'sell' : 'buy', qty: Math.abs(p.qty), type: 'market' }); closed += ` ${p.qty > 0 ? 'sold' : 'bought'} ${Math.abs(p.qty)} ${p.symbol}`;
    }
    for (const t of this.trades) if (same(t.sym) && t.state === 'open') this.journal(t, 'flatten', this.px(t) ?? null, 'flattened from the chart', true);
    this.trades = this.trades.filter(t => !same(t.sym)); this.save();
    this.d.note(`Flattened ${root} from the chart.${closed || ' Nothing was open.'}`, 'trade'); return '';
  }

  /**
   * You dragged a line on the chart: move this trade's stop, target or (still working) limit entry to `price`.
   * Open trade: the order at the broker is changed (or placed, if the trade had none). A stop must stay on the losing side of the
   * current price and a target on the winning side, so a drag can never fill it at once. Working entry: the stop / target
   * distances are re-measured from the limit price and go in when it fills. Returns '' or why it was refused.
   */
  async moveBracket(key: string, which: 'stop' | 'target' | 'entry', price: number): Promise<string> {
    const t = this.trades.find(x => x.key === key);
    if (!t) return 'that trade is no longer open';
    if (!Number.isFinite(price) || price <= 0) return 'that price is not valid';
    const T = XTICK[t.sym] ?? tickOf(t.orderSym), px = Math.round(price / T) * T, d = t.dir === 'long' ? 1 : -1, exit = d > 0 ? 'sell' as const : 'buy' as const;
    const f = (n: number) => n.toFixed(T < 1 ? 2 : 0);
    if (t.state === 'working') {
      const ref = t.limitPx;
      if (ref === null || !t.entryOrder) return 'this entry is a market order; drag its lines once it has filled';
      if (which === 'entry') {
        const last = this.px(t);
        if (last !== undefined && (d > 0 ? px >= last : px <= last)) return `a ${t.dir} limit must stay ${d > 0 ? 'below' : 'above'} the current price (${f(last)})`;
        await this.d.desk.modifyOrder(t.entryOrder, { price: px }); t.limitPx = px; this.save();
        this.d.note(`${t.id}: limit entry moved to ${f(px)} from the chart.`, 'info'); return '';
      }
      const dist = (px - ref) * d;
      if (which === 'stop') { if (dist >= 0) return `the stop must be ${d > 0 ? 'below' : 'above'} the entry`; t.stopPts = Math.round(-dist / T) * T; }
      else { if (dist <= 0) return `the target must be ${d > 0 ? 'above' : 'below'} the entry`; t.tgtPts = Math.round(dist / T) * T; }
      this.save(); this.d.note(`${t.id}: ${which} set to ${f(px)} (goes in when the entry fills).`, 'info'); return '';
    }
    if (which === 'entry') return 'the entry has already filled';
    const last = this.px(t);
    if (last === undefined) return 'no live price yet, so the move cannot be checked';
    if (which === 'stop' && (d > 0 ? px >= last : px <= last)) return `a ${t.dir} stop must stay ${d > 0 ? 'below' : 'above'} the current price (${f(last)})`;
    if (which === 'target' && (d > 0 ? px <= last : px >= last)) return `a ${t.dir} target must stay ${d > 0 ? 'above' : 'below'} the current price (${f(last)})`;
    const id = which === 'stop' ? t.stopOrder : t.targetOrder;
    if (id) await this.d.desk.modifyOrder(id, { price: px });
    else {
      const nid = await this.d.desk.placeOrder({ symbol: t.orderSym, side: exit, qty: t.qty, type: which === 'stop' ? 'stop' : 'limit', price: px });
      if (which === 'stop') t.stopOrder = nid; else t.targetOrder = nid;
    }
    if (which === 'stop') { t.stop = px; this.stopMissing.set(t.key, 0); } else t.target = px;
    this.save();
    this.d.note(`${t.id}: ${which} moved to ${f(px)} from the chart.`, 'trade'); return '';
  }

  /** Entry filled: put the stop (and target) at the broker, measured from the real average fill price. */
  private async onFilled(t: XLiveTrade) {
    const d = t.dir === 'long' ? 1 : -1, T = XTICK[t.sym] ?? tickOf(t.orderSym), exit = d > 0 ? 'sell' as const : 'buy' as const;
    if (t.entryOrder) { await this.d.desk.cancelOrder(t.entryOrder).catch(() => {}); t.entryOrder = null; }   // a partial fill keeps what filled
    const pos = (await this.d.desk.getPositions()).find(p => p.symbol === t.orderSym && Math.sign(p.qty) === d);
    if (!pos) { this.d.note(`${t.id}: entry sent but no position showed up; nothing to protect.`, 'warn'); this.trades = this.trades.filter(x => x !== t); this.save(); return; }
    t.qty = Math.abs(pos.qty); t.entry = Number.isFinite(pos.avgPrice) ? pos.avgPrice : (t.limitPx ?? 0);
    t.stop = t.stopPts > 0 ? Math.round((t.entry - d * t.stopPts) / T) * T : null; t.target = t.tgtPts > 0 ? Math.round((t.entry + d * t.tgtPts) / T) * T : null;
    t.state = 'open'; t.placed = this.now();
    if (t.stop !== null) try { t.stopOrder = await this.d.desk.placeOrder({ symbol: t.orderSym, side: exit, qty: t.qty, type: 'stop', price: t.stop }); }
    catch (e) {
      await this.d.desk.placeOrder({ symbol: t.orderSym, side: exit, qty: t.qty, type: 'market' }).catch(() => {});
      this.d.note(`${t.id} was closed right away because its stop could not be placed (${(e as Error).message}). Check your platform.`, 'warn');
      this.trades = this.trades.filter(x => x !== t); this.save(); return;
    }
    if (t.target !== null) { try { t.targetOrder = await this.d.desk.placeOrder({ symbol: t.orderSym, side: exit, qty: t.qty, type: 'limit', price: t.target }); } catch { this.d.note(`${t.id}: target order failed; the stop is in place.`, 'warn'); } }
    this.save();
    this.d.note(`${t.id} filled ${t.dir} ${t.qty} ${t.orderSym} @ ${t.entry.toFixed(2)}: ${t.stop !== null ? `stop ${t.stop.toFixed(2)}` : 'no stop'}${t.target !== null ? `, target ${t.target.toFixed(2)}` : ''}${t.endAt ? `, out by ${new Date(wallOf(t.endAt)).toISOString().slice(11, 16)} ET` : ''}.`, 'trade');
  }

  private async exit(t: XLiveTrade, why: string) {
    for (const id of [t.entryOrder, t.stopOrder, t.targetOrder]) if (id) await this.d.desk.cancelOrder(id).catch(() => {});
    const d = t.dir === 'long' ? 1 : -1, pos = (await this.d.desk.getPositions()).find(p => p.symbol === t.orderSym);
    const open = pos ? Math.max(0, Math.min(t.qty, pos.qty * d)) : 0;
    try { if (open > 0) await this.d.desk.placeOrder({ symbol: t.orderSym, side: d > 0 ? 'sell' : 'buy', qty: open, type: 'market' }); }
    catch { this.d.note(`${t.id}: could not close ${t.orderSym}. Check your platform now.`, 'warn'); return; }
    if (open > 0 || t.state === 'open') { this.d.note(`${t.id}: closed ${t.dir} ${t.qty} ${t.orderSym} (${why}).`, 'trade'); this.journal(t, 'forced', this.px(t) ?? null, why, true); }
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
      this.journal(t, hitTarget ? 'target' : 'stop', hitTarget ? t.target : (t.stop ?? this.px(t) ?? null), hitTarget ? 'target filled' : 'stop filled', t.stop === null && !hitTarget);
      this.trades = this.trades.filter(x => x !== t); this.save();
    }
  }

  aiTrade() { return this.trades.find(t => t.id === 'AI') ?? null; }
  view() {
    return XSTRATEGIES.map(S => ({ id: S.id, name: S.name, symbol: S.symbol, orderSymbol: MICRO[S.symbol], enabled: !!this.cfg.enabled[S.id], paperOnly: S.paperOnly, evidence: S.evidence,
      trade: this.trades.find(t => t.id === S.id) ?? null, ...(this.status[S.id] ?? { lastScan: 0, working: null, note: '' }) }));
  }
}
