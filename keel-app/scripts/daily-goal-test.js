// Daily profit target check of Keel's real main process (dist/main/main.js) without a window.
// Accounts: A (picked at the top, daily goal $300), B (second account, daily goal $500), C (second account, no goal).
// Each holds a chart trade. When an account's P&L for today reaches its goal, Keel must close everything on THAT account
// and stop all trading on it (chart orders refused too), while the other accounts keep their positions and keep trading.
// Live/off modes drive the broker's P&L; paper mode moves the price so the paper trades reach the goal.
// Usage: npm run build && MODE=paper|live|off node scripts/daily-goal-test.js
'use strict';
{ const RealDate = Date, shift = RealDate.parse('2026-11-04T15:30:00Z') - RealDate.now();
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.now() + shift])); } static now() { return RealDate.now() + shift; } }
  global.Date = FakeDate; }
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-goal-'));
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

const D = path.join(__dirname, '../../backtests/data');
const csv = f => fs.readFileSync(path.join(D, f), 'utf8').trim().split('\n').slice(1).map(l => { const v = l.split(','); return { t: Date.parse(v[0].replace(' ', 'T')), o: +v[1], h: +v[2], l: +v[3], c: +v[4], v: +v[5] || 0 }; });
const DATA = { hour: { NQ: csv('NQ_cont_1h.csv'), GC: csv('GC_cont_1h.csv') }, min5: { NQ: csv('NQ_cont_5m.csv'), GC: csv('GC_cont_5m.csv') }, day: { NQ: csv('NQ_cont_1d.csv'), GC: csv('GC_cont_1d.csv') } };
const ROOT = s => s.replace(/^M(?=NQ|GC|ES)/, '');
const made = [];
class Replay {
  constructor(acct) { this.id = 'replay'; this.name = 'Replay'; this.acct = acct; this.closed = 0; this.pnl = 0; this.bump = 0; this.pos = {}; this.work = {}; made.push(this); }
  async connect(c) { this.accountId = c.accountId; }
  async disconnect() { this.disconnected = true; }
  onQuote() {}
  async subscribe() {}
  lastPrice(s) { const a = DATA.hour[ROOT(s)]; return a ? a[a.length - 1].c + this.bump : undefined; }
  async getHistory(s, unit, n) { const a = (DATA[unit] || DATA.hour)[ROOT(s)] || []; return a.slice(-n); }
  async placeOrder(o) { this.seq = (this.seq || 0) + 1; const id = 'r' + this.seq;
    if (o.type === 'market') this.pos[o.symbol] = (this.pos[o.symbol] || 0) + (o.side === 'buy' ? o.qty : -o.qty);
    else this.work[id] = { id, symbol: o.symbol, side: o.side, qty: o.qty, type: o.type, price: o.price }; return id; }
  async getOpenOrders() { return Object.values(this.work); } async modifyOrder(id, c) { if (this.work[id]) this.work[id].price = c.price; } async cancelOrder(id) { delete this.work[id]; }
  async getPositions() { return Object.entries(this.pos).filter(([, q]) => q).map(([symbol, qty]) => ({ symbol, qty, avgPrice: this.lastPrice(symbol) })); }
  async getDailyPnL() { return this.pnl; } async closeAll() { this.closed++; this.pos = {}; this.work = {}; }
  async getAccount() { return { name: this.acct?.label ?? 'replay', size: 50000, startBalance: 50000, balance: 50000 + this.pnl, maxLoss: 2000, days: [] }; }
  holding() { return Object.values(this.pos).some(q => q) || Object.keys(this.work).length > 0; }
}
const { ADAPTERS } = require('../dist/brokers');
const { BROKERS } = require('../dist/core/registry');
ADAPTERS.replay = acct => new Replay(acct);
BROKERS.push({ id: 'replay', name: 'Replay', status: 'ready', note: '', fields: [] });

const acct = (id, label, dailyGoal) => ({ id, label, firm: 'Topstep', connection: 'replay', brokerRef: id, stage: 'funded', plan: '', size: 50000, drawdown: 'static', maxLoss: 2000,
  dailyLoss: 1000, profitTarget: 0, consistencyPct: 0, consistencyBasis: 'target', minDays: 0, maxMini: 4, maxMicro: 40, dailyGoal, pauseAtGoal: true, cost: 0, purchaseDate: '', notes: '', trade: true, riskUsd: 250 });
const A = 'a-00000000000a', B = 'a-00000000000b', C = 'a-00000000000c';
fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify({ selected: A, accounts: [acct(A, 'Account A', 300), acct(B, 'Account B', 500), acct(C, 'Account C', 0)] }));
fs.writeFileSync(path.join(tmp, 'risk.json'), JSON.stringify({ maxDailyLoss: 1000, maxQtyPerOrder: 10, maxOpenPositions: 4, allowedSymbols: ['MNQ', 'MGC', 'NQ', 'GC'] }));
const MODE = process.env.MODE || 'paper';
fs.writeFileSync(path.join(tmp, 'ksystem.json'), JSON.stringify({ mode: MODE, riskUsd: 250, flatByHour: MODE === 'off' ? 23 : 16 }));
console.log(`--- Strategies mode: ${MODE} ---`);

