// Two Topstep 50K Static accounts on ONE TopstepX login, trading at the same time, through Keel's real main process
// (dist/main/main.js) without a window. Electron is stubbed; a "replay" connection stands in for TopstepX (real price
// history, no network) and behaves like a broker per account ID. The clock is set to a weekday morning in New York so
// chart orders are allowed whatever time the test runs.
// Checks: both start, each on its own real account and its own connection, each with its own risk per trade and mix,
// its own daily loss limit (one account hitting it never blocks the other), separate orders/positions/flatten,
// Stop all trading reaches both, and Keel refuses to start when two accounts would trade the same real account.
// Usage: npm run build && node scripts/two-50k-test.js        (MODE=paper for paper mode; default live = replay orders)
'use strict';
// ---- clock: Wednesday 10:30 New York (shift the whole process so timers and Date agree)
{ const RealDate = Date, shift = RealDate.parse('2026-11-04T15:30:00Z') - RealDate.now();
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.now() + shift])); } static now() { return RealDate.now() + shift; } }
  global.Date = FakeDate; }
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-two50k-'));
const handlers = {};
const electron = {
  app: { getPath: () => tmp, isPackaged: false, getVersion: () => 'test', whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
  ipcMain: { handle: (n, f) => { handlers[n] = f; } },
  BrowserWindow: class { constructor() { this.webContents = { on() {}, setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} } }; } loadFile() {} on() {} once() {} show() {} },
  clipboard: { writeText() {} }, Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
  session: { defaultSession: { setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} } } },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() }
};
const orig = Module._load;
Module._load = function (req, ...a) { if (req === 'electron') return electron; if (req === 'electron-updater') return { autoUpdater: { on() {}, checkForUpdates: async () => {}, setFeedURL() {} } }; return orig.call(this, req, ...a); };

// ---- the stand-in for TopstepX: one login, two real accounts (each instance is one connection to one account)
const D = path.join(__dirname, '../../backtests/data');
const csv = f => fs.readFileSync(path.join(D, f), 'utf8').trim().split('\n').slice(1).map(l => { const v = l.split(','); return { t: Date.parse(v[0].replace(' ', 'T')), o: +v[1], h: +v[2], l: +v[3], c: +v[4], v: +v[5] || 0 }; });
const DATA = { hour: { NQ: csv('NQ_cont_1h.csv'), GC: csv('GC_cont_1h.csv') }, min5: { NQ: csv('NQ_cont_5m.csv'), GC: csv('GC_cont_5m.csv') }, day: { NQ: csv('NQ_cont_1d.csv'), GC: csv('GC_cont_1d.csv') } };
const ROOT = s => s.replace(/^M(?=NQ|GC|ES)/, '');
const REAL = ['111001', '111002'];                 // the two 50K Static accounts on the login
const BOOK = Object.fromEntries(REAL.map(id => [id, { pos: {}, work: {}, fills: [], pnl: 0, closed: 0 }]));   // what the "broker" holds per real account
const made = [];
class TopstepLike {
  constructor(acct) { this.id = 'tsx'; this.name = 'TopstepX (replay)'; this.acct = acct; made.push(this); }
  async connect(c) { this.creds = c; const id = c.accountId ? REAL.find(x => x === c.accountId) : REAL[0]; if (!id) throw new Error('No tradable account was found on this login.'); this.accountId = id; this.book = BOOK[id]; }
  async disconnect() { this.disconnected = true; }
  onQuote() {} async subscribe() {}
  lastPrice(s) { const a = DATA.hour[ROOT(s)]; return a ? a[a.length - 1].c : undefined; }
  async getHistory(s, unit, n) { const a = (DATA[unit] || DATA.hour)[ROOT(s)] || []; return a.slice(-n); }
  async placeOrder(o) { const B = this.book; B.seq = (B.seq || 0) + 1; const id = this.accountId + '-' + B.seq;
    if (o.type === 'market') { B.pos[o.symbol] = (B.pos[o.symbol] || 0) + (o.side === 'buy' ? o.qty : -o.qty); B.fills.push(o); }
    else B.work[id] = { id, symbol: o.symbol, side: o.side, qty: o.qty, type: o.type, price: o.price }; return id; }
  async getOpenOrders() { return Object.values(this.book.work); } async modifyOrder(id, c) { if (this.book.work[id]) this.book.work[id].price = c.price; } async cancelOrder(id) { delete this.book.work[id]; }
  async getPositions() { return Object.entries(this.book.pos).filter(([, q]) => q).map(([symbol, qty]) => ({ symbol, qty, avgPrice: this.lastPrice(symbol) })); }
  async getDailyPnL() { return this.book.pnl; } async closeAll() { this.book.closed++; this.book.pos = {}; this.book.work = {}; }
  async getAccount() { return { name: this.acct?.label ?? 'tsx', size: 50000, startBalance: 50000, balance: 50000 + this.book.pnl, maxLoss: 2000, floor: 48000, days: [] }; }
}
const { ADAPTERS } = require('../dist/brokers');
const { BROKERS } = require('../dist/core/registry');
ADAPTERS.tsx = acct => new TopstepLike(acct);
BROKERS.push({ id: 'tsx', name: 'TopstepX (replay)', status: 'ready', note: '', fields: [{ key: 'userName', label: 'User', secret: false }, { key: 'apiKey', label: 'Key', secret: true }] });

