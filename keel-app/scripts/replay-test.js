// End-to-end test of the live K runner (dist/ksys/live) against the validated simulator.
// A replay broker serves history only up to "now" and walks quotes through each hourly bar (open, low/high, high/low, close);
// orders go through PaperOrders. The live runner's entries and exits must line up with simulate() over the same hours.
// Usage: node scripts/replay-test.js NQ_1h.csv GC_1h.csv [hours=1500] [notes_out.txt]
'use strict';
const fs = require('fs');
const { parseHourly, buildSeries } = require('../dist/ksys/series');
const { simulate, STRATEGIES, INSTRUMENTS } = require('../dist/ksys/sim');
const { KLive, DEFAULT_KCONFIG } = require('../dist/ksys/live');
const { PaperOrders } = require('../dist/ksys/paperOrders');
const { RiskGuard } = require('../dist/core/risk');

const [nqF, gcF, hoursArg, notesOut] = process.argv.slice(2), HOURS = Number(hoursArg || 1500), H = 3600e3;
const load = f => parseHourly(fs.readFileSync(f, 'utf8'), 'America/New_York');
const daily = f => {
  const L = fs.readFileSync(f.replace('_1h', '_1d'), 'utf8').trim().split(/\r?\n/), c = L[0].toLowerCase().split(',').indexOf('close');
  return L.slice(1).map(l => { const v = l.split(','); return { date: v[0].slice(0, 10), close: +v[c] }; });
};
const DATA = { NQ: load(nqF), GC: load(gcF) }, DAILY = { NQ: daily(nqF), GC: daily(gcF) };
const TWIN = { MNQ: 'NQ', MGC: 'GC' };

let clock = 0; const last = {};
const replay = {
  id: 'replay', name: 'Replay', onQuote() {}, connect: async () => {}, disconnect: async () => {},
  lastPrice: s => last[TWIN[s] || s],
  async getHistory(sym, unit, count) {
    if (unit === 'day') return DAILY[sym].filter(d => Date.parse(d.date + 'T22:00:00Z') <= clock).slice(-count)
      .map(d => ({ t: Date.parse(d.date + 'T00:00:00Z'), o: d.close, h: d.close, l: d.close, c: d.close, v: 0 }));
    return DATA[sym].filter(b => b.utc + H <= clock).slice(-count).map(b => ({ t: b.utc, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  }
};
const paper = new PaperOrders(replay);
const notes = [], opened = [];
const cfg = { ...DEFAULT_KCONFIG, mode: 'paper', enabled: Object.fromEntries(STRATEGIES.map(s => [s.id, true])), pauseOn: false, riskUsd: 300, capMult: 3, flatByHour: 16 };
let saved = [];
const k = new KLive(cfg, {
  data: replay, desk: paper, risk: new RiskGuard({ maxDailyLoss: 1e9, maxQtyPerOrder: 1000, maxOpenPositions: 10, allowedSymbols: ['MNQ', 'MGC'] }),
  dailyPnL: async () => 0, account: () => null, now: () => clock,
  store: { load: () => [], save: t => { for (const x of t) if (!saved.some(y => y.id === x.id && y.entryUtc === x.entryUtc)) opened.push({ ...x }); saved = t.map(x => ({ ...x })); } },
  note: m => notes.push(`${new Date(clock).toISOString().slice(0, 16)} ${m}`)
});
const quote = (sym, p) => { last[sym] = p; paper.onQuote({ symbol: INSTRUMENTS[sym].micro, price: p, ts: clock }); };

const nq = DATA.NQ, start = nq.length - HOURS, gcBy = new Map(DATA.GC.map(b => [b.utc, b]));
const t0 = Date.now();
(async () => {
  for (let i = start; i < nq.length; i++) {
    const bar = { NQ: nq[i], GC: gcBy.get(nq[i].utc) };
    clock = nq[i].utc + 20e3;                                        // 20 s after the bar opened: the hourly run, entries at this open
    for (const s of ['NQ', 'GC']) if (bar[s]) quote(s, bar[s].o);
    k.nextCheck = 0; await k.tick();
    // continuous price path inside the bar: open -> low -> high (or open -> high -> low), about 100 steps per leg, like live ticks
    for (const s of ['NQ', 'GC']) {
      const b = bar[s]; if (!b) continue;
      let p = b.o;
      for (const target of (b.c >= b.o ? [b.l, b.h] : [b.h, b.l])) {
        const T = INSTRUMENTS[s].tick, n = Math.max(1, Math.round(Math.abs(target - p) / T / Math.max(1, Math.round(Math.abs(target - p) / T / 100))));
        for (let k = 1; k <= n; k++) quote(s, Math.round((p + (target - p) * k / n) / T) * T);
        p = target;
      }
    }
    clock = nq[i].utc + 57 * 60e3; await k.tick();                   // fill sync and the flat-by guard near the end of the hour
    for (const s of ['NQ', 'GC']) { const b = bar[s]; if (!b) continue; const last = b.c >= b.o ? b.h : b.l, T = INSTRUMENTS[s].tick, n = Math.max(1, Math.min(100, Math.round(Math.abs(b.c - last) / T)));
      for (let k = 1; k <= n; k++) quote(s, Math.round((last + (b.c - last) * k / n) / T) * T); }
    clock = nq[i].utc + 59 * 60e3; await k.tick();
  }
  const series = { NQ: buildSeries('NQ', 0.25, nq, DAILY.NQ), GC: buildSeries('GC', 0.1, DATA.GC, DAILY.GC) };
  const ref = simulate(series, { sizing: 'fixed', riskUsd: 300, divisor: 12, startEquity: 5e4, maxLoss: 2e3, netting: 'priority', capMult: 3, feePerSide: 0.75,
    enabled: cfg.enabled, flatByHour: 16, pause: { on: false, window: 30, below: -0.2, countFrom: 0, resumed: {} } });
  const from = nq[start].utc + 3 * 24 * H;   // first days: state warm-up
  const R = ref.trades.filter(t => t.entryUtc >= from), L = opened.filter(t => t.entryUtc >= from);
  const key = t => `${t.id}|${t.entryUtc}|${t.dir}`, rk = new Set(R.map(key)), lk = new Set(L.map(key));
  console.log(`replayed ${HOURS} hours in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`simulator trades: ${R.length}   live-runner trades: ${L.length}   same (strategy, entry hour, side): ${R.filter(t => lk.has(key(t))).length}`);
  console.log('only simulator:', R.filter(t => !lk.has(key(t))).map(t => `${t.id} ${new Date(t.entryUtc).toISOString().slice(0, 13)} ${t.dir}`).slice(0, 10));
  console.log('only live     :', L.filter(t => !rk.has(key(t))).map(t => `${t.id} ${new Date(t.entryUtc).toISOString().slice(0, 13)} ${t.dir}`).slice(0, 10));
  console.log(`P&L over the window: simulator $${R.reduce((a, t) => a + t.pnl, 0).toFixed(0)}   paper account (live runner) $${(paper.realized + paper.unrealized()).toFixed(0)}`);
  const warn = notes.filter(n => /could not|failed|no working stop|blocked|Check your/i.test(n));
  console.log(`warnings: ${warn.length}`); warn.slice(0, 8).forEach(n => console.log('  ' + n));
  if (notesOut) fs.writeFileSync(notesOut, notes.join('\n'));
})();
