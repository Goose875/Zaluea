import { wallOf, utcOf, sessionKey, weekKey, hourOf } from './time';

export interface HBar { utc: number; wall: number; hour: number; sess: string; o: number; h: number; l: number; c: number; v: number }
export interface Series {
  sym: string; tick: number; bars: HBar[];
  atr: number[]; ema20: number[]; ema50: number[]; atrSma: number[]; regimeUp: boolean[]; regimeKnown: boolean[];
  vwap: number[]; band1: number[]; weekMid: number[]; poc: number[]; val: number[]; nr4: boolean[]; nr7: boolean[]; lastOfSession: boolean[];
}

/** Reads a 1-hour CSV (TradingView export or similar). Times: unix seconds/ms or ISO with offset are UTC; plain date-times use `zone`. */
export function parseHourly(text: string, zone: string): HBar[] {
  if (text.length > 60_000_000) throw new Error('That file is too big (60 MB max).');
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  const head = (lines[0] || '').toLowerCase().split(/[,;\t]/).map(h => h.trim().replace(/"/g, ''));
  const col = (...n: string[]) => head.findIndex(h => n.includes(h));
  const iT = col('time', 'date', 'datetime', 'timestamp'), iO = col('open'), iH = col('high'), iL = col('low'), iC = col('close'), iV = col('volume', 'vol');
  if ([iT, iO, iH, iL, iC].some(i => i < 0)) throw new Error('The file needs time, open, high, low and close columns.');
  if (iV < 0) throw new Error('The file needs a volume column. The prior-day POC and VAL are built from volume.');
  const out: HBar[] = [];
  for (const line of lines.slice(1)) {
    const v = line.split(/[,;\t]/).map(x => x.trim().replace(/"/g, ''));
    const raw = v[iT]; let utc: number;
    if (/^\d+(\.\d+)?$/.test(raw)) { utc = Number(raw); if (utc < 1e11) utc *= 1000; }
    else if (/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) utc = Date.parse(raw);
    else { const w = Date.parse(raw.replace(' ', 'T') + 'Z'); utc = utcOf(w, zone); }
    const b = { o: +v[iO], h: +v[iH], l: +v[iL], c: +v[iC], vol: +v[iV] };
    if (![utc, b.o, b.h, b.l, b.c].every(Number.isFinite) || b.h < b.l) continue;
    const wall = wallOf(utc);
    out.push({ utc, wall, hour: hourOf(wall), sess: sessionKey(wall), o: b.o, h: b.h, l: b.l, c: b.c, v: Number.isFinite(b.vol) ? b.vol : 0 });
  }
  out.sort((a, b) => a.utc - b.utc);
  const dedup = out.filter((b, i) => i === 0 || b.utc !== out[i - 1].utc);
  if (dedup.length < 200) throw new Error('Keel needs at least 200 hourly bars.');
  const gaps = dedup.slice(1, 400).map((b, i) => b.utc - dedup[i].utc).sort((a, b) => a - b);
  if (gaps[Math.floor(gaps.length / 2)] !== 3_600_000) throw new Error('These are not 1-hour bars. Export the chart at 60 minutes.');
  return dedup;
}

/** Volume profile of bars: 40 equal bins between their low and high, typical price weighted by volume, 70% value area. */
export function profile(rb: { h: number; l: number; c: number; v: number }[]): { poc: number; val: number; vah: number } | null {
  if (!rb.length) return null;
  const lo = Math.min(...rb.map(b => b.l)), hi = Math.max(...rb.map(b => b.h)), total = rb.reduce((a, b) => a + b.v, 0);
  if (!(total > 0)) return null;
  const N = 40, w = (hi - lo) / N, vol = new Array(N).fill(0);
  for (const b of rb) { const tp = (b.h + b.l + b.c) / 3; const k = w > 0 ? Math.min(N - 1, Math.max(0, Math.floor((tp - lo) / w))) : 0; vol[k] += b.v; }
  let p = 0; for (let k = 1; k < N; k++) if (vol[k] > vol[p]) p = k;   // first highest bin
  let a = p, z = p, acc = vol[p];
  while (acc < 0.7 * total && (a > 0 || z < N - 1)) {
    const up = z < N - 1 ? vol[z + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn) { z++; acc += vol[z]; } else { a--; acc += vol[a]; }   // larger neighbour, ties go up
  }
  return { poc: lo + (p + 0.5) * w, val: lo + a * w, vah: lo + (z + 1) * w };
}

/** Every indicator and level from spec section 2, per bar. NaN comparisons behave like pandas (false). */
export function buildSeries(sym: string, tick: number, bars: HBar[]): Series {
  const n = bars.length, NaNs = () => new Array(n).fill(NaN);
  const atr = NaNs(), ema20 = NaNs(), ema50 = NaNs(), atrSma = NaNs(), vwap = NaNs(), band1 = NaNs(), weekMid = NaNs(), poc = NaNs(), val = NaNs();
  const regimeUp = new Array(n).fill(false), regimeKnown = new Array(n).fill(false), nr4 = new Array(n).fill(false), nr7 = new Array(n).fill(false), last = new Array(n).fill(false);
  const a20 = 2 / 21, a50 = 2 / 51;
  let sumAtr = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l;
    atr[i] = i === 0 ? tr : atr[i - 1] + (tr - atr[i - 1]) / 14;
    ema20[i] = i === 0 ? b.c : ema20[i - 1] + a20 * (b.c - ema20[i - 1]);
    ema50[i] = i === 0 ? b.c : ema50[i - 1] + a50 * (b.c - ema50[i - 1]);
    sumAtr += atr[i]; if (i >= 100) sumAtr -= atr[i - 100];
    if (i >= 99) atrSma[i] = sumAtr / 100;
    const rng = (j: number) => bars[j].h - bars[j].l;
    if (i >= 3) nr4[i] = rng(i) === Math.min(rng(i), rng(i - 1), rng(i - 2), rng(i - 3));
    if (i >= 6) { let m = Infinity; for (let j = i - 6; j <= i; j++) m = Math.min(m, rng(j)); nr7[i] = rng(i) === m; }
  }
  // sessions
  const sessIdx: number[] = [], sessions: { key: string; from: number; to: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!sessions.length || sessions[sessions.length - 1].key !== bars[i].sess) sessions.push({ key: bars[i].sess, from: i, to: i });
    sessions[sessions.length - 1].to = i; sessIdx[i] = sessions.length - 1;
  }
  for (let i = 0; i < n; i++) last[i] = bars[i].hour === 16 || (i + 1 < n && bars[i + 1].sess !== bars[i].sess);
  // daily regime: yesterday's daily close > SMA50 of daily closes
  const dClose = sessions.map(s => bars[s.to].c), sma50 = dClose.map((_, k) => (k >= 49 ? dClose.slice(k - 49, k + 1).reduce((x, y) => x + y, 0) / 50 : NaN));
  // session VWAP and expanding sample sigma of (close - vwap)
  for (const s of sessions) {
    let pv = 0, vv = 0, cnt = 0, mean = 0, m2 = 0;
    for (let i = s.from; i <= s.to; i++) {
      const b = bars[i]; pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v;
      vwap[i] = vv > 0 ? pv / vv : NaN;
      const d = b.c - vwap[i];
      if (Number.isFinite(d)) { cnt++; const dl = d - mean; mean += dl / cnt; m2 += dl * (d - mean); }
      const sig = cnt >= 3 ? Math.sqrt(m2 / (cnt - 1)) : NaN;
      band1[i] = vwap[i] + sig;
    }
  }
  // prior-week midpoint
  const weeks = new Map<string, { hi: number; lo: number }>(), order: string[] = [];
  for (const b of bars) { const k = weekKey(b.sess); const w = weeks.get(k); if (!w) { weeks.set(k, { hi: b.h, lo: b.l }); order.push(k); } else { w.hi = Math.max(w.hi, b.h); w.lo = Math.min(w.lo, b.l); } }
  const prevWeek = new Map<string, number>();
  order.forEach((k, j) => { if (j > 0) { const w = weeks.get(order[j - 1])!; prevWeek.set(k, (w.hi + w.lo) / 2); } });
  // prior-day POC / VAL from the previous Globex day's 10:00-15:00 bars
  const prof: ({ poc: number; val: number } | null)[] = sessions.map(s => profile(bars.slice(s.from, s.to + 1).filter(b => b.hour >= 10 && b.hour <= 15)));
  for (let i = 0; i < n; i++) {
    const k = sessIdx[i];
    if (k >= 1) { regimeKnown[i] = Number.isFinite(sma50[k - 1]); regimeUp[i] = dClose[k - 1] > sma50[k - 1]; }
    weekMid[i] = prevWeek.get(weekKey(bars[i].sess)) ?? NaN;
    for (let j = k - 1; j >= 0; j--) if (prof[j]) { poc[i] = prof[j]!.poc; val[i] = prof[j]!.val; break; }
  }
  return { sym, tick, bars, atr, ema20, ema50, atrSma, regimeUp, regimeKnown, vwap, band1, weekMid, poc, val, nr4, nr7, lastOfSession: last };
}
