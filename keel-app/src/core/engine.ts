import { BrokerAdapter, Position, Signal, Strategy } from './types';
import { RiskGuard } from './risk';
import { DEFAULT_GOALS, Goals, Progress, evaluate } from './goals';
import { buildStrategy, StrategyConfig } from '../strategies/rules';

export class Engine {
  private running = new Map<string, { s: Strategy; key: string; name: string }>();
  private tv = new Map<string, StrategyConfig>();
  private cfgs = new Map<string, StrategyConfig>();
  private last = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();   // orders go out one at a time, in order
  private reported = new Set<string>();
  /** One open trade per strategy, so Keel knows what to exit and when. */
  private open = new Map<string, { symbol: string; side: 'buy' | 'sell'; qty: number; entry: number | null; tpPx: number | null; slPx: number | null; name: string; opened: number }>();
  /** Called with every price, for the chart. */
  onTick?: (q: { symbol: string; price: number; ts: number }) => void;
  /** Called first when the kill switch or a daily-loss stop fires (the K system stops and forgets its trades). */
  onHalt?: () => void;
  log: string[] = [];
  events: { t: number; msg: string; kind: 'trade' | 'warn' | 'info' }[] = [];
  private stats = { realized: 0, unrealized: 0, total: 0, positions: [] as Position[], updated: 0 };
  private history: [number, number][] = [];
  private goals: Goals = DEFAULT_GOALS;
  private progress: Progress = evaluate(DEFAULT_GOALS, null, 0);
  private account: unknown = null;
  private latched = false;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false; private bad = 0;

  constructor(private broker: BrokerAdapter, private risk: RiskGuard) {
    broker.onQuote(q => {
      this.last.set(q.symbol, q.price);
      this.onTick?.(q);
      this.queue = this.queue.then(() => this.checkExits(q.symbol, q.price)).catch(() => {});
      for (const [id, r] of this.running) {
        const out = r.s.onQuote(q);
        for (const sig of Array.isArray(out) ? out : out ? [out] : []) this.queue = this.queue.then(() => this.handleSignal(sig)).catch(() => {});
        if (r.s.error && !this.reported.has(id)) { this.reported.add(id); this.note(`${r.name} stopped: ${r.s.error}`); }
      }
    });
  }

  addStrategy(s: Strategy) { this.running.set(s.id, { s, key: '', name: s.name }); }

  /** Keeps the running set in line with the saved list: on ones run, off or removed ones stop. */
  syncStrategies(list: { id: string; enabled: boolean; cfg: StrategyConfig }[]) {
    const on = new Set<string>();
    for (const x of list) {
      if (!x.enabled) continue;
      on.add(x.id); this.cfgs.set(x.id, x.cfg);
      if (x.cfg.type === 'tradingview') { this.tv.set(x.id, x.cfg); continue; }
      const key = JSON.stringify(x.cfg), cur = this.running.get(x.id);
      if (!cur || cur.key !== key) { const s = buildStrategy(x.cfg, x.id); if (s) this.running.set(x.id, { s, key, name: x.cfg.name }); }
    }
    for (const id of [...this.running.keys()]) if (!on.has(id) && this.running.get(id)!.key !== '') this.running.delete(id);
    for (const id of [...this.tv.keys()]) if (!on.has(id)) this.tv.delete(id);
  }
  setGoals(g: Goals) { this.goals = g; this.progress = evaluate(g, null, this.stats.total); }

  /** Starts live prices and a check every 2 seconds. The daily loss limit is enforced here even when no new trade comes in. */
  /** Resolves once every queued order and exit check has finished. */
  idle() { return this.queue; }

  openTrades() { return [...this.open].map(([id, t]) => ({ id, ...t })); }

  async start(symbols: string[]) {
    if (this.broker.getBars) {   // give bar-based strategies some history so they can trade sooner
      for (const [id, r] of this.running) {
        const cfg = this.cfgs.get(id) as any;
        if (!r.s.warmup || !cfg) continue;
        const sec = cfg.ltf ?? cfg.timeframe ?? 60;
        try { r.s.warmup(await this.broker.getBars(cfg.symbol, sec, 600)); } catch { /* no history: it warms up live */ }
      }
    }
    try { await this.broker.subscribe?.(symbols); }
    catch (e) { this.note(`Live prices are not available: ${(e as Error).message} Strategies that need prices will not trade.`); }
    this.timer = setInterval(() => void this.watch(), 2000);
    (this.timer as any).unref?.();
    void this.watch();
  }

