import { AccountInfo, BrokerAdapter, Order, Position, Quote } from '../core/types';
import type { AccountRecord } from '../core/accounts';
import { assertSafeUrl } from '../core/net';
import { SignalRClient } from './signalr';

interface Contract { id: string; symbol: string; tickSize: number; tickValue: number }

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
 */
export class ProjectXBroker implements BrokerAdapter {
  readonly id = 'projectx'; readonly name = 'TopstepX (ProjectX)';
  private token = ''; private accountId = 0;
  private creds: Record<string, string> = {};
  private bySymbol = new Map<string, Contract>();
  private byId = new Map<string, Contract>();
  private last = new Map<string, number>();
  private market?: SignalRClient;
  private cb: (q: Quote) => void = () => {};

  constructor(private base = 'https://api.topstepx.com', private rtc = 'https://rtc.topstepx.com', private acct?: AccountRecord) { assertSafeUrl(base); assertSafeUrl(rtc); }

  private async raw(path: string, body: unknown, auth: boolean): Promise<any> {
    const res = await fetch(this.base + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', accept: 'text/plain', ...(auth ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body)
    });
    if (res.status === 401 && auth) throw Object.assign(new Error('expired'), { expired: true });
    if (!res.ok) throw new Error(`ProjectX request failed (${res.status}).`);
    const j: any = await res.json();
    if (j.success === false) throw new Error(`ProjectX rejected the request (code ${j.errorCode}).`);
    return j;
  }

  private async call(path: string, body: unknown): Promise<any> {
    try { return await this.raw(path, body, true); }
    catch (e: any) { if (!e.expired) throw e; await this.login(); return this.raw(path, body, true); } // tokens last 24 hours
  }

  private async login() {
    let j: any;
    try { j = await this.raw('/api/Auth/loginKey', { userName: this.creds.userName, apiKey: this.creds.apiKey }, false); }
    catch { throw new Error('ProjectX did not accept that username and API key.'); }
    if (typeof j.token !== 'string' || !j.token) throw new Error('ProjectX did not return a session.');
    this.token = j.token;
  }

  async connect(creds: Record<string, string>) {
    if (!creds.userName || !creds.apiKey) throw new Error('Save your TopstepX username and API key first.');
    this.creds = creds;
    await this.login();
    const j = await this.call('/api/Account/search', { onlyActiveAccounts: true });
    const acct = (j.accounts || []).find((a: any) => a.canTrade && (!creds.accountId || String(a.id) === creds.accountId));
    if (!acct) throw new Error('No tradable account was found on this login.');
    this.accountId = acct.id;
  }

  async disconnect() { this.market?.stop(); this.market = undefined; this.token = ''; }
  onQuote(cb: (q: Quote) => void) { this.cb = cb; }

  private remember(symbol: string, c: any): Contract {
    const out: Contract = { id: String(c.id), symbol, tickSize: Number(c.tickSize), tickValue: Number(c.tickValue) };
    if (!(out.tickSize > 0) || !(out.tickValue > 0)) throw new Error(`ProjectX did not give tick details for ${symbol}.`);
    this.bySymbol.set(symbol, out); this.byId.set(out.id, out);
    if (this.market) this.market.invoke('SubscribeContractQuotes', [out.id]);
    return out;
  }

  private async contractFor(symbol: string): Promise<Contract> {
    const hit = this.bySymbol.get(symbol); if (hit) return hit;
    const j = await this.call('/api/Contract/search', { searchText: symbol, live: false });
    const list: any[] = j.contracts || [];
    const c = list.find(x => x.activeContract) ?? list[0];
    if (!c || typeof c.id !== 'string') throw new Error(`ProjectX has no contract for ${symbol}.`);
    return this.remember(symbol, c);
  }

  /** For positions opened outside Keel. */
  private async contractById(id: string): Promise<Contract> {
    const hit = this.byId.get(id); if (hit) return hit;
    const j = await this.call('/api/Contract/searchById', { contractId: id });
    if (!j.contract) throw new Error('You have a position Keel does not recognise. Close it or check it in TopstepX.');
    return this.remember(String(j.contract.name || id), j.contract);
  }

  async subscribe(symbols: string[]) {
    for (const s of symbols) { try { await this.contractFor(s); } catch { /* symbol may not exist; skip it */ } }
    const hub = new SignalRClient(this.rtc.replace(/\/$/, '') + '/hubs/market', () => this.token);
    hub.on('GatewayQuote', ([contractId, d]) => {
      const price = Number(d?.lastPrice);
      if (!Number.isFinite(price)) return;
      this.last.set(String(contractId), price);
      const c = this.byId.get(String(contractId));
      if (c) this.cb({ symbol: c.symbol, price, ts: Date.now() });
    });
    hub.onOpen = () => { for (const c of this.byId.values()) hub.invoke('SubscribeContractQuotes', [c.id]); };  // also after every reconnect
    this.market = hub;
    await hub.start();
  }

  async placeOrder(o: Order) {
    if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error('Order size must be a whole number.');
    const contractId = (await this.contractFor(o.symbol)).id;
    // type 2 = market, side 0 = buy, side 1 = sell
    const j = await this.call('/api/Order/place', { accountId: this.accountId, contractId, type: 2, side: o.side === 'buy' ? 0 : 1, size: o.qty });
    return String(j.orderId);
  }

  async getPositions(): Promise<Position[]> {
    const j = await this.call('/api/Position/searchOpen', { accountId: this.accountId });
    return (j.positions || []).map((p: any) => ({ symbol: String(p.contractId), qty: p.type === 2 ? -p.size : p.size, avgPrice: Number(p.averagePrice) }));
  }

  async closeAll() {
    let failed = 0;
    const orders = await this.call('/api/Order/searchOpen', { accountId: this.accountId });
    for (const o of orders.orders || []) { try { await this.call('/api/Order/cancel', { accountId: this.accountId, orderId: o.id }); } catch { failed++; } }
    const pos = await this.call('/api/Position/searchOpen', { accountId: this.accountId });
    for (const p of pos.positions || []) { try { await this.call('/api/Position/closeContract', { accountId: this.accountId, contractId: p.contractId }); } catch { failed++; } }
    if (failed) throw new Error(`${failed} item(s) could not be closed.`);
  }

  async getPnLBreakdown() {
    const now = new Date();
    const t = await this.call('/api/Trade/search', { accountId: this.accountId, startTimestamp: sessionStart(now).toISOString(), endTimestamp: now.toISOString() });
    const realized = (t.trades || []).reduce((sum: number, x: any) => sum + (Number(x.profitAndLoss) || 0) - (Number(x.fees) || 0), 0);
    const p = await this.call('/api/Position/searchOpen', { accountId: this.accountId });
    const positions: Position[] = [];
    for (const pos of p.positions || []) {
      const c = await this.contractById(String(pos.contractId));
      const px = this.last.get(c.id);
      if (px === undefined) throw new Error('No live price yet for an open position.');
      const dir = pos.type === 2 ? -1 : 1;
      positions.push({ symbol: c.symbol, qty: dir * pos.size, avgPrice: Number(pos.averagePrice), pnl: dir * pos.size * ((px - Number(pos.averagePrice)) / c.tickSize) * c.tickValue });
    }
    return { realized, unrealized: positions.reduce((a, x) => a + (x.pnl || 0), 0), positions };
  }

  async getDailyPnL() { const b = await this.getPnLBreakdown(); return b.realized + b.unrealized; }

  /** Balance from the account list (the `balance` field is from third-party clients, not yet checked). Rules come from your account in Keel. */
  async getAccount(): Promise<AccountInfo | null> {
    const j = await this.call('/api/Account/search', { onlyActiveAccounts: true });
    const a = (j.accounts || []).find((x: any) => x.id === this.accountId);
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
