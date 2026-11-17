import { createHash } from 'crypto';
import { AccountInfo, BrokerAdapter, HistBar, Order, Position, Quote, WorkingOrder, HistUnit } from '../core/types';
import type { AccountRecord } from '../core/accounts';
import { assertSafeUrl } from '../core/net';
import { SignalRClient } from './signalr';
import { cachedHistory, HistEntry } from './histcache';

interface Contract { id: string; symbol: string; tickSize: number; tickValue: number; name: string }

/**
 * TopstepX / ProjectX Gateway (REST).
 * Checked against ProjectX's docs: /api/Auth/loginKey, /api/Account/search, /api/Order/place.
 * Taken from third-party clients and NOT yet checked against the official docs or a live account:
 * /api/Contract/search, /api/Position/searchOpen, /api/Position/closeContract, /api/Order/searchOpen,
 * /api/Order/cancel, /api/Trade/search. Test every one on a practice account before real money.
 *
 * Live prices: ProjectX's market hub (SignalR over WebSocket, per their real-time docs: GatewayQuote, SubscribeContractQuotes).
 * Connection details (token in the URL, no negotiate step) follow their sample code and are untested against the real service.
 * Daily P&L = closed trades since 5pm Chicago, minus fees, plus open positions marked to the latest price using the
 * contract's tickSize and tickValue. If an open position has no live price, getDailyPnL throws and the engine blocks trades (fails closed).
 *
 * Network: every Keel account on one login shares one sign-in, one live price stream, the contract list, the account list
 * (balances) and the price history. Each account keeps short-lived copies of its positions, working orders and today's
 * closed P&L, and drops them the moment Keel sends, changes or cancels an order on it.
 */

/** What every Keel account on one TopstepX login shares. */
interface Login {
  key: string; base: string; rtc: string; user: string; apiKey: string;
  token: string; signing: Promise<void> | null; refs: number;
  bySymbol: Map<string, Contract>; byId: Map<string, Contract>; last: Map<string, number>;
  market: SignalRClient | null; opening: Promise<void> | null; subscribed: Set<string>; restarted: number;
  listeners: Set<(q: Quote) => void>;
  accounts: { at: number; p: Promise<any[]> } | null;
  searches: Map<string, { at: number; p: Promise<any[]> }>;
  hist: Map<string, HistEntry>;
}
const LOGINS = new Map<string, Login>();

