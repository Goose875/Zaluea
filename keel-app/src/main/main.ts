import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, IpcMainInvokeEvent, powerSaveBlocker } from 'electron';
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
import { addAccount, updateAccounts, removeAccount, selectAccount, sampleAccounts, goalsFor, clashingAccounts, BLANK, PRESETS } from '../core/accounts';
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
import { ping, checkWebhook, testPing, status as discordStatus, statusEnd as discordStatusEnd, everyoneOn, COLOR, Embed, logLine, flushLog, testLog } from './discord';
import { mult } from '../core/contracts';
import { UPDATE_KEY } from './updateKey';
import { loadJournal, recordTrade, editTrade, removeTrade, payoutRecord, allPayouts, setPayoutRules, addPayout, removePayout } from './journalStore';
import { stats as journalStats, filter as journalFilter, toCsv, nyDay } from '../core/journal';
import type { CloseReport, JournalFilter } from '../core/journal';
import { payoutStatus } from '../core/payouts';
import { listRithmicAccounts } from '../brokers/rithmic';
import type { AccountRecord } from '../core/accounts';
import { ProjectXBroker } from '../brokers/projectx';
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
let runBroker: any = null;
let runData: any = null;
let chartData: Promise<any> | null = null;
const chartTicks = new Map<string, { price: number; ts: number }>();   // TopstepX prices for the chart when the account is on Rithmic Test     // a separate price connection when the account's own has no data   // the running bot's connection (also serves chart history)
/** Other accounts trading at the same time (Accounts page "Trade with Keel"). */
interface Follower { acct: AccountRecord; broker: any; data: any; seen: Record<string, number>; k: KLive; x: XLive; paper: PaperOrders | null; error: string; goalHit: boolean; stop: () => Promise<void>; flatten: () => Promise<void> }
let followers: Follower[] = [];
// The bot journal: every K / PO3 / Claude note with its New York time (today's notes feed the daily review and the chat).
const journal: string[] = [];
const nyStamp = (t = Date.now()) => new Date(wallOf(t)).toISOString().slice(0, 16).replace('T', ' ');
function jot(m: string) {
  const line = `${nyStamp()} ${m}`; journal.push(line); if (journal.length > 1500) journal.splice(0, journal.length - 1500);
  try { fs.appendFileSync(path.join(app.getPath('userData'), `journal_${line.slice(0, 10)}.txt`), line + '\n'); } catch { /* journal is best effort */ }
  try { logLine(line); } catch { /* Discord must never touch trading */ }
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

function stopK() { if (runData) { void runData.disconnect().catch(() => {}); runData = null; } for (const f of followers) void f.stop(); followers = []; clearInterval(aiTimer); kBroker = null; kLive?.stop(); kLive = null; xLive?.stop(); xLive = null; kPaper = null; clearInterval(kAcctTimer); kAcct = null; }
// ---------- Discord live status: one message, edited every 30 s while the bot runs ----------
let statusTimer: ReturnType<typeof setInterval> | undefined;
const usd = (v: number) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const px2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '?' : v.toFixed(2));
/** 7:42 PM style New York time. */
const nyHM = (t = Date.now()) => { const w = new Date(wallOf(t)), h = w.getUTCHours(), m = String(w.getUTCMinutes()).padStart(2, '0'); return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`; };
const shortLabel = (s: string) => (s.length > 26 ? `${s.slice(0, 12)}…${s.slice(-12)}` : s);
/** One account's open Keel trades with live P&L, and its working entry orders. */
function tradeLines(k: KLive | null, x: XLive | null, data: any, engineTrades: ReturnType<Engine['openTrades']> = []): { lines: string[]; open: number; pnl: number | null } {
  const price = (orderSym: string, sym: string) => data?.lastPrice?.(orderSym) ?? data?.lastPrice?.(sym);
  const out: string[] = []; let open = 0, sum = 0, known = true;
  const line = (id: string, dir: 'long' | 'short', qty: number, orderSym: string, sym: string, entry: number, stop: number | null, target: number | null) => {
    const now = price(orderSym, sym), d = dir === 'long' ? 1 : -1, pnl = now === undefined ? null : (now - entry) * d * qty * mult(orderSym);
    open++; if (pnl === null) known = false; else sum += pnl;
    out.push(`${pnl === null ? '⚪' : pnl >= 0 ? '🟢' : '🔴'} **${id}** ${dir === 'long' ? 'Long' : 'Short'} ${qty} ${orderSym} · **${pnl === null ? 'P&L ?' : usd(pnl)}**\n` +
      `└ entry ${px2(entry)} → now ${px2(now)} · stop ${px2(stop)}${target !== null ? ` · target ${px2(target)}` : ''}`);
  };
  for (const t of k?.trades ?? []) line(t.id, t.dir, t.qty, t.orderSym, t.sym, t.entry, t.stop, t.target);
  for (const t of x?.trades ?? []) {
    if (t.state === 'open' && t.entry !== null) line(t.id, t.dir, t.qty, t.orderSym, t.sym, t.entry, t.stop, t.target);
    else if (t.state === 'working') out.push(`⏳ **${t.id}** ${t.dir === 'long' ? 'Buy' : 'Sell'} limit ${t.qty} ${t.orderSym} @ ${px2(t.limitPx)}\n└ working until ${nyHM(t.liveUntil)} ET`);
  }
  for (const t of engineTrades) if (t.entry !== null) line(t.name, t.side === 'buy' ? 'long' : 'short', t.qty, t.symbol, t.symbol, t.entry, t.slPx, t.tpPx);
  return { lines: out, open, pnl: open ? (known ? sum : null) : 0 };
}
/** The live status card: a summary row, then each account (P&L today, open P&L, its trades). */
async function statusEmbed(): Promise<Embed> {
  const kc = loadKConfig(), st = loadAccounts(conns()), snap = engine?.snapshot();
  const rows: { label: string; today: number | null; goal: number; flag: string; t: ReturnType<typeof tradeLines> }[] = [];
  if (snap) {
    const main = st.accounts.find(a => a.id === activeAccount);
    rows.push({ label: main?.label ?? 'Paper account', today: kPaper ? kPaper.realized + kPaper.unrealized() : snap.total, goal: main?.dailyGoal ?? 0,
      flag: snap.paused ? '⛔ Stopped for today (daily target)' : snap.halted ? '⛔ Halted' : '', t: tradeLines(kLive, xLive, kBroker ?? runBroker, engine?.openTrades()) });
  }
  for (const f of followers) {
    let today: number | null = null;
    try { today = f.paper ? f.paper.realized + f.paper.unrealized() : await f.broker.getDailyPnL(); } catch { /* unknown right now */ }
    rows.push({ label: f.acct.label, today, goal: f.acct.dailyGoal, flag: f.goalHit ? '⛔ Stopped for today (daily target)' : '', t: tradeLines(f.k, f.x, f.data) });
  }
  const total = rows.every(r => r.today !== null) ? rows.reduce((a, r) => a + (r.today as number), 0) : null;
  const openPnl = rows.every(r => r.t.pnl !== null) ? rows.reduce((a, r) => a + (r.t.pnl as number), 0) : null, openN = rows.reduce((a, r) => a + r.t.open, 0);
  const next = kLive?.status().nextCheck, sigs = lastSignals();
  const fields: Embed['fields'] = [
    { name: '⚙️ Mode', value: kc.mode === 'off' ? 'Chart trading' : kc.mode === 'live' ? 'Live' : 'Paper', inline: true },
    { name: '💰 Today', value: total === null ? '?' : usd(total), inline: true },
    { name: '📈 Open P&L', value: openN ? `${openPnl === null ? '?' : usd(openPnl)} (${openN})` : 'Flat', inline: true },
    ...(next ? [{ name: '🕒 Next check', value: `${nyHM(next)} ET`, inline: true }] : []),
    ...(sigs.length ? [{ name: '🔔 Last signal per strategy', value: sigs.map(s => `**${s.id}** ${s.t ? new Date(wallOf(s.t)).toISOString().slice(5, 10).replace('-', '/') + (s.dir ? ' ' + s.dir : '') : 'none yet'}`).join(' · '), inline: false }] : [])
  ];
  for (const r of rows) {
    fields.push({ name: '🏦 Account', value: shortLabel(r.label), inline: true },
      { name: '💵 Today', value: `${r.today === null ? '?' : usd(r.today)}${r.goal > 0 && r.today !== null ? ` · ${Math.max(0, Math.round(100 * r.today / r.goal))}% of $${r.goal.toLocaleString('en-US')}` : ''}`, inline: true },
      { name: '📊 Open', value: r.t.open ? (r.t.pnl === null ? '?' : usd(r.t.pnl)) : 'Flat', inline: true });
    if (r.flag || r.t.lines.length) fields.push({ name: '​', value: [r.flag, ...r.t.lines].filter(Boolean).join('\n'), inline: false });
  }
  const anyStop = rows.some(r => r.flag);
  return { title: '📊 Keel live', color: total === null ? COLOR.blue : total >= 0 ? COLOR.green : COLOR.red, fields,
    footer: { text: `Live trade tracking · updated ${nyHM()} ET${anyStop ? ' · some accounts stopped' : ''}` }, timestamp: new Date().toISOString() };
}
function startStatus() {
  clearInterval(statusTimer);
  if (!vault.has('discord')) return;
  const push = async () => { try { if (engine) await discordStatus(await statusEmbed()); } catch { /* Discord must never touch trading */ } };
  setTimeout(() => void push(), 5000);
  statusTimer = setInterval(() => void push(), 30_000); (statusTimer as any).unref?.();
}
// ---------- health line: every 5 minutes, one log line per running account (file + Discord bot log) ----------
let healthTimer: ReturnType<typeof setInterval> | undefined, healthFirst: ReturnType<typeof setTimeout> | undefined;
const mainSeen: Record<string, number> = {};   // when the main account's price feed last sent each symbol
/** NQ and GC price with its age, from whichever of the mini / micro quoted last. */
function feed(data: any, seen: Record<string, number>, now: number): { text: string; stale: boolean } {
  const parts: string[] = []; let stale = false;
  for (const [root, micro] of [['NQ', 'MNQ'], ['GC', 'MGC']]) {
    const sym = (seen[micro] ?? 0) > (seen[root] ?? 0) ? micro : root, t = seen[sym], px = data?.lastPrice?.(sym) ?? data?.lastPrice?.(root);
    const age = t ? Math.max(0, Math.round((now - t) / 1000)) : null;   // a quote that arrives while this line is built is 0 s old, not -1
    if (age === null || age > 120) stale = true;
    parts.push(`${root} ${px === undefined ? '?' : px.toFixed(2)} (${age === null ? 'no live price yet' : age < 120 ? age + ' s old' : Math.round(age / 60) + ' min old'})`);
  }
  return { text: parts.join(' · '), stale };
}
/** Futures pause 17:00-18:00 ET and over the weekend: no prices then is normal. */
function marketClosed(now: number) { const w = new Date(wallOf(now)), d = w.getUTCDay(), h = w.getUTCHours(); return h === 17 || d === 6 || (d === 0 && h < 18) || (d === 5 && h >= 17); }
/** The main account's switched-on strategies with their newest signal (newest first). */
function lastSignals(): { id: string; t: number | null; dir: string | null }[] {
  const kc = loadKConfig(), out: { id: string; t: number | null; dir: string | null }[] = [];
  for (const s of kLive?.status().strategies ?? []) if (kc.enabled[s.id]) out.push({ id: s.id, t: s.lastSignal ?? null, dir: s.lastSignalDir ?? null });
  for (const s of xLive?.view() ?? []) if (kc.enabled[s.id] && !(s.paperOnly && kc.mode === 'live')) out.push({ id: s.id, t: s.lastScan ? s.lastSignal ?? null : null, dir: s.lastSignalDir ?? null });
  return out.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
}
const nyDate = (t: number) => new Date(wallOf(t)).toISOString().slice(0, 10);
/** Weekdays (trading days) after the day of `from`, up to and including today. */
function tradingDaysSince(from: number, now = Date.now()) { let n = 0; for (let d = Date.parse(nyDate(from) + 'T12:00:00Z') + 86_400_000; d <= Date.parse(nyDate(now) + 'T12:00:00Z'); d += 86_400_000) { const w = new Date(d).getUTCDay(); if (w && w !== 6) n++; } return n; }
let quietAlarmDay = '';
/** No signal from any switched-on strategy for 5+ trading days: something may be wrong (it happened 3 times in 2.4 years of backtest). Once a day. */
function checkQuiet() {
  if (!kLive || !kLive.status().lastRun) return;   // the K system hasn't finished a check yet
  const sigs = lastSignals(), newest = sigs.find(s => s.t !== null);
  if (!sigs.length) return;
  const days = newest && newest.t ? tradingDaysSince(newest.t) : Infinity, today = nyDate(Date.now());
  if (days < 5 || quietAlarmDay === today) return;
  quietAlarmDay = today;
  const m = `No strategy has signalled for ${days === Infinity ? 'the whole loaded price history' : days + ' trading days'}${newest && newest.t ? ` (newest: ${newest.id} on ${nyDate(newest.t)})` : ''}. In 2.4 years of backtest that happened only 3 times: check the Strategies page and the log.`;
  jot(m); engine?.say(m); ping(m);
}

async function healthLines() {
  const now = Date.now(), closed = marketClosed(now), st = loadAccounts(conns()), snap = engine?.snapshot();
  const one = (label: string, f: { text: string; stale: boolean }, today: number | null, open: number, working: number, next: number | null, err: string, flag: string) => {
    const ok = !f.stale && today !== null, state = ok ? 'connected' : closed ? 'market closed' : '⚠ CHECK CONNECTION';
    jot(`Health: [${label}] ${state} · ${f.text} · today ${today === null ? 'P&L unreadable' : usd(today)} · ${open ? open + ' open' : 'flat'}${working ? ' · ' + working + ' working order' + (working > 1 ? 's' : '') : ''}${next ? ' · next check ' + (next <= now + 60_000 ? 'due now' : nyHM(next) + ' ET') : ''}${flag ? ' · ' + flag : ''}${err ? ' · last error: ' + err : ''}`);
  };
  if (snap) {
    const main = st.accounts.find(a => a.id === activeAccount);
    let today: number | null = null;
    try { today = kPaper ? kPaper.realized + kPaper.unrealized() : runBroker?.getDailyPnL ? await runBroker.getDailyPnL() : snap.total; } catch { /* unreadable */ }
    one(main?.label ?? 'Paper account', feed(kBroker ?? runBroker, mainSeen, now), today,
      (kLive?.trades.length ?? 0) + (xLive?.trades.filter(t => t.state === 'open').length ?? 0) + (engine?.openTrades().length ?? 0),
      xLive?.trades.filter(t => t.state === 'working').length ?? 0, kLive?.status().nextCheck || null, kLive?.lastError || xLive?.lastError || '',
      snap.paused ? 'stopped for today (daily target)' : snap.halted ? 'halted' : '');
  }
  for (const f of followers) {
    let today: number | null = null;
    try { today = f.paper ? f.paper.realized + f.paper.unrealized() : await f.broker.getDailyPnL(); } catch { /* unreadable */ }
    one(f.acct.label, feed(f.data, f.seen, now), today, f.k.trades.length + f.x.trades.filter(t => t.state === 'open').length, f.x.trades.filter(t => t.state === 'working').length,
      f.k.status().nextCheck || null, f.k.lastError || f.x.lastError || '', f.goalHit ? 'stopped for today (daily target)' : '');
  }
}
function startHealth() {
  stopHealth();
  const run = () => { if (engine) { void healthLines().catch(() => {}); try { checkQuiet(); } catch { /* never touch trading */ } } };
  healthFirst = setTimeout(run, 20_000); (healthFirst as any).unref?.();   // the first one shortly after Start, once prices flow
  healthTimer = setInterval(run, 5 * 60_000); (healthTimer as any).unref?.();
}
function stopHealth() { clearTimeout(healthFirst); clearInterval(healthTimer); healthTimer = undefined; }

async function stopStatus() {
  clearInterval(statusTimer); statusTimer = undefined;
  try { await discordStatusEnd({ title: '⏹ Keel stopped', color: COLOR.grey, description: 'A new live status card starts when the bot starts again.',
    footer: { text: `Live trade tracking · stopped ${nyHM()} ET` }, timestamp: new Date().toISOString() }); } catch { /* best effort */ }
}

// While the bot runs, Windows must not go to sleep (a sleeping PC trades nothing). Released when the bot stops.
let awakeId: number | null = null;
function keepAwake(on: boolean) {
  try {
    if (on && awakeId === null && powerSaveBlocker) { awakeId = powerSaveBlocker.start('prevent-app-suspension'); jot('Keeping this PC awake while the bot runs.'); }
    if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
  } catch { /* best effort */ }
}

async function stopTrading() {
  keepAwake(false);
  stopHealth();
  void flushLog();
  void stopStatus();
  stopK(); runBroker = null;
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

/** Starts K1-K9 / P1-P3 on more accounts, each with its own connection, risk guard, paper desk and trade records. */
async function startFollowers(list: AccountRecord[], kc: ReturnType<typeof loadKConfig>, say: (m: string) => void) {
  for (const a of list) {
    const tag = (m: string, k?: string) => { const line = `[${a.label}] ${m}`; jot(line); say(line); if (k === 'trade') ping(line); };
    try {
      const def = BROKERS.find(b => b.id === a.connection), creds = vault.get(`broker:${a.connection}`);
      if (!def || (def.fields.length && !creds)) { tag(`not started: save your ${def?.name ?? a.connection} login first.`); continue; }
      const b: any = ADAPTERS[a.connection](a);
      await b.connect({ ...(creds ?? {}), ...(a.brokerRef ? { accountId: a.brokerRef } : {}) });
      if (!b.getHistory || (kc.mode === 'live' && !(b.getOpenOrders && b.modifyOrder && b.cancelOrder))) { tag('not started: this connection cannot run the strategies.'); await b.disconnect(); continue; }
      await b.subscribe?.(K_SYMBOLS).catch(() => {});
      const data: any = await dataFor(b, tag);
      const g = loadRisk(), guard = new RiskGuard({ ...g, maxDailyLoss: a.dailyLoss > 0 ? Math.min(g.maxDailyLoss, a.dailyLoss) : g.maxDailyLoss, maxMini: a.maxMini || 0, maxMicro: a.maxMicro || 0 });
      const paper = kc.mode === 'paper' ? new PaperOrders(data) : null, seen: Record<string, number> = {};
      data.onQuote((q: any) => { seen[q.symbol] = Date.now(); paper?.onQuote(q); });
      const desk: OrderDesk = paper ?? (b as OrderDesk);
      const dailyPnL = async () => (paper ? paper.realized + paper.unrealized() : b.getDailyPnL());
      let info: { equity: number; floor: number } | null = null;
      const poll = async () => { try { const i = b.getAccount ? await b.getAccount() : null; if (i) info = { equity: i.balance, floor: i.floor ?? (a.size - a.maxLoss) }; } catch { /* keep last */ } };
      void poll(); const timer = setInterval(() => void poll(), 60_000); (timer as any).unref?.();
      let x: XLive | null = null;
      const fc = acctCfg(kc, a);
      const record = recorder(a.id, () => a.label, kc.mode as 'paper' | 'live');
      const k = new KLive(fc, { data, desk, risk: guard, store: kTradeStore(kc.mode as 'paper' | 'live', a.id), dailyPnL, account: () => info, note: tag, log: m => jot(`[${a.label}] ${m}`),
        xHolds: sym => !!x?.holds(sym), gate: ctx => aiGate(ctx, kc.mode), record });
      x = new XLive(fc, { data, desk, risk: guard, store: xTradeStore(kc.mode as 'paper' | 'live', a.id), dailyPnL, note: tag, log: m => jot(`[${a.label}] ${m}`),
        kHolds: sym => k.trades.some(t => t.sym === sym), gate: ctx => aiGate(ctx, kc.mode), record });
      k.start(); x.start();
      const f: Follower = { acct: a, broker: b, data, seen, k, x, paper, error: '', goalHit: false,
        stop: async () => { k.stop(); x!.stop(); clearInterval(timer); clearInterval(goalTimer); await b.disconnect().catch(() => {}); if (data !== b) await data.disconnect().catch(() => {}); },
        flatten: async () => { k.stop(); k.forgetAll(); x!.stop(); x!.forgetAll(); if (paper) await paper.closeAll(); else await b.closeAll().catch(() => tag('could not flatten. Check your platform now.')); } };
      // this account's own daily profit target: close everything on it and stop trading it (the other accounts keep going)
      let goalBusy = false;
      const goalCheck = async () => {
        const goal = f.acct.dailyGoal;
        if (f.goalHit || goalBusy || !(goal > 0) || f.acct.pauseAtGoal === false) return;
        goalBusy = true;
        try {
          const pnl = await dailyPnL();
          if (!(pnl >= goal)) return;
          f.goalHit = true; clearInterval(goalTimer);
          guard.halt('Your daily profit target is reached, so this account is stopped for today.');
          goalPing(a.label);
          await f.flatten();
          tag(`Daily profit target of $${goal.toLocaleString('en-US')} reached ($${Math.round(pnl).toLocaleString('en-US')} today). Closed all positions and orders, and stopped trading this account for today.`);
        } catch { /* P&L unreadable: try again on the next check */ } finally { goalBusy = false; }
      };
      const goalTimer = setInterval(() => void goalCheck(), 3000); (goalTimer as any).unref?.();
      followers.push(f); tag(`trading in ${kc.mode} mode.`);
      void goalCheck();
    } catch (err) { tag(`not started: ${(err as Error).message}`); }
  }
}

/** Prices and history for the strategies: the account's own connection, or (when it has none, e.g. Rithmic Test without
 *  market data) the saved TopstepX login. Orders always go to the account's own connection. */
async function dataFor(broker: any, say: (m: string) => void): Promise<any> {
  const testPrices = broker.id === 'rithmic' && broker.isTest;   // Rithmic Test prices are simulated, not the real market
  // the account's own prices only when it really serves the history the strategies need (300+ hourly bars of NQ and GC), not just a few bars
  if (!testPrices) { try { const [n, g] = broker.getHistory ? await Promise.all([broker.getHistory('NQ', 'hour', 300), broker.getHistory('GC', 'hour', 300)]) : [[], []]; if (n.length >= 300 && g.length >= 300) return broker; } catch { /* fall through */ } }
  const px = vault.get('broker:projectx');
  if (!px || broker.id === 'projectx') return broker;
  try {
    const d: any = ADAPTERS.projectx(); await d.connect(px); await d.subscribe?.(K_SYMBOLS).catch(() => {});
    say(testPrices ? 'This account is on Rithmic Test, whose prices are simulated, so prices and history come from your TopstepX login. Orders still go to this account.'
      : 'The connection of this account does not serve enough price history for the strategies, so prices and history come from your TopstepX login. Orders still go to this account.');
    return d;
  } catch (err) { say(`No price data on this account, and TopstepX prices failed too (${(err as Error).message}).`); return broker; }
}

/** The bot's settings for one account: its own risk per trade and strategy mix when set, else the Strategies page. */
function acctCfg(kc: ReturnType<typeof loadKConfig>, a: AccountRecord | null | undefined) {
  if (!a) return kc;
  const ids = a.mix ? a.mix.split(' + ') : null;
  return { ...kc, riskUsd: a.riskUsd > 0 ? a.riskUsd : kc.riskUsd, enabled: ids ? Object.fromEntries(Object.keys(kc.enabled).map(id => [id, ids.includes(id)])) : kc.enabled };
}
/** After settings change: push each running account its own config (chart-trading-only mode keeps strategies off). */
function applyConfigs() {
  const kc = loadKConfig(), st = loadAccounts(conns()), find = (id: string) => st.accounts.find(a => a.id === id);
  if (kc.mode === 'off') return;
  const main = acctCfg(kc, find(activeAccount)); kLive?.setConfig(main); xLive?.setConfig(main);
  for (const f of followers) { const c = acctCfg(kc, find(f.acct.id) ?? f.acct); f.k.setConfig(c); f.x.setConfig(c); }
}
const goalPing = (label: string) => ping(`[${label}] Daily profit target reached: closing everything and stopping this account for today.`);
const mainLabel = () => loadAccounts(conns()).accounts.find(a => a.id === activeAccount)?.label ?? 'Paper account';
/** Trade journal hook for one account's trading systems. */
const recorder = (id: string, label: () => string, mode: 'paper' | 'live') => (r: CloseReport) => {
  const t = recordTrade(r, { id, label: label() }, mode);
  jot(`[${t.account}] Journal: ${t.id} ${t.dir} ${t.qty} ${t.orderSym} ${t.entry.toFixed(2)} -> ${t.exit !== null ? t.exit.toFixed(2) : '?'} (${t.how})${t.pnl !== null ? ` ${t.pnl >= 0 ? '+' : '-'}$${Math.abs(t.pnl).toFixed(2)}${t.approx ? ' approx.' : ''}` : ''}`);
};

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
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"]   // inline styles: the chart library builds its layout stylesheet at runtime
    }
  }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));

  // Updates: in the installed app, Keel checks updates.keeltrading.net (Cloudflare R2, key-protected) for a newer version, downloads it quietly,
  // and installs it when you close Keel (or right away if you press Restart and update while the bot is stopped).
  let update: { state: 'none' | 'downloading' | 'ready' | 'error'; version: string } = { state: 'none', version: '' };
  if (app.isPackaged) {
    autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.requestHeaders = { 'x-keel-key': UPDATE_KEY };
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
      if (f.optional && (v === undefined || v === null || (typeof v === 'string' && !v.trim()))) continue;
      if (typeof v !== 'string' || !v.trim() || v.length > 200) return { ok: false, error: `Fill in ${f.label}.` };
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
      for (const f of followers) { const now = st.accounts.find(a => a.id === f.acct.id); if (now) { f.acct.dailyGoal = now.dailyGoal; f.acct.pauseAtGoal = now.pauseAtGoal; } }
      if (!engine && (!watch || watch.id !== st.selected || fn.length >= 0)) void startWatch();
      return { ok: true, store: st };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  };
  ipcMain.handle('accounts:add', (e, x: unknown) => allowed(e) ? commitAccounts(st => addAccount(st, x, conns())) : { ok: false, error: 'Not allowed.' });
  ipcMain.handle('accounts:update', (e, ids: unknown, patch: unknown) => { if (!allowed(e)) return { ok: false, error: 'Not allowed.' }; const r = commitAccounts(st => updateAccounts(st, ids, patch, conns())); if (engine) applyConfigs(); return r; });
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
    if (acct && acct.trade === false) return { ok: false, error: `${acct.label} is switched off for trading (Accounts, Trade with Keel). Switch it on or pick another account.` };
    // every account that will trade (the one at the top plus each one switched on under Accounts) must be a different real account
    const clash = clashingAccounts(st.accounts.filter(a => a.id === acct?.id || (a.trade !== false && a.connection in ADAPTERS)));
    if (clash) { void startWatch(); return { ok: false, error: clash }; }
    const brokerId = acct ? acct.connection : 'paper';
    const def = BROKERS.find(b => b.id === brokerId);
    if (!def || !(brokerId in ADAPTERS) || (def.dev && app.isPackaged)) return { ok: false, error: 'That connection is not available.' };
    const creds = vault.get(`broker:${brokerId}`);
    if (def.fields.length && !creds) return { ok: false, error: `Save your ${def.name} keys under Connections first.` };
    const broker = ADAPTERS[brokerId](acct ?? undefined);
    runBroker = broker;
    try { await broker.connect({ ...(creds ?? {}), ...(acct?.brokerRef ? { accountId: acct.brokerRef } : {}) }); }
    catch (err) { void startWatch(); return { ok: false, error: (err as Error).message }; }
    const global = loadRisk();
    // The account's own rules tighten the global limits, never loosen them.
    const limits = { ...global, maxDailyLoss: acct && acct.dailyLoss > 0 ? Math.min(global.maxDailyLoss, acct.dailyLoss) : global.maxDailyLoss,
      maxMini: acct?.maxMini || 0, maxMicro: acct?.maxMicro || 0 };
    const guard = new RiskGuard(limits);
    engine = new Engine(broker, guard);
    engine.onNote = m => jot(m);   // daily goal stop, loss limit, kill switch, rule strategies: into the log file too
    engine.setGoals(goalsFor(acct));
    engine.syncStrategies(loadStrategies());
    // K system (K1-K7): paper = real prices, pretend orders; live = real orders with stops resting at the broker.
    const kc = loadKConfig();
    let kErr = '';
    if (kc.mode !== 'off') {
      if (!broker.getHistory) kErr = `${def.name} has no price history, so the K system can't run on it.`;
      else if (kc.mode === 'live' && !(broker.getOpenOrders && broker.modifyOrder && broker.cancelOrder)) kErr = `${def.name} can't hold stop orders yet, so the K system can't trade live on it. Use paper mode.`;
    }
    let dataSrc: any = broker;
    if (kc.mode !== 'off' && !kErr) {
      dataSrc = await dataFor(broker, m => engine?.say(m));
      if (dataSrc !== broker) { dataSrc.onQuote((q: any) => { mainSeen[q.symbol] = Date.now(); bars.add(q); kPaper?.onQuote(q); }); runData = dataSrc; }
      kPaper = kc.mode === 'paper' ? new PaperOrders(dataSrc) : null;
      const desk: OrderDesk = kPaper ?? (broker as unknown as OrderDesk);
      const e = engine;
      const pc = acctCfg(kc, acct);
      kLive = new KLive(pc, {
        data: dataSrc, desk, risk: guard, store: kTradeStore(kc.mode),
        dailyPnL: async () => (kPaper ? kPaper.realized + kPaper.unrealized() : broker.getDailyPnL()),
        account: () => kAcct, note: (m, k) => { jot(m); e.say(m); if (k === 'trade') ping(`[${mainLabel()}] ${m}`); }, log: jot, xHolds: sym => !!xLive?.holds(sym), gate: ctx => aiGate(ctx, kc.mode),
        record: recorder(acct?.id ?? 'main', mainLabel, kc.mode as 'paper' | 'live')
      });
      // K8, K9, P1-P3: same order desk, same risk limits, one position per market shared with K1-K7.
      xLive = new XLive(pc, {
        data: dataSrc, desk, risk: guard, store: xTradeStore(kc.mode),
        dailyPnL: async () => (kPaper ? kPaper.realized + kPaper.unrealized() : broker.getDailyPnL()),
        note: (m, k) => { jot(m); e.say(m); if (k === 'trade') ping(`[${mainLabel()}] ${m}`); }, log: jot, kHolds: sym => !!kLive?.trades.some(t => t.sym === sym), gate: ctx => aiGate(ctx, kc.mode),
        record: recorder(acct?.id ?? 'main', mainLabel, kc.mode as 'paper' | 'live')
      });
      const pollAcct = async () => {
        try { const i = broker.getAccount ? await broker.getAccount() : null; if (i) kAcct = { equity: i.balance, floor: i.floor ?? ((acct?.size || i.size) - (acct?.maxLoss || i.maxLoss)) }; } catch { /* keep the last value */ }
      };
      void pollAcct(); kAcctTimer = setInterval(() => void pollAcct(), 60_000); (kAcctTimer as any).unref?.();
      engine.onHalt = () => { kLive?.stop(); kLive?.forgetAll(); xLive?.stop(); xLive?.forgetAll(); void kPaper?.closeAll(); for (const f of followers) void f.flatten(); };
      // daily profit target on this account: stop and close it here only (followers watch their own targets)
      engine.onGoal = () => { kLive?.stop(); kLive?.forgetAll(); xLive?.stop(); xLive?.forgetAll(); void kPaper?.closeAll(); goalPing(mainLabel()); };
      if (kPaper) { const p = kPaper; engine.goalPnl = async () => p.realized + p.unrealized(); }
    }
    engine.onTick = q => { if (runData) return; mainSeen[q.symbol] = Date.now(); bars.add(q); kPaper?.onQuote(q); };   // with a separate price source, that source feeds both
    await seedBars(broker);
    await engine.start(kLive ? [...new Set([...limits.allowedSymbols, ...K_SYMBOLS])] : limits.allowedSymbols);
    if (kErr) engine.say(`K system is off: ${kErr}`);
    if (kLive) {
      const miss = K_SYMBOLS.filter(x => x.startsWith('M') && !limits.allowedSymbols.includes(x));
      if (miss.length) engine.say(`K system: add ${miss.join(' and ')} to your allowed symbols under Risk limits, or its trades there will be blocked.`);
      engine.say(`K system started in ${kc.mode} mode. It checks for signals a few seconds after every hour.`);
      kLive.start(); xLive?.start();
      // every other account switched on under Accounts trades too (own connection, risk limits and trade records)
      const others = st.accounts.filter(a => a.trade !== false && a.id !== acct?.id && a.connection in ADAPTERS && a.connection !== 'paper');
      if (others.length) { engine.say(`Also trading ${others.length} more account${others.length === 1 ? '' : 's'}: ${others.map(a => a.label).join(', ')}.`); void startFollowers(others, kc, m => engine?.say(m)); }
      kBroker = dataSrc; const eng = engine!; aiTimer = setInterval(() => void aiTick(kc.mode, eng), 30_000); (aiTimer as any).unref?.(); void aiTick(kc.mode, eng);
      const xOn = XSTRATEGIES.filter(S => kc.enabled[S.id]).map(S => S.id);
      if (xOn.length) engine.say(`PO3/Fractal strategies on: ${xOn.join(', ')}. PO3 entries are resting limit orders at the exact level; stops go in as soon as they fill.`);
    } else if (kc.mode === 'off' && broker.getOpenOrders && broker.cancelOrder) {
      // Strategies off: chart trading only. Real orders on this account and every account switched on under Accounts.
      const mc = { ...kc, mode: 'live' as const, enabled: {} as Record<string, boolean> }, e = engine;
      xLive = new XLive(mc, { data: broker, desk: broker as unknown as OrderDesk, risk: guard, store: xTradeStore('live'), dailyPnL: () => broker.getDailyPnL(),
        note: (m, k) => { jot(m); e.say(m); if (k === 'trade') ping(`[${mainLabel()}] ${m}`); }, kHolds: () => false, record: recorder(acct?.id ?? 'main', mainLabel, 'live') });
      xLive.start();
      const others = st.accounts.filter(a => a.trade !== false && a.id !== acct?.id && a.connection in ADAPTERS && a.connection !== 'paper');
      engine.say(`Strategies are off, so the bot is in chart-trading mode: orders you place from the chart are REAL orders on ${1 + others.length} account${others.length ? 's' : ''}.`);
      if (others.length) void startFollowers(others, mc, m => engine?.say(m));
      engine.onHalt = () => { xLive?.stop(); xLive?.forgetAll(); for (const f of followers) void f.flatten(); };
      engine.onGoal = () => { xLive?.stop(); xLive?.forgetAll(); goalPing(mainLabel()); };
    } else engine.onGoal = () => goalPing(mainLabel());
    activeBroker = brokerId; activeAccount = acct?.id ?? '';
    hook = startWebhook(8787, webhookSecret(), s => void engine?.handleSignal(s));
    startStatus();
    keepAwake(true);
    startHealth();
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
  // ---------- trading from the chart, on any running account ----------
  const runners = () => {
    const st = loadAccounts(conns()), main = st.accounts.find(a => a.id === activeAccount);
    return [...(xLive ? [{ id: activeAccount || 'main', label: main?.label ?? 'Paper account', x: xLive, k: kLive }] : []), ...followers.map(f => ({ id: f.acct.id, label: f.acct.label, x: f.x, k: f.k as KLive | null }))];
  };
  ipcMain.handle('chart:accounts', e => allowed(e) ? { running: !!engine, mode: loadKConfig().mode, accounts: runners().map(r => ({ id: r.id, label: r.label })) } : null);
  ipcMain.handle('chart:order', async (e, o: any) => {
    if (!allowed(e) || !o || typeof o !== 'object') return { ok: false, error: 'Not allowed.' };
    if (!engine) return { ok: false, error: 'Start the bot first: chart orders go through the running accounts.' };
    if (typeof o.orderSym !== 'string' || !/^[A-Z0-9]{1,6}$/.test(o.orderSym) || !['long', 'short'].includes(o.dir) || !['market', 'limit'].includes(o.type)) return { ok: false, error: 'That order is not valid.' };
    const ids: string[] = Array.isArray(o.accounts) ? o.accounts : [], targets = runners().filter(r => ids.includes(r.id));
    if (!targets.length) return { ok: false, error: 'Tick at least one account.' };
    const results = await Promise.all(targets.map(async r => {
      try { const why = await r.x.manualOrder({ orderSym: o.orderSym, dir: o.dir, qty: Number(o.qty), type: o.type, price: Number(o.price), stopPts: Number(o.stopPts) || 0, tgtPts: Number(o.tgtPts) || 0 });
        return { account: r.label, ok: !why, why }; }
      catch (err) { return { account: r.label, ok: false, why: (err as Error).message }; }
    }));
    for (const x of results) { const line = `Chart ${o.dir} ${o.type} ${o.qty} ${o.orderSym} on ${x.account}: ${x.ok ? 'sent' : 'not sent, ' + x.why}`; jot(line); }   // each account's runner pings its own "sent" / "filled" (no duplicate here)
    return { ok: true, results };
  });
  ipcMain.handle('chart:flatten', async (e, root: unknown, accounts: unknown) => {
    if (!allowed(e) || typeof root !== 'string' || !/^[A-Z0-9]{1,6}$/.test(root)) return { ok: false, error: 'Not allowed.' };
    const ids: string[] = Array.isArray(accounts) ? accounts as string[] : [], targets = runners().filter(r => ids.includes(r.id));
    const results = await Promise.all(targets.map(async r => { try { await r.x.flattenMarket(root.replace(/^M(?=NQ|ES|GC|YM|CL)/, '')); return { account: r.label, ok: true, why: '' }; } catch (err) { return { account: r.label, ok: false, why: (err as Error).message }; } }));
    return { ok: true, results };
  });

  const twinOf = (s: string) => (/^M(NQ|ES|GC|YM|CL)$/.test(s) ? s.slice(1) : /^(NQ|ES|GC|YM|CL)$/.test(s) ? 'M' + s : s);
  /** The newest live tick for a market from the chart's price source (null = no live prices yet). */
  const liveTick = (symbol: string) => {
    const src = chartData && !runData && !runBroker ? chartTicks : chartData && runBroker?.id === 'rithmic' && runBroker?.isTest && !runData ? chartTicks : bars.last;
    const a = src.get(symbol), b = src.get(twinOf(symbol)); return a && b ? (a.ts >= b.ts ? a : b) : a ?? b ?? null;
  };
  ipcMain.handle('chart:tick', (e, symbol: unknown) => (allowed(e) && typeof symbol === 'string' ? { tick: liveTick(symbol), now: Date.now() } : null));
  /** Open trades on a market across every running account, one line set per trade; the same trade on several accounts
   *  (a chart order sent to all of them, or the same strategy) is grouped. PO3/Fractal/chart/Claude trades can be dragged. */
  type Line = { ref: string; name: string; side: string; qty: number; entry: number | null; tp: number | null; sl: number | null; drag: boolean; working: boolean; opened: number | null; accounts: string[] };
  const chartLines = (same: (s: string) => boolean): Line[] => {
    const out = new Map<string, Line>(), add = (l: Line) => {
      const g = out.get(l.ref);
      if (!g) { out.set(l.ref, l); return; }
      g.accounts.push(...l.accounts); g.qty += l.qty;
    };
    for (const r of runners()) {
      for (const t of r.k?.trades ?? []) if (same(t.sym)) add({ ref: `K|${t.id}|${t.sym}|${t.dir}`, name: t.id, side: t.dir === 'long' ? 'buy' : 'sell', qty: t.qty, entry: t.entry, tp: t.target, sl: t.stop, drag: false, working: false, opened: t.opened, accounts: [r.label] });
      for (const t of r.x.trades) if (same(t.sym)) {
        const d = t.dir === 'long' ? 1 : -1, w = t.state === 'working', e = t.entry ?? t.limitPx;
        const sl = w ? (e !== null && t.stopPts > 0 ? e - d * t.stopPts : null) : t.stop, tp = w ? (e !== null && t.tgtPts > 0 ? e + d * t.tgtPts : null) : t.target;
        add({ ref: `X|${t.id}|${t.sym}|${t.dir}|${t.state}`, name: t.id === 'MANUAL' ? 'Chart' : t.id, side: t.dir === 'long' ? 'buy' : 'sell', qty: t.qty, entry: e, tp, sl,
          drag: !w || t.limitPx !== null, working: w, opened: w ? null : t.placed, accounts: [r.label] });
      }
    }
    const res = [...out.values()];
    for (const t of engine ? engine.openTrades() : []) if (same(t.symbol)) res.push({ ref: `E|${t.name}`, name: t.name, side: t.side, qty: t.qty, entry: t.entry, tp: t.tpPx ?? null, sl: t.slPx ?? null, drag: false, working: false, opened: null, accounts: [] });
    return res;
  };
  // A stop / target / limit line dragged on the chart: moved on every running account that holds that trade.
  ipcMain.handle('chart:move', async (e, ref: unknown, which: unknown, price: unknown) => {
    if (!allowed(e) || typeof ref !== 'string' || !['stop', 'target', 'entry'].includes(which as string) || typeof price !== 'number') return { ok: false, error: 'Not allowed.' };
    const [kind, id, sym, dir, state] = ref.split('|');
    if (kind !== 'X') return { ok: false, error: 'K1-K7 stops are managed by the strategy (it trails them), so they cannot be dragged.' };
    const targets = runners().map(r => ({ r, t: r.x.trades.find(t => t.id === id && t.sym === sym && t.dir === dir && t.state === state) })).filter(x => x.t);
    if (!targets.length) return { ok: false, error: 'That trade is no longer open.' };
    const results = await Promise.all(targets.map(async ({ r, t }) => {
      try { const why = await r.x.moveBracket(t!.key, which as 'stop' | 'target' | 'entry', price); return { account: r.label, ok: !why, why }; }
      catch (err) { return { account: r.label, ok: false, why: (err as Error).message }; }
    }));
    for (const x of results) jot(`Chart: ${id} ${which} to ${price} on ${x.account}: ${x.ok ? 'moved' : 'not moved, ' + x.why}`);
    return { ok: true, results };
  });
  const HIST_UNITS = ['min1', 'min5', 'min15', 'hour', 'hour4', 'day'];
  ipcMain.handle('chart:hist', async (e, symbol: unknown, unit: unknown, count: unknown) => {
    if (!allowed(e) || typeof symbol !== 'string' || !HIST_UNITS.includes(unit as string)) return { ok: false, error: 'Not allowed.' };
    let b: any = runData ?? runBroker ?? watch?.broker;
    if (b && b.id === 'rithmic' && b.isTest && vault.get('broker:projectx')) {          // Rithmic Test: show real prices from TopstepX
      if (!chartData) { const d: any = ADAPTERS.projectx(); d.onQuote((q: any) => chartTicks.set(q.symbol, { price: q.price, ts: Date.now() }));
        chartData = d.connect(vault.get('broker:projectx')).then(() => d).catch((err: Error) => { chartData = null; throw err; }); }
      b = await chartData; await b.subscribe?.([symbol, twinOf(symbol)]).catch(() => {});
    }
    if (!b?.getHistory) return { ok: false, error: 'Start the bot (or pick an account) to load chart history.' };
    try {
      const n = Math.max(3, Math.min(5000, Number(count) || 1500));
      const bars = await b.getHistory(symbol, unit, n, true);
      const root = symbol.replace(/^M(?=NQ|ES|GC)/, ''), same = (s: string) => s.replace(/^M(?=NQ|ES|GC)/, '') === root;
      const lines = chartLines(same);
      const first = bars.length ? bars[0].t : Date.now() - 86_400_000;
      const closed = loadJournal().filter(t => same(t.sym) && t.closedAt >= first).slice(-300)
        .map(t => ({ account: t.account, id: t.id, dir: t.dir, qty: t.qty, entry: t.entry, exit: t.exit, pnl: t.pnl, openedAt: t.openedAt, closedAt: t.closedAt, how: t.how }));
      return { ok: true, bars, lines, closed, tick: liveTick(symbol) };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  ipcMain.handle('chart:get', (e, symbol: unknown, tf: unknown) => {
    if (!allowed(e) || typeof symbol !== 'string' || ![15, 60, 300].includes(tf as number)) return null;
    const trades = engine ? engine.openTrades().filter(t => t.symbol === symbol).map(t => ({ side: t.side, qty: t.qty, entry: t.entry, tp: t.tpPx, sl: t.slPx, name: t.name })) : [];
    return { bars: bars.get(symbol, (tf as number) * 1000, 160), trades, symbols: bars.symbols() };
  });
  // ---------- trade journal, stats and payouts ----------
  const parseFilter = (f: any): JournalFilter => {
    const o: JournalFilter = {};
    if (!f || typeof f !== 'object') return o;
    for (const k of ['accountId', 'system', 'id', 'sym'] as const) if (typeof f[k] === 'string' && f[k] && f[k].length < 80) o[k] = f[k];
    if (f.mode === 'paper' || f.mode === 'live') o.mode = f.mode;
    for (const k of ['from', 'to'] as const) if (Number.isFinite(f[k]) && f[k] > 0) o[k] = f[k];
    return o;
  };
  ipcMain.handle('journal:get', (e, f: unknown) => {
    if (!allowed(e)) return null;
    const all = loadJournal(), list = journalFilter(all, parseFilter(f));
    return { trades: list.slice(-1000).reverse(), total: list.length, stats: journalStats(list),
      accounts: [...new Map(all.map(t => [t.accountId, t.account])).entries()].map(([id, label]) => ({ id, label })), strategies: [...new Set(all.map(t => t.id))].sort() };
  });
  ipcMain.handle('journal:edit', (e, uid: unknown, patch: unknown) => {
    if (!allowed(e) || typeof uid !== 'string' || !patch || typeof patch !== 'object') return { ok: false, error: 'Not allowed.' };
    try { return { ok: true, trade: editTrade(uid, patch as any) }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  ipcMain.handle('journal:remove', (e, uid: unknown) => { if (!allowed(e) || typeof uid !== 'string') return { ok: false, error: 'Not allowed.' }; removeTrade(uid); return { ok: true }; });
  ipcMain.handle('journal:csv', async (e, f: unknown) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    const csv = toCsv(journalFilter(loadJournal(), parseFilter(f))), w = BrowserWindow.fromWebContents(e.sender);
    const r = await (w ? dialog.showSaveDialog(w, { defaultPath: `keel-journal-${nyDay(Date.now())}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] }) : dialog.showSaveDialog({ defaultPath: 'keel-journal.csv' }));
    if (r.canceled || !r.filePath) return { ok: false, error: '' };
    fs.writeFileSync(r.filePath, csv); return { ok: true, path: r.filePath };
  });
  const validAcct = (id: unknown): id is string => typeof id === 'string' && loadAccounts(conns()).accounts.some(a => a.id === id);
  /** Payout status for an account. The window passes the account's daily results it already shows (from the broker). */
  ipcMain.handle('payouts:get', (e, id: unknown, days: unknown, todayPnl: unknown, netProfit: unknown) => {
    if (!allowed(e) || !validAcct(id)) return null;
    const a = loadAccounts(conns()).accounts.find(x => x.id === id)!, rec = payoutRecord(id);
    const ds = Array.isArray(days) ? days.filter((d: any) => d && typeof d.date === 'string' && Number.isFinite(d.pnl)).map((d: any) => ({ date: d.date, pnl: d.pnl })) : [];
    const today = nyDay(Date.now()), tp = Number.isFinite(todayPnl) ? (todayPnl as number) : 0, np = Number.isFinite(netProfit) ? (netProfit as number) : ds.reduce((x, d) => x + d.pnl, 0) + tp;
    const all = allPayouts(), accts = loadAccounts(conns()).accounts;
    const totals = { paid: 0, cost: 0, payouts: 0 };
    for (const x of accts) { totals.cost += x.cost || 0; const r = all[x.id]; if (r) { totals.paid += r.taken.reduce((s, p) => s + p.amount, 0); totals.payouts += r.taken.length; } }
    return { rec: { rules: rec.rules, taken: [...rec.taken].sort((x, y) => (x.date < y.date ? -1 : 1)) }, status: payoutStatus(rec, ds, tp, today, np, a.cost || 0), totals, today };
  });
  ipcMain.handle('payouts:rules', (e, id: unknown, rules: unknown) => {
    if (!allowed(e) || !validAcct(id)) return { ok: false, error: 'Not allowed.' };
    try { setPayoutRules(id, rules); return { ok: true }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  ipcMain.handle('payouts:add', (e, id: unknown, p: unknown) => {
    if (!allowed(e) || !validAcct(id)) return { ok: false, error: 'Not allowed.' };
    try { addPayout(id, p); jot(`Payout recorded on ${loadAccounts(conns()).accounts.find(a => a.id === id)?.label}: $${(p as any).amount}`); return { ok: true }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  ipcMain.handle('payouts:remove', (e, id: unknown, index: unknown) => {
    if (!allowed(e) || !validAcct(id)) return { ok: false, error: 'Not allowed.' };
    try { removePayout(id, index as number); return { ok: true }; } catch (err) { return { ok: false, error: (err as Error).message }; }
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
  ipcMain.handle('engine:kill', async e => { if (allowed(e)) { ping('Stop all trading pressed: every account is being flattened.'); await engine?.halt(); } });

  // ---------- K system ----------
  // ---------- accounts on your logins ----------
  ipcMain.handle('accounts:discover', async e => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    const st = loadAccounts(conns()), out: any[] = [], errors: string[] = [];
    const known = (c: string, id: string) => st.accounts.find(a => a.connection === c && a.brokerRef === id)?.id ?? null;
    const px = vault.get('broker:projectx');
    if (px) { try { for (const a of await new ProjectXBroker().listAccounts(px)) out.push({ connection: 'projectx', login: 'TopstepX', firm: 'Topstep', ...a, added: known('projectx', a.id) }); } catch (err) { errors.push(`TopstepX: ${(err as Error).message}`); } }
    const rc = vault.get('broker:rithmic');
    if (rc) { try { for (const a of await listRithmicAccounts(rc)) out.push({ connection: 'rithmic', login: 'Rithmic', firm: 'Lucid Trading', ...a, balance: null, canTrade: true, simulated: false, added: known('rithmic', a.id) }); } catch (err) { errors.push(`Rithmic: ${(err as Error).message}`); } }
    if (!px && !rc) errors.push('Save your TopstepX or Rithmic login under Logins first.');
    return { ok: true, accounts: out, errors };
  });
  ipcMain.handle('accounts:import', (e, items: unknown) => {
    if (!allowed(e) || !Array.isArray(items) || !items.length || items.length > 200) return { ok: false, error: 'Pick at least one account.' };
    return commitAccounts(st0 => {
      let st = st0;
      for (const it of items as any[]) {
        if (!it || !['projectx', 'rithmic'].includes(it.connection) || typeof it.id !== 'string') continue;
        if (st.accounts.some(a => a.connection === it.connection && a.brokerRef === it.id)) continue;
        const name = String(it.name || it.id).slice(0, 60), k = /(\d{2,3})\s?k/i.exec(name), size = k ? Number(k[1]) * 1000 : 50000;
        st = addAccount(st, { ...BLANK, label: name, firm: it.connection === 'rithmic' ? 'Lucid Trading' : 'Topstep', connection: it.connection, brokerRef: it.id,
          size, maxLoss: size <= 50000 ? 2000 : size <= 100000 ? 3000 : 4500, trade: false }, conns());
      }
      return st;
    });
  });

  // ---------- Discord ----------
  ipcMain.handle('discord:get', e => (allowed(e) ? { saved: vault.has('discord'), everyone: everyoneOn(), logSaved: vault.has('discordLog') } : null));
  ipcMain.handle('discord:logSave', async (e, url: unknown) => {
    if (!allowed(e) || typeof url !== 'string') return { ok: false, error: 'Not allowed.' };
    try { const u = checkWebhook(url); await testLog(u); vault.set('discordLog', { url: u }); return { ok: true }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  ipcMain.handle('discord:logRemove', e => { if (allowed(e)) vault.remove('discordLog'); return { ok: true }; });
  ipcMain.handle('discord:save', async (e, url: unknown, everyone: unknown) => {
    if (!allowed(e) || typeof url !== 'string') return { ok: false, error: 'Not allowed.' };
    try { const u = checkWebhook(url), ev = everyone !== false; await testPing(u, ev); vault.set('discord', { url: u, everyone: ev ? '1' : '0' }); if (engine) startStatus(); return { ok: true }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  ipcMain.handle('discord:everyone', (e, on: unknown) => {
    const c = vault.get('discord'); if (!allowed(e) || !c) return { ok: false };
    vault.set('discord', { ...c, everyone: on === true ? '1' : '0' }); return { ok: true };
  });
  ipcMain.handle('discord:remove', e => { if (allowed(e)) { void stopStatus(); vault.remove('discord'); } return { ok: true }; });

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
      main: kLive ? { risk: kLive.riskNow(), on: Object.keys((kLive as any).cfg.enabled).filter(k => (kLive as any).cfg.enabled[k]) } : null,
      followers: followers.map(f => ({ id: f.acct.id, label: f.acct.label, risk: f.k.riskNow(), on: Object.keys((f.k as any).cfg.enabled).filter(k => (f.k as any).cfg.enabled[k]), open: f.k.trades.length + f.x.trades.filter(t => t.state === 'open').length, working: f.x.trades.filter(t => t.state === 'working').length, paper: f.paper ? f.paper.realized + f.paper.unrealized() : null, goalHit: f.goalHit })),
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
    saveKConfig(next); applyConfigs();
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
