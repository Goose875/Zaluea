// Checks for: dragging a trade's stop / target / limit entry on the chart (XLive.moveBracket), the trade journal hook and
// its statistics, and the payout tracker. No network, no Electron: a fake broker and a fixed clock.
// Usage: npm run build && node scripts/journal-test.js
'use strict';
const { XLive } = require('../dist/ksys/xlive');
const { DEFAULT_KCONFIG } = require('../dist/ksys/live');
const { RiskGuard } = require('../dist/core/risk');
const { stats, pnlOf, filter, toCsv } = require('../dist/core/journal');
const { payoutStatus, parseRules, DEFAULT_RULES } = require('../dist/core/payouts');

let fails = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) fails++; };

// ---- a fake broker: market orders fill at `price`, stop / limit orders rest until cancelled or triggered by hand
function broker() {
  const b = { price: 20000, pos: {}, work: {}, seq: 0, mods: [] };
  Object.assign(b, {
    lastPrice: () => b.price,
    async placeOrder(o) { const id = 'o' + ++b.seq; if (o.type === 'market') { b.pos[o.symbol] = (b.pos[o.symbol] || 0) + (o.side === 'buy' ? o.qty : -o.qty); }
      else b.work[id] = { id, symbol: o.symbol, side: o.side, qty: o.qty, type: o.type, price: o.price }; return id; },
    async getOpenOrders() { return Object.values(b.work); },
    async modifyOrder(id, c) { if (!b.work[id]) throw new Error('no such order'); b.work[id].price = c.price; b.mods.push([id, c.price]); },
    async cancelOrder(id) { delete b.work[id]; },
    async getPositions() { return Object.entries(b.pos).filter(([, q]) => q).map(([symbol, qty]) => ({ symbol, qty, avgPrice: b.fill ?? b.price })); },
    trigger(id) { const o = b.work[id]; delete b.work[id]; b.pos[o.symbol] = (b.pos[o.symbol] || 0) + (o.side === 'buy' ? o.qty : -o.qty); }
  });
  return b;
}
// 10:00 New York on a weekday, well before any flat-by time
let clock = Date.parse('2026-11-03T15:00:00Z');
const mk = (b, records) => new XLive({ ...DEFAULT_KCONFIG, mode: 'live', flatByHour: 16, enabled: {} }, {
  data: b, desk: b, risk: new RiskGuard({ maxDailyLoss: 5000, maxContracts: 50, maxPositions: 5, allowedSymbols: ['MNQ', 'MGC', 'NQ', 'GC'], flatByHour: null }),
  dailyPnL: async () => 0, store: { load: () => ({ trades: [], done: [] }), save() {} }, note: () => {}, kHolds: () => false, now: () => clock, record: r => records.push(r)
});

