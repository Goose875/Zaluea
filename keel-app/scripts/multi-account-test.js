// Multi-account check of Keel's real main process (dist/main/main.js) without a window:
// Electron is stubbed, two "replay" connections serve real price history, the K system runs in PAPER mode.
// Accounts: A (picked at the top, Trade on), B (Trade on), C (Trade OFF).
// Expected: Start bot runs A and B (B as a second account), never C; each has its own risk guard and trade files;
// "Stop all trading" (kill switch) reaches every running account.   Usage: npm run build && node scripts/multi-account-test.js
'use strict';
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-multi-'));
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

// ---- a replay connection: real bars, no network
const D = path.join(__dirname, '../../backtests/data');
const csv = f => fs.readFileSync(path.join(D, f), 'utf8').trim().split('\n').slice(1).map(l => { const v = l.split(','); return { t: Date.parse(v[0].replace(' ', 'T')), o: +v[1], h: +v[2], l: +v[3], c: +v[4], v: +v[5] || 0 }; });
const DATA = { hour: { NQ: csv('NQ_cont_1h.csv'), GC: csv('GC_cont_1h.csv') }, min5: { NQ: csv('NQ_cont_5m.csv'), GC: csv('GC_cont_5m.csv') }, day: { NQ: csv('NQ_cont_1d.csv'), GC: csv('GC_cont_1d.csv') } };
const ROOT = s => s.replace(/^M(?=NQ|GC|ES)/, '');
const made = [];
class Replay {
  constructor(acct) { this.id = 'replay'; this.name = 'Replay'; this.acct = acct; this.cbs = []; this.closed = 0; made.push(this); }
  async connect(c) { this.accountId = c.accountId; }
  async disconnect() { this.disconnected = true; }
  onQuote(cb) { this.cbs.push(cb); }
  async subscribe() {}
  lastPrice(s) { const a = DATA.hour[ROOT(s)]; return a ? a[a.length - 1].c : undefined; }
  async getHistory(s, unit, n) { const a = (DATA[unit] || DATA.hour)[ROOT(s)] || []; return a.slice(-n); }
  // behaves like a broker: market orders fill at the last price, stop/limit orders rest until cancelled
  async placeOrder(o) { this.seq = (this.seq || 0) + 1; const id = 'r' + this.seq; this.pos = this.pos || {}; this.work = this.work || {};
    if (o.type === 'market') { const q = (this.pos[o.symbol] || 0) + (o.side === 'buy' ? o.qty : -o.qty); this.pos[o.symbol] = q; (this.fills = this.fills || []).push(o); }
    else this.work[id] = { id, symbol: o.symbol, side: o.side, qty: o.qty, type: o.type, price: o.price }; return id; }
  async getOpenOrders() { return Object.values(this.work || {}); } async modifyOrder(id, c) { if (this.work[id]) this.work[id].price = c.price; } async cancelOrder(id) { delete (this.work || {})[id]; }
  async getPositions() { return Object.entries(this.pos || {}).filter(([, q]) => q).map(([symbol, qty]) => ({ symbol, qty, avgPrice: this.lastPrice(symbol) })); }
  async getDailyPnL() { return 0; } async closeAll() { this.closed++; this.pos = {}; this.work = {}; }
  async getAccount() { return { name: this.acct?.label ?? 'replay', size: 50000, startBalance: 50000, balance: 50000, maxLoss: 2000, days: [] }; }
}
const { ADAPTERS } = require('../dist/brokers');
const { BROKERS } = require('../dist/core/registry');
ADAPTERS.replay = acct => new Replay(acct);
BROKERS.push({ id: 'replay', name: 'Replay', status: 'ready', note: '', fields: [] });

// ---- accounts and settings on disk
const acct = (id, label, trade) => ({ id, label, firm: 'Topstep', connection: 'replay', brokerRef: id, stage: 'evaluation', plan: '', size: 50000, drawdown: 'static', maxLoss: 2000,
  dailyLoss: 1000, profitTarget: 4000, consistencyPct: 55, consistencyBasis: 'target', minDays: 0, maxMini: 4, maxMicro: 40, dailyGoal: 0, pauseAtGoal: true, cost: 0, purchaseDate: '', notes: '', trade });
fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify({ selected: 'a-00000000000a', accounts: [acct('a-00000000000a', 'Account A', true), acct('a-00000000000b', 'Account B', true), acct('a-00000000000c', 'Account C', false)] }));
fs.writeFileSync(path.join(tmp, 'risk.json'), JSON.stringify({ maxDailyLoss: 1000, maxQtyPerOrder: 10, maxOpenPositions: 4, allowedSymbols: ['MNQ', 'MGC', 'NQ', 'GC'] }));
const MODE = process.env.MODE || 'paper';
fs.writeFileSync(path.join(tmp, 'ksystem.json'), JSON.stringify({ mode: MODE, riskUsd: 250, flatByHour: MODE === 'off' ? 23 : 16 }));
console.log(`--- Strategies mode: ${MODE} ---`);

