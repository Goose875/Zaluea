// Large disciplined strategy search on hourly NQ / GC (Keel's data), with a luck benchmark.
// ~650,000 variants: 8 entry families x params x direction x session x trend x volatility x stop x target x time exit.
// Splits by time: TRAIN first 50%, VALID next 20%, TEST last 30% (looked at once, at the end).
// Usage (repo root, after npm run build in keel-app): node backtests/strategy_search_hourly.js keel-app backtests/data [null]   ("null" = coin-flip directions: what luck alone looks like)
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path');

const STOPS = [0.5, 1, 1.5, 2], TGTS = [1, 1.5, 2, 3, 0], TIMES = [2, 4, 8, 99];
const EXITS = []; for (const s of STOPS) for (const g of TGTS) for (const t of TIMES) EXITS.push([s, g, t]);
const HOURS = [['all', () => true], ['asia 18-02', h => h >= 18 || h < 2], ['london 02-08', h => h >= 2 && h < 8], ['ny am 08-12', h => h >= 8 && h < 12], ['ny pm 12-15', h => h >= 12 && h < 15]];
const DIRS = ['long', 'short', 'both'], TRENDS = ['none', 'with', 'against'], VOLS = ['all', 'high', 'low'];

function prep(APP, DATA, sym) {
  const { parseHourly, buildSeries } = require(path.join(APP, 'dist/ksys/series'));
  const { INSTRUMENTS } = require(path.join(APP, 'dist/ksys/sim'));
  const X = buildSeries(sym, INSTRUMENTS[sym].tick, parseHourly(fs.readFileSync(path.join(DATA, `${sym}_cont_1h.csv`), 'utf8'), 'America/New_York'));
  const B = X.bars, n = B.length;
  const o = B.map(b => b.o), h = B.map(b => b.h), l = B.map(b => b.l), c = B.map(b => b.c), hr = B.map(b => b.hour), utc = B.map(b => b.utc), atr = [...X.atr];
  return { sym, n, o, h, l, c, hr, utc, atr, tick: INSTRUMENTS[sym].tick, pt: sym === 'NQ' ? 2 : 10 };
}