const ev = { senderFrame: { url: 'file:///keel/index.html' } };
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails++; };
const conn = id => made.filter(b => b.accountId === id && !b.disconnected).pop();   // the trading connection, not the read-only one from before Start
const fol = async label => ((await handlers['k:get'](ev)).followers || []).find(f => f.label === label);
const stats = async () => (await handlers['status'](ev)).stats;
// live/off: the broker reports the P&L; paper: the price moves (MNQ is $2 a point) so the paper trade is up that much
const reach = (id, usd) => { if (MODE === 'paper') conn(id).bump = usd / 2; else conn(id).pnl = usd; };
const holds = async (id, label) => {
  if (MODE !== 'paper') return conn(id).holding();
  if (id === A) { const p = (await handlers['k:get'](ev)).paper; return !!p && p.unrealized !== 0; }
  const f = await fol(label); return !!f && f.open > 0;
};

(async () => {
  require('../dist/main/main.js');
  await wait(300);
  const start = await handlers['engine:start'](ev);
  check(start && start.ok, `Start bot: ${JSON.stringify(start)}`);
  await wait(2500);
  const ids = (await handlers['chart:accounts'](ev)).accounts.map(x => x.id);
  check(ids.length === 3, `three accounts running: ${ids.join(', ')}`);
  const o1 = await handlers['chart:order'](ev, { orderSym: 'MNQ', dir: 'long', qty: 1, type: 'market', stopPts: 400, tgtPts: 800, accounts: ids });
  check(o1.ok && o1.results.every(r => r.ok), `chart BUY 1 MNQ on all three: ${JSON.stringify(o1.results)}`);
  check(await holds(A, 'Account A') && await holds(B, 'Account B') && await holds(C, 'Account C'), 'each account holds the trade');

  // 1) below the goal: nothing happens
  reach(B, 450); await wait(3500);
  check(!(await fol('Account B')).goalHit && await holds(B, 'Account B'), 'B at $450 of $500: still trading');

  // 2) B reaches its goal: B is closed and stopped, A and C carry on
  reach(B, 600); await wait(3500);
  const fb = await fol('Account B');
  check(fb.goalHit, 'B at $600 of $500: daily profit target reached');
  check(!(await holds(B, 'Account B')), `B is flat${MODE === 'paper' ? '' : ` (positions and orders closed at the broker: closeAll x${conn(B).closed})`}`);
  if (MODE === 'paper') check(fb.paper >= 500, `B locked in the paper profit: $${Math.round(fb.paper)}`);
  check(await holds(A, 'Account A') && await holds(C, 'Account C'), 'A and C still hold their trades');
  check(!(await stats()).paused, 'A is not stopped');
  const o2 = await handlers['chart:order'](ev, { orderSym: 'MGC', dir: 'long', qty: 1, type: 'market', stopPts: 20, tgtPts: 40, accounts: [B, C] });
  const rB = o2.results.find(r => r.account === 'Account B'), rC = o2.results.find(r => r.account === 'Account C');
  check(rB && !rB.ok && /daily profit target/.test(rB.why), `new chart order on B refused: ${rB && rB.why}`);
  check(rC && rC.ok, 'new chart order on C still goes through');

  // 3) A (the account at the top) reaches its goal: A is closed and stopped, C carries on
  reach(A, 400); await wait(3000);
  const s = await stats();
  check(s.paused && s.halted, `A at $400 of $300: stopped (paused ${s.paused}, halted ${s.halted})`);
  check(!(await holds(A, 'Account A')), `A is flat${MODE === 'paper' ? '' : ` (closeAll x${conn(A).closed})`}`);
  if (MODE === 'paper') { const p = (await handlers['k:get'](ev)).paper; check(p.realized >= 300, `A locked in the paper profit: $${Math.round(p.realized)}`); }
  check(s.events.some(e => /Daily profit target of \$300 reached .*stopped trading this account for today/.test(e.msg)), 'activity feed says why A stopped');
  const fc = await fol('Account C');
  check(!fc.goalHit && await holds(C, 'Account C'), 'C (no goal) is untouched and still holds its trades');
  if (MODE !== 'paper') check(conn(C).closed === 0, 'C was never flattened');
  const o3 = await handlers['chart:order'](ev, { orderSym: 'MGC', dir: 'short', qty: 1, type: 'market', stopPts: 20, tgtPts: 40, accounts: [A] });
  check(!o3.results[0].ok && /daily profit target/.test(o3.results[0].why), `new chart order on A refused: ${o3.results[0].why}`);
  await wait(2500);
  check(!(await holds(A, 'Account A')) && !(await holds(B, 'Account B')), 'A and B stay flat');
  check((await stats()).updated > Date.now() - 4000, 'the dashboard keeps updating after the stop');
  const journal = fs.readdirSync(tmp).find(f => f.startsWith('journal'));
  console.log((journal ? fs.readFileSync(path.join(tmp, journal), 'utf8') : '').split('\n').filter(l => /profit target/.test(l)).map(l => '      ' + l).join('\n'));

  await handlers['engine:stop'](ev); await wait(300);
  console.log(fails ? `\n${fails} check(s) failed.` : '\nAll daily-goal checks passed.');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
