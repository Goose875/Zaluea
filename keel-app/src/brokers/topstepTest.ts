import { AccountInfo, BrokerAdapter, DayResult, Order, Position, Quote } from '../core/types';
import type { AccountRecord } from '../core/accounts';

/** Same account id gives the same past days every time. */
function seeded(text: string) { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const MULT: Record<string, number> = { ES: 50, NQ: 20, MES: 5, MNQ: 2 };   // dollars per point
const STEP: Record<string, number> = { ES: 1.5, NQ: 6, MES: 1.5, MNQ: 6 };   // typical move per second

/**
 * DEV ONLY. A pretend $50K Topstep account: random name, random past days, simulated prices, P&L in dollars.
 * A new one is made every time the bot starts, so rules like consistency pass and fail in different runs.
 */
export class TopstepTestBroker implements BrokerAdapter {
  readonly id = 'topstep-test'; readonly name = 'Pretend account (dev)';
  private price = new Map<string, number>([['ES', 5000], ['NQ', 18000], ['MES', 5000], ['MNQ', 18000]]);
  private positions = new Map<string, Position>();
  private realized = 0;
  private cb: (q: Quote) => void = () => {};
  private timer?: ReturnType<typeof setInterval>;
  private info!: AccountInfo;

  constructor(private rand: () => number = Math.random, private acct?: AccountRecord) {}

  async connect() {
    this.info = this.makeAccount();
    this.timer = setInterval(() => {
      for (const [sym, p] of this.price) {
        const next = Math.max(1, p + (this.rand() - 0.5) * 2 * STEP[sym]);
        this.price.set(sym, next);
        this.cb({ symbol: sym, price: next, ts: Date.now() });
      }
    }, 1000);
    (this.timer as any).unref?.();
  }
  async disconnect() { if (this.timer) clearInterval(this.timer); }
  onQuote(cb: (q: Quote) => void) { this.cb = cb; }

  private makeAccount(): AccountInfo {
    const r = this.acct ? seeded(this.acct.id) : this.rand, n = 4 + Math.floor(r() * 6);
    const round5 = (v: number) => Math.round(v / 5) * 5;
    const days: DayResult[] = [];
    const d = new Date();
    while (days.length < n) {
      d.setDate(d.getDate() - 1);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      days.unshift({ date: d.toISOString().slice(0, 10), pnl: round5(r() < 0.7 ? 50 + r() * 600 : -(50 + r() * 400)) });
    }
    if (r() < 0.2) days[Math.floor(r() * days.length)].pnl = round5(1400 + r() * 500);   // sometimes one huge day, to trip the consistency rule
    const num = (k: number) => String(Math.floor(r() * 10 ** k)).padStart(k, '0');
    if (this.acct) {
      const k = this.acct.size / 50000;   // scale past days to the account size
      return { name: this.acct.label, size: this.acct.size, startBalance: this.acct.size, balance: this.acct.size, maxLoss: this.acct.maxLoss, days: days.map(d => ({ ...d, pnl: Math.round(d.pnl * k) })) };
    }
    return { name: `50KTC-V2-${num(6)}-${num(2)}`, size: 50000, startBalance: 50000, balance: 50000, maxLoss: 2000, days };
  }

  private unreal(p: Position) { return ((this.price.get(p.symbol) ?? p.avgPrice) - p.avgPrice) * MULT[p.symbol] * p.qty; }

  async placeOrder(o: Order) {
    const px = this.price.get(o.symbol), mult = MULT[o.symbol];
    if (px === undefined) throw new Error(`${o.symbol} is not on the test account. Use ES, NQ, MES or MNQ.`);
    const signed = o.side === 'buy' ? o.qty : -o.qty, cur = this.positions.get(o.symbol);
    if (!cur) this.positions.set(o.symbol, { symbol: o.symbol, qty: signed, avgPrice: px });
    else if (Math.sign(cur.qty) === Math.sign(signed)) {
      const q = cur.qty + signed;
      this.positions.set(o.symbol, { symbol: o.symbol, qty: q, avgPrice: (cur.avgPrice * Math.abs(cur.qty) + px * Math.abs(signed)) / Math.abs(q) });
    } else {
      const closing = Math.min(Math.abs(cur.qty), Math.abs(signed));
      this.realized += (px - cur.avgPrice) * mult * closing * Math.sign(cur.qty);
      const q = cur.qty + signed;
      if (q === 0) this.positions.delete(o.symbol);
      else this.positions.set(o.symbol, { symbol: o.symbol, qty: q, avgPrice: Math.sign(q) === Math.sign(cur.qty) ? cur.avgPrice : px });
    }
    return `test-${Date.now()}`;
  }

  async closeAll() { for (const p of this.positions.values()) this.realized += this.unreal(p); this.positions.clear(); }
  async getPositions() { return [...this.positions.values()]; }

  async getPnLBreakdown() {
    const positions = [...this.positions.values()].map(p => ({ ...p, pnl: this.unreal(p) }));
    return { realized: this.realized, unrealized: positions.reduce((a, p) => a + p.pnl, 0), positions };
  }
  async getDailyPnL() { const b = await this.getPnLBreakdown(); return b.realized + b.unrealized; }

  /** Pretend history that ends at today's price, so the chart and strategies have something to start from. */
  async getBars(symbol: string, seconds: number, count: number) {
    const now = this.price.get(symbol); if (now === undefined) return [];
    const out: { t: number; o: number; h: number; l: number; c: number }[] = [];
    const step = STEP[symbol] * Math.sqrt(seconds), end = Math.floor(Date.now() / (seconds * 1000)) * seconds * 1000;
    let c = now, drift = 0;
    for (let i = 0; i < count; i++) {
      if (i % 40 === 0) drift = (Math.random() - 0.5) * 0.6 * step;
      const o = c - drift - (Math.random() - 0.5) * step;
      const h = Math.max(o, c) + Math.random() * step * 0.5, l = Math.min(o, c) - Math.random() * step * 0.5;
      out.unshift({ t: end - (i + 1) * seconds * 1000, o, h, l, c }); c = o;
    }
    return out;
  }

  async getAccount(): Promise<AccountInfo> {
    const today = await this.getDailyPnL();
    return { ...this.info, balance: this.info.startBalance + this.info.days.reduce((a, d) => a + d.pnl, 0) + today };
  }
}