  private async watch() {
    if (this.busy || this.risk.halted) return;
    this.busy = true;
    try {
      const b = this.broker.getPnLBreakdown
        ? await this.broker.getPnLBreakdown()
        : { realized: await this.broker.getDailyPnL(), unrealized: 0, positions: await this.broker.getPositions() };
      const pnl = b.realized + b.unrealized;
      this.stats = { realized: b.realized, unrealized: b.unrealized, total: pnl, positions: b.positions, updated: Date.now() };
      this.history.push([Date.now(), pnl]); if (this.history.length > 900) this.history.shift();
      const acct = this.broker.getAccount ? await this.broker.getAccount() : null;
      this.account = acct ? { name: acct.name, size: acct.size, startBalance: acct.startBalance } : null;
      this.progress = evaluate(this.goals, acct, pnl, Math.max(pnl, ...this.history.map(h => h[1])));
      if (!this.latched && this.goals.pauseAtDailyTarget && this.progress.dailyHit) {
        this.latched = true;
        this.note('Daily profit target reached. New trades are paused for this session.');
      }
      this.bad = 0;
      if (pnl <= -Math.abs(this.risk.limits.maxDailyLoss)) {
        this.note('Daily loss limit reached. Stopping and closing positions.');
        await this.halt();
      }
    } catch {
      if (++this.bad === 5) this.note("Can't read your profit and loss right now. New trades stay blocked until it works.");
    } finally { this.busy = false; }
  }

  /** Take profit and stop loss, checked on every price. */
  private async checkExits(symbol: string, price: number) {
    for (const [id, t] of this.open) {
      if (t.symbol !== symbol) continue;
      const long = t.side === 'buy';
      const hitTp = t.tpPx !== null && (long ? price >= t.tpPx : price <= t.tpPx), hitSl = t.slPx !== null && (long ? price <= t.slPx : price >= t.slPx);
      const why = hitSl ? 'stop loss' : hitTp ? 'take profit' : '';
      const move = t.entry === null ? 0 : long ? price - t.entry : t.entry - price;
      if (!why) continue;
      this.open.delete(id);
      try {
        // Exits after the price touched the level go at market: brokers now honour limit orders, and a resting limit after a touch might never fill.
        await this.broker.placeOrder({ symbol, side: t.side === 'buy' ? 'sell' : 'buy', qty: t.qty, type: 'market' });
        this.note(`${why === 'take profit' ? 'Took profit' : 'Stopped out'} on ${t.qty} ${symbol} (${t.name}), ${move >= 0 ? '+' : ''}${move.toFixed(2)} points.`);
      } catch { this.note(`Could not close ${symbol} for ${t.name} at its ${why}. Check your trading platform now.`); }
      this.running.get(id)?.s.reset?.();
    }
  }