if (isMainThread) {
  const [APP, DATA, mode] = process.argv.slice(2), NULL = mode === 'null';
  const data = ['NQ', 'GC'].map(s => prep(APP, DATA, s));
  const FAMILIES = [];
  for (const N of [3, 5, 8, 12, 20, 30, 50]) FAMILIES.push(['breakout', N]);
  for (const p of [[10, 50], [20, 50], [20, 100], [20, 200], [50, 200]]) FAMILIES.push(['pullback', p]);
  for (const k of [1, 1.5, 2, 2.5]) FAMILIES.push(['reversion', k]);
  for (const t of [5, 10, 20, 30]) FAMILIES.push(['rsi', t]);
  for (const N of [4, 7]) FAMILIES.push(['nr', N]);
  for (const m of ['break', 'sweep']) FAMILIES.push(['prevday', m]);
  for (const H of [18, 3, 9]) FAMILIES.push(['openrange', H]);
  for (const N of [3, 6, 12]) FAMILIES.push(['momentum', N]);
  const jobs = []; for (let s = 0; s < 2; s++) for (let f = 0; f < FAMILIES.length; f++) jobs.push([s, f]);
  const W = 4, parts = [...Array(W)].map((_, w) => jobs.filter((_, j) => j % W === w));
  const t0 = Date.now(); let done = 0; const out = []; let tested = 0, nullMax = -Infinity;
  for (let w = 0; w < W; w++) {
    const wk = new Worker(__filename, { workerData: { data, FAMILIES, jobs: parts[w], NULL } });
    wk.on('message', m => { out.push(...m.keep); tested += m.tested; nullMax = Math.max(nullMax, m.maxT);
      if (++done === W) finish(); });
    wk.on('error', e => { console.error('worker error', e); process.exit(1); });
  }
  function finish() {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`${NULL ? 'LUCK BENCHMARK (coin-flip directions)' : 'REAL SEARCH'}: ${tested.toLocaleString()} variants tested in ${secs} s.`);
    console.log(`Best TRAIN t-stat of any variant: ${nullMax.toFixed(2)}. Variants with TRAIN t > 3 and 80+ trades: ${out.filter(x => x.tr.t > 3).length}.`);
    // stage 2: must also be positive on VALID (t >= 1, 25+ trades)
    const v = out.filter(x => x.tr.t > 3 && x.va.n >= 25 && x.va.t >= 1);
    console.log(`...of those, also good on VALID (t >= 1): ${v.length}.`);
    v.sort((a, b) => (b.tr.t + b.va.t) - (a.tr.t + a.va.t));
    const top = v.slice(0, 25);

    if (NULL) return;
    console.log('\nTop 25 (picked on TRAIN + VALID only). TEST = the last 30%, seen now for the first time:');
    console.log('sym family        param     dir   session        trend   vol   stop tgt time | TRAIN n  avgR   t   | VALID n  avgR   t  | TEST n  avgR    t   per day');
    for (const x of top) {
      const s = x.spec, f = (v, d = 2) => v.toFixed(d);
      console.log(`${s.sym}  ${String(s.fam).padEnd(13)} ${String(s.param).padEnd(9)} ${s.dir.padEnd(5)} ${s.hours.padEnd(14)} ${s.trend.padEnd(7)} ${s.vol.padEnd(5)} ${String(s.stop).padStart(4)} ${String(s.tgt || '-').padStart(3)} ${String(s.time === 99 ? 'flat' : s.time).padStart(4)} | ${String(x.tr.n).padStart(7)} ${f(x.tr.m).padStart(5)} ${f(x.tr.t, 1).padStart(4)} | ${String(x.va.n).padStart(7)} ${f(x.va.m).padStart(5)} ${f(x.va.t, 1).padStart(4)} | ${String(x.te.n).padStart(6)} ${f(x.te.m).padStart(5)} ${f(x.te.t, 1).padStart(5)}   ${f(x.perDay)}`);
    }
    const pos = top.filter(x => x.te.m > 0).length;
    console.log(`\nTEST: ${pos} of ${top.length} still positive; median TEST avgR ${(top.map(x => x.te.m).sort((a, b) => a - b)[Math.floor(top.length / 2)] || 0).toFixed(3)}.`);
  }
} else {
  const { data, FAMILIES, jobs, NULL } = workerData;
  const keep = []; let tested = 0, maxT = -Infinity;
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const [si, fi] of jobs) {
    const D = data[si], { n, o, h, l, c, hr, utc, atr, tick, pt } = D, [fam, param] = FAMILIES[fi];
    // helpers
    const ema = (N) => { const e = new Float64Array(n); const k = 2 / (N + 1); e[0] = c[0]; for (let i = 1; i < n; i++) e[i] = e[i - 1] + k * (c[i] - e[i - 1]); return e; };
    const newSess = i => i === 0 || hr[i] === 18 && utc[i] - utc[i - 1] >= 3600e3 || utc[i] - utc[i - 1] > 3 * 3600e3;
    // session index, previous session high/low/close, daily trend (session close vs EMA20 of session closes, as of the previous session)
    const sess = new Int32Array(n); let sN = 0; for (let i = 0; i < n; i++) { if (i && newSess(i)) sN++; sess[i] = sN; }
    const sH = new Float64Array(sN + 1).fill(-Infinity), sL = new Float64Array(sN + 1).fill(Infinity), sC = new Float64Array(sN + 1);
    for (let i = 0; i < n; i++) { sH[sess[i]] = Math.max(sH[sess[i]], h[i]); sL[sess[i]] = Math.min(sL[sess[i]], l[i]); sC[sess[i]] = c[i]; }
    const dE = new Float64Array(sN + 1); dE[0] = sC[0]; for (let k = 1; k <= sN; k++) dE[k] = dE[k - 1] + (2 / 21) * (sC[k] - dE[k - 1]);
    const trendAt = i => { const k = sess[i] - 1; return k < 1 ? 0 : sC[k] > dE[k] ? 1 : -1; };
    const atrS = new Float64Array(n); { let s = 0; for (let i = 0; i < n; i++) { s += atr[i]; if (i >= 100) s -= atr[i - 100]; atrS[i] = i >= 99 ? s / 100 : NaN; } }
    const volAt = i => (Number.isNaN(atrS[i]) ? 0 : atr[i] > atrS[i] ? 1 : -1);
    // exit window: last bar index a trade from entry e may use (close of the 15:00 bar, or the end of the session)
    const lastIdx = new Int32Array(n); { for (let i = n - 1; i >= 0; i--) { if (hr[i] === 15 || i === n - 1 || sess[i + 1] !== sess[i]) lastIdx[i] = i; else lastIdx[i] = lastIdx[i + 1]; } }
    // candidate signals at bar close i: list of [i, dir]
    const cand = [];
    if (fam === 'breakout') { const N = param; for (let i = N; i < n - 1; i++) { let H = -Infinity, L = Infinity; for (let j = i - N; j < i; j++) { if (h[j] > H) H = h[j]; if (l[j] < L) L = l[j]; } if (c[i] > H) cand.push([i, 1]); else if (c[i] < L) cand.push([i, -1]); } }
    if (fam === 'pullback') { const f = ema(param[0]), s = ema(param[1]); for (let i = 1; i < n - 1; i++) { if (f[i] > s[i] && l[i] <= f[i] && c[i] > f[i]) cand.push([i, 1]); else if (f[i] < s[i] && h[i] >= f[i] && c[i] < f[i]) cand.push([i, -1]); } }
    if (fam === 'reversion') { const e = ema(20); for (let i = 20; i < n - 1; i++) { if (c[i] < e[i] - param * atr[i]) cand.push([i, 1]); else if (c[i] > e[i] + param * atr[i]) cand.push([i, -1]); } }
    if (fam === 'rsi') { const N = param === 30 ? 14 : 2, lo = param === 30 ? 30 : param; let ag = 0, al = 0;
      for (let i = 1; i < n - 1; i++) { const ch = c[i] - c[i - 1], g = Math.max(ch, 0), ls = Math.max(-ch, 0); ag = (ag * (N - 1) + g) / N; al = (al * (N - 1) + ls) / N; const r = al === 0 ? 100 : 100 - 100 / (1 + ag / al); if (i < 20) continue; if (r < lo) cand.push([i, 1]); else if (r > 100 - lo) cand.push([i, -1]); } }
    if (fam === 'nr') { const N = param; for (let i = N; i < n - 1; i++) { const p = i - 1; let nr = true; for (let j = p - N + 1; j < p; j++) if (h[j] - l[j] <= h[p] - l[p]) { nr = false; break; } if (!nr) continue; if (c[i] > h[p]) cand.push([i, 1]); else if (c[i] < l[p]) cand.push([i, -1]); } }
    if (fam === 'prevday') { let used = -1; for (let i = 1; i < n - 1; i++) { const k = sess[i] - 1; if (k < 0 || used === sess[i]) continue; const PH = sH[k], PL = sL[k];
      if (param === 'break') { if (c[i] > PH) { cand.push([i, 1]); used = sess[i]; } else if (c[i] < PL) { cand.push([i, -1]); used = sess[i]; } }
      else { if (l[i] < PL && c[i] > PL) { cand.push([i, 1]); used = sess[i]; } else if (h[i] > PH && c[i] < PH) { cand.push([i, -1]); used = sess[i]; } } } }
    if (fam === 'openrange') { let orH = NaN, orL = NaN, os = -1, used = -1; for (let i = 0; i < n - 1; i++) { if (hr[i] === param) { orH = h[i]; orL = l[i]; os = sess[i]; continue; }
      if (sess[i] !== os || used === os || Number.isNaN(orH)) continue; if (c[i] > orH) { cand.push([i, 1]); used = os; } else if (c[i] < orL) { cand.push([i, -1]); used = os; } } }
    if (fam === 'momentum') { const N = param; for (let i = N; i < n - 1; i++) { const d = Math.sign(c[i] - c[i - N]); if (d) cand.push([i, d]); } }
    if (NULL) for (const x of cand) x[1] = rnd() < 0.5 ? 1 : -1;
    // outcome of every candidate for every exit (r after costs, and the bar it ends on); entry at the next bar's open
    const m = cand.length, E = EXITS.length, R = new Float32Array(m * E), END = new Int32Array(m * E), ok = new Uint8Array(m);
    const costPts = 2 * tick + 2 * 0.74 / pt;
    for (let q = 0; q < m; q++) {
      const [i, d] = cand[q], e = i + 1; if (e >= n || sess[e] !== sess[i] || hr[e] === 15 || hr[e] === 16 || hr[e] === 17 || !(atr[i] > 0)) continue; ok[q] = 1;
      const en = o[e], last = lastIdx[e];
      for (let x = 0; x < E; x++) {
        const [sm, tg, tm] = EXITS[x], dist = sm * atr[i], stop = en - d * dist, tgt = tg ? en + d * tg * dist : NaN, endBar = Math.min(last, e + tm - 1);
        let px = NaN, j = e;
        for (; j <= endBar; j++) {
          if (d > 0 ? l[j] <= stop : h[j] >= stop) { px = j > e ? (d > 0 ? Math.min(stop, o[j]) : Math.max(stop, o[j])) : stop; break; }
          if (tg && (d > 0 ? h[j] >= tgt + tick : l[j] <= tgt - tick)) { px = tgt; break; }
        }
        if (Number.isNaN(px)) { j = endBar; px = c[endBar]; }
        R[q * E + x] = ((px - en) * d - costPts) / dist; END[q * E + x] = j;
      }
    }
    // time splits
    const tA = utc[0], tB = utc[n - 1], c1 = tA + 0.5 * (tB - tA), c2 = tA + 0.7 * (tB - tA), sessions = sN + 1;
    // every filter combination x exit: one position at a time
    for (let di = 0; di < 3; di++) for (let hi = 0; hi < HOURS.length; hi++) for (let ti = 0; ti < 3; ti++) for (let vi = 0; vi < 3; vi++) {
      const sel = [];
      for (let q = 0; q < m; q++) { if (!ok[q]) continue; const [i, d] = cand[q];
        if ((di === 0 && d < 0) || (di === 1 && d > 0)) continue; if (!HOURS[hi][1](hr[i + 1])) continue;
        if (ti) { const tr = trendAt(i); if (!tr || (ti === 1 ? tr !== d : tr === d)) continue; }
        if (vi) { const v = volAt(i); if (!v || (vi === 1 ? v < 0 : v > 0)) continue; }
        sel.push(q); }
      if (sel.length < 100) { tested += E; continue; }
      for (let x = 0; x < E; x++) {
        tested++;
        const acc = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; let busy = -1;
        for (const q of sel) { const i = cand[q][0]; if (i + 1 <= busy) continue; const r = R[q * E + x]; busy = END[q * E + x];
          const k = utc[i] < c1 ? 0 : utc[i] < c2 ? 1 : 2; acc[k][0]++; acc[k][1] += r; acc[k][2] += r * r; }
        const st = a => { const n = a[0], mean = n ? a[1] / n : 0, sd = n > 1 ? Math.sqrt(Math.max(1e-12, (a[2] - n * mean * mean) / (n - 1))) : 1; return { n, m: mean, t: n > 1 ? mean / sd * Math.sqrt(n) : 0 }; };
        const tr = st(acc[0]); if (tr.n >= 80 && tr.t > maxT) maxT = tr.t;
        if (tr.n >= 80 && tr.t > 2.5) {
          const [sm, tg, tm] = EXITS[x];
          keep.push({ spec: { sym: D.sym, fam, param: Array.isArray(param) ? param.join('/') : param, dir: DIRS[di], hours: HOURS[hi][0], trend: TRENDS[ti], vol: VOLS[vi], stop: sm, tgt: tg, time: tm },
            tr, va: st(acc[1]), te: st(acc[2]), perDay: (acc[0][0] + acc[1][0] + acc[2][0]) / sessions });
        }
      }
    }
  }
  parentPort.postMessage({ keep, tested, maxT });
}
