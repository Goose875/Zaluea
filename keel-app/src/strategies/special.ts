import { Quote, Signal, Strategy } from '../core/types';
import { tick } from '../core/contracts';

export interface SpecialConfig {
  type: 'keels_special'; name: string; symbol: string; qty: number; takeProfit: number; stopLoss: number;
  ltf: number;        // entry bar size in seconds
  htfMult: number;    // bias bars are this many entry bars
  fastEma: number; slowEma: number;   // bias: fast EMA above slow EMA on the bias bars = only longs (and the reverse)
  swing: number;      // bars on each side that make a swing high or low
  retrace: number;    // % of the first leg price must pull back into (50 = the 50% mark)
  rr: number;         // target as a multiple of the risk
  timeout: number;    // bars to wait for each step before starting over
  buffer: number;     // ticks past the pullback extreme for the stop
}
interface Bar { t: number; o: number; h: number; l: number; c: number }

/**
 * Keel's Special. Trades in the direction of the higher-timeframe bias:
 *   1. Bias from a fast and slow EMA on bigger bars.
 *   2. First break of structure: a close beyond the last swing high (low for shorts). That move is the first leg.
 *   3. Pullback into the first leg, at least to the retrace mark, without breaking the leg's start.
 *   4. Second break: a close beyond the first leg's extreme. Enter there.
 *   Stop just past the pullback extreme, target at rr times the risk. One trade at a time.
 */
export function buildSpecial(cfg: SpecialConfig, id: string): Strategy {
  const bars: Bar[] = []; let cur: Bar | null = null, bucket = -1;
  let hb: Bar | null = null, hBucket = -1, fast = NaN, slow = NaN, hCount = 0;
  const swingsH: { i: number; p: number }[] = [], swingsL: { i: number; p: number }[] = [];
  let state: 'idle' | 'leg' | 'pullback' = 'idle', dir = 0, since = 0, legStart = 0, legEnd = 0, pb = 0, inTrade = false, quiet = false;
  const T = tick(cfg.symbol);
  const kf = 2 / (cfg.fastEma + 1), ks = 2 / (cfg.slowEma + 1);
  const fastSeed: number[] = [], slowSeed: number[] = [];
  const ema = (seed: number[], v: number, prev: number, k: number, n: number) => { if (!Number.isNaN(prev)) return prev + k * (v - prev); seed.push(v); return seed.length >= n ? seed.reduce((a, b) => a + b, 0) / n : NaN; };
  const bias = () => (Number.isNaN(fast) || Number.isNaN(slow) ? 0 : fast > slow ? 1 : fast < slow ? -1 : 0);
  // In "dir" space a short setup looks exactly like a long one, so one set of rules handles both.
  const H = (b: Bar) => (dir === 1 ? b.h : -b.l), L = (b: Bar) => (dir === 1 ? b.l : -b.h), C = (b: Bar) => (dir === 1 ? b.c : -b.c);
  const back = (v: number) => dir * v;

  function closeHtf(b: Bar) { fast = ema(fastSeed, b.c, fast, kf, cfg.fastEma); slow = ema(slowSeed, b.c, slow, ks, cfg.slowEma); hCount++; }

  function onBar(b: Bar): Signal | null {
    bars.push(b); if (bars.length > 3000) { bars.shift(); for (const s of [swingsH, swingsL]) s.forEach(x => x.i--); }
    const k = bars.length - 1, w = cfg.swing, c = k - w;
    if (c >= w) {   // confirm a swing w bars ago
      const mid = bars[c], left = bars.slice(c - w, c), right = bars.slice(c + 1, k + 1);   // equal highs on the right still count
      if (left.every(x => x.h < mid.h) && right.every(x => x.h <= mid.h)) swingsH.push({ i: c, p: mid.h });
      if (left.every(x => x.l > mid.l) && right.every(x => x.l >= mid.l)) swingsL.push({ i: c, p: mid.l });
      if (swingsH.length > 50) swingsH.shift(); if (swingsL.length > 50) swingsL.shift();
    }
    if (inTrade) return null;
    const bnow = bias();
    if (state !== 'idle' && bnow !== dir) state = 'idle';   // bias flipped: forget the setup
    if (state === 'idle') {
      if (!bnow) return null;
      dir = bnow;
      const level = dir === 1 ? swingsH[swingsH.length - 1] : swingsL[swingsL.length - 1];
      const startSwing = dir === 1 ? swingsL[swingsL.length - 1] : swingsH[swingsH.length - 1];
      if (!level || level.i >= k) return null;
      const lv = dir === 1 ? level.p : -level.p;
      if (C(b) > lv && (k < 1 || C(bars[k - 1]) <= lv)) {   // first break of structure
        const from = startSwing && startSwing.i < k ? startSwing.i : Math.max(0, k - 20);
        legStart = Math.min(...bars.slice(from, k + 1).map(L)); legEnd = H(b); state = 'leg'; since = k;
      }
      return null;
    }
    if (k - since > cfg.timeout) { state = 'idle'; return null; }
    if (state === 'leg') {
      legEnd = Math.max(legEnd, H(b));
      if (C(b) < legStart) { state = 'idle'; return null; }
      if (L(b) <= legEnd - (cfg.retrace / 100) * (legEnd - legStart)) { state = 'pullback'; pb = L(b); since = k; }
      return null;
    }
    // pullback
    pb = Math.min(pb, L(b));
    if (pb < legStart) { state = 'idle'; return null; }
    if (C(b) > legEnd) {   // second break: enter
      const entry = C(b), stop = pb - cfg.buffer * T, risk = entry - stop;
      state = 'idle';
      if (!(risk > 0)) return null;
      const target = entry + cfg.rr * risk;
      if (quiet) return null;
      inTrade = true;
      return { symbol: cfg.symbol, side: dir === 1 ? 'buy' : 'sell', qty: cfg.qty, source: 'strategy', from: cfg.name, strategyId: id,
        tp: back(target), sl: back(stop) };
    }
    return null;
  }

  function feed(b: Bar): Signal | null {
    const hb2 = Math.floor(b.t / (cfg.ltf * cfg.htfMult * 1000));
    if (hb && hb2 !== hBucket) { closeHtf(hb); hb = null; }
    if (!hb) { hb = { ...b }; hBucket = hb2; } else { hb.h = Math.max(hb.h, b.h); hb.l = Math.min(hb.l, b.l); hb.c = b.c; }
    return onBar(b);
  }

  return {
    id, name: cfg.name,
    reset() { inTrade = false; state = 'idle'; },
    warmup(history: Bar[]) { quiet = true; for (const b of history) feed(b); quiet = false; state = 'idle'; },
    onQuote(q: Quote) {
      if (q.symbol !== cfg.symbol) return null;
      const b = Math.floor(q.ts / (cfg.ltf * 1000));
      let out: Signal | null = null;
      if (cur && b !== bucket) { out = feed(cur); cur = null; }
      if (!cur) { cur = { t: b * cfg.ltf * 1000, o: q.price, h: q.price, l: q.price, c: q.price }; bucket = b; }
      else { cur.h = Math.max(cur.h, q.price); cur.l = Math.min(cur.l, q.price); cur.c = q.price; }
      return out;
    }
  } as Strategy;
}