(async () => {
  // ---- 1. open long, drag stop and target
  const b = broker(), rec = [], x = mk(b, rec);
  const why = await x.manualOrder({ orderSym: 'MNQ', dir: 'long', qty: 2, type: 'market', stopPts: 20, tgtPts: 40 });
  ok(why === '', `chart order accepted (${why || 'ok'})`);
  const t = x.trades[0];
  ok(t && t.state === 'open' && t.stop === 19980 && t.target === 20040, `bracket at the broker from the fill: stop ${t && t.stop}, target ${t && t.target}`);
  ok(await x.moveBracket(t.key, 'stop', 19990.1) === '' && t.stop === 19990 && b.work[t.stopOrder].price === 19990, 'stop dragged to 19990 (rounded to the tick) and modified at the broker');
  ok(/below the current price/.test(await x.moveBracket(t.key, 'stop', 20005)), 'a long stop above the price is refused (it would fill at once)');
  ok(b.work[t.stopOrder].price === 19990, 'refused drag leaves the broker stop alone');
  ok(await x.moveBracket(t.key, 'target', 20060) === '' && t.target === 20060 && b.work[t.targetOrder].price === 20060, 'target dragged to 20060');
  ok(/above the current price/.test(await x.moveBracket(t.key, 'target', 19995)), 'a long target below the price is refused');
  ok(/already filled/.test(await x.moveBracket(t.key, 'entry', 19900)), 'the entry of a filled trade cannot be dragged');
  b.price = 20010; ok(await x.moveBracket(t.key, 'stop', 20002) === '' && t.stop === 20002, 'stop moved above the entry (locks in profit) while the price is above it');

  // ---- 2. it closes at the dragged stop: the journal gets the dragged price and the P&L
  clock += 60_000; b.price = 20001; b.trigger(t.stopOrder); await x.sync();
  ok(x.trades.length === 0, 'trade closed once the stop filled');
  ok(rec.length === 1 && rec[0].how === 'stop' && rec[0].exit === 20002 && rec[0].entry === 20000 && !rec[0].approx, `journal: stop exit at 20002 (${JSON.stringify(rec[0] && { how: rec[0].how, exit: rec[0].exit })})`);
  ok(pnlOf('long', 20000, 20002, 2, 'MNQ') === 8, 'P&L: 2 MNQ x 2 points x $2 = +$8');
  ok(Object.keys(b.work).length === 0, 'the target order was cancelled');

  // ---- 3. working short limit: drag its entry, stop and target before it fills
  const b2 = broker(), rec2 = [], x2 = mk(b2, rec2);
  ok(await x2.manualOrder({ orderSym: 'MGC', dir: 'short', qty: 1, type: 'limit', price: 4010, stopPts: 5, tgtPts: 10 }) === '', 'short limit working');
  const w = x2.trades[0]; b2.price = 4000;
  ok(/above the current price/.test(await x2.moveBracket(w.key, 'entry', 3995)), 'a short limit below the price is refused');
  ok(await x2.moveBracket(w.key, 'entry', 4012.04) === '' && w.limitPx === 4012 && b2.work[w.entryOrder].price === 4012, 'limit entry dragged to 4012');
  ok(await x2.moveBracket(w.key, 'stop', 4020) === '' && Math.abs(w.stopPts - 8) < 1e-9, `stop distance re-measured from the limit: ${w.stopPts} pts`);
  ok(/must be below the entry/.test(await x2.moveBracket(w.key, 'target', 4015)), 'a short target above the entry is refused');
  ok(await x2.moveBracket(w.key, 'target', 3990) === '' && Math.abs(w.tgtPts - 22) < 1e-9, `target distance ${w.tgtPts} pts`);
  b2.fill = 4012; b2.trigger(w.entryOrder); clock += 30_000; await x2.sync();
  ok(w.state === 'open' && Math.abs(w.stop - 4020) < 1e-9 && Math.abs(w.target - 3990) < 1e-9, `filled: stop ${w.stop}, target ${w.target} from the dragged distances`);
  ok(await x2.moveBracket('nope', 'stop', 1) !== '', 'unknown trade refused');

  // ---- 4. flatten records an approximate exit at the last price
  b2.price = 4005; await x2.flattenMarket('GC');
  ok(rec2.length === 1 && rec2[0].how === 'flatten' && rec2[0].approx && rec2[0].exit === 4005, 'flatten: journal exit at the last price, marked approximate');
  ok(pnlOf('short', 4012, 4005, 1, 'MGC') === 70, 'short MGC 4012 -> 4005 = +$70');

  // ---- 5. statistics
  const T = (pnl, d, id = 'P1', acct = 'a') => ({ uid: Math.random().toString(36), account: acct, accountId: acct, mode: 'live', system: 'PO3/Fractal', id, sym: 'NQ', orderSym: 'MNQ', dir: 'long', qty: 1,
    entry: 100, exit: 100, how: 'stop', why: '', approx: false, pnl, openedAt: Date.parse(d) - 1, closedAt: Date.parse(d), note: '', tags: [] });
  const L = [T(100, '2026-11-02T15:00:00Z'), T(-50, '2026-11-02T16:00:00Z'), T(-30, '2026-11-03T15:00:00Z', 'K1'), T(200, '2026-11-03T16:00:00Z', 'K1', 'b'), T(null, '2026-11-03T17:00:00Z')];
  const S = stats(L);
  ok(S.trades === 5 && S.counted === 4 && S.wins === 2 && S.losses === 2 && S.winRate === 50, `counts: ${S.trades} trades, ${S.counted} with P&L, win rate ${S.winRate}%`);
  ok(S.net === 220 && S.profitFactor === 3.75 && S.expectancy === 55, `net ${S.net}, profit factor ${S.profitFactor}, expectancy ${S.expectancy}`);
  ok(S.maxDrawdown === 80 && S.longestLosing === 2, `max drawdown ${S.maxDrawdown}, losing streak ${S.longestLosing}`);
  ok(S.byDay.length === 2 && S.byDay[0].date === '2026-11-03' && S.byDay[0].net === 170, 'by New York day, newest first');
  ok(S.byStrategy.find(s => s.key === 'K1').net === 170, 'by strategy');
  ok(filter(L, { accountId: 'b' }).length === 1 && filter(L, { from: Date.parse('2026-11-03T00:00:00Z') }).length === 3, 'filters by account and date');
  ok(toCsv(L).split('\n').length === 7, 'CSV has a header and one row per trade');

  // ---- 6. payouts
  const R = { ...DEFAULT_RULES, winDays: 3, winDayMin: 200, maxPct: 50, maxAmount: 1000, minAmount: 125, buffer: 0, consistencyPct: 0 };
  const days = [{ date: '2026-10-27', pnl: 300 }, { date: '2026-10-28', pnl: -100 }, { date: '2026-10-29', pnl: 250 }];
  let P = payoutStatus({ rules: R, taken: [] }, days, 0, '2026-11-04', 450);
  ok(!P.eligible && P.winDays === 2 && /1 more winning day/.test(P.reasons[0]), `2 of 3 winning days: not yet (${P.reasons.join('; ')})`);
  P = payoutStatus({ rules: R, taken: [] }, days, 210, '2026-11-04', 660);
  ok(P.eligible && P.winDays === 3 && P.request === 330, `today's +$210 makes 3 days: request ${P.request} (50% of 660)`);
  P = payoutStatus({ rules: { ...R, maxAmount: 300 }, taken: [] }, days, 210, '2026-11-04', 660);
  ok(P.request === 300, 'capped at the per-payout cap');
  P = payoutStatus({ rules: R, taken: [{ date: '2026-10-28', amount: 200, note: '' }] }, days, 0, '2026-11-04', 450, 150);
  ok(P.cycleStart === '2026-10-28' && P.cycleDays === 1 && P.winDays === 1 && P.available === 250 && P.totalPaid === 200 && P.netAfterCost === 50,
    `after a payout the cycle restarts: ${P.cycleDays} day(s), available ${P.available}, paid ${P.totalPaid}, net after cost ${P.netAfterCost}`);
  P = payoutStatus({ rules: { ...R, winDays: 0, consistencyPct: 40 }, taken: [] }, [{ date: '2026-10-27', pnl: 600 }, { date: '2026-10-28', pnl: 100 }], 0, '2026-11-04', 700);
  ok(!P.eligible && !P.consistencyOk && /over 40%/.test(P.reasons.join()), 'consistency: best day 600 of 700 is over 40%');
  P = payoutStatus({ rules: { ...R, winDays: 0, buffer: 700 }, taken: [] }, days, 0, '2026-11-04', 450);
  ok(!P.eligible && P.available === 0, 'profit below the buffer: nothing available');
  let threw = false; try { parseRules({ ...R, maxPct: 0 }); } catch { threw = true; }
  ok(threw, 'rules are validated');

  console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