  async handleSignal(sig: Signal) {
    // A strategy's exit when Keel already closed it (or never opened it) must not open a new position the other way.
    const own = sig.source === 'strategy' && sig.strategyId ? this.open.get(sig.strategyId) : undefined;
    if (sig.source === 'strategy' && sig.strategyId && !own && sig.side === 'sell' && ['ma_cross', 'rsi', 'breakout'].includes(this.cfgs.get(sig.strategyId)?.type ?? '')) return;   // long-only strategies
    if (sig.source === 'tradingview' && sig.strategyId) {
      const cfg = this.tv.get(sig.strategyId);
      if (!cfg) { this.note('Ignored a TradingView alert: that strategy is switched off or was removed.'); return; }
      sig = { ...sig, symbol: cfg.symbol, qty: cfg.qty, from: cfg.name };
    }
    const sid = sig.strategyId, cfg = sid ? this.cfgs.get(sid) : undefined, trade = sid ? this.open.get(sid) : undefined;
    const isExit = !!trade && trade.side !== sig.side;
    if (isExit) {   // exits always go through: they only reduce risk
      this.open.delete(sid!);
      try { await this.broker.placeOrder({ symbol: sig.symbol, side: sig.side, qty: trade!.qty, type: 'market' }); this.note(`Sent ${sig.side} ${trade!.qty} ${sig.symbol} (${sig.from ?? sig.source}, exit)`); }
      catch { this.note(`Could not exit ${sig.symbol} for ${sig.from}. Check your trading platform now.`); }
      return;
    }
    if (trade) return;   // already in a trade for this strategy
    if (this.latched) { this.note(`Blocked ${sig.side} ${sig.qty} ${sig.symbol}: your daily profit target is already reached.`); return; }
    const positions = await this.broker.getPositions();
    let dailyPnL: number;
    try { dailyPnL = await this.broker.getDailyPnL(); }
    catch { this.note(`Blocked ${sig.side} ${sig.qty} ${sig.symbol}: can't read your daily profit and loss, so the limit can't be checked.`); return; }
    const verdict = this.risk.check(sig, { dailyPnL, openPositions: positions.length, positions });
    if (!verdict.ok) {
      this.note(`Blocked ${sig.side} ${sig.qty} ${sig.symbol}: ${verdict.reason}`);
      if (sid) this.running.get(sid)?.s.reset?.();
      if (this.risk.halted) { try { await this.broker.closeAll(); } catch { this.note('Could not close positions. Check your trading platform now.'); } }
      return;
    }
    await this.broker.placeOrder({ symbol: sig.symbol, side: sig.side, qty: sig.qty, type: 'market' });
    this.note(`Sent ${sig.side} ${sig.qty} ${sig.symbol} (${sig.from ?? sig.source})`);
    if (sid && cfg) {
      const entry = this.last.get(sig.symbol) ?? null, d = sig.side === 'buy' ? 1 : -1;
      // The strategy's own levels win; otherwise use the take profit and stop loss points from its settings.
      const tpPx = cfg.takeProfit > 0 && entry !== null ? entry + d * cfg.takeProfit : sig.tp ?? null;
      const slPx = cfg.stopLoss > 0 && entry !== null ? entry - d * cfg.stopLoss : sig.sl ?? null;
      this.open.set(sid, { symbol: sig.symbol, side: sig.side, qty: sig.qty, entry, tpPx, slPx, name: cfg.name, opened: Date.now() });
      if (entry === null && (cfg.takeProfit || cfg.stopLoss)) this.note(`No live price for ${sig.symbol} yet, so the take profit and stop loss for ${cfg.name} are not active.`);
    }
  }

  /** Kill switch: stop everything and flatten. */
  async halt() {
    this.risk.halt();
    try { this.onHalt?.(); } catch { /* keep going: closing positions matters more */ }
    this.open.clear();
    for (const r of this.running.values()) r.s.reset?.();
    try {
      await this.broker.closeAll();
      this.note('Kill switch used. All positions closed.');
    } catch {
      this.note('Kill switch used, but closing positions failed. Check your trading platform right now.');
    }
  }

  async shutdown() {
    clearInterval(this.timer);
    await this.halt();
    await this.broker.disconnect();
  }

  /** What the dashboard shows. */
  snapshot() {
    const h = this.history, step = Math.max(1, Math.ceil(h.length / 120));
    return { ...this.stats, halted: this.risk.halted, paused: this.latched, goals: this.goals, progress: this.progress, account: this.account, limit: this.risk.limits.maxDailyLoss, strategies: [...[...this.running.values()].map(r => r.name), ...[...this.tv.values()].map(c => c.name)], active: [...this.running.keys(), ...this.tv.keys()],
      events: this.events.slice(-80), history: h.filter((_, i) => i % step === 0 || i === h.length - 1) };
  }

  /** Lets other parts of Keel (the K system) post to the activity feed. */
  say(m: string) { this.note(m); }

  private note(m: string) {
    this.log.push(`${new Date().toISOString()} ${m}`); this.log = this.log.slice(-200);
    const kind = /^Sent|closed .* at its|K system: closed/.test(m) ? 'trade' : /Blocked|Ignored|stopped:|limit|can't|Can't|failed|not available|Check your|could not|skipped .* late/i.test(m) ? 'warn' : 'info';
    this.events.push({ t: Date.now(), msg: m, kind }); this.events = this.events.slice(-200);
  }
}