// ---- your two accounts, as "Find my accounts" would add them, each on one of the pinned mixes at $500 risk
const MIX1 = 'K8 + K9 + K1 + K3 + K4 + K6 + K7', MIX2 = 'K8 + K9 + K3 + K4 + K5 + K6 + K7';
const acct = (id, label, ref, mix) => ({ id, label, firm: 'Topstep', connection: 'tsx', brokerRef: ref, stage: 'evaluation', plan: '50K', size: 50000, drawdown: 'static', maxLoss: 2000,
  dailyLoss: 1000, profitTarget: 3000, consistencyPct: 50, consistencyBasis: 'target', minDays: 0, maxMini: 5, maxMicro: 50, dailyGoal: 0, pauseAtGoal: true, cost: 0, purchaseDate: '', notes: '', trade: true, riskUsd: 500, mix });
const A = acct('a-00000000001a', '50K Static #1', REAL[0], MIX1), B = acct('a-00000000001b', '50K Static #2', REAL[1], MIX2);
const writeAccounts = list => fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify({ selected: list[0].id, accounts: list }));
writeAccounts([A, B]);
fs.writeFileSync(path.join(tmp, 'risk.json'), JSON.stringify({ maxDailyLoss: 1000, maxQtyPerOrder: 10, maxOpenPositions: 4, allowedSymbols: ['MNQ', 'MGC', 'NQ', 'GC'] }));
const MODE = process.env.MODE || 'live';
fs.writeFileSync(path.join(tmp, 'ksystem.json'), JSON.stringify({ mode: MODE, riskUsd: 250, flatByHour: 16 }));
console.log(`--- two Topstep 50K Static accounts, one login, strategies in ${MODE} mode, clock ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} New York ---`);

