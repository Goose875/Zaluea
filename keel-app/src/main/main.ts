import { app, BrowserWindow, clipboard, ipcMain, Menu, session, IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as http from 'http';
import * as path from 'path';
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
import { LIBRARY } from '../core/library';
import { loadStrategies, saveStrategies } from './strategies';

let engine: Engine | null = null;
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

async function stopTrading() {
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

app.whenReady().then(async () => {
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
    return { dev: !app.isPackaged, accounts: loadAccounts(conns()), blank: BLANK, strategies: loadStrategies(), library: LIBRARY, brokers: BROKERS.filter(b => !b.dev || !app.isPackaged), presets: PRESETS, version: app.getVersion(), saved: BROKERS.filter(b => vault.has(`broker:${b.id}`)).map(b => b.id), risk: loadRisk() };
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
    engine = new Engine(broker, new RiskGuard(limits));
    engine.setGoals(goalsFor(acct));
    engine.syncStrategies(loadStrategies());
    engine.onTick = q => bars.add(q);
    await seedBars(broker);
    await engine.start(limits.allowedSymbols);
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