async function raw(L: Login, path: string, body: unknown, auth: boolean): Promise<any> {
  const res = await fetch(L.base + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', accept: 'text/plain', ...(auth ? { Authorization: `Bearer ${L.token}` } : {}) },
    body: JSON.stringify(body)
  });
  if (res.status === 401 && auth) throw Object.assign(new Error('expired'), { expired: true });
  if (!res.ok) throw new Error(`ProjectX request failed (${res.status}).`);
  const j: any = await res.json();
  if (j.success === false) throw new Error(`ProjectX rejected the request (code ${j.errorCode}).`);
  return j;
}
/** One sign-in at a time per login (several accounts asking at once share it). */
function signIn(L: Login): Promise<void> {
  if (!L.signing) L.signing = (async () => {
    let j: any;
    try { j = await raw(L, '/api/Auth/loginKey', { userName: L.user, apiKey: L.apiKey }, false); }
    catch { throw new Error('ProjectX did not accept that username and API key.'); }
    if (typeof j.token !== 'string' || !j.token) throw new Error('ProjectX did not return a session.');
    L.token = j.token;
  })().finally(() => { L.signing = null; });
  return L.signing;
}
async function call(L: Login, path: string, body: unknown): Promise<any> {
  if (!L.token) await signIn(L);
  try { return await raw(L, path, body, true); }
  catch (e: any) { if (!e.expired) throw e; await signIn(L); return raw(L, path, body, true); }   // tokens last 24 hours
}
function acquire(base: string, rtc: string, creds: Record<string, string>): Login {
  const key = `${base}|${creds.userName}|${createHash('sha256').update(String(creds.apiKey)).digest('hex').slice(0, 16)}`;
  let L = LOGINS.get(key);
  if (!L) {
    L = { key, base, rtc, user: creds.userName, apiKey: creds.apiKey, token: '', signing: null, refs: 0, bySymbol: new Map(), byId: new Map(), last: new Map(),
      market: null, opening: null, subscribed: new Set(), restarted: 0, listeners: new Set(), accounts: null, searches: new Map(), hist: new Map() };
    LOGINS.set(key, L);
  }
  L.refs++; return L;
}
/** The last account to let go of a login closes its price stream. */
function release(L: Login) {
  if (--L.refs > 0) return;
  L.market?.stop(); L.market = null; L.opening = null; L.subscribed.clear();
  if (LOGINS.get(L.key) === L) LOGINS.delete(L.key);
}
/** Balances and the account list, shared by the accounts on a login (asked for at most every `maxAge` ms). */
function accountList(L: Login, maxAge: number): Promise<any[]> {
  const now = Date.now();
  if (L.accounts && now - L.accounts.at < maxAge) return L.accounts.p;
  const p = call(L, '/api/Account/search', { onlyActiveAccounts: true }).then(j => (j.accounts || []) as any[]);
  const e = { at: now, p }; L.accounts = e; p.catch(() => { if (L.accounts === e) L.accounts = null; });
  return p;
}
/** Contracts matching a symbol, shared by the accounts on a login. */
function searchContracts(L: Login, text: string, maxAge: number): Promise<any[]> {
  const now = Date.now(), hit = L.searches.get(text);
  if (hit && now - hit.at < maxAge) return hit.p;
  const p = call(L, '/api/Contract/search', { searchText: text, live: false }).then(j => (j.contracts || []) as any[]);
  const e = { at: now, p }; L.searches.set(text, e); p.catch(() => { if (L.searches.get(text) === e) L.searches.delete(text); });
  return p;
}
/** Exact root match on the contract name (e.g. NQZ5 / NQZ25 for NQ, never MNQZ5), front month = activeContract. */
function frontMonth(symbol: string, all: any[]): any {
  const exact = all.filter(x => new RegExp(`^${symbol}[FGHJKMNQUVXZ]\\d{1,2}$`).test(String(x.name || '')));
  const list = exact.length ? exact : all, c = list.find(x => x.activeContract) ?? list[0];
  if (!c || typeof c.id !== 'string') throw new Error(`ProjectX has no contract for ${symbol}.`);
  return c;
}
function subscribeAll(L: Login) {
  if (!L.market) return;
  for (const c of L.byId.values()) if (!L.subscribed.has(c.id)) { L.market.invoke('SubscribeContractQuotes', [c.id]); L.subscribed.add(c.id); }
}
function remember(L: Login, symbol: string, c: any): Contract {
  const out: Contract = { id: String(c.id), symbol, tickSize: Number(c.tickSize), tickValue: Number(c.tickValue), name: String(c.name || c.id) };
  if (!(out.tickSize > 0) || !(out.tickValue > 0)) throw new Error(`ProjectX did not give tick details for ${symbol}.`);
  L.bySymbol.set(symbol, out); L.byId.set(out.id, out); subscribeAll(L);
  return out;
}
/** One live price stream per login. A stream that fails to open keeps retrying by itself, as before. */
function openMarket(L: Login): Promise<void> {
  if (L.market) return L.opening ?? Promise.resolve();
  const hub = new SignalRClient(L.rtc.replace(/\/$/, '') + '/hubs/market', () => L.token);
  hub.on('GatewayQuote', ([contractId, d]) => {
    const price = Number(d?.lastPrice);
    if (!Number.isFinite(price)) return;
    const id = String(contractId); L.last.set(id, price);
    const c = L.byId.get(id); if (!c) return;
    const q: Quote = { symbol: c.symbol, price, ts: Date.now() };
    for (const f of L.listeners) { try { f(q); } catch { /* one account's trouble must not stop the others' prices */ } }
  });
  hub.onOpen = () => { L.subscribed.clear(); subscribeAll(L); };   // also after every reconnect
  L.market = hub;
  const opening = hub.start().finally(() => { if (L.opening === opening) L.opening = null; });
  L.opening = opening;
  return opening;
}
/** History/retrieveBars: unit 2 = minute, 3 = hour, 4 = day; [unit, number, bars a day]. */
const U: Record<HistUnit, [number, number, number]> = { min1: [2, 1, 1380], min5: [2, 5, 276], min15: [2, 15, 92], hour: [3, 1, 22], hour4: [3, 4, 6], day: [4, 1, 0.66] };
const parseBars = (j: any): HistBar[] => ((j.bars || []) as any[]).map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 }))
  .filter(b => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite)).sort((a, b) => a.t - b.t);

