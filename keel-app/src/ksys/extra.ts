/**
 * Keel's second strategy family (beside K1-K7): ICT Power of Three (PO3) on 4-hour candles and the gold Fractal breakout.
 * Ported line for line from the research code (backtests/po3.py, backtests/precise.py, backtests/portfolio_all.py) and checked
 * trade for trade against it (scripts/parity-x.js). The simulator here is also what the live runner (xlive.ts) asks
 * "which order should be working right now?", so live and backtest use the same rules.
 *
 *  K8  GC Fractal breakout, day trade: daily signal, market entry at the 18:00 reopen, stop 0.5 x daily ATR, target 3R, flat by the cut-off.
 *  K9  GC PO3, 1-hour rejection block, 4h EMA20 bias, exit at the 4h candle's close.
 *  P1  GC PO3, 15-minute FVG midpoint (no bias), exit at the 4h candle's close.           paper only: 10 weeks of evidence
 *  P2  GC PO3, 15-minute rejection block, bias vs the 18:00 open, 3R target, 4h close.   paper only: 10 weeks of evidence
 *  P3  NQ PO3, 15-minute FVG midpoint (no bias), exit at the 4h candle's close.           paper only: 10 weeks of evidence
 */
import { wallOf, sessionKey } from './time';

export interface XBar { utc: number; wall: number; mod: number; day: string; o: number; h: number; l: number; c: number; v: number }
export interface XStrategy {
  id: string; name: string; symbol: 'NQ' | 'GC'; kind: 'po3' | 'fractal';
  barMinutes: number;                 // execution bars: 5, 60 (PO3) or 1440 (fractal, daily bars)
  trigMinutes?: number;               // PO3 trigger bars: 15 or 60
  model?: 'RB' | 'FVG CE'; bias?: 'none' | '4h EMA20' | 'vs 18:00 open'; target?: 'none' | '3R';
  paperOnly: boolean; evidence: string;
}
export const XSTRATEGIES: XStrategy[] = [
  { id: 'K8', name: 'GC Fractal breakout (day trade)', symbol: 'GC', kind: 'fractal', barMinutes: 1440, paperOnly: false, evidence: '2005-2026 daily data' },
  { id: 'K9', name: 'GC PO3 1h rejection block', symbol: 'GC', kind: 'po3', barMinutes: 60, trigMinutes: 60, model: 'RB', bias: '4h EMA20', target: 'none', paperOnly: false, evidence: 'Jun 2024 - Nov 2026 hourly data' },
  { id: 'P1', name: 'GC PO3 15m FVG midpoint', symbol: 'GC', kind: 'po3', barMinutes: 5, trigMinutes: 15, model: 'FVG CE', bias: 'none', target: 'none', paperOnly: true, evidence: '10 weeks of 5-minute data' },
  { id: 'P2', name: 'GC PO3 15m rejection block', symbol: 'GC', kind: 'po3', barMinutes: 5, trigMinutes: 15, model: 'RB', bias: 'vs 18:00 open', target: '3R', paperOnly: true, evidence: '10 weeks of 5-minute data' },
  { id: 'P3', name: 'NQ PO3 15m FVG midpoint', symbol: 'NQ', kind: 'po3', barMinutes: 5, trigMinutes: 15, model: 'FVG CE', bias: 'none', target: 'none', paperOnly: true, evidence: '10 weeks of 5-minute data' }
];
export const XTICK: Record<string, number> = { NQ: 0.25, GC: 0.1 };
const MINI: Record<string, number> = { NQ: 20, GC: 100 };
const LAST_ENTRY = 15 * 60 + 55, FLAT_AT = 16 * 60 + 9;

