// Checks Keel's K8 / K9 / P1-P3 engine (dist/ksys/extra) against the research trades exported by
// backtests/export_x_parity.py. Usage: node scripts/parity-x.js <backtests dir>
'use strict';
const fs = require('fs'), path = require('path');
const { XSTRATEGIES, toXBars, xOrders, xSimulate, fractalTrades } = require('../dist/ksys/extra');
const B = path.resolve(process.argv[2] || path.join(__dirname, '../../backtests'));
function bars(file) {
  const L = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/), h = L[0].split(',');
  const iO = h.indexOf('Open'), iH = h.indexOf('High'), iL = h.indexOf('Low'), iC = h.indexOf('Close'), iV = h.indexOf('Volume');
  return toXBars(L.slice(1).map(l => { const v = l.split(','); return { t: Date.parse(v[0].replace(' ', 'T')), o: +v[iO], h: +v[iH], l: +v[iL], c: +v[iC], v: iV >= 0 ? +v[iV] : 0 }; }));
}
function csv(file) {
  const L = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/), h = L[0].split(',');
  return L.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [h[i], v])));
}
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
let bad = 0;
for (const S of XSTRATEGIES) {
  const want = csv(path.join(B, 'results/parity_x', S.id + '.csv'));
  let got;
  if (S.kind === 'fractal') {
    got = fractalTrades(bars(path.join(B, 'results/parity_x/GC_daily_frame.csv'))).map(t => ({ key: t.day, pts: t.side * (t.exit - t.entry) }));
    const w = want.map(x => ({ key: x.day, pts: +x.pts }));
    const miss = w.filter(x => !got.some(g => g.key === x.key && close(g.pts, x.pts))), extra = got.filter(g => !w.some(x => x.key === g.key));
    console.log(`${S.id} ${S.name.padEnd(36)} research ${w.length}  Keel ${got.length}  mismatched ${miss.length}  extra ${extra.length}`);
    bad += miss.length + extra.length; continue;
  }
  const file = path.join(B, 'data', `${S.symbol}_cont_${S.barMinutes === 60 ? '1h' : '5m'}.csv`), X = bars(file);
  const r = xSimulate(X, S.symbol, xOrders(S, X));
  got = r.trades.map(t => ({ key: X[t.fb].utc + ':' + t.side, fill: t.fill, exit: t.exit, pnl: t.pnl }));
  const w = want.map(x => ({ key: x.fill_utc + ':' + x.side, fill: +x.fill, exit: +x.exit, pnl: +x.pnl }));
  const miss = w.filter(x => { const g = got.find(y => y.key === x.key); return !g || !close(g.fill, x.fill) || !close(g.exit, x.exit) || !close(g.pnl, x.pnl, 1e-4); });
  const extra = got.filter(g => !w.some(x => x.key === g.key));
  console.log(`${S.id} ${S.name.padEnd(36)} research ${w.length}  Keel ${got.length}  mismatched ${miss.length}  extra ${extra.length}`);
  for (const m of miss.slice(0, 3)) console.log('   research', JSON.stringify(m), ' keel', JSON.stringify(got.find(y => y.key === m.key) || null));
  for (const m of extra.slice(0, 3)) console.log('   keel only', JSON.stringify(m));
  bad += miss.length + extra.length;
}
console.log(bad ? `\n${bad} differences.` : '\nAll research trades reproduced exactly.');
process.exit(bad ? 1 : 0);