export class ProjectXBroker implements BrokerAdapter {
  readonly id = 'projectx'; readonly name = 'TopstepX (ProjectX)';
  private L: Login | null = null; private accountId = 0;
  private cb: (q: Quote) => void = () => {};
  private hear = (q: Quote) => this.cb(q);
  // this account's short-lived copies (dropped as soon as Keel sends, changes or cancels an order here)
  private posC: { at: number; p: Promise<any[]> } | null = null;
  private ordC: { at: number; p: Promise<any[]> } | null = null;
  private realC: { at: number; key: string; p: Promise<number> } | null = null;
  private seenPos = 0; private seenOrd = 0; private sentAt = 0;

  constructor(private base = 'https://api.topstepx.com', private rtc = 'https://rtc.topstepx.com', private acct?: AccountRecord) { assertSafeUrl(base); assertSafeUrl(rtc); }

  private get login(): Login { if (!this.L) throw new Error('TopstepX is not connected.'); return this.L; }
  private call(path: string, body: unknown) { return call(this.login, path, body); }

  async connect(creds: Record<string, string>) {
    if (!creds.userName || !creds.apiKey) throw new Error('Save your TopstepX username and API key first.');
    if (this.L) await this.disconnect();
    const L = acquire(this.base, this.rtc, creds);
    try {
      if (!L.token) await signIn(L);
      const acct = (await accountList(L, 5000)).find((a: any) => a.canTrade && (!creds.accountId || String(a.id) === creds.accountId));
      if (!acct) throw new Error('No tradable account was found on this login.');
      this.accountId = acct.id; this.L = L; L.listeners.add(this.hear);
    } catch (e) { release(L); throw e; }
  }

  /** Every active account on this login (for the Accounts list). */
  async listAccounts(creds: Record<string, string>): Promise<{ id: string; name: string; balance: number; canTrade: boolean; simulated: boolean }[]> {
    if (!creds.userName || !creds.apiKey) throw new Error('Save your TopstepX username and API key first.');
    const L = acquire(this.base, this.rtc, creds);
    try {
      if (!L.token) await signIn(L);
      return (await accountList(L, 0)).map((a: any) => ({ id: String(a.id), name: String(a.name ?? a.id), balance: Number(a.balance), canTrade: !!a.canTrade, simulated: !!a.simulated }));
    } finally { release(L); }
  }

  async disconnect() { const L = this.L; if (!L) return; this.L = null; L.listeners.delete(this.hear); release(L); }
  onQuote(cb: (q: Quote) => void) { this.cb = cb; }