/** Broker bars (t = bar open, ms UTC) into X bars. */
export function toXBars(bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]): XBar[] {
  return bars.map(b => { const wall = wallOf(b.t), d = new Date(wall); return { utc: b.t, wall, mod: d.getUTCHours() * 60 + d.getUTCMinutes(), day: sessionKey(wall), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; })
    .sort((a, b) => a.utc - b.utc).filter((b, i, a) => i === 0 || b.utc !== a[i - 1].utc);
}

/** numpy's round (half to even), so prices round exactly like the research code. */
function npRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/** An order the strategy wants: live from bar i for exp more bars; stop/target distances from the fill; exit after bar `end`. */
export interface XOrder { i: number; side: 1 | -1; type: 0 | 1; px: number; exp: number; end: number; grp: number; stop: number; tgt: number; candleStart?: number }

// ---------------------------------------------------------------- PO3 order builder (po3.build + po3.orders_for)
interface Candle { o: number; h: number; l: number; c: number; i0: number; i1: number; t0: number; atr: number; ph: number; pl: number; pbull: boolean | null; ema: number; pc: number; sessOpen: number; start: number }

export function po3Orders(S: XStrategy, X: XBar[], thr = 0.1, windowH = 3): XOrder[] {
  const tick = XTICK[S.symbol], n = X.length;
  // 4h candles: 18:00, 22:00, 02:00, 06:00, 10:00, 14:00 ET, numbered in order of appearance (pd.factorize)
  const keyOf = (b: XBar) => b.day + '|' + Math.floor((((Math.floor(b.mod / 60) - 18) % 24) + 24) % 24 / 4);
  const cid = new Map<string, number>(), c4: number[] = new Array(n);
  for (let i = 0; i < n; i++) { const k = keyOf(X[i]); if (!cid.has(k)) cid.set(k, cid.size); c4[i] = cid.get(k)!; }
  const sessOpen = new Map<string, number>(); for (const b of X) if (!sessOpen.has(b.day)) sessOpen.set(b.day, b.o);
  const C: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const k = c4[i], b = X[i];
    if (!C[k]) C[k] = { o: b.o, h: b.h, l: b.l, c: b.c, i0: i, i1: i, t0: b.utc, atr: NaN, ph: NaN, pl: NaN, pbull: null, ema: NaN, pc: NaN, sessOpen: sessOpen.get(b.day)!, start: 0 };
    else { const x = C[k]; x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.i1 = i; }
  }
  let ema = NaN;
  for (let k = 0; k < C.length; k++) {
    const x = C[k];
    if (k >= 1) {
      const lo = Math.max(0, k - 14), win = C.slice(lo, k).map(y => y.h - y.l);   // rolling(14, min_periods=5).mean().shift()
      x.atr = win.length >= 5 ? win.reduce((a, v) => a + v, 0) / win.length : NaN;
      x.ph = C[k - 1].h; x.pl = C[k - 1].l; x.pbull = C[k - 1].c > C[k - 1].o; x.pc = C[k - 1].c; x.ema = ema;
    }
    ema = k === 0 ? x.c : ema + (2 / 21) * (x.c - ema);
  }
  // trigger bars: clock-aligned bins of trigMinutes (label left); a 4h candle never straddles a bin
  const tm = S.trigMinutes!, T: { start: number; startUtc: number; o: number; h: number; l: number; c: number; i: number; c4: number }[] = [];
  for (let i = 0; i < n; i++) {
    const b = X[i], start = b.wall - (b.mod % tm) * 60_000;
    const last = T[T.length - 1];
    if (last && last.start === start) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.i = i; }
    else T.push({ start, startUtc: b.utc - (b.mod % tm) * 60_000, o: b.o, h: b.h, l: b.l, c: b.c, i, c4: c4[i] });
  }
  const byCandle = new Map<number, typeof T>();
  for (const t of T) { const a = byCandle.get(t.c4); if (a) a.push(t); else byCandle.set(t.c4, [t]); }
  const rows: XOrder[] = [];
  for (const k of [...byCandle.keys()].sort((a, b) => a - b)) {
    const g = byCandle.get(k)!, cd = C[k];
    if (!(cd.atr > 0)) continue;
    const t0wall = wallOf(cd.t0), cutUtc = cd.t0 + windowH * 3_600_000;
    let li = X.findIndex((b, j) => j >= cd.i0 && b.utc >= cutUtc); if (li < 0) li = n - 1;
    const liveEnd = li;
    for (const side of [1, -1] as const) {
      if (S.bias === '4h EMA20' && ((cd.pc > cd.ema) !== (side === 1))) continue;   // NaN compares false, as in pandas
      if (S.bias === 'vs 18:00 open' && ((cd.o > cd.sessOpen) !== (side === 1))) continue;
      const x = (v: number) => side * v;
      const H = g.map(t => side === 1 ? x(t.h) : x(t.l)), L = g.map(t => side === 1 ? x(t.l) : x(t.h)), Cl = g.map(t => x(t.c)), Op = g.map(t => x(t.o));
      const O = x(cd.o); let ext = Infinity;
      for (let m = 0; m < g.length; m++) {
        ext = Math.min(ext, L[m]);
        if (g[m].startUtc >= cutUtc) break;
        if (!(ext < O - thr * cd.atr)) continue;
        let lb = 0; for (let j = 1; j <= m; j++) if (L[j] < L[lb]) lb = j;
        if (lb === m && S.model !== 'RB') continue;
        const stopLvl = ext - tick; let px: number;
        if (S.model === 'FVG CE' && m - 2 >= lb && L[m] > H[m - 2]) px = (L[m] + H[m - 2]) / 2;
        else if (S.model === 'RB' && m > lb) {
          const rng = H[lb] - L[lb], wick = Math.min(Op[lb], Cl[lb]) - L[lb];
          if (rng > 0 && wick / rng >= 0.5 && Cl[m] > H[lb] && Cl[m - 1] <= H[lb]) px = Math.min(Op[lb], Cl[lb]); else continue;
        } else continue;
        const dist = px - stopLvl;
        if (!(2 * tick <= dist && dist <= 1.5 * cd.atr)) break;
        const prevext = (side === 1 ? x(cd.ph) : x(cd.pl)) - px;
        rows.push({ i: g[m].i + 1, side, type: 1, px: x(px), exp: Math.max(1, liveEnd - g[m].i - 1), end: cd.i1, grp: k, stop: dist,
          tgt: S.target === '3R' ? 3 * dist : 0, candleStart: t0wall });
        void prevext; break;
      }
    }
  }
  // 1-hour bars: be flat by 16:00, so the last bar a trade can be held through is 15:00 (as in the research)
  if (S.barMinutes === 60) {
    const cap = new Map<string, number>(); X.forEach((b, i) => { if (b.mod === 900) cap.set(b.day, i); });
    for (const r of rows) { const d = X[Math.min(r.i, n - 1)].day, c = cap.get(d); if (c !== undefined) r.end = Math.min(r.end, c); }
  }
  return rows.map((r, j) => ({ r, j })).sort((a, b) => a.r.i - b.r.i || a.j - b.j).map(x => x.r);
}