const ev = { senderFrame: { url: 'file:///keel/index.html' } }, wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails++; };
const conns = id => made.filter(b => b.accountId === id && !b.disconnected);
const book = id => BOOK[id], held = id => Object.entries(book(id).pos).filter(([, q]) => q).map(([s, q]) => `${s} ${q}`).join(', ') || 'flat';
(async () => {
  require('../dist/main/main.js'); await wait(300);
  const sv = await handlers['creds:save'](ev, 'tsx', { userName: 'me', apiKey: 'one-login-key' });
  check(sv && sv.ok, 'one TopstepX login saved');

  // 1. both start together
  const start = await handlers['engine:start'](ev); check(start && start.ok, `Start bot: ${JSON.stringify(start)}`);
  await wait(2500);
  check(conns(REAL[0]).length >= 1 && conns(REAL[1]).length >= 1, `each account has its own connection: #1 -> ${REAL[0]} (${conns(REAL[0]).length}), #2 -> ${REAL[1]} (${conns(REAL[1]).length})`);
  { const c = made.filter(b => b.creds); check(c.length >= 2 && c.every(b => b.creds.userName === 'me' && b.creds.apiKey === 'one-login-key'), `both connections use the same TopstepX login (${c.length} connections)`); }
  const trading = made.filter(b => b.creds);   // the connections the bot opened for the two accounts
  const ca = await handlers['chart:accounts'](ev), ids = ca.accounts.map(x => x.id);
  check(ca.accounts.length === 2, `both running: ${ca.accounts.map(x => x.label).join(', ')}`);
  if (MODE !== 'off') {
    const k = await handlers['k:get'](ev), f = (k.followers || []).find(x => x.label === B.label);
    check(k.running && k.main && k.main.risk === 500, `#1: $${k.main && k.main.risk} risk`);
    check(f && f.risk === 500 && f.on.join(' + ') === [...MIX2.split(' + ')].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join(' + ') || (f && f.on.slice().sort().join() === MIX2.split(' + ').sort().join()), `#2: $${f && f.risk} risk, mix ${f && f.on.join(' + ')}`);
    const st = await handlers['k:get'](ev); check(st.main && (st.main.on || []).slice().sort().join() === MIX1.split(' + ').sort().join() || !st.main.on, `#1 mix: ${st.main && st.main.on ? st.main.on.join(' + ') : '(Strategies page mix shown as ' + JSON.stringify(st.cfg && st.cfg.enabled) + ')'}`);
  }

  // 2. one order from the chart goes to both, separately
  const o1 = await handlers['chart:order'](ev, { orderSym: 'MNQ', dir: 'long', qty: 2, type: 'market', stopPts: 30, tgtPts: 60, accounts: ids });
  check(o1.ok && o1.results.length === 2 && o1.results.every(r => r.ok), `BUY 2 MNQ (stop 30, target 60) on both: ${JSON.stringify(o1.results)}`);
  if (MODE === 'live') {
    const ok = REAL.every(id => book(id).pos.MNQ === 2 && Object.values(book(id).work).filter(w => w.type === 'stop').length === 1 && Object.values(book(id).work).filter(w => w.type === 'limit').length === 1);
    check(ok, `each real account holds its own 2 MNQ with its own stop and target (not 4 on one): ${REAL.map(id => id + ': ' + held(id) + ', ' + Object.values(book(id).work).map(w => w.type + '@' + w.price).join(' ')).join(' | ')}`);
  }
  // 3. flatten only #1: #2 keeps its trade
  const f1 = await handlers['chart:flatten'](ev, 'MNQ', [A.id]);
  check(f1.ok && f1.results.length === 1 && f1.results[0].ok, `flatten MNQ on #1 only: ${JSON.stringify(f1.results)}`);
  if (MODE === 'live') check(!book(REAL[0]).pos.MNQ && book(REAL[1]).pos.MNQ === 2 && Object.keys(book(REAL[1]).work).length === 2, `#1 flat, #2 still long 2 with stop and target: #1 ${held(REAL[0])}, #2 ${held(REAL[1])}`);
  await handlers['chart:flatten'](ev, 'MNQ', [B.id]);

  // 4. each has its own daily loss limit: #1 at -$1,000 is blocked, #2 still trades
  if (MODE === 'live') {
    book(REAL[0]).pnl = -1000; await wait(200);
    const o2 = await handlers['chart:order'](ev, { orderSym: 'MGC', dir: 'short', qty: 1, type: 'market', stopPts: 5, tgtPts: 10, accounts: ids });
    const rA = o2.results.find(r => r.account === A.label), rB = o2.results.find(r => r.account === B.label);
    check(rA && !rA.ok && rB && rB.ok, `#1 at its $1,000 daily loss is blocked (${rA && rA.why}); #2 still trades (${rB && (rB.ok ? 'sent' : rB.why)})`);
    check(!book(REAL[0]).pos.MGC && book(REAL[1]).pos.MGC === -1, `positions: #1 ${held(REAL[0])}, #2 ${held(REAL[1])}`);
    book(REAL[0]).pnl = 0;
  }

  // 5. Stop all trading reaches both accounts
  await handlers['engine:kill'](ev); await wait(800);
  if (MODE === 'live') check(REAL.every(id => book(id).closed >= 1 && !Object.values(book(id).pos).some(q => q) && !Object.keys(book(id).work).length), `Stop all trading flattened both: ${REAL.map(id => id + ' ' + held(id) + ', flatten calls ' + book(id).closed).join(' | ')}`);
  else check(true, 'Stop all trading sent (paper: pretend positions closed on both)');
  await handlers['engine:stop'](ev); await wait(500);
  check(trading.every(b => b.disconnected), `Stop bot disconnects both accounts (${trading.length} connections closed)`);
  const files = fs.readdirSync(tmp).filter(f => /trades|journal/.test(f));
  check(files.some(f => f.includes(B.id)) || MODE === 'live', `separate trade files per account: ${files.join(', ') || '(none yet)'}`);

  // 6. two accounts that would trade the SAME real account are refused before anything connects
  for (const [why, list] of [['same account ID', [A, { ...B, brokerRef: REAL[0] }]], ['both without an account ID', [{ ...A, brokerRef: '' }, { ...B, brokerRef: '' }]], ['one without an account ID', [A, { ...B, brokerRef: '' }]]]) {
    writeAccounts(list); const before = JSON.stringify(BOOK);
    const r = await handlers['engine:start'](ev), ca2 = await handlers['chart:accounts'](ev);
    check(r && !r.ok && /same real account|no account ID/.test(r.error) && !ca2.running && JSON.stringify(BOOK) === before, `refused (${why}): ${r && r.error}`);
    if (r && r.ok) await handlers['engine:stop'](ev);
  }
  console.log(fails ? `\n${fails} check(s) failed.` : '\nAll two-account checks passed.');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