  /** The contract Keel trades for each market, e.g. { MNQ: 'MNQZ6' } (Topstep's active front month, looked up at Start). */
  contractNames(): Record<string, string> { return this.L ? Object.fromEntries([...this.L.bySymbol.entries()].map(([s, c]) => [s, c.name])) : {}; }
  /** Topstep's active contract (the list is looked up at most every 10 minutes per login; enough to spot the quarterly / gold roll). */
  async activeName(symbol: string): Promise<string> { return String(frontMonth(symbol, await searchContracts(this.login, symbol, 600_000)).name); }
  /** Switch a market to Topstep's new active contract, for every account on this login (only call while all are flat in it). */
  async rollTo(symbol: string): Promise<string> {
    const L = this.login, old = L.bySymbol.get(symbol), c = frontMonth(symbol, await searchContracts(L, symbol, 0));
    if (old && old.id !== String(c.id)) {
      try { L.market?.invoke('UnsubscribeContractQuotes', [old.id]); } catch { /* best effort */ }
      L.byId.delete(old.id); L.last.delete(old.id); L.bySymbol.delete(symbol); L.subscribed.delete(old.id);
      for (const k of [...L.hist.keys()]) if (k.startsWith(old.id + '|')) L.hist.delete(k);
    }
    return (await this.contractFor(symbol)).name;
  }
  private async contractFor(symbol: string): Promise<Contract> {
    const L = this.login, hit = L.bySymbol.get(symbol); if (hit) return hit;
    return remember(L, symbol, frontMonth(symbol, await searchContracts(L, symbol, 600_000)));
  }
  /** For positions opened outside Keel. */
  private async contractById(id: string): Promise<Contract> {
    const L = this.login, hit = L.byId.get(id); if (hit) return hit;
    const j = await this.call('/api/Contract/searchById', { contractId: id });
    if (!j.contract) throw new Error('You have a position Keel does not recognise. Close it or check it in TopstepX.');
    return remember(L, String(j.contract.name || id), j.contract);
  }

  /** Start the price feed again from scratch (a feed can go quiet without closing). The accounts on a login share it, so
   *  when several of them ask at once it is restarted once. */
  async resubscribe() {
    const L = this.login;
    if (L.market && Date.now() - L.restarted < 60_000) return;
    L.restarted = Date.now(); L.market?.stop(); L.market = null; L.opening = null; L.subscribed.clear();
    await openMarket(L);
  }
  async subscribe(symbols: string[]) {
    for (const s of symbols) { try { await this.contractFor(s); } catch { /* symbol may not exist; skip it */ } }
    await openMarket(this.login);
  }

  /** An order was sent, changed or cancelled here: the next look at positions, orders and P&L goes to TopstepX. */
  private touched() { this.posC = null; this.ordC = null; this.realC = null; this.sentAt = Date.now(); }
  /** Something is going on (a position, a working order, an order sent in the last 2 minutes): look every second.
   *  Flat with nothing working, nothing can change on its own, so every 10 seconds is enough. */
  private ttl() { return this.seenPos > 0 || this.seenOrd > 0 || Date.now() - this.sentAt < 120_000 ? 1000 : 10_000; }
  private positionsRaw(): Promise<any[]> {
    const now = Date.now(); if (this.posC && now - this.posC.at < this.ttl()) return this.posC.p;
    const p = this.call('/api/Position/searchOpen', { accountId: this.accountId }).then(j => { const l = (j.positions || []) as any[]; this.seenPos = l.length; return l; });
    const e = { at: now, p }; this.posC = e; p.catch(() => { if (this.posC === e) this.posC = null; });
    return p;
  }
  private ordersRaw(): Promise<any[]> {
    const now = Date.now(); if (this.ordC && now - this.ordC.at < this.ttl()) return this.ordC.p;
    const p = this.call('/api/Order/searchOpen', { accountId: this.accountId }).then(j => { const l = (j.orders || []) as any[]; this.seenOrd = l.length; return l; });
    const e = { at: now, p }; this.ordC = e; p.catch(() => { if (this.ordC === e) this.ordC = null; });
    return p;
  }
  /** Today's closed P&L: asked again when the positions change (a trade closed or opened) and at least every 15 seconds. */
  private realized(list: any[]): Promise<number> {
    const key = list.map(p => `${p.contractId}:${p.type}:${p.size}:${p.averagePrice}`).sort().join('|'), now = Date.now(), c = this.realC;
    if (c && c.key === key && now - c.at < 15_000) return c.p;
    const p = (async () => {
      const d = new Date();
      const t = await this.call('/api/Trade/search', { accountId: this.accountId, startTimestamp: sessionStart(d).toISOString(), endTimestamp: d.toISOString() });
      return ((t.trades || []) as any[]).reduce((sum: number, x: any) => sum + (Number(x.profitAndLoss) || 0) - (Number(x.fees) || 0), 0);
    })();
    const e = { at: now, key, p }; this.realC = e; p.catch(() => { if (this.realC === e) this.realC = null; });
    return p;
  }

