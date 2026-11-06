// Topstep 50K Static (Labs) speed run: pass the Combine AND reach a $2,000 payout, how often within one week?
// Combine: +$4,000, $2,000 static max loss, $1,000 daily loss limit, best day <= 55% of profit.
// Funded: $2,000 max loss, $1,000 DLL; payout of $2,000 (50% of profit) needs $4,000 profit and either
//   3+ trading days with best day <= 40% of profit, or 5 days of +$150.
// Real trade sequences from every start day. Varied: strategy mix, risk per trade (per stage), daily profit cap (Keel's daily goal).
// Chosen on start days in the first 70%, checked on the last 30%.  Usage (repo root, after npm run build in keel-app): node backtests/topstep_50k_static_speedrun.js keel-app backtests/data
'use strict';
const fs = require('fs'), path = require('path');
const [APP, DATA] = process.argv.slice(2);
const { parseHourly, buildSeries } = require(path.join(APP, 'dist/ksys/series'));
const { simulate, STRATEGIES, INSTRUMENTS } = require(path.join(APP, 'dist/ksys/sim'));
const { XSTRATEGIES, toXBars, xOrders, xSimulate, fractalTrades } = require(path.join(APP, 'dist/ksys/extra'));
const { wallOf } = require(path.join(APP, 'dist/ksys/time'));
const csvBars = f => { const L = fs.readFileSync(path.join(DATA, f), 'utf8').trim().split(/\r?\n/), h = L[0].split(',');
  return L.slice(1).map(l => { const v = l.split(','); return { t: Date.parse(v[0].length === 10 ? v[0] + 'T00:00:00Z' : v[0].replace(' ', 'T')), o: +v[h.indexOf('Open')], h: +v[h.indexOf('High')], l: +v[h.indexOf('Low')], c: +v[h.indexOf('Close')], v: +v[h.indexOf('Volume')] || 0 }; }).filter(b => Number.isFinite(b.o)); };
const dayKey = t => new Date(wallOf(t) + 6 * 3600e3).toISOString().slice(0, 10);   // a session's P&L counts on the day it ends (18:00 rolls to the next day)

// ---- every strategy's trades as R-multiples, with the trading day and the time they close
const trades = [];
const series = {}; for (const s of ['NQ', 'GC']) series[s] = buildSeries(s, INSTRUMENTS[s].tick, parseHourly(fs.readFileSync(path.join(DATA, `${s}_cont_1h.csv`), 'utf8'), 'America/New_York'));
const ks = simulate(series, { sizing: 'fixed', riskUsd: 1000, divisor: 12, startEquity: 50000, maxLoss: 2000, netting: 'independent', capMult: null, feePerSide: 0.74,
  pause: { on: false, window: 30, below: -0.2, countFrom: 0, resumed: {} }, enabled: Object.fromEntries(STRATEGIES.map(s => [s.id, true])), flatByHour: 16 }).trades;
for (const t of ks) trades.push({ id: t.id, day: dayKey(t.exitUtc), at: t.exitUtc, r: t.r });
const gcH = toXBars(csvBars('GC_cont_1h.csv')), K9 = XSTRATEGIES.find(s => s.id === 'K9'), k9 = xSimulate(gcH, 'GC', xOrders(K9, gcH));
for (const t of k9.trades) { const at = gcH[t.eb].utc + 3600e3; trades.push({ id: 'K9', day: dayKey(at), at, r: t.r }); }
const first = series.NQ.bars[0].utc;
for (const t of fractalTrades(toXBars(csvBars('GC_cont_1d.csv')))) { const at = Date.parse(t.day + 'T20:00:00Z'); if (at >= first) trades.push({ id: 'K8', day: t.day, at, r: t.r }); }
trades.sort((a, b) => a.at - b.at);
const IDS = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9'];
const counts = Object.fromEntries(IDS.map(id => [id, trades.filter(t => t.id === id).length]));
// trading-day calendar (weekdays) over the shared period
const d0 = Date.parse(dayKey(first) + 'T12:00:00Z'), d1 = Date.parse(dayKey(Math.min(series.NQ.bars.at(-1).utc, series.GC.bars.at(-1).utc)) + 'T12:00:00Z'), cal = [];
for (let d = d0; d <= d1; d += 864e5) { const w = new Date(d).getUTCDay(); if (w && w !== 6) cal.push(new Date(d).toISOString().slice(0, 10)); }
const byDay = new Map(cal.map(d => [d, []])); for (const t of trades) if (byDay.has(t.day)) byDay.get(t.day).push(t);

