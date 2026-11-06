// Goose Special research: six pre-chosen daily patterns on hourly NQ / GC (no parameter mining).
// Each: one trade per session at most, protective stop, time exit, $350 risk on micros, 1 tick slippage each side + fees.
// Judged on the first 70% of the data, confirmed on the last 30%.  Usage (from the repo root, after npm run build in keel-app): node backtests/goose_special_research.js keel-app backtests/data
'use strict';
const fs = require('fs'), path = require('path');
const [APP, DATA] = process.argv.slice(2);
const { parseHourly, buildSeries } = require(path.join(APP, 'dist/ksys/series'));
const { INSTRUMENTS } = require(path.join(APP, 'dist/ksys/sim'));
const { wallOf } = require(path.join(APP, 'dist/ksys/time'));
const S = {}; for (const s of ['NQ', 'GC']) S[s] = buildSeries(s, INSTRUMENTS[s].tick, parseHourly(fs.readFileSync(path.join(DATA, `${s}_cont_1h.csv`), 'utf8'), 'America/New_York'));
const PT = { NQ: 2, GC: 10 }, TK = { NQ: 0.25, GC: 0.1 }, FEE = 0.74, RISK = 350;
const wd = b => new Date(b.wall).getUTCDay();
// group bars by session (18:00 -> 17:00 next day), keyed by the evening it starts
function sessions(X) { const m = new Map(); X.bars.forEach((b, i) => { const k = new Date(b.wall - 18 * 3600e3).toISOString().slice(0, 10); if (!m.has(k)) m.set(k, []); m.get(k).push(i); }); return [...m.entries()].map(([k, idx]) => ({ k, idx })); }
// run one trade: enter at bar e's open in dir d, stop = entry -/+ stopPts, optional target, exit at close of bar x (or stop/target first; stop checked first)
function trade(sym, X, e, x, d, stopPts, tgtR) {
  const T = TK[sym], E = X.bars[e].o + d * T, R = stopPts, qty = Math.floor(RISK / (R * PT[sym])); if (qty < 1 || !(R > 0)) return null;
  const stop = E - d * R, tgt = tgtR ? E + d * tgtR * R : null;
  for (let j = e; j <= x; j++) {
    const b = X.bars[j];
    if (d > 0 ? b.l <= stop : b.h >= stop) return fin(sym, E, (d > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o)) - d * T, d, qty, R, X.bars[e].utc, 'stop');
    if (tgt !== null && (d > 0 ? b.h >= tgt + T : b.l <= tgt - T)) return fin(sym, E, tgt, d, qty, R, X.bars[e].utc, 'target');
  }
  return fin(sym, E, X.bars[x].c - d * T, d, qty, R, X.bars[e].utc, 'time');
}
const fin = (sym, E, P, d, qty, R, utc, why) => { const pnl = (P - E) * d * qty * PT[sym] - 2 * FEE * qty; return { sym, utc, d, pnl, r: pnl / (R * qty * PT[sym]), why }; };
const at = (X, idx, h) => idx.find(i => X.bars[i].hour === h);   // the bar of this session starting at wall hour h

