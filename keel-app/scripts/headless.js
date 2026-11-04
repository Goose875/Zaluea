// Runs Keel's K system without the window: the same Engine, RiskGuard, TopstepX adapter and K runner as the app.
// SAFETY: it only trades an account TopstepX reports as simulated (practice). It never trades a funded/live account.
// Credentials come from environment variables and are never written to disk or logs.
//   TOPSTEPX_USER, TOPSTEPX_KEY   your TopstepX login
//   ACCOUNT        part of the account name or its id (e.g. 150K), required
//   MODE           live (orders on the practice account) | paper (pretend orders)   default paper
//   RUN_MINUTES    how long to run, then flatten K positions and stop             default 120
//   RISK_USD       risk per trade                                                  default 300
//   STATE_DIR      where the K trade file goes                                     default current dir
//   CHECK_ONLY=1   connect, list accounts, print recent bars, place nothing, exit
'use strict';
const path = require('path'), fs = require('fs');
const { ProjectXBroker } = require('../dist/brokers/projectx');
const { Engine } = require('../dist/core/engine');
const { RiskGuard } = require('../dist/core/risk');
const { KLive, parseKConfig } = require('../dist/ksys/live');
const { PaperOrders } = require('../dist/ksys/paperOrders');
const { STRATEGIES, INSTRUMENTS } = require('../dist/ksys/sim');

const env = process.env, USER = env.TOPSTEPX_USER, KEY = env.TOPSTEPX_KEY;
const MODE = env.MODE === 'live' ? 'live' : 'paper', MINUTES = Number(env.RUN_MINUTES || 120), RISK = Number(env.RISK_USD || 300);
const STATE = path.join(env.STATE_DIR || process.cwd(), `k_trades_headless_${MODE}.json`);
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
if (!USER || !KEY || !env.ACCOUNT) { console.error('Set TOPSTEPX_USER, TOPSTEPX_KEY and ACCOUNT.'); process.exit(2); }

