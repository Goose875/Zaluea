import { BrokerAdapter, Order, Position, Quote } from './types';
import { Engine } from './engine';
import { RiskGuard } from './risk';
import { StrategyConfig } from '../strategies/rules';
import { mult, tick } from './contracts';
import { Candle } from './bars';

/** Reads price history exported from TradingView (or any CSV with time, open, high, low, close columns). */
export function parseCsv(text: string): Candle[] {
  if (text.length > 30_000_000) throw new Error('That file is too big (30 MB max).');
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 3) throw new Error('That file has no price rows.');
  const head = lines[0].toLowerCase().split(/[,;\t]/).map(h => h.trim().replace(/"/g, ''));
  const col = (...names: string[]) => head.findIndex(h => names.includes(h));
  const iT = col('time', 'date', 'datetime', 'timestamp'), iO = col('open', 'o'), iH = col('high', 'h'), iL = col('low', 'l'), iC = col('close', 'c', 'last');
  if ([iT, iO, iH, iL, iC].some(i => i < 0)) throw new Error('The file needs time, open, high, low and close columns.');
  const out: Candle[] = [];
  for (const line of lines.slice(1)) {
    const v = line.split(/[,;\t]/).map(x => x.trim().replace(/"/g, ''));
    const raw = v[iT]; let t = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (t > 0 && t < 1e11) t *= 1000;   // unix seconds
    const b = { t, o: Number(v[iO]), h: Number(v[iH]), l: Number(v[iL]), c: Number(v[iC]) };
    if ([b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.h >= b.l) out.push(b);
  }
  if (out.length < 50) throw new Error('Keel needs at least 50 good price rows.');
  out.sort((a, b) => a.t - b.t);
  return out;
}

export interface Trade { side: 'long' | 'short'; qty: number; entryT: number; entry: number; exitT: number; exit: number; pnl: number; points: number; r: number | null; by: string }
export interface Report {
  bars: number; from: number; to: number; trades: Trade[]; net: number; wins: number; losses: number; winRate: number;
  profitFactor: number | null; avgWin: number; avgLoss: number; avgR: number | null; maxDrawdown: number; bestDay: number; worstDay: number;
  days: { date: string; pnl: number }[]; equity: [number, number][]; notes: string[];
}

/** A pretend broker that fills at the current price with slippage and charges commission. */
class SimBroker implements BrokerAdapter {
  readonly id = 'sim'; readonly name = 'Backtest';
  price = 0; t = 0; cb: (q: Quote) => void = () => {};
  pos = 0; avg = 0; realized = 0;
  open: { side: 'long' | 'short'; qty: number; entryT: number; entry: number; startRealized: number; risk: number | null } | null = null;
  trades: Omit<Trade, 'by'>[] = [];
  constructor(private symbol: string, private slip: number, private fee: number) {}
  async connect() {} async disconnect() {}
  onQuote(cb: (q: Quote) => void) { this.cb = cb; }
  async placeOrder(o: Order) {
    const T = tick(this.symbol), M = mult(this.symbol);
    // A target fills at its own price; everything else fills at the current price plus slippage.
    const px = o.type === 'limit' && typeof o.price === 'number' ? o.price : this.price + (o.side === 'buy' ? 1 : -1) * this.slip * T;
    const signed = o.side === 'buy' ? o.qty : -o.qty;
    this.realized -= this.fee * o.qty;
    if (this.pos === 0 || Math.sign(this.pos) === Math.sign(signed)) {
      const q = this.pos + signed; this.avg = this.pos === 0 ? px : (this.avg * Math.abs(this.pos) + px * Math.abs(signed)) / Math.abs(q); this.pos = q;
      if (!this.open) this.open = { side: signed > 0 ? 'long' : 'short', qty: Math.abs(q), entryT: this.t, entry: px, startRealized: this.realized + this.fee * o.qty, risk: null };
      else this.open.qty = Math.abs(q);
    } else {
      const closing = Math.min(Math.abs(this.pos), Math.abs(signed));
      this.realized += (px - this.avg) * M * closing * Math.sign(this.pos);
      const q = this.pos + signed;
      if (q === 0 || Math.sign(q) !== Math.sign(this.pos)) {
        const t = this.open!;
        this.trades.push({ side: t.side, qty: t.qty, entryT: t.entryT, entry: t.entry, exitT: this.t, exit: px, pnl: this.realized - t.startRealized,
          points: (px - t.entry) * (t.side === 'long' ? 1 : -1), r: t.risk ? ((px - t.entry) * (t.side === 'long' ? 1 : -1)) / t.risk : null });
        this.open = null;
        if (q !== 0) { this.open = { side: q > 0 ? 'long' : 'short', qty: Math.abs(q), entryT: this.t, entry: px, startRealized: this.realized, risk: null }; this.avg = px; }
      }
      this.pos = q;
    }
    return `bt-${this.trades.length}`;
  }
  async closeAll() { if (this.pos) await this.placeOrder({ symbol: this.symbol, side: this.pos > 0 ? 'sell' : 'buy', qty: Math.abs(this.pos), type: 'market' }); }
  async getPositions(): Promise<Position[]> { return this.pos ? [{ symbol: this.symbol, qty: this.pos, avgPrice: this.avg }] : []; }
  async getDailyPnL() { return 0; }   // backtests don't stop for the day
}

/**
 * Replays history through the same engine the live bot uses. Each bar becomes four prices
 * (open, then the low and high in the likely order, then close), so stops and targets fill inside bars.
 * If a bar touches both the stop and the target, the stop counts first (the cautious choice).
 */
export async function runBacktest(cfg: StrategyConfig, bars: Candle[], opts: { slippageTicks: number; feePerSide: number }): Promise<Report> {
  const sim = new SimBroker(cfg.symbol, opts.slippageTicks, opts.feePerSide);
  const eng = new Engine(sim, new RiskGuard({ maxDailyLoss: 1e12, maxQtyPerOrder: 10_000, maxOpenPositions: 1000, allowedSymbols: [cfg.symbol] }));
  const id = 's-000000000000';
  eng.syncStrategies([{ id, enabled: true, cfg }]);
  const gaps = bars.slice(1, 200).map((b, i) => b.t - bars[i].t).filter(x => x > 0).sort((a, b) => a - b);
  const span = gaps[Math.floor(gaps.length / 2)] || 60_000;
  const send = async (t: number, p: number) => {
    sim.price = p; sim.t = t;
    sim.cb({ symbol: cfg.symbol, price: p, ts: t });
    await eng.idle();
    if (sim.open && sim.open.risk === null) {
      const tr = eng.openTrades().find(x => x.id === id);
      if (tr && tr.slPx !== null) sim.open.risk = Math.abs(sim.open.entry - tr.slPx);
    }
  };
  for (const b of bars) {
    const lowFirst = b.c >= b.o;
    await send(b.t, b.o);
    await send(b.t + span * 0.3, lowFirst ? b.l : b.h);
    await send(b.t + span * 0.6, lowFirst ? b.h : b.l);
    await send(b.t + span * 0.95, b.c);
  }
  if (sim.pos) { await sim.closeAll(); }
  return report(sim.trades.map(t => ({ ...t, by: '' })), bars, cfg, span);
}

function report(trades: Trade[], bars: Candle[], cfg: StrategyConfig, span: number): Report {
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0; const equity: [number, number][] = [[bars[0].t, 0]];
  const byDay = new Map<string, number>();
  for (const t of trades) {
    eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); equity.push([t.exitT, eq]);
    const d = new Date(t.exitT).toISOString().slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + t.pnl);
  }
  const days = [...byDay].map(([date, pnl]) => ({ date, pnl }));
  const rs = trades.map(t => t.r).filter((r): r is number => r !== null);
  const notes: string[] = [];
  const ltf = (cfg as any).ltf ?? (cfg as any).timeframe;
  if (ltf && span > ltf * 1000 * 1.5) notes.push(`Your data has ${Math.round(span / 60000)}-minute bars but the strategy uses ${ltf < 60 ? ltf + '-second' : ltf / 60 + '-minute'} bars. Use data with the same or smaller bars for a fair test.`);
  if (trades.length < 30) notes.push('Fewer than 30 trades is too few to judge a strategy. Test on more history.');
  return {
    bars: bars.length, from: bars[0].t, to: bars[bars.length - 1].t, trades, net: eq, wins: wins.length, losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0, profitFactor: gl > 0 ? gw / gl : null,
    avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0, avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    maxDrawdown: dd, bestDay: Math.max(0, ...days.map(d => d.pnl)), worstDay: Math.min(0, ...days.map(d => d.pnl)), days, equity, notes
  };
}

/** Pretend prices with trends and pullbacks, for trying the backtester when you have no data yet. Not real market data. */
export function samplePrices(symbol: string, minutes = 60 * 24 * 10): Candle[] {
  const T = tick(symbol), out: Candle[] = [];
  let p = symbol.includes('NQ') ? 18000 : symbol.includes('ES') ? 5000 : 1000, t = Date.UTC(2026, 9, 1), trend = 0;
  for (let i = 0; i < minutes; i++) {
    if (i % 240 === 0) trend = (Math.random() - 0.5) * 0.8;
    const vol = (symbol.includes('NQ') ? 6 : 1.5);
    const o = p, c = Math.round((o + trend + (Math.random() - 0.5) * vol * 2) / T) * T;
    const h = Math.max(o, c) + Math.random() * vol * 0.6, l = Math.min(o, c) - Math.random() * vol * 0.6;
    out.push({ t: t + i * 60000, o, h: Math.round(h / T) * T, l: Math.round(l / T) * T, c }); p = c;
  }
  return out;
}
