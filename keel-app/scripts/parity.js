// Runs Keel's own K1-K7 engine (compiled dist/ksys) on hourly CSVs and prints per-strategy, per-period stats
// next to the research backtest numbers (spec section 8). Usage: node scripts/parity.js NQ.csv GC.csv [out_trades.csv]
'use strict';
const fs = require('fs');
const { parseHourly, buildSeries } = require('../dist/ksys/series');
const { simulate, VALIDATION, INSTRUMENTS } = require('../dist/ksys/sim');
const { compare } = require('../dist/ksys/validate');
const { wallOf } = require('../dist/ksys/time');
const [nqFile, gcFile, outFile] = process.argv.slice(2);
// Optional exchange daily closes next to each hourly file: <same name with _1h -> _1d> (Date,Open,High,Low,Close,...)
function dailyFor(f) {
  const d = f.replace('_1h', '_1d'); if (d === f || !fs.existsSync(d)) return undefined;
  const lines = fs.readFileSync(d, 'utf8').trim().split(/\r?\n/), head = lines[0].toLowerCase().split(','), iD = 0, iC = head.indexOf('close');
  return lines.slice(1).map(l => { const v = l.split(','); return { date: v[iD].slice(0, 10), close: +v[iC] }; });
}
const series = {};
for (const [sym, f] of [['NQ', nqFile], ['GC', gcFile]]) if (f) series[sym] = buildSeries(sym, INSTRUMENTS[sym].tick, parseHourly(fs.readFileSync(f, 'utf8'), 'America/New_York'), dailyFor(f));
const res = simulate(series, VALIDATION);
const all = Object.values(series).flatMap(s => s.bars), from = Math.min(...all.map(b => b.utc)), to = Math.max(...all.map(b => b.utc));
const rows = compare(res.trades, from, to, wallOf);
const f2 = x => (x === null ? '  -  ' : x.toFixed(2).padStart(5));
console.log('id  period  | Keel: trades  win%  avgR    PF |  spec: trades win% avgR   PF | flags');
for (const r of rows) console.log(`${r.id}  ${r.period.padEnd(6)} | ${String(r.got.trades).padStart(10)} ${r.got.win.toFixed(0).padStart(5)} ${f2(r.got.avgR)} ${f2(r.got.pf)} | ${String(r.want[0]).padStart(12)} ${String(r.want[1]).padStart(4)} ${f2(r.want[2])} ${f2(r.want[3])} | ${r.flags.join('; ')}`);
if (outFile) fs.writeFileSync(outFile, 'id,dir,signal_utc,entry_utc,exit_utc,entry,exit,stop0,target,risk_pts,points,pnl,r,why,bars\n' +
  res.trades.map(t => [t.id, t.dir, t.signalUtc, t.entryUtc, t.exitUtc, t.entry, t.exit, t.stop0, t.target ?? '', t.riskPts, t.points, t.pnl, t.r, t.why, t.bars].join(',')).join('\n'));