// ---------------------------------------------------------------- Fractal (portfolio_all.fractal_trades), daily bars
export function fractalOrders(D: XBar[], tick = XTICK.GC): (XOrder & { atr: number })[] {
  const n = D.length, c = D.map(b => b.c), h = D.map(b => b.h), l = D.map(b => b.l);
  const atr: number[] = [], e20: number[] = [], e50: number[] = [];
  for (let i = 0; i < n; i++) {
    const tr = i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i];
    atr[i] = i ? atr[i - 1] + (tr - atr[i - 1]) / 14 : tr;
    e20[i] = i ? e20[i - 1] + (2 / 21) * (c[i] - e20[i - 1]) : c[i]; e50[i] = i ? e50[i - 1] + (2 / 51) * (c[i] - e50[i - 1]) : c[i];
  }
  const sma = (arr: number[], i: number, k: number) => (i >= k - 1 ? arr.slice(i - k + 1, i + 1).reduce((a, v) => a + v, 0) / k : NaN);
  let lu = NaN, ld = NaN; const LU: number[] = [], LD: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i >= 4 && h[i - 2] > h[i - 3] && h[i - 2] > h[i - 4] && h[i - 2] > h[i - 1] && h[i - 2] > h[i]) lu = h[i - 2];
    if (i >= 4 && l[i - 2] < l[i - 3] && l[i - 2] < l[i - 4] && l[i - 2] < l[i - 1] && l[i - 2] < l[i]) ld = l[i - 2];
    LU[i] = lu; LD[i] = ld;
  }
  const out: (XOrder & { atr: number })[] = [];
  for (let i = 1; i < n; i++) {
    const reg = i >= 1 && c[i - 1] > sma(c, i - 1, 50);            // yesterday's close > its SMA50 (NaN -> false)
    const tr = e20[i] > e50[i], a100 = sma(atr, i, 100), volhi = atr[i] > a100;
    const up = c[i] > LU[i] && c[i - 1] <= LU[i - 1], dn = LD[i] > c[i] && LD[i - 1] <= c[i - 1];
    const L = up && reg && tr && !volhi, S = dn && !reg && !tr && !volhi;
    if (!(L || S) || !(atr[i] > 0)) continue;
    const risk = Math.max(0.5 * atr[i], 4 * tick);
    out.push({ i: i + 1, side: L ? 1 : -1, type: 0, px: 0, exp: 0, end: i + 1, grp: i, stop: risk, tgt: 3 * risk, atr: atr[i] });
  }
  return out;
}
/** The research's daily-bar fill for the fractal: entry at the open (+1 tick), stop first, then target, else the day's close. */
export function fractalTrades(D: XBar[], tick = XTICK.GC, fee = 2.5) {
  return fractalOrders(D, tick).filter(o => o.i < D.length).map(o => {
    const b = D[o.i], s = o.side, e = b.o + s * tick, stp = e - s * o.stop, tgt = e + s * o.tgt;
    const ex = (s === 1 ? b.l <= stp : b.h >= stp) ? (s === 1 ? Math.min(stp, b.o) : Math.max(stp, b.o)) - s * tick
      : (s === 1 ? b.h >= tgt + tick : b.l <= tgt - tick) ? tgt : b.c - s * tick;
    const pnl = s * (ex - e) * MINI.GC - 2 * fee;
    return { day: b.day, side: s, entry: e, exit: ex, stopPts: o.stop, pnl, r: pnl / (o.stop * MINI.GC) };
  });
}

