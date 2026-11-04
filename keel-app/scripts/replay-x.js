// End-to-end test of the PO3 live runner (dist/ksys/xlive) against the validated simulator, like replay-test.js does for K1-K7.
// A replay broker serves bars only up to "now" and walks quotes through every bar (open -> low/high -> high/low -> close);
// orders go through PaperOrders. The runner's fills must line up with xSimulate() over the same bars.
// Usage: node scripts/replay-x.js <strategy id: K9|P1|P2|P3> <bars csv> [bars to replay]
'use strict';
const fs = require('fs');
const { XSTRATEGIES, toXBars, xOrders, xSimulate } = require('../dist/ksys/extra');
const { XLive } = require('../dist/ksys/xlive');
const { DEFAULT_KCONFIG } = require('../dist/ksys/live');
const { PaperOrders } = require('../dist/ksys/paperOrders');
const { RiskGuard } = require('../dist/core/risk');

const [id, file, nArg] = process.argv.slice(2), S = XSTRATEGIES.find(s => s.id === id), MS = S.barMinutes * 60e3;
const L = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/), hd = L[0].split(',');
const raw = L.slice(1).map(l => { const v = l.split(','); return { t: Date.parse(v[0].replace(' ', 'T')), o: +v[hd.indexOf('Open')], h: +v[hd.indexOf('High')], l: +v[hd.indexOf('Low')], c: +v[hd.indexOf('Close')], v: +v[hd.indexOf('Volume')] || 0 }; });
const ALL = toXBars(raw), N = Math.min(ALL.length - 400, Number(nArg || 4000)), start = ALL.length - N;
const MICRO = { NQ: 'MNQ', GC: 'MGC' }, TICK = { NQ: 0.25, GC: 0.1 }, T = TICK[S.symbol];
let clock = 0, last;
const replay = { id: 'replay', name: 'Replay', lastPrice: () => last,
  async getHistory(sym, unit, count) { return raw.filter(b => b.t + MS <= clock).slice(-count); } };
const paper = new PaperOrders(replay), notes = [], fills = [];
const cfg = { ...DEFAULT_KCONFIG, mode: 'paper', enabled: { [id]: true }, riskUsd: 350, flatByHour: 16 };
const x = new XLive(cfg, {
  data: replay, desk: paper, risk: new RiskGuard({ maxDailyLoss: 1e9, maxQtyPerOrder: 1000, maxOpenPositions: 10, allowedSymbols: ['MNQ', 'MGC'] }),
  dailyPnL: async () => 0, now: () => clock, kHolds: () => false,
  store: { load: () => ({ trades: [], done: [] }), save: s => { for (const t of s.trades) if (t.state === 'open' && !fills.some(f => f.key === t.key)) fills.push({ key: t.key, side: t.dir, entry: t.entry, at: clock }); } },
  note: m => notes.push(`${new Date(clock).toISOString().slice(0, 16)} ${m}`)
});
const quote = p => { last = p; paper.onQuote({ symbol: MICRO[S.symbol], price: p, ts: clock }); };
const walk = (a, b) => { const n = Math.max(1, Math.min(60, Math.round(Math.abs(b - a) / T))); for (let k = 1; k <= n; k++) quote(Math.round((a + (b - a) * k / n) / T) * T); };
(async () => {
  for (let i = start; i < ALL.length; i++) {
    const b = ALL[i];
    clock = b.utc + 16e3; quote(b.o); x.lastScan = {}; await x.tick();          // scan ~15 s after the previous bar closed
    const [p1, p2] = b.c >= b.o ? [b.l, b.h] : [b.h, b.l];
    walk(b.o, p1); clock = b.utc + MS * 0.4; await x.tick();
    walk(p1, p2); clock = b.utc + MS * 0.8; await x.tick();
    walk(p2, b.c); clock = b.utc + MS - 2e3; await x.tick();
  }
  const sim = xSimulate(ALL, S.symbol, xOrders(S, ALL)), from = ALL[start].utc + 3 * 86400e3;
  const R = sim.trades.filter(t => ALL[t.fb].utc >= from).map(t => ({ at: ALL[t.fb].utc, side: t.side > 0 ? 'long' : 'short' }));
  const F = fills.filter(f => f.at >= from), near = (a, b) => Math.abs(a - b) <= MS * 1.01;
  const both = R.filter(r => F.some(f => f.side === r.side && f.at >= r.at && f.at - r.at <= MS * 1.01));
  console.log(`${id}: replayed ${N} bars. simulator trades ${R.length}, live-runner fills ${F.length}, matched ${both.length}`);
  console.log('only simulator:', R.filter(r => !both.includes(r)).slice(0, 6).map(r => new Date(r.at).toISOString().slice(0, 16) + ' ' + r.side));
  console.log('only live     :', F.filter(f => !R.some(r => f.side === r.side && f.at >= r.at && f.at - r.at <= MS * 1.01)).slice(0, 6).map(f => new Date(f.at).toISOString().slice(0, 16) + ' ' + f.side));
  console.log(`paper P&L $${(paper.realized + paper.unrealized()).toFixed(0)}; simulator P&L (1 mini) $${R.length ? sim.trades.filter(t => ALL[t.fb].utc >= from).reduce((a, t) => a + t.pnl, 0).toFixed(0) : 0}`);
  const warn = notes.filter(n => /could not|failed|no working stop|blocked|Check your|no position/i.test(n));
  console.log(`warnings: ${warn.length}`); warn.slice(0, 6).forEach(n => console.log('  ' + n)); void near;
  fs.writeFileSync(`/tmp/replay-${id}.txt`, notes.join('\n'));
})();