  async placeOrder(o: Order) {
    if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error('Order size must be a whole number.');
    const c = await this.contractFor(o.symbol);
    // ProjectX order types: 1 = limit, 2 = market, 4 = stop. Side 0 = buy (bid), 1 = sell (ask).
    const type = o.type === 'limit' ? 1 : o.type === 'stop' ? 4 : o.type === 'stoplimit' ? 3 : 2;
    if (o.type === 'stoplimit' && !(Number.isFinite(o.trigger) && (o.trigger as number) > 0)) throw new Error('A stop-limit order needs a trigger price.');
    if (type !== 2 && !(Number.isFinite(o.price) && (o.price as number) > 0)) throw new Error(`A ${o.type} order needs a price.`);
    const px = type === 2 ? undefined : Math.round((o.price as number) / c.tickSize) * c.tickSize;
    try {
      const j = await this.call('/api/Order/place', { accountId: this.accountId, contractId: c.id, type, side: o.side === 'buy' ? 0 : 1, size: o.qty,
        ...(type === 1 ? { limitPrice: px } : type === 4 ? { stopPrice: px } : type === 3 ? { limitPrice: px, stopPrice: Math.round((o.trigger as number) / c.tickSize) * c.tickSize } : {}) });
      return String(j.orderId);
    } finally { this.touched(); }
  }

  async getPositions(): Promise<Position[]> {
    const list = await this.positionsRaw();
    // Report positions by Keel's symbol (e.g. MNQ), not ProjectX's contract id, so they match orders and strategies.
    // Position type: 1 = long, 2 = short.
    const out: Position[] = [];
    for (const p of list) {
      const c = await this.contractById(String(p.contractId));
      out.push({ symbol: c.symbol, qty: p.type === 2 ? -Number(p.size) : Number(p.size), avgPrice: Number(p.averagePrice) });
    }
    return out;
  }

  async closeAll() {
    let failed = 0;
    try {
      const orders = await this.call('/api/Order/searchOpen', { accountId: this.accountId });
      for (const o of orders.orders || []) { try { await this.call('/api/Order/cancel', { accountId: this.accountId, orderId: o.id }); } catch { failed++; } }
      const pos = await this.call('/api/Position/searchOpen', { accountId: this.accountId });
      for (const p of pos.positions || []) { try { await this.call('/api/Position/closeContract', { accountId: this.accountId, contractId: p.contractId }); } catch { failed++; } }
    } finally { this.touched(); }
    if (failed) throw new Error(`${failed} item(s) could not be closed.`);
  }

  async getPnLBreakdown() {
    const list = await this.positionsRaw(), realized = await this.realized(list), L = this.login;
    const positions: Position[] = [];
    for (const pos of list) {
      const c = await this.contractById(String(pos.contractId));
      const px = L.last.get(c.id);
      if (px === undefined) throw new Error('No live price yet for an open position.');
      const dir = pos.type === 2 ? -1 : 1;
      positions.push({ symbol: c.symbol, qty: dir * pos.size, avgPrice: Number(pos.averagePrice), pnl: dir * pos.size * ((px - Number(pos.averagePrice)) / c.tickSize) * c.tickValue });
    }
    return { realized, unrealized: positions.reduce((a, x) => a + (x.pnl || 0), 0), positions };
  }

  async getDailyPnL() { const b = await this.getPnLBreakdown(); return b.realized + b.unrealized; }

  lastPrice(symbol: string) { const L = this.L, c = L?.bySymbol.get(symbol); return c ? L!.last.get(c.id) : undefined; }