const C = {
  'NQ overnight drift (long 18:00 -> 09:00)': () => { const X = S.NQ, out = []; for (const s of sessions(X)) { const e = at(X, s.idx, 18), x = at(X, s.idx, 8); if (e === undefined || x === undefined || x <= e) continue; const t = trade('NQ', X, e, x, 1, X.atr[e - 1], null); if (t) out.push(t); } return out; },
  'GC overnight drift (long 18:00 -> 09:00)': () => { const X = S.GC, out = []; for (const s of sessions(X)) { const e = at(X, s.idx, 18), x = at(X, s.idx, 8); if (e === undefined || x === undefined || x <= e) continue; const t = trade('GC', X, e, x, 1, X.atr[e - 1], null); if (t) out.push(t); } return out; },
  'NQ first-hour momentum (10:00 -> 16:00)': () => { const X = S.NQ, out = []; for (const s of sessions(X)) { const f = at(X, s.idx, 9), x = at(X, s.idx, 15); if (f === undefined || x === undefined || x <= f + 1) continue; const b = X.bars[f], d = Math.sign(b.c - b.o); if (!d) continue; const t = trade('NQ', X, f + 1, x, d, X.atr[f], null); if (t) out.push(t); } return out; },
  'NQ last-hour momentum (15:00 -> 16:00)': () => { const X = S.NQ, out = []; for (const s of sessions(X)) { const o = at(X, s.idx, 9), x = at(X, s.idx, 15); if (o === undefined || x === undefined) continue; const d = Math.sign(X.bars[x - 1].c - X.bars[o].o); if (!d) continue; const t = trade('NQ', X, x, x, d, X.atr[x - 1], null); if (t) out.push(t); } return out; },
  'NQ opening-range breakout (09:00 bar, 2R)': () => { const X = S.NQ, out = []; for (const s of sessions(X)) { const f = at(X, s.idx, 9), x = at(X, s.idx, 15); if (f === undefined || x === undefined) continue; const H = X.bars[f].h, L = X.bars[f].l;
      for (let j = f + 1; j < x; j++) { const c = X.bars[j].c; const d = c > H ? 1 : c < L ? -1 : 0; if (!d) continue; const t = trade('NQ', X, j + 1, x, d, d > 0 ? X.bars[j + 1].o - L : H - X.bars[j + 1].o, 2); if (t) out.push(t); break; } } return out; },
  'GC London breakout of Asia range (2R)': () => { const X = S.GC, out = []; for (const s of sessions(X)) { const a = s.idx.filter(i => { const h = X.bars[i].hour; return h >= 18 || h < 2; }), x = at(X, s.idx, 15); if (a.length < 6 || x === undefined) continue;
      const H = Math.max(...a.map(i => X.bars[i].h)), L = Math.min(...a.map(i => X.bars[i].l)), from = a[a.length - 1] + 1;
      for (let j = from; j < x && X.bars[j].hour < 11; j++) { const c = X.bars[j].c; const d = c > H ? 1 : c < L ? -1 : 0; if (!d) continue; const t = trade('GC', X, j + 1, x, d, d > 0 ? X.bars[j + 1].o - L : H - X.bars[j + 1].o, 2); if (t) out.push(t); break; } } return out; },
};
const stat = tr => { const n = tr.length, gw = tr.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), gl = -tr.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  let eq = 0, pk = 0, dd = 0; for (const t of tr) { eq += t.pnl; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); }
  return { n, win: n ? 100 * tr.filter(t => t.pnl > 0).length / n : 0, avgR: n ? tr.reduce((a, t) => a + t.r, 0) / n : 0, pf: gl ? gw / gl : 0, usd: gw - gl, dd }; };
const all = S.NQ.bars, t0 = all[0].utc, t1 = all[all.length - 1].utc, cut = t0 + 0.7 * (t1 - t0), nSess = sessions(S.NQ).length;
const f = (x, d = 2) => x.toFixed(d);
console.log(`Hourly data ${new Date(t0).toISOString().slice(0, 10)} to ${new Date(t1).toISOString().slice(0, 10)} (${nSess} sessions). Split at ${new Date(cut).toISOString().slice(0, 10)}.\n`);
console.log('pattern'.padEnd(44) + ' per-day  | first 70%: trades win%  avgR   PF     net$  | last 30%: trades win%  avgR   PF    net$  | halves +');
const res = {};
for (const [name, fn] of Object.entries(C)) {
  const tr = fn().sort((a, b) => a.utc - b.utc); res[name] = tr;
  const a = stat(tr.filter(t => t.utc < cut)), b = stat(tr.filter(t => t.utc >= cut));
  // stability: 5 equal time slices, how many positive
  let pos = 0; for (let k = 0; k < 5; k++) { const lo = t0 + k * (t1 - t0) / 5, hi = t0 + (k + 1) * (t1 - t0) / 5; if (stat(tr.filter(t => t.utc >= lo && t.utc < hi)).usd > 0) pos++; }
  console.log(`${name.padEnd(44)} ${f(tr.length / nSess).padStart(5)}    | ${String(a.n).padStart(15)} ${f(a.win, 0).padStart(4)} ${f(a.avgR).padStart(5)} ${f(a.pf).padStart(5)} ${f(a.usd, 0).padStart(8)}  | ${String(b.n).padStart(14)} ${f(b.win, 0).padStart(4)} ${f(b.avgR).padStart(5)} ${f(b.pf).padStart(5)} ${f(b.usd, 0).padStart(7)}  | ${pos}/5`);
}
void res;
