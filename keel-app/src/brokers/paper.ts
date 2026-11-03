import { BrokerAdapter, Order, Position, Quote } from '../core/types';

/** Simulated broker with a random-walk price feed. No real money, no keys. */
export class PaperBroker implements BrokerAdapter {
  readonly id = 'paper'; readonly name = 'Paper trading';
  private cb: (q: Quote) => void = () => {};
  private positions = new Map<string, Position>();
  private price = new Map<string, number>([['ES', 5000], ['NQ', 18000]]);
  private realized = 0;
  private timer?: NodeJS.Timeout;

  async connect() {
    this.timer = setInterval(() => {
      for (const [sym, p] of this.price) {
        const next = p + (Math.random() - 0.5) * 2;
        this.price.set(sym, next);
        this.cb({ symbol: sym, price: next, ts: Date.now() });
      }
    }, 1000);
  }
  async disconnect() { if (this.timer) clearInterval(this.timer); }
  onQuote(cb: (q: Quote) => void) { this.cb = cb; }

  async placeOrder(o: Order) {
    const px = this.price.get(o.symbol) ?? 0;
    const signed = o.side === 'buy' ? o.qty : -o.qty;
    const cur = this.positions.get(o.symbol);
    if (!cur) this.positions.set(o.symbol, { symbol: o.symbol, qty: signed, avgPrice: px });
    else {
      const qty = cur.qty + signed;
      if (qty === 0) { this.realized += (px - cur.avgPrice) * cur.qty; this.positions.delete(o.symbol); }
      else this.positions.set(o.symbol, { ...cur, qty });
    }
    return `paper-${Date.now()}`;
  }
  async closeAll() {
    for (const p of this.positions.values()) this.realized += ((this.price.get(p.symbol) ?? p.avgPrice) - p.avgPrice) * p.qty;
    this.positions.clear();
  }
  async getPositions() { return [...this.positions.values()]; }
  async getPnLBreakdown() {
    const positions = [...this.positions.values()].map(p => ({ ...p, pnl: ((this.price.get(p.symbol) ?? p.avgPrice) - p.avgPrice) * p.qty }));
    return { realized: this.realized, unrealized: positions.reduce((a, p) => a + p.pnl, 0), positions };
  }
  async getDailyPnL() {
    let open = 0;
    for (const p of this.positions.values()) open += ((this.price.get(p.symbol) ?? p.avgPrice) - p.avgPrice) * p.qty;
    return this.realized + open;
  }
}