// ---------------------------------------------------------------- precise fill engine (precise.run)
export interface XTrade { k: number; fb: number; eb: number; side: number; fill: number; exit: number; pnl: number; r: number; why: 'stop' | 'target' | 'flat' | 'candle close'; stopPts: number }
export interface XSimResult { trades: XTrade[]; open: (XTrade & { stopPx: number; tgtPx: number | null; order: XOrder })[]; working: { order: XOrder; k: number }[] }

export function xSimulate(X: XBar[], sym: string, orders: XOrder[], fee = 2.5): XSimResult {
  const n = X.length, tick = XTICK[sym], mult = MINI[sym];
  const dayIdx: number[] = []; { let d = -1, prev = ''; for (const b of X) { if (b.day !== prev) { d++; prev = b.day; } dayIdx.push(d); } }
  const st = orders.map(o => Math.max(npRound(o.stop / tick) * tick, 2 * tick)), tg = orders.map(o => npRound(o.tgt / tick) * tick);
  const trades: XTrade[] = [], open: XSimResult['open'] = [], working: XSimResult['working'] = [];
  let busy = -1, lastDay = -1, lastGrp = -1;
  for (let k = 0; k < orders.length; k++) {
    const o = orders[k], i0 = o.i;
    if (i0 <= busy) continue;
    if (i0 >= n) { if (o.grp !== lastGrp) working.push({ order: o, k }); continue; }      // goes live at the next bar
    if (dayIdx[i0] !== lastDay) lastDay = dayIdx[i0];
    if (o.grp >= 0 && o.grp === lastGrp) continue;
    const side = o.side; let fill = NaN, fb = -1, j = i0, ranOut = false;
    while (j <= i0 + o.exp && dayIdx[j] === dayIdx[i0] && !(X[j].mod >= LAST_ENTRY && X[j].mod < 1080)) {
      if (o.type === 0) { fill = X[j].o + side * tick; fb = j; break; }
      if (side === 1 && X[j].l <= o.px - tick) { fill = Math.min(o.px, X[j].o); fb = j; break; }
      if (side === -1 && X[j].h >= o.px + tick) { fill = Math.max(o.px, X[j].o); fb = j; break; }
      j++;
      if (j >= n) { ranOut = true; break; }
    }
    if (fb < 0) { if (ranOut && j <= i0 + o.exp) working.push({ order: o, k }); continue; }
    const risk = st[k]; let stp = fill - side * risk; const tgt = tg[k] > 0 ? fill + side * tg[k] : NaN;
    let ex = NaN, eb = -1, why: XTrade['why'] = 'flat';
    for (j = fb; j < n; j++) {
      const b = X[j];
      if (dayIdx[j] !== dayIdx[fb] || (b.mod > FLAT_AT && b.mod < 1080) || (o.end >= 0 && j > o.end)) {
        ex = X[j - 1].c - side * tick; eb = j - 1; why = o.end >= 0 && j > o.end ? 'candle close' : 'flat'; break;
      }
      if ((side === 1 && b.l <= stp) || (side === -1 && b.h >= stp)) {
        const gap = j > fb ? b.o : stp; ex = (side === 1 ? Math.min(stp, gap) : Math.max(stp, gap)) - side * tick; eb = j; why = 'stop'; break;
      }
      if (j > fb && tgt === tgt && ((side === 1 && b.h >= tgt + tick) || (side === -1 && b.l <= tgt - tick))) { ex = tgt; eb = j; why = 'target'; break; }
      if (b.mod === FLAT_AT) { ex = b.c - side * tick; eb = j; why = 'flat'; break; }
    }
    if (eb < 0) {   // still open at the last bar: this is the trade live should be in
      open.push({ k, fb, eb: -1, side, fill, exit: NaN, pnl: NaN, r: NaN, why: 'flat', stopPts: risk, stopPx: stp, tgtPx: tgt === tgt ? tgt : null, order: o });
      break;
    }
    const pnl = side * (ex - fill) * mult - 2 * fee;
    trades.push({ k, fb, eb, side, fill, exit: ex, pnl, r: pnl / (risk * mult), why, stopPts: risk });
    busy = eb; lastGrp = o.grp; void stp;
  }
  return { trades, open, working };
}

/** Orders for one strategy from its bars (5-minute / hourly bars for PO3, daily bars for the fractal). */
export function xOrders(S: XStrategy, X: XBar[]): XOrder[] { return S.kind === 'po3' ? po3Orders(S, X) : fractalOrders(X); }
