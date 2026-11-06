// 20-year daily search for a DAY-TRADE edge (in at the open, out by the close; Topstep-compatible) on NQ, ES, GC.
// TRAIN 2005-2015 (pick), VALID 2016-2020 (filter), TEST 2021-2026 (seen once). Luck benchmark: same search, coin-flip
// directions, several seeds.  Usage (repo root): node backtests/strategy_search_daily20.js backtests/data [number of luck seeds]
'use strict';
const fs = require('fs'), path = require('path');
const [DATA, nullSeeds] = process.argv.slice(2);
const TICK = { NQ: 0.25, ES: 0.25, GC: 0.1 }, PT = { NQ: 2, ES: 5, GC: 10 };   // micro point values (MNQ, MES, MGC)
function load(sym) {
  const L = fs.readFileSync(path.join(DATA, `${sym}_cont_1d.csv`), 'utf8').trim().split(/\r?\n/).slice(1);
  const B = L.map(l => { const v = l.split(','); return { d: v[0].slice(0, 10), o: +v[1], h: +v[2], l: +v[3], c: +v[4] }; }).filter(b => b.h > b.l && b.o > 0 && b.c > 0);
  const n = B.length, atr = new Float64Array(n), sma = N => { const a = new Float64Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += B[i].c; if (i >= N) s -= B[i - N].c; if (i >= N - 1) a[i] = s / N; } return a; };
  for (let i = 0; i < n; i++) { const tr = i ? Math.max(B[i].h - B[i].l, Math.abs(B[i].h - B[i - 1].c), Math.abs(B[i].l - B[i - 1].c)) : B[i].h - B[i].l; atr[i] = i ? atr[i - 1] + (tr - atr[i - 1]) / 14 : tr; }
  const atrA = new Float64Array(n).fill(NaN); { let s = 0; for (let i = 0; i < n; i++) { s += atr[i]; if (i >= 100) s -= atr[i - 100]; if (i >= 99) atrA[i] = s / 100; } }
  let ag = 0, al = 0; const rsi2 = new Float64Array(n).fill(50);
  for (let i = 1; i < n; i++) { const ch = B[i].c - B[i - 1].c; ag = (ag + Math.max(ch, 0)) / 2; al = (al + Math.max(-ch, 0)) / 2; rsi2[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  return { sym, B, n, atr, atrA, s50: sma(50), s200: sma(200), rsi2 };
}
const SYMS = ['NQ', 'ES', 'GC'].map(load);
// signal families: decided with information up to the close of day i (or the open of day i+1 for gaps), traded on day i+1
const FAM = [];
for (const t of [0.1, 0.2, 0.3]) FAM.push(['IBS', t, (S, i) => { const b = S.B[i], ibs = (b.c - b.l) / (b.h - b.l); return ibs < t ? 1 : ibs > 1 - t ? -1 : 0; }]);
for (const t of [5, 10, 20]) FAM.push(['RSI2', t, (S, i) => S.rsi2[i] < t ? 1 : S.rsi2[i] > 100 - t ? -1 : 0]);
for (const N of [5, 10, 20, 55]) { FAM.push([`${N}d breakout follow`, N, (S, i) => brk(S, i, N)]); FAM.push([`${N}d breakout fade`, N, (S, i) => -brk(S, i, N)]); }
function brk(S, i, N) { if (i < N) return 0; let H = -Infinity, L = Infinity; for (let j = i - N; j < i; j++) { H = Math.max(H, S.B[j].h); L = Math.min(L, S.B[j].l); } return S.B[i].c > H ? 1 : S.B[i].c < L ? -1 : 0; }
for (const k of [0, 0.5, 1]) { FAM.push([`prev day follow >${k}ATR`, k, (S, i) => { const r = S.B[i].c - S.B[i - 1].c; return Math.abs(r) > k * S.atr[i - 1] ? Math.sign(r) : 0; }]);
  FAM.push([`prev day fade >${k}ATR`, k, (S, i) => { const r = S.B[i].c - S.B[i - 1].c; return Math.abs(r) > k * S.atr[i - 1] ? -Math.sign(r) : 0; }]); }
for (const k of [0.1, 0.25, 0.5]) { FAM.push([`gap follow >${k}ATR`, k, (S, i) => { const g = S.B[i + 1].o - S.B[i].c; return Math.abs(g) > k * S.atr[i] ? Math.sign(g) : 0; }]);
  FAM.push([`gap fade >${k}ATR`, k, (S, i) => { const g = S.B[i + 1].o - S.B[i].c; return Math.abs(g) > k * S.atr[i] ? -Math.sign(g) : 0; }]); }
FAM.push(['inside day follow', 0, (S, i) => { const a = S.B[i], p = S.B[i - 1]; return a.h < p.h && a.l > p.l ? Math.sign(a.c - a.o) : 0; }]);
FAM.push(['NR7 follow close', 0, (S, i) => { if (i < 7) return 0; const r = S.B[i].h - S.B[i].l; for (let j = i - 6; j < i; j++) if (S.B[j].h - S.B[j].l <= r) return 0; return Math.sign(S.B[i].c - S.B[i].o); }]);
for (const wd of [1, 2, 3, 4, 5]) FAM.push([`weekday ${'xMTWRF'[wd]}`, wd, (S, i) => new Date(S.B[i + 1].d + 'T12:00:00Z').getUTCDay() === wd ? 1 : 0]);
FAM.push(['turn of month', 0, (S, i) => { const d1 = S.B[i + 1].d, d2 = S.B[i + 2] ? S.B[i + 2].d : null; const day = +d1.slice(8); return (d2 && d2.slice(5, 7) !== d1.slice(5, 7)) || day <= 3 ? 1 : 0; }]);
FAM.push(['always', 0, () => 1]);
const DIRS = ['long', 'short', 'both'], TRENDS = ['none', 'up (>200d)', 'down (<200d)', 'up (>50d)', 'down (<50d)'], VOLS = ['all', 'high', 'low'];
const STOPS = [0.25, 0.5, 0.75, 1, 1.5, 0], TGTS = [0.5, 1, 2, 0];   // stop in daily ATR (0 = none, out at the close); target in R
const y = d => +d.slice(0, 4), split = d => (y(d) <= 2015 ? 0 : y(d) <= 2020 ? 1 : 2);
function search(seed) {
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  let tested = 0, maxT = -Infinity; const keep = [];
  for (const S of SYMS) {
    const { B, n, atr, atrA, s50, s200 } = S, cost = 2 * TICK[S.sym] + 2 * 0.74 / PT[S.sym];
    for (const [fname, fp, fn] of FAM) {
      const sig = new Int8Array(n);
      for (let i = 200; i < n - 2; i++) { let d = fn(S, i); if (d && seed) d = rnd() < 0.5 ? 1 : -1; sig[i] = d; }
      // outcome per (day, stop, target): enter at the next open, stop first, then target, else the close
      const E = STOPS.length * TGTS.length, R = new Float32Array(n * E);
      for (let i = 200; i < n - 2; i++) { if (!sig[i]) continue; const b = B[i + 1], d = sig[i], en = b.o, a = atr[i];
        let x = 0; for (const sm of STOPS) for (const tg of TGTS) {
          const risk = sm ? sm * a : a;   // no stop: measure in 1 ATR units
          const stop = sm ? en - d * sm * a : NaN, tgt = tg ? en + d * tg * risk : NaN;
          let px;
          if (sm && (d > 0 ? b.l <= stop : b.h >= stop)) px = stop;                          // stop first (worst case)
          else if (tg && (d > 0 ? b.h >= tgt + TICK[S.sym] : b.l <= tgt - TICK[S.sym])) px = tgt;
          else px = b.c;
          R[i * E + x++] = ((px - en) * d - cost) / risk; } }
      for (let di = 0; di < 3; di++) for (let ti = 0; ti < TRENDS.length; ti++) for (let vi = 0; vi < 3; vi++) {
        const sel = [];
        for (let i = 200; i < n - 2; i++) { const d = sig[i]; if (!d) continue; if ((di === 0 && d < 0) || (di === 1 && d > 0)) continue;
          const c = B[i].c; if (ti === 1 && !(c > s200[i])) continue; if (ti === 2 && !(c < s200[i])) continue; if (ti === 3 && !(c > s50[i])) continue; if (ti === 4 && !(c < s50[i])) continue;
          if (vi && (Number.isNaN(atrA[i]) || (vi === 1 ? atr[i] <= atrA[i] : atr[i] > atrA[i]))) continue; sel.push(i); }
        if (sel.length < 150) { tested += E; continue; }
        for (let x = 0; x < E; x++) { tested++;
          const acc = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
          for (const i of sel) { const r = R[i * E + x], k = split(B[i + 1].d); acc[k][0]++; acc[k][1] += r; acc[k][2] += r * r; }
          const st = a => { const m = a[0] ? a[1] / a[0] : 0, sd = a[0] > 1 ? Math.sqrt(Math.max(1e-12, (a[2] - a[0] * m * m) / (a[0] - 1))) : 1; return { n: a[0], m, t: a[0] > 1 ? m / sd * Math.sqrt(a[0]) : 0 }; };
          const tr = st(acc[0]); if (tr.n >= 150 && tr.t > maxT) maxT = tr.t;
          if (tr.n >= 150 && tr.t > 3) keep.push({ spec: { sym: S.sym, fam: fname, dir: DIRS[di], trend: TRENDS[ti], vol: VOLS[vi], stop: STOPS[Math.floor(x / TGTS.length)], tgt: TGTS[x % TGTS.length] },
            tr, va: st(acc[1]), te: st(acc[2]), perYear: sel.length / 21.8 }); } }
    }
  }
  return { tested, maxT, keep };
}
const f = (v, d = 2) => v.toFixed(d);
if (nullSeeds) {
  for (let k = 1; k <= +nullSeeds; k++) { const r = search(7919 * k); const v = r.keep.filter(x => x.va.n >= 50 && x.va.t >= 1.5);
    console.log(`LUCK seed ${k}: ${r.tested.toLocaleString()} tested; best TRAIN t ${f(r.maxT)}; TRAIN t>3: ${r.keep.length}; also VALID t>=1.5: ${v.length}; of those TEST t>=1.5: ${v.filter(x => x.te.t >= 1.5).length}`); }
} else {
  const r = search(0), v = r.keep.filter(x => x.va.n >= 50 && x.va.t >= 1.5).sort((a, b) => (b.tr.t + b.va.t) - (a.tr.t + a.va.t));
  console.log(`REAL: ${r.tested.toLocaleString()} tested; best TRAIN t ${f(r.maxT)}; TRAIN t>3: ${r.keep.length}; also VALID t>=1.5: ${v.length}; of those TEST t>=1.5: ${v.filter(x => x.te.t >= 1.5).length}\n`);
  console.log('sym fam                       dir   trend          vol   stop tgt | TRAIN 05-15 n avgR   t  | VALID 16-20 n avgR  t  | TEST 21-26 n  avgR   t  | /yr');
  for (const x of v.slice(0, 30)) { const s = x.spec;
    console.log(`${s.sym}  ${s.fam.padEnd(25)} ${s.dir.padEnd(5)} ${s.trend.padEnd(14)} ${s.vol.padEnd(5)} ${String(s.stop || '-').padStart(4)} ${String(s.tgt || '-').padStart(3)} | ${String(x.tr.n).padStart(12)} ${f(x.tr.m).padStart(5)} ${f(x.tr.t, 1).padStart(4)} | ${String(x.va.n).padStart(12)} ${f(x.va.m).padStart(5)} ${f(x.va.t, 1).padStart(3)} | ${String(x.te.n).padStart(11)} ${f(x.te.m).padStart(5)} ${f(x.te.t, 1).padStart(4)} | ${f(x.perYear, 0)}`); }

}