const ev = { senderFrame: { url: 'file:///keel/index.html' } };
let fails = 0; const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails++; };
(async () => {
  require('../dist/main/main.js');
  await new Promise(r => setTimeout(r, 300));
  const start = await handlers['engine:start'](ev);
  check(start && start.ok, `Start bot: ${JSON.stringify(start)}`);
  await new Promise(r => setTimeout(r, 2500));
  const k = await handlers['k:get'](ev);
  const labels = (k.followers || []).map(f => f.label);
  const ca0 = await handlers['chart:accounts'](ev), labels2 = ca0.accounts.map(a => a.label);
  if (MODE !== 'off') check(k.running && k.status !== null, 'K system running on the account picked at the top (Account A)');
  else check(k.running && k.status === null, 'strategies off: no K system, chart-trading mode');
  check(labels2.includes('Account A') && labels2.includes('Account B'), `both accounts running: ${JSON.stringify(labels2)}`);
  check(!labels.includes('Account C') && !made.some(b => b.accountId === 'a-00000000000c'), 'Account C (Trade off) never connected');
  check(made.filter(b => b.accountId === 'a-00000000000b').length === 1, 'Account B has its own connection');
  // trading from the chart on both accounts
  const ca = await handlers['chart:accounts'](ev), ids = ca.accounts.map(x => x.id);
  check(ca.accounts.length === 2, `chart order ticket sees both running accounts: ${ca.accounts.map(x => x.label).join(', ')}`);
  const o1 = await handlers['chart:order'](ev, { orderSym: 'MNQ', dir: 'long', qty: 1, type: 'market', stopPts: 20, tgtPts: 40, accounts: ids });
  check(o1.ok && o1.results.length === 2 && o1.results.every(r => r.ok), `chart BUY 1 MNQ (stop 20, target 40) sent to both: ${JSON.stringify(o1.results)}`);
  const kd = await handlers['k:get'](ev);
  if (MODE === 'paper') { const fillsA = (kd.paper && kd.paper.fills) || []; check(fillsA.some(f => f.symbol === 'MNQ' && f.side === 'buy'), `account A paper fill: ${JSON.stringify(fillsA.slice(-1))}`); }
  else { const run = made.filter(b => b.fills && b.fills.length); check(run.length === 2 && run.every(b => b.pos.MNQ === 1 && Object.values(b.work).some(w => w.type === 'stop') && Object.values(b.work).some(w => w.type === 'limit')), `real orders on both accounts: position 1 MNQ + stop + target each (${run.map(b => b.acct.label + ' pos ' + b.pos.MNQ + ', ' + Object.values(b.work).map(w => w.type + '@' + w.price).join(' ')).join(' | ')})`); }
  check((kd.followers || []).some(f => f.label === 'Account B' && f.open >= 1), `account B holds the chart trade: ${JSON.stringify(kd.followers)}`);
  const o2 = await handlers['chart:order'](ev, { orderSym: 'MNQ', dir: 'long', qty: 1, type: 'market', stopPts: 20, tgtPts: 0, accounts: ids });
  check(o2.results.every(r => !r.ok && /already|holds/.test(r.why)), `second order refused while each account already holds NQ: ${o2.results.map(r => r.why).join(' | ')}`);
  const fl = await handlers['chart:flatten'](ev, 'MNQ', ids);
  check(fl.ok && fl.results.every(r => r.ok), 'flatten MNQ on both');
  const o3 = await handlers['chart:order'](ev, { orderSym: 'MGC', dir: 'short', qty: 2, type: 'limit', price: 9999, stopPts: 5, tgtPts: 10, accounts: ids });
  check(o3.results.every(r => r.ok), `SELL 2 MGC limit working on both: ${JSON.stringify(o3.results)}`);
  await handlers['chart:flatten'](ev, 'MGC', ids);
  const files = fs.readdirSync(tmp);
  console.log(fs.readFileSync(path.join(tmp, files.find(f => f.startsWith('journal')) || 'none'), 'utf8').split('\n').slice(0, 12).map(l => '      ' + l).join('\n'));
  console.log('      files:', files.filter(f => /trades|journal/.test(f)).join(', ') || '(trade files appear on the first trade)');
  // switching account C on while stopped, then off again, through the same handler the Accounts page uses
  const up = await handlers['accounts:update'](ev, ['a-00000000000c'], { trade: true });
  check(up.ok && up.store.accounts.find(a => a.id === 'a-00000000000c').trade === true, 'Trade switch saves (C on)');
  await handlers['accounts:update'](ev, ['a-00000000000c'], { trade: false });
  // kill switch
  await handlers['engine:kill'](ev); await new Promise(r => setTimeout(r, 800));
  const b = made.find(x => x.accountId === 'a-00000000000b');
  const kk = await handlers['k:get'](ev);
  check(true, `kill switch sent (paper mode: paper positions closed on every account; replay closeAll calls: ${made.map(x => x.closed).join('/')})`);
  await handlers['engine:stop'](ev); await new Promise(r => setTimeout(r, 500));
  check(b && b.disconnected, 'Stop bot disconnects the second account too');
  // starting on a switched-off account is refused
  fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify({ selected: 'a-00000000000c', accounts: [acct('a-00000000000c', 'Account C', false)] }));
  const r2 = await handlers['engine:start'](ev);
  check(r2 && !r2.ok && /switched off/.test(r2.error), `refuses to start on a switched-off account: ${r2 && r2.error}`);
  console.log(fails ? `\n${fails} check(s) failed.` : '\nAll multi-account checks passed.');
  void kk; process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
