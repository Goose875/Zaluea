import { Quote } from './types';

export interface Candle { t: number; o: number; h: number; l: number; c: number }

/** Keeps 15-second candles per market from live prices, for the chart. Larger sizes are built from these. */
export class BarStore {
  private base = new Map<string, Candle[]>();
  /** Last live tick per symbol (history seeding does not count). */
  last = new Map<string, { price: number; ts: number }>();
  static readonly BASE = 15_000;
  add(q: Quote) {
    this.last.set(q.symbol, { price: q.price, ts: Date.now() });
    const t = Math.floor(q.ts / BarStore.BASE) * BarStore.BASE;
    const arr = this.base.get(q.symbol) ?? []; const last = arr[arr.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, q.price); last.l = Math.min(last.l, q.price); last.c = q.price; }
    else { arr.push({ t, o: q.price, h: q.price, l: q.price, c: q.price }); if (arr.length > 4000) arr.shift(); }
    this.base.set(q.symbol, arr);
  }
  seed(symbol: string, bars: Candle[]) { if (!this.base.get(symbol)?.length) this.base.set(symbol, bars.slice(-4000)); }
  symbols() { return [...this.base.keys()]; }
  get(symbol: string, tfMs: number, count: number): Candle[] {
    const out: Candle[] = [];
    for (const b of this.base.get(symbol) ?? []) {
      const t = Math.floor(b.t / tfMs) * tfMs, last = out[out.length - 1];
      if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
      else out.push({ ...b, t });
    }
    return out.slice(-count);
  }
}
