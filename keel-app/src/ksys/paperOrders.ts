import { BrokerAdapter, Order, Position, Quote, WorkingOrder } from '../core/types';
import { mult, tick } from '../core/contracts';

/** Micro contracts trade the same prices as their mini: use the mini's quote when the micro has none yet. */
const PRICE_TWIN: Record<string, string> = { MNQ: 'NQ', MGC: 'GC', MES: 'ES', NQ: 'MNQ', GC: 'MGC', ES: 'MES' };

/**
 * Paper mode for the K system: real prices from the connected broker, pretend orders.
 * Market orders fill at the last price plus 1 tick against you. Stops trigger when the price touches them and fill 1 tick
 * worse. Limits fill only when the price trades 1 tick through them (same rules as the backtest). Nothing reaches the broker.
 */
export class PaperOrders {
  private orders = new Map<string, WorkingOrder>();
  private pos = new Map<string, { qty: number; avg: number }>();
  private seq = 0;
  private oco = new Map<string, string>();          // order id -> its one-cancels-other partner
  private armed = new Set<string>();                // stop-limits whose trigger has traded (now plain limits)
  private fillCbs: (() => void)[] = [];
  onFill(cb: () => void) { this.fillCbs.push(cb); }
  realized = 0;
  fills: { t: number; symbol: string; side: 'buy' | 'sell'; qty: number; price: number; why: string }[] = [];

  constructor(private data: BrokerAdapter) {}

  price(symbol: string): number | undefined {
    return this.data.lastPrice?.(symbol) ?? (PRICE_TWIN[symbol] ? this.data.lastPrice?.(PRICE_TWIN[symbol]) : undefined);
  }

  /** Feed every live quote here. */
  onQuote(q: Quote) {
    for (const sym of [q.symbol, PRICE_TWIN[q.symbol]].filter(Boolean) as string[]) {
      for (const o of [...this.orders.values()].filter(x => x.symbol === sym)) {
        const T = tick(sym), p = q.price;
        if (o.type === 'stop' && o.price !== null && (o.side === 'buy' ? p >= o.price : p <= o.price)) this.fill(o, o.side === 'buy' ? Math.max(p, o.price) + T : Math.min(p, o.price) - T, 'stop');
        else if (o.type === 'limit' && o.price !== null && (o.side === 'buy' ? p <= o.price - T : p >= o.price + T)) this.fill(o, o.price, 'limit');
        else if (o.type === 'stoplimit' && o.price !== null && o.trigger != null) {
          // the trigger trades: fill now if the price is still inside the limit, else rest as a limit at the limit price
          if (!this.armed.has(o.id) && (o.side === 'buy' ? p >= o.trigger : p <= o.trigger)) {
            this.armed.add(o.id);
            if (o.side === 'buy' ? p <= o.price : p >= o.price) { this.fill(o, o.side === 'buy' ? Math.min(o.price, Math.max(p, o.trigger) + T) : Math.max(o.price, Math.min(p, o.trigger) - T), 'stop-limit'); continue; }
          }
          if (this.armed.has(o.id) && (o.side === 'buy' ? p <= o.price - T : p >= o.price + T)) this.fill(o, o.price, 'stop-limit');
        }
      }
    }
  }

  private fill(o: WorkingOrder, px: number, why: string) {
    this.orders.delete(o.id); this.armed.delete(o.id);
    const other = this.oco.get(o.id); if (other) { this.orders.delete(other); this.oco.delete(other); this.oco.delete(o.id); }
    this.book(o.symbol, o.side, o.qty, px, why);
    for (const cb of this.fillCbs) { try { cb(); } catch { /* listeners never break fills */ } }
  }
  async placeOco(a: Order, b: Order): Promise<[string, string]> {
    const x = await this.placeOrder(a), y = await this.placeOrder(b); this.oco.set(x, y); this.oco.set(y, x); return [x, y];
  }

  private book(symbol: string, side: 'buy' | 'sell', qty: number, px: number, why: string) {
    const signed = side === 'buy' ? qty : -qty, cur = this.pos.get(symbol) ?? { qty: 0, avg: 0 }, M = mult(symbol);
    this.fills.push({ t: Date.now(), symbol, side, qty, price: px, why }); this.fills = this.fills.slice(-500);
    if (cur.qty === 0 || Math.sign(cur.qty) === Math.sign(signed)) {
      const q = cur.qty + signed; this.pos.set(symbol, { qty: q, avg: (cur.avg * Math.abs(cur.qty) + px * qty) / Math.abs(q) });
    } else {
      const closing = Math.min(Math.abs(cur.qty), qty);
      this.realized += closing * (px - cur.avg) * Math.sign(cur.qty) * M - 2 * 0.75 * closing;
      const q = cur.qty + signed;
      if (q === 0) this.pos.delete(symbol); else this.pos.set(symbol, { qty: q, avg: Math.sign(q) === Math.sign(cur.qty) ? cur.avg : px });
    }
  }

  async placeOrder(o: Order): Promise<string> {
    if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error('Order size must be a whole number.');
    const id = `paper-${++this.seq}`;
    if (o.type === 'market') {
      const p = this.price(o.symbol);
      if (p === undefined) throw new Error(`No live price for ${o.symbol} yet.`);
      this.book(o.symbol, o.side, o.qty, p + (o.side === 'buy' ? 1 : -1) * tick(o.symbol), 'market');
    } else {
      if (!(Number.isFinite(o.price) && (o.price as number) > 0)) throw new Error(`A ${o.type} order needs a price.`);
      if (o.type === 'stoplimit' && !(Number.isFinite(o.trigger) && (o.trigger as number) > 0)) throw new Error('A stop-limit order needs a trigger price.');
      this.orders.set(id, { id, symbol: o.symbol, side: o.side, qty: o.qty, type: o.type, price: o.price as number, ...(o.type === 'stoplimit' ? { trigger: o.trigger as number } : {}) });
    }
    return id;
  }
  async getOpenOrders() { return [...this.orders.values()].map(o => ({ ...o })); }
  async modifyOrder(id: string, change: { price: number }) {
    const o = this.orders.get(id); if (!o) throw new Error('That order is no longer working.');
    if (o.type === 'stoplimit' && o.trigger != null && o.price !== null) o.trigger += change.price - o.price;   // the trigger moves with the limit
    o.price = change.price;
  }
  async cancelOrder(id: string) { this.orders.delete(id); this.armed.delete(id); const other = this.oco.get(id); if (other) { this.oco.delete(other); this.oco.delete(id); } }
  async getPositions(): Promise<Position[]> { return [...this.pos].map(([symbol, p]) => ({ symbol, qty: p.qty, avgPrice: p.avg })); }
  unrealized() {
    let u = 0;
    for (const [s, p] of this.pos) { const px = this.price(s); if (px !== undefined) u += (px - p.avg) * p.qty * mult(s); }
    return u;
  }
  async closeAll() {
    this.orders.clear(); this.oco.clear(); this.armed.clear();
    for (const [s, p] of [...this.pos]) { const px = this.price(s) ?? p.avg; this.book(s, p.qty > 0 ? 'sell' : 'buy', Math.abs(p.qty), px - Math.sign(p.qty) * tick(s), 'close all'); }
  }
}