(async () => {
  // 1. find the practice account (simulated only)
  const probe = new ProjectXBroker();
  await probe.connect({ userName: USER, apiKey: KEY }).catch(e => { log('Login failed:', e.message); process.exit(1); });
  const list = (await probe.call('/api/Account/search', { onlyActiveAccounts: true })).accounts || [];
  log('Accounts on this login:');
  for (const a of list) log(`  id ${a.id}  ${a.name}  balance ${a.balance}  canTrade ${a.canTrade}  simulated ${a.simulated}`);
  const pick = list.filter(a => String(a.id) === env.ACCOUNT || String(a.name).toUpperCase().includes(env.ACCOUNT.toUpperCase()));
  if (pick.length !== 1) { log(`ACCOUNT "${env.ACCOUNT}" matches ${pick.length} accounts; it must match exactly one.`); process.exit(1); }
  const acct = pick[0];
  if (acct.simulated !== true) { log(`REFUSING: ${acct.name} is not marked simulated/practice by TopstepX. This runner only trades practice accounts.`); process.exit(1); }
  if (!acct.canTrade) { log(`${acct.name} can't trade right now.`); process.exit(1); }
  log(`Using practice account ${acct.name} (id ${acct.id}), mode ${MODE.toUpperCase()}.`);

  // 2. connect the real adapter to that account, show the latest bars of each market (bar-time check)
  const broker = new ProjectXBroker();
  await broker.connect({ userName: USER, apiKey: KEY, accountId: String(acct.id) });
  for (const sym of ['NQ', 'GC']) {
    const hb = await broker.getHistory(sym, 'hour', 5), db = await broker.getHistory(sym, 'day', 3);
    log(`${sym} last hourly bars (t = bar time, UTC):`, hb.map(b => `${new Date(b.t).toISOString().slice(0, 16)} o${b.o} c${b.c} v${b.v}`).join(' | '));
    log(`${sym} last daily bars:`, db.map(b => `${new Date(b.t).toISOString().slice(0, 16)} c${b.c}`).join(' | '));
  }
  if (env.CHECK_ONLY === '1') { await broker.disconnect(); await probe.disconnect(); log('Check only: nothing placed.'); process.exit(0); }

  // 3. engine + risk guard + K runner, exactly as the app wires them
  const limits = { maxDailyLoss: Number(env.MAX_DAILY_LOSS || 1500), maxQtyPerOrder: 10, maxOpenPositions: 2, allowedSymbols: env.ALLOW_MINIS === '1' ? ['MNQ', 'MGC', 'NQ', 'GC'] : ['MNQ', 'MGC'] };
  const guard = new RiskGuard(limits), engine = new Engine(broker, guard);
  const paper = MODE === 'paper' ? new PaperOrders(broker) : null;
  const cfg = parseKConfig({ mode: MODE, riskUsd: RISK, sizing: 'fixed', capMult: 3, pauseOn: true, flatByHour: 16, countFrom: Date.now(), allowMinis: env.ALLOW_MINIS === '1' });
  const store = { load: () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return []; } }, save: t => fs.writeFileSync(STATE, JSON.stringify(t, null, 1)) };
  const k = new KLive(cfg, { data: broker, desk: paper || broker, risk: guard, store, account: () => null, note: (m) => { log(m); engine.say(m); },
    dailyPnL: async () => (paper ? paper.realized + paper.unrealized() : broker.getDailyPnL()) });
  engine.onTick = q => { paper?.onQuote(q); };
  engine.onHalt = () => { k.stop(); k.forgetAll(); void paper?.closeAll(); };
  await engine.start([...new Set(STRATEGIES.flatMap(s => [s.symbol, INSTRUMENTS[s.symbol].micro]))]);
  log(`K system running: ${STRATEGIES.filter(s => cfg.enabled[s.id]).map(s => s.id).join(', ')} on; flat by 4 PM ET; risk $${RISK}/trade; minis ${cfg.allowMinis ? 'allowed' : 'off'}; daily loss stop $${limits.maxDailyLoss}.`);
  k.start();

  // status every 10 minutes
  const report = () => {
    const st = k.status();
    log(`status: last bar ${st.lastBarUtc ? new Date(st.lastBarUtc).toISOString().slice(0, 16) : '-'}, open K trades ${k.trades.length}${st.error ? ', problem: ' + st.error : ''}`);
    for (const s of st.strategies) if (s.live || s.pending) log(`  ${s.id}: ${s.live ? `${s.live.dir} ${s.live.qty} ${s.live.orderSym} @${s.live.entry} stop ${s.live.stop} target ${s.live.target}` : `pending ${s.pending.kind} ${s.pending.dir}`}`);
    if (paper) log(`  paper P&L ${(paper.realized + paper.unrealized()).toFixed(2)}`);
  };
  const rep = setInterval(report, 10 * 60_000);

  // 4. stop after RUN_MINUTES: close K positions, cancel their orders, leave the account flat
  setTimeout(async () => {
    clearInterval(rep); k.stop(); report();
    log('Run time is up: closing K positions and their orders.');
    for (const t of [...k.trades]) {
      for (const id of [t.stopOrder, t.targetOrder]) if (id) await (paper || broker).cancelOrder(id).catch(() => {});
      const pos = (await (paper || broker).getPositions()).find(p => p.symbol === t.orderSym);
      if (pos && pos.qty) await (paper || broker).placeOrder({ symbol: t.orderSym, side: pos.qty > 0 ? 'sell' : 'buy', qty: Math.abs(pos.qty), type: 'market' }).catch(e => log('close failed:', e.message));
    }
    k.forgetAll();
    const pnl = await broker.getDailyPnL().catch(() => null);
    log(`Done. Account P&L today (TopstepX): ${pnl === null ? 'unknown' : pnl.toFixed(2)}.`);
    await broker.disconnect(); process.exit(0);
  }, MINUTES * 60_000);
})().catch(e => { log('Stopped by error:', e.stack || e.message); process.exit(1); });
