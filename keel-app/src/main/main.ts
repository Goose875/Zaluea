import { app, BrowserWindow, clipboard, ipcMain, Menu, session, IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { vault } from './vault';
import { startWebhook } from './webhook';
import { Engine } from '../core/engine';
import { RiskGuard, parseRisk } from '../core/risk';
import { BROKERS } from '../core/registry';
import { ADAPTERS } from '../brokers';
import { loadRisk, saveRisk } from './settings';
import { evaluate } from '../core/goals';
import { addAccount, updateAccounts, removeAccount, selectAccount, sampleAccounts, goalsFor, BLANK, PRESETS } from '../core/accounts';
import { loadAccounts, saveAccounts } from './accountsStore';
import { addTo, updateIn, removeFrom } from '../core/strategyList';
import { checkPine } from '../pine/run';
import { BarStore } from '../core/bars';
import { parseCsv, runBacktest, samplePrices } from '../core/backtest';
import { parseStrategy } from '../strategies/rules';
import { loadStrategies, saveStrategies } from './strategies';
import { KLive, parseKConfig, OrderDesk } from '../ksys/live';
import { XLive } from '../ksys/xlive';
import { XSTRATEGIES } from '../ksys/extra';
import { PaperOrders } from '../ksys/paperOrders';
import { loadKConfig, saveKConfig, kTradeStore, xTradeStore } from './kstore';
import RANKINGS from '../ksys/rankings.json';
import { KeelAI, parseAIConfig } from './ai';
import type { EntryContext } from '../ksys/live';
import { parseHourly, buildSeries, DailyClose } from '../ksys/series';
import { simulate, VALIDATION, STRATEGIES, INSTRUMENTS } from '../ksys/sim';
import { compare, EXPECTED, stats as kStats } from '../ksys/validate';
import { wallOf } from '../ksys/time';

let engine: Engine | null = null;
let kLive: KLive | null = null;
let xLive: XLive | null = null;
let ai: KeelAI | null = null;
let aiTimer: ReturnType<typeof setInterval> | undefined;
let kBroker: any = null;
// The bot journal: every K / PO3 / Claude note with its New York time (today's notes feed the daily review and the chat).
const journal: string[] = [];
const nyStamp = (t = Date.now()) => new Date(wallOf(t)).toISOString().slice(0, 16).replace('T', ' ');
function jot(m: string) {
  const line = `${nyStamp()} ${m}`; journal.push(line); if (journal.length > 1500) journal.splice(0, journal.length - 1500);
  try { fs.appendFileSync(path.join(app.getPath('userData'), `journal_${line.slice(0, 10)}.txt`), line + '\n'); } catch { /* journal is best effort */ }
}
const todayJournal = () => { const d = nyStamp().slice(0, 10); return journal.filter(l => l.startsWith(d)); };

let kPaper: PaperOrders | null = null;
let kAcct: { equity: number; floor: number } | null = null;
let kAcctTimer: ReturnType<typeof setInterval> | undefined;
/** Data symbols the K system reads (NQ, GC) and trades (MNQ, MGC). */
const K_SYMBOLS = [...new Set(STRATEGIES.flatMap(s => [s.symbol, INSTRUMENTS[s.symbol].micro]))];
let hook: http.Server | null = null;
let activeBroker = '';
let activeAccount = '';

/**
 * Account readout while the bot is stopped: connects to the selected account read-only and checks
 * today's P&L, total P&L and balance every few seconds. It never places orders. Paused while the bot runs.
 */
type Watch = { id: string; broker: ReturnType<(typeof ADAPTERS)[string]>; timer?: ReturnType<typeof setInterval>; data: Record<string, unknown> | null; error: string };
let watch: Watch | null = null;
const bars = new BarStore();
async function seedBars(b: { getBars?: (s: string, sec: number, n: number) => Promise<any[]> }) {
  if (!b.getBars) return;
  for (const sym of loadRisk().allowedSymbols) { try { bars.seed(sym, await b.getBars(sym, 15, 960)); } catch { /* no history */ } }
}
let watchToken = 0;
function stopWatch() { if (watch) { clearInterval(watch.timer); void watch.broker.disconnect().catch(() => {}); watch = null; } watchToken++; }
async function startWatch() {
  stopWatch();
  if (engine) return;
  const token = watchToken, st = loadAccounts(conns()), acct = st.accounts.find(a => a.id === st.selected);
  if (!acct || !(acct.connection in ADAPTERS)) return;
  const def = BROKERS.find(b => b.id === acct.connection)!, creds = vault.get(`broker:${acct.connection}`);
  const w: Watch = { id: acct.id, broker: ADAPTERS[acct.connection](acct), data: null, error: '' };
  watch = w;
  w.broker.onQuote(q => bars.add(q));
  if (def.fields.length && !creds) { w.error = `Save your ${def.name} keys under Connections to see this account.`; return; }
  try {
    await w.broker.connect({ ...(creds ?? {}), ...(acct.brokerRef ? { accountId: acct.brokerRef } : {}) });
    await w.broker.subscribe?.(loadRisk().allowedSymbols).catch(() => {});
  } catch (err) { if (token === watchToken) w.error = (err as Error).message; return; }
  if (token !== watchToken) { void w.broker.disconnect(); return; }
  await seedBars(w.broker);
  const tick = async () => {
    try {
      const b = w.broker.getPnLBreakdown ? await w.broker.getPnLBreakdown() : { realized: await w.broker.getDailyPnL(), unrealized: 0, positions: await w.broker.getPositions() };
      const info = w.broker.getAccount ? await w.broker.getAccount() : null;
      w.data = { today: b.realized + b.unrealized, realized: b.realized, unrealized: b.unrealized, positions: b.positions,
        balance: info ? info.balance : null, total: info ? info.balance - info.startBalance : null, name: info?.name ?? acct.label, updated: Date.now(),
        progress: evaluate(goalsFor(acct), info, b.realized + b.unrealized), account: info ? { name: info.name, size: info.size, startBalance: info.startBalance } : null };
      w.error = '';
    } catch { w.error = "Couldn't read the account just now. Trying again."; }
  };
  await tick();
  w.timer = setInterval(() => void tick(), 3000);
  (w.timer as any).unref?.();
}

const conns = () => BROKERS.filter(b => !b.dev || !app.isPackaged).map(b => b.id);

const fromOurWindow = (e: IpcMainInvokeEvent) => e.senderFrame?.url.startsWith('file://') ?? false;
/** Every trading action checks the sign-in here in the main process, not in the UI. */
const allowed = fromOurWindow;   // personal app: no sign-in, only our own window may ask

function webhookSecret(): string {
  const existing = vault.get('webhook');
  if (existing) return existing.secret;
  const secret = crypto.randomBytes(24).toString('hex');
  vault.set('webhook', { secret });
  return secret;
}

function stopK() { clearInterval(aiTimer); kBroker = null; kLive?.stop(); kLive = null; xLive?.stop(); xLive = null; kPaper = null; clearInterval(kAcctTimer); kAcct = null; }
async function stopTrading() {
  stopK();
  await engine?.shutdown();
  engine = null;
  hook?.close();
  hook = null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1040, height: 700, minWidth: 420, backgroundColor: '#0c2233',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

/** Before any entry is sent: the news pause, then (if switched on for this mode) Claude's entry check. */
async function aiGate(ctx: EntryContext, mode: string): Promise<{ ok: boolean; reason?: string }> {
  if (!ai) return { ok: true };
  const n = ai.newsBlock();
  if (n) return { ok: false, reason: `news pause (${n})` };
  if (!ai.hasKey() || !ai.gateOn(ai.cfg.entryCheck, mode)) return { ok: true };
  try {
    const r = await ai.entryCheck({ ...ctx, nowET: nyStamp() });
    jot(`Claude entry check ${ctx.id} ${ctx.dir}: ${r.allow ? 'allowed' : 'VETOED'}. ${r.reason}`);
    return r.allow ? { ok: true } : { ok: false, reason: `Claude vetoed it: ${r.reason}` };
  } catch (err) {
    jot(`Claude entry check failed (${(err as Error).message}); ${ai.cfg.vetoOnError ? 'entry skipped' : 'entry allowed'}.`);
    return ai.cfg.vetoOnError ? { ok: false, reason: 'Claude check failed' } : { ok: true };
  }
}
const bars5 = async (sym: string, n: number) => {
  const b = kBroker?.getHistory ? await kBroker.getHistory(sym, 'min5', n) : [];
  return b.map((x: any) => ({ t: nyStamp(x.t), o: x.o, h: x.h, l: x.l, c: x.c }));
};
async function aiTick(mode: string, e: { say: (m: string) => void }) {
  if (!ai || !ai.hasKey()) return;
  const say = (m: string) => { jot(m); e.say(m); }, w = new Date(wallOf(Date.now())), m = w.getUTCHours() * 60 + w.getUTCMinutes(), date = nyStamp().slice(0, 10);
  const once = async (key: string, fn: () => Promise<void>) => { if (ai!.busy.has(key)) return; ai!.busy.add(key); try { await fn(); } catch (err) { say(`Claude: ${key} failed (${(err as Error).message}).`); } finally { ai!.busy.delete(key); } };
  // 1. Morning pre-flight from 7:30 ET (or as soon as the bot starts later in the day)
  if (ai.cfg.autoPreflight && m >= 7 * 60 + 30 && ai.state.preflight?.date !== date)
    await once('pre-flight', async () => { const p = await ai!.preflight(); say(`Claude pre-flight: ${p.events.filter(x => x.impact === 'high').map(x => `${x.time} ${x.name}`).join(', ') || 'no high-impact releases today'}.`); });
  // 2. News trade, 3-5 minutes after a high-impact release
  const ev = ai.gateOn(ai.cfg.newsTrades, mode) ? ai.dueRelease() : null;
  if (ev && xLive) await once('news trade', async () => {
    const idea = await ai!.newsIdea(ev, { NQ: await bars5('NQ', 12), GC: await bars5('GC', 12) }, xLive!['cfg'].riskUsd);
    if (!idea.trade) { say(`Claude news check (${ev.name}): no trade. ${idea.reason}`); return; }
    const lim = idea.symbol === 'NQ' ? [15, 80] : [3, 20], stop = Math.min(lim[1], Math.max(lim[0], idea.stop_points)), r = Math.min(3, Math.max(1, idea.target_r));
    const why = await xLive!.manual(idea.symbol, idea.direction, stop, stop * r, Date.now() + 60 * 60_000, idea.reason);
    if (why) say(`Claude news trade (${ev.name}) not taken: ${why}.`);
  });
  // 3. Daily review after the flat-by
  if (ai.cfg.autoReview && m >= 16 * 60 + 12 && m < 18 * 60 && ai.state.review?.date !== date) await once('daily review', async () => { await runReview(); say('Claude: the daily review is ready on the Claude page.'); });
}
async function runReview() {
  const pnl = kPaper ? `paper ${(kPaper.realized + kPaper.unrealized()).toFixed(0)} USD` : kBroker?.getDailyPnL ? `${(await kBroker.getDailyPnL()).toFixed(0)} USD today` : 'unknown';
  const acct = kAcct ? `; account equity ${kAcct.equity.toFixed(0)}, drawdown floor ${kAcct.floor.toFixed(0)}` : '';
  return ai!.review(todayJournal(), { NQ: await bars5('NQ', 300).catch(() => []), GC: await bars5('GC', 300).catch(() => []) }, pnl + acct);
}

app.whenReady().then(async () => {
  ai = new KeelAI();
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({
    responseHeaders: {
      ...d.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:"]
    }
  }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));

  // Updates: in the installed app, Keel checks GitHub for a newer version, downloads it quietly,
  // and installs it when you close Keel (or right away if you press Restart and update while the bot is stopped).
  let update: { state: 'none' | 'downloading' | 'ready' | 'error'; version: string } = { state: 'none', version: '' };
  if (app.isPackaged) {
    autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', i => { update = { state: 'downloading', version: i.version }; });
    autoUpdater.on('update-downloaded', i => { update = { state: 'ready', version: i.version }; });
    autoUpdater.on('error', () => { if (update.state !== 'ready') update = { state: 'error', version: '' }; });
    const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
    check(); setInterval(check, 4 * 3600_000).unref?.();
  }
  ipcMain.handle('update:install', e => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    if (engine) return { ok: false, error: 'Stop the bot before updating.' };
    if (update.state !== 'ready') return { ok: false, error: 'No update is ready yet.' };
    autoUpdater.quitAndInstall(); return { ok: true };
  });

  ipcMain.handle('status', e => {
    if (!fromOurWindow(e)) return null;
    return {
      running: !!engine, broker: activeBroker, account: activeAccount, update,
      watch: watch ? { account: watch.id, data: watch.data, error: watch.error } : null, stats: engine ? engine.snapshot() : null,
      webhookSecret: webhookSecret()
    };
  });

  ipcMain.handle('catalog', e => {
    if (!allowed(e)) return null;
    return { dev: !app.isPackaged, accounts: loadAccounts(conns()), blank: BLANK, strategies: loadStrategies(), brokers: BROKERS.filter(b => !b.dev || !app.isPackaged), presets: PRESETS, version: app.getVersion(), saved: BROKERS.filter(b => vault.has(`broker:${b.id}`)).map(b => b.id), risk: loadRisk() };
  });

  // Keys can be saved or removed from the window, but there is no call that returns them.
  ipcMain.handle('creds:save', (e, brokerId: string, creds: Record<string, unknown>) => {
    const def = BROKERS.find(b => b.id === brokerId);
    if (!allowed(e) || !def || !def.fields.length || !creds || typeof creds !== 'object') return { ok: false, error: 'Not allowed.' };
    const clean: Record<string, string> = {};
    for (const f of def.fields) {
      const v = creds[f.key];
      if (typeof v !== 'string' || !v.trim() || v.length > 200) return { ok: false, error: 'Fill in every field.' };
      clean[f.key] = v.trim();
    }
    vault.set(`broker:${brokerId}`, clean);
    void startWatch();
    return { ok: true };
  });
  ipcMain.handle('creds:remove', (e, brokerId: string) => {
    if (allowed(e) && BROKERS.some(b => b.id === brokerId)) vault.remove(`broker:${brokerId}`);
  });

  // Accounts: saved as soon as they change. Rules for the running account apply right away.
  const commitAccounts = (fn: (st: ReturnType<typeof loadAccounts>) => ReturnType<typeof loadAccounts>) => {
    try {
      const st = fn(loadAccounts(conns())); saveAccounts(st);
      const live = st.accounts.find(a => a.id === activeAccount);
      if (engine && live) engine.setGoals(goalsFor(live));
      if (!engine && (!watch || watch.id !== st.selected || fn.length >= 0)) void startWatch();
      return { ok: true, store: st };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  };
  ipcMain.handle('accounts:add', (e, x: unknown) => allowed(e) ? commitAccounts(st => addAccount(st, x, conns())) : { ok: false, error: 'Not allowed.' });
  ipcMain.handle('accounts:update', (e, ids: unknown, patch: unknown) => allowed(e) ? commitAccounts(st => updateAccounts(st, ids, patch, conns())) : { ok: false, error: 'Not allowed.' });
  ipcMain.handle('accounts:remove', (e, id: unknown) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    if (engine && id === activeAccount) return { ok: false, error: 'Stop the bot before removing the account it is running on.' };
    return commitAccounts(st => removeAccount(st, id));
  });
  ipcMain.handle('accounts:select', (e, id: unknown) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    if (engine) return { ok: false, error: 'Stop the bot before switching accounts.' };
    return commitAccounts(st => selectAccount(st, id));
  });
  ipcMain.handle('accounts:samples', e => (allowed(e) && !app.isPackaged)
    ? commitAccounts(st => sampleAccounts().reduce((acc, x) => addAccount(acc, x, conns()), st)) : { ok: false, error: 'Not allowed.' });

  ipcMain.handle('risk:set', (e, input: unknown) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    try { saveRisk(parseRisk(input)); return { ok: true }; }
    catch (err) { return { ok: false, error: (err as Error).message }; }
  });

  ipcMain.handle('engine:start', async e => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    if (engine) return { ok: false, error: 'The bot is already running.' };
    stopWatch();   // one connection at a time
    const st = loadAccounts(conns());
    const acct = st.accounts.find(a => a.id === st.selected) ?? null;
    const brokerId = acct ? acct.connection : 'paper';
    const def = BROKERS.find(b => b.id === brokerId);
    if (!def || !(brokerId in ADAPTERS) || (def.dev && app.isPackaged)) return { ok: false, error: 'That connection is not available.' };
    const creds = vault.get(`broker:${brokerId}`);
    if (def.fields.length && !creds) return { ok: false, error: `Save your ${def.name} keys under Connections first.` };
    const broker = ADAPTERS[brokerId](acct ?? undefined);
    try { await broker.connect({ ...(creds ?? {}), ...(acct?.brokerRef ? { accountId: acct.brokerRef } : {}) }); }
    catch (err) { void startWatch(); return { ok: false, error: (err as Error).message }; }
    const global = loadRisk();
    // The account's own rules tighten the global limits, never loosen them.
    const limits = { ...global, maxDailyLoss: acct && acct.dailyLoss > 0 ? Math.min(global.maxDailyLoss, acct.dailyLoss) : global.maxDailyLoss,
      maxMini: acct?.maxMini || 0, maxMicro: acct?.maxMicro || 0 };
    const guard = new RiskGuard(limits);
    engine = new Engine(broker, guard);
    engine.setGoals(goalsFor(acct));
    engine.syncStrategies(loadStrategies());
    // K system (K1-K7): paper = real prices, pretend orders; live = real orders with stops resting at the broker.
    const kc = loadKConfig();
    let kErr = '';
    if (kc.mode !== 'off') {
      if (!broker.getHistory) kErr = `${def.name} has no price history, so the K system can't run on it.`;
      else if (kc.mode === 'live' && !(broker.getOpenOrders && broker.modifyOrder && broker.cancelOrder)) kErr = `${def.name} can't hold stop orders yet, so the K system can't trade live on it. Use paper mode.`;
    }
    if (kc.mode !== 'off' && !kErr) {
      kPaper = kc.mode === 'paper' ? new PaperOrders(broker) : null;
      const desk: OrderDesk = kPaper ?? (broker as unknown as OrderDesk);
      const e = engine;
      kLive = new KLive(kc, {
        data: broker, desk, risk: guard, store: kTradeStore(kc.mode),
        dailyPnL: async () => (kPaper ? kPaper.realized + kPaper.unrealized() : broker.getDailyPnL()),
        account: () => kAcct, note: m => { jot(m); e.say(m); }, xHolds: sym => !!xLive?.holds(sym), gate: ctx => aiGate(ctx, kc.mode)
      });
      // K8, K9, P1-P3: same order desk, same risk limits, one position per market shared with K1-K7.
      xLive = new XLive(kc, {
        data: broker, desk, risk: guard, store: xTradeStore(kc.mode),
        dailyPnL: async () => (kPaper ? kPaper.realized + kPaper.unrealized() : broker.getDailyPnL()),
        note: m => { jot(m); e.say(m); }, kHolds: sym => !!kLive?.trades.some(t => t.sym === sym), gate: ctx => aiGate(ctx, kc.mode)
      });
      const pollAcct = async () => {
        try { const i = broker.getAccount ? await broker.getAccount() : null; if (i) kAcct = { equity: i.balance, floor: i.floor ?? ((acct?.size || i.size) - (acct?.maxLoss || i.maxLoss)) }; } catch { /* keep the last value */ }
      };
      void pollAcct(); kAcctTimer = setInterval(() => void pollAcct(), 60_000); (kAcctTimer as any).unref?.();
      engine.onHalt = () => { kLive?.stop(); kLive?.forgetAll(); xLive?.stop(); xLive?.forgetAll(); void kPaper?.closeAll(); };
    }
    engine.onTick = q => { bars.add(q); kPaper?.onQuote(q); };
    await seedBars(broker);
    await engine.start(kLive ? [...new Set([...limits.allowedSymbols, ...K_SYMBOLS])] : limits.allowedSymbols);
    if (kErr) engine.say(`K system is off: ${kErr}`);
    if (kLive) {
      const miss = K_SYMBOLS.filter(x => x.startsWith('M') && !limits.allowedSymbols.includes(x));
      if (miss.length) engine.say(`K system: add ${miss.join(' and ')} to your allowed symbols under Risk limits, or its trades there will be blocked.`);
      engine.say(`K system started in ${kc.mode} mode. It checks for signals a few seconds after every hour.`);
      kLive.start(); xLive?.start();
      kBroker = broker; const eng = engine!; aiTimer = setInterval(() => void aiTick(kc.mode, eng), 30_000); (aiTimer as any).unref?.(); void aiTick(kc.mode, eng);
      const xOn = XSTRATEGIES.filter(S => kc.enabled[S.id]).map(S => S.id);
      if (xOn.length) engine.say(`PO3/Fractal strategies on: ${xOn.join(', ')}. PO3 entries are resting limit orders at the exact level; stops go in as soon as they fill.`);
    }
    activeBroker = brokerId; activeAccount = acct?.id ?? '';
    hook = startWebhook(8787, webhookSecret(), s => void engine?.handleSignal(s));
    return { ok: true };
  });
  // Strategies save as soon as they change and the running bot picks the change up right away.
  const commit = (fn: () => ReturnType<typeof loadStrategies>) => {
    try { const list = fn(); saveStrategies(list); engine?.syncStrategies(list); return { ok: true, list }; }
    catch (err) { return { ok: false, error: (err as Error).message }; }
  };
  ipcMain.handle('strategies:add', (e, cfg: unknown, source: unknown) => allowed(e) ? commit(() => addTo(loadStrategies(), cfg, source)) : { ok: false, error: 'Not allowed.' });
  ipcMain.handle('strategies:update', (e, id: unknown, patch: unknown) => allowed(e) ? commit(() => updateIn(loadStrategies(), id, patch)) : { ok: false, error: 'Not allowed.' });
  ipcMain.handle('strategies:remove', (e, id: unknown) => allowed(e) ? commit(() => removeFrom(loadStrategies(), id)) : { ok: false, error: 'Not allowed.' });
  ipcMain.handle('strategies:checkPine', (e, text: unknown) => {
    if (!allowed(e) || typeof text !== 'string') return { ok: false, error: 'Not allowed.' };
    const r = checkPine(text);
    return r.ok ? { ok: true, title: r.title, warnings: r.warnings } : r;
  });
  ipcMain.handle('copy:strategyAlert', (e, id: unknown) => {
    const s = loadStrategies().find(x => x.id === id && x.cfg.type === 'tradingview');
    if (!allowed(e) || !s) return false;
    clipboard.writeText(JSON.stringify({ secret: webhookSecret(), strategy: s.id, side: '{{strategy.order.action}}' }));
    return true;
  });
  ipcMain.handle('engine:stop', async e => { if (allowed(e)) { await stopTrading(); activeBroker = ''; activeAccount = ''; void startWatch(); } });
  ipcMain.handle('copy:alert', e => {
    if (!allowed(e)) return false;
    clipboard.writeText(JSON.stringify({ secret: webhookSecret(), symbol: 'ES', side: 'buy', qty: 1 }));
    return true;
  });
  ipcMain.handle('chart:get', (e, symbol: unknown, tf: unknown) => {
    if (!allowed(e) || typeof symbol !== 'string' || ![15, 60, 300].includes(tf as number)) return null;
    const trades = engine ? engine.openTrades().filter(t => t.symbol === symbol).map(t => ({ side: t.side, qty: t.qty, entry: t.entry, tp: t.tpPx, sl: t.slPx, name: t.name })) : [];
    return { bars: bars.get(symbol, (tf as number) * 1000, 160), trades, symbols: bars.symbols() };
  });
  // Backtests run here, never in the window. Data comes from a CSV the user picks, or pretend prices in the dev version.
  ipcMain.handle('backtest:run', async (e, id: unknown, csv: unknown, opts: any) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    const s = loadStrategies().find(x => x.id === id);
    if (!s) return { ok: false, error: 'Pick a strategy to test.' };
    if (s.cfg.type === 'tradingview') return { ok: false, error: "TradingView-alert strategies can't be backtested here because TradingView decides the trades. Use TradingView's own Strategy Tester." };
    try {
      const data = typeof csv === 'string' && csv ? parseCsv(csv) : !app.isPackaged ? samplePrices(s.cfg.symbol) : null;
      if (!data) return { ok: false, error: 'Choose a price file first.' };
      const slip = Number(opts?.slippageTicks), fee = Number(opts?.feePerSide);
      if (!(slip >= 0 && slip <= 20) || !(fee >= 0 && fee <= 50)) return { ok: false, error: 'Slippage must be 0 to 20 ticks and fees $0 to $50.' };
      const cfg = parseStrategy(s.cfg);
      const r = await runBacktest(cfg, data, { slippageTicks: slip, feePerSide: fee });
      return { ok: true, pretend: !(typeof csv === 'string' && csv), report: { ...r, trades: r.trades.slice(-300), tradeCount: r.trades.length } };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  ipcMain.handle('engine:kill', async e => { if (allowed(e)) await engine?.halt(); });

  // ---------- K system ----------
  // ---------- Claude ----------
  ipcMain.handle('ai:get', e => allowed(e) && ai ? { cfg: ai.cfg, hasKey: ai.hasKey(), preflight: ai.state.preflight, review: ai.state.review, chat: ai.state.chat,
    newsNow: ai.newsBlock(), aiTrade: xLive?.aiTrade() ?? null, journal: todayJournal().slice(-60) } : null);
  ipcMain.handle('ai:set', (e, x: unknown) => { if (!allowed(e) || !ai) return { ok: false, error: 'Not allowed.' }; const c = parseAIConfig(x); ai.setConfig(c); return { ok: true, cfg: c }; });
  ipcMain.handle('ai:key', (e, key: unknown) => {
    if (!allowed(e) || !ai) return { ok: false, error: 'Not allowed.' };
    try { if (key === null) ai.removeKey(); else if (typeof key === 'string') ai.setKey(key); return { ok: true }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  const aiRun = (fn: () => Promise<unknown>) => async (e: Electron.IpcMainInvokeEvent) => {
    if (!allowed(e) || !ai) return { ok: false, error: 'Not allowed.' };
    try { return { ok: true, result: await fn() }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  };
  ipcMain.handle('ai:preflight', aiRun(() => ai!.preflight(true)));
  ipcMain.handle('ai:review', aiRun(() => runReview()));
  ipcMain.handle('ai:clearChat', aiRun(async () => ai!.clearChat()));
  ipcMain.handle('ai:chat', async (e, q: unknown) => {
    if (!allowed(e) || !ai || typeof q !== 'string' || !q.trim() || q.length > 4000) return { ok: false, error: 'Type a question.' };
    try {
      const snap = { now: nyStamp(), running: !!engine, k: { cfg: loadKConfig(), status: kLive?.status() ?? null }, po3: xLive?.view() ?? null,
        paper: kPaper ? { realized: kPaper.realized, unrealized: kPaper.unrealized(), fills: kPaper.fills.slice(-30) } : null, account: kAcct,
        preflight: ai.state.preflight, recommended: (RANKINGS as any).recommended, journalToday: todayJournal().slice(-120) };
      return { ok: true, answer: await ai.chat(q.trim(), snap) };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });

  ipcMain.handle('k:get', e => {
    if (!allowed(e)) return null;
    return { cfg: loadKConfig(), status: kLive ? kLive.status() : null, running: !!engine, x: xLive ? xLive.view() : null, rankings: RANKINGS,
      xmeta: XSTRATEGIES.map(S => ({ id: S.id, name: S.name, symbol: S.symbol, orderSymbol: S.symbol === 'NQ' ? 'MNQ' : 'MGC', paperOnly: S.paperOnly, evidence: S.evidence })),
      paper: kPaper ? { realized: kPaper.realized, unrealized: kPaper.unrealized(), fills: kPaper.fills.slice(-50) } : null,
      meta: STRATEGIES.map(S => ({ id: S.id, name: S.name, symbol: S.symbol, orderSymbol: INSTRUMENTS[S.symbol].micro, direction: S.direction,
        flat: S.flat_at_session_end, expected: (EXPECTED as any)[S.id] })) };
  });
  ipcMain.handle('k:set', (e, x: unknown) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    const next = parseKConfig(x), cur = loadKConfig();
    if (engine && next.mode !== cur.mode) return { ok: false, error: 'Stop the bot before switching the K system between off, paper and live.' };
    if (next.mode === 'live' && cur.mode !== 'live' && !next.countFrom) next.countFrom = Date.now();
    saveKConfig(next); kLive?.setConfig(next); xLive?.setConfig(next);
    return { ok: true, cfg: next };
  });
  /** Validation: runs Keel's K engine on hourly CSVs (and optional daily CSVs) and compares with spec section 8. */
  ipcMain.handle('k:validate', (e, files: any, flatBy: unknown) => {
    if (!allowed(e) || !files || typeof files !== 'object') return { ok: false, error: 'Not allowed.' };
    try {
      const dailyOf = (txt: unknown): DailyClose[] | undefined => {
        if (typeof txt !== 'string' || !txt.trim()) return undefined;
        const L = txt.replace(/\r/g, '').trim().split('\n'), head = L[0].toLowerCase().split(/[,;\t]/).map(h => h.trim().replace(/"/g, ''));
        const iT = head.findIndex(h => ['time', 'date', 'datetime', 'timestamp'].includes(h)), iC = head.indexOf('close');
        if (iT < 0 || iC < 0) throw new Error('The daily file needs date and close columns.');
        return L.slice(1).map(l => { const v = l.split(/[,;\t]/).map(x => x.trim().replace(/"/g, '')); const t = v[iT];
          const date = /^\d+(\.\d+)?$/.test(t) ? new Date(Number(t) < 1e11 ? Number(t) * 1000 : Number(t)).toISOString().slice(0, 10) : t.slice(0, 10); return { date, close: Number(v[iC]) }; })
          .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && Number.isFinite(d.close));
      };
      const series: Record<string, ReturnType<typeof buildSeries>> = {};
      for (const sym of ['NQ', 'GC']) {
        const f = files[sym]; if (typeof f !== 'string' || !f.trim()) continue;
        series[sym] = buildSeries(sym, INSTRUMENTS[sym].tick, parseHourly(f, 'America/New_York'), dailyOf(files[sym + 'daily']));
      }
      if (!Object.keys(series).length) return { ok: false, error: 'Choose at least one hourly price file (NQ or GC).' };
      const fb = typeof flatBy === 'number' && flatBy >= 12 && flatBy <= 17 ? flatBy : null;
      const res = simulate(series, { ...VALIDATION, flatByHour: fb });
      const all = Object.values(series).flatMap(x => x.bars), from = Math.min(...all.map(b => b.utc)), to = Math.max(...all.map(b => b.utc));
      const rows = compare(res.trades, from, to, wallOf).filter(r => series[STRATEGIES.find(S => S.id === r.id)!.symbol]);
      const totals = STRATEGIES.filter(S => series[S.symbol]).map(S => ({ id: S.id, ...kStats(res.trades.filter(t => t.id === S.id)) }));
      return { ok: true, rows, totals, from, to, flatBy: fb, daily: Object.fromEntries(['NQ', 'GC'].map(x => [x, !!files[x + 'daily']])),
        bars: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.bars.length])) };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });

  // A small menu with no developer tools in it.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]));
  void startWatch();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