// ---- one start day: Combine then funded, real trades in order, intraday stops on the daily loss limit / daily goal / max loss
function run(s, mask, R1, R2, cap1, cap2) {
  let stage = 1, eq = 0, best = 0, days = 0, wins150 = 0, tradedDays = 0;
  for (let k = s; k < cal.length; k++) {
    const R = stage === 1 ? R1 : R2, cap = stage === 1 ? cap1 : cap2;
    let day = 0, any = false;
    for (const t of byDay.get(cal[k])) {
      if (!(mask >> IDS.indexOf(t.id) & 1)) continue;
      day += t.r * R; any = true;
      if (day <= -1000) { day = -1000; break; }            // daily loss limit: flattened, done for the day
      if (eq + day <= -2000) return { ok: false, n: k - s + 1, stage };   // max loss
      if (cap && day >= cap) break;                         // daily goal reached: Keel closes everything and stops for the day
    }
    eq += day; if (any) tradedDays++;
    if (eq <= -2000) return { ok: false, n: k - s + 1, stage };
    best = Math.max(best, day); if (day >= 150) wins150++;
    if (stage === 1 && eq >= 4000 && best <= 0.55 * eq) { stage = 2; eq = 0; best = 0; wins150 = 0; tradedDays = 0; days = k - s + 1; continue; }
    if (stage === 2 && eq >= 4000 && ((tradedDays >= 3 && best <= 0.40 * eq) || wins150 >= 5)) return { ok: true, n: k - s + 1, pass: days };
  }
  return null;   // ran out of data
}
function score(starts, mask, R1, R2, cap1, cap2) {
  let wk = 0, two = 0, ever = 0, failed = 0, n = 0, m1 = 0, m2 = 0, dd = [];
  for (const s of starts) { const r = run(s, mask, R1, R2, cap1, cap2); if (!r) continue; n++; if (r.ok) { ever++; dd.push(r.n); if (r.n <= 5) wk++; if (r.n <= 10) two++; if (r.n <= 21) m1++; if (r.n <= 42) m2++; } else failed++; }
  dd.sort((a, b) => a - b);
  return { n, wk: wk / n, two: two / n, m1: m1 / n, m2: m2 / n, ever: ever / n, fail: failed / n, med: dd.length ? dd[Math.floor(dd.length / 2)] : null };
}
const cut = Math.floor(cal.length * 0.7), IS = [...Array(cut).keys()], OOS = [...Array(cal.length - cut).keys()].map(i => i + cut);
console.log(`Trades per strategy (${cal[0]} to ${cal[cal.length - 1]}): ${IDS.map(id => id + ' ' + counts[id]).join(', ')}`);
console.log(`${cal.length} trading days; picking on starts to ${cal[cut - 1]}, checking on starts from ${cal[cut]}.\n`);

// ---- search: every mix x risk per stage x daily caps
const RISKS = [400, 500, 600, 750, 900, 1000], CAP1 = [0, 1500, 2100], CAP2 = [0, 1000, 1550];
const res = [];
for (let mask = 1; mask < 1 << IDS.length; mask++) for (const R1 of RISKS) for (const R2 of RISKS) for (const c1 of CAP1) for (const c2 of CAP2) {
  const a = score(IS, mask, R1, R2, c1, c2); if (a.n < 100) continue; res.push({ mask, R1, R2, c1, c2, a });
}
const name = m => IDS.filter((_, i) => m >> i & 1).join("+");
const p = v => (100 * v).toFixed(0).padStart(3) + "%";
const show = (title, list) => { console.log(title); console.log("mix".padEnd(26) + " risk C/F    caps C/F   | first 70%:  1 mo  2 mo  ever  fail  med | last 30%:  1 mo  2 mo  ever  fail  med | EV/acct last 30% (2 mo)");
  for (const x of list) { const b = score(OOS, x.mask, x.R1, x.R2, x.c1, x.c2);
    console.log(name(x.mask).padEnd(26) + " " + String(x.R1).padStart(5) + "/" + String(x.R2).padEnd(5) + " " + String(x.c1 || "-").padStart(5) + "/" + String(x.c2 || "-").padEnd(5) + "| " + [x.a.m1, x.a.m2, x.a.ever, x.a.fail].map(p).join("  ").padStart(26) + String(x.a.med ?? "-").padStart(5) + " | " + [b.m1, b.m2, b.ever, b.fail].map(p).join("  ").padStart(25) + String(b.med ?? "-").padStart(5) + " | $" + (b.m2 * 1800 - 149).toFixed(0)); } console.log(""); };
// rank on the first 70% only: payout within 1 month, then 2 months
show("Best chance of a $2,000 payout within ~1 MONTH (21 trading days), picked on the first 70%:", [...res].sort((a, b) => b.a.m1 - a.a.m1 || b.a.m2 - a.a.m2).slice(0, 8));
show("Best within ~2 MONTHS (42 trading days):", [...res].sort((a, b) => b.a.m2 - a.a.m2 || a.a.fail - b.a.fail).slice(0, 8));
const def = IDS.reduce((m, id, i) => ["K1","K3","K4","K5","K6","K7"].includes(id) ? m | 1 << i : m, 0);
show("Today's default (K1+K3-K7, $350, no caps) and the same mix at other risk:", [350, 500, 750, 1000].map(R => ({ mask: def, R1: R, R2: R, c1: 0, c2: 0, a: score(IS, def, R, R, 0, 0) })));