  /** Bars for the front-month contract (at most 20,000). Completed bars only, unless `partial` (the chart wants the bar
   *  that is still forming). Completed bars are kept per login and topped up, so an hourly check downloads a few new bars. */
  async getHistory(symbol: string, unit: HistUnit, count: number, partial = false): Promise<HistBar[]> {
    const c = await this.contractFor(symbol);
    if (partial) return this.bars(c, unit, count, true);
    return cachedHistory(this.login.hist, `${c.id}|${unit}`, unit, count, n => this.bars(c, unit, n, false), (from, n) => this.barsFrom(c, unit, from, n));
  }
  private async bars(c: Contract, unit: HistUnit, count: number, partial: boolean): Promise<HistBar[]> {
    const [u, n, perDay] = U[unit], end = new Date(), days = Math.ceil(count / perDay) + (unit === 'day' ? 14 : unit === 'hour' || unit === 'hour4' ? 14 : 5);
    const j = await this.call('/api/History/retrieveBars', { contractId: c.id, live: false, startTime: new Date(end.getTime() - days * 86_400_000).toISOString(),
      endTime: end.toISOString(), unit: u, unitNumber: n, limit: Math.min(20_000, count), includePartialBar: partial });
    return parseBars(j).slice(-count);
  }
  private async barsFrom(c: Contract, unit: HistUnit, from: number, limit: number): Promise<HistBar[]> {
    const [u, n] = U[unit];
    const j = await this.call('/api/History/retrieveBars', { contractId: c.id, live: false, startTime: new Date(from).toISOString(),
      endTime: new Date().toISOString(), unit: u, unitNumber: n, limit: Math.min(20_000, limit), includePartialBar: false });
    return parseBars(j);
  }

  async getOpenOrders(): Promise<WorkingOrder[]> {
    const list = await this.ordersRaw();
    const out: WorkingOrder[] = [];
    for (const o of list) {
      const c = await this.contractById(String(o.contractId));
      out.push({ id: String(o.id), symbol: c.symbol, side: o.side === 0 ? 'buy' : 'sell', qty: Number(o.size),
        type: o.type === 1 ? 'limit' : o.type === 4 ? 'stop' : o.type === 2 ? 'market' : 'other', price: o.type === 1 ? Number(o.limitPrice) : o.type === 4 ? Number(o.stopPrice) : null });
    }
    return out;
  }
  async modifyOrder(id: string, change: { price: number }) {
    this.ordC = null;                                   // the order as it is now, not a copy
    const o = (await this.getOpenOrders()).find(x => x.id === id);
    if (!o) throw new Error('That order is no longer working.');
    const c = await this.contractFor(o.symbol), px = Math.round(change.price / c.tickSize) * c.tickSize;
    try { await this.call('/api/Order/modify', { accountId: this.accountId, orderId: Number(id), ...(o.type === 'stop' ? { stopPrice: px } : { limitPrice: px }) }); }
    finally { this.touched(); }
  }
  async cancelOrder(id: string) { try { await this.call('/api/Order/cancel', { accountId: this.accountId, orderId: Number(id) }); } finally { this.touched(); } }

  /** Balance from the account list (the `balance` field is from third-party clients, not yet checked). Rules come from your account in Keel.
   *  The list holds every account on the login, so the accounts share one look-up (at most every 15 seconds). */
  async getAccount(): Promise<AccountInfo | null> {
    const a = (await accountList(this.login, 15_000)).find((x: any) => x.id === this.accountId);
    if (!a || typeof a.balance !== 'number') return null;
    const size = this.acct?.size || 50000;
    return { name: String(a.name ?? this.acct?.label ?? 'TopstepX'), size, startBalance: size, balance: a.balance, maxLoss: this.acct?.maxLoss ?? 0, days: [] };
  }
}

/** Futures trading day starts at 5pm Chicago time. */
export function sessionStart(now: Date): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(now).map(x => [x.type, x.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = local - now.getTime();
  let start = Date.UTC(+parts.year, +parts.month - 1, +parts.day, 17, 0, 0);
  if (local < start) start -= 86_400_000;
  return new Date(start - offset);
}
