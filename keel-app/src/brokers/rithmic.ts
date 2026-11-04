/**
 * Rithmic (R | Protocol API: WebSockets + Google protocol buffers) for Lucid Trading and other Rithmic prop accounts.
 * Four connections ("plants") per login, as Rithmic designs it:
 *   ORDER plant   account list, trade routes, orders and order updates
 *   TICKER plant  live trades (last price) and front-month contract lookup
 *   HISTORY plant time bars for the strategies and the chart
 *   PNL plant     positions, P&L and account balance
 * The protocol files come from Rithmic's dev kit, which is licensed to you and is NOT in this repository: put the kit's
 * `proto` folder (plus base.proto from its samples) in keel-app/vendor/rithmic/proto; `npm run build` copies it into the app.
 * Every request carries a user_msg tag so its responses can be matched; a response with rp_code ends a request.
 * TLS: the gateway's certificate is checked normally (the dev kit's samples switch checking off; Keel does not).
 */
import * as path from 'path';
import * as fs from 'fs';
import WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import { AccountInfo, BrokerAdapter, HistBar, HistUnit, Order, Position, Quote, WorkingOrder } from '../core/types';
import type { AccountRecord } from '../core/accounts';

const APP = { name: 'Keel', version: '0.6.0' };
const TEMPLATE_VERSION = '5.55';
const DEFAULT_GATEWAY = 'wss://rituz00100.rithmic.com:443', DEFAULT_SYSTEM = 'Rithmic Test';
const EXCHANGE: Record<string, string> = { NQ: 'CME', MNQ: 'CME', ES: 'CME', MES: 'CME', RTY: 'CME', M2K: 'CME', YM: 'CBOT', MYM: 'CBOT', GC: 'COMEX', MGC: 'COMEX', SI: 'COMEX', CL: 'NYMEX', MCL: 'NYMEX' };
const INFRA = { TICKER: 1, ORDER: 2, HISTORY: 3, PNL: 4 } as const;
/** Responses (matched to a request by user_msg). */
const RESPONSE: Record<number, string> = {
  11: 'ResponseLogin', 13: 'ResponseLogout', 17: 'ResponseRithmicSystemInfo', 19: 'ResponseHeartbeat', 101: 'ResponseMarketDataUpdate', 114: 'ResponseFrontMonthContract',
  203: 'ResponseTimeBarReplay', 301: 'ResponseLoginInfo', 303: 'ResponseAccountList', 309: 'ResponseSubscribeForOrderUpdates', 311: 'ResponseTradeRoutes',
  313: 'ResponseNewOrder', 315: 'ResponseModifyOrder', 317: 'ResponseCancelOrder', 321: 'ResponseShowOrders', 347: 'ResponseCancelAllOrders', 3505: 'ResponseExitPosition',
  401: 'ResponsePnLPositionUpdates', 403: 'ResponsePnLPositionSnapshot'
};
/** Updates the server pushes on its own. */
const PUSH: Record<number, string> = { 75: 'Reject', 77: 'ForcedLogout', 150: 'LastTrade', 351: 'RithmicOrderNotification', 352: 'ExchangeOrderNotification', 450: 'InstrumentPnLPositionUpdate', 451: 'AccountPnLPositionUpdate' };

let ROOT: protobuf.Root | null = null;
/** The dev kit's protocol files, bundled into Keel at build time (never in git). */
export function rithmicProtoDir(): string | null {
  for (const d of [path.join(__dirname, '..', 'rithmic-proto'), path.join(__dirname, '..', '..', 'vendor', 'rithmic', 'proto'), process.env.KEEL_RITHMIC_PROTO ?? ''])
    if (d && fs.existsSync(path.join(d, 'base.proto'))) return d;
  return null;
}
function root(): protobuf.Root {
  if (ROOT) return ROOT;
  const dir = rithmicProtoDir();
  if (!dir) throw new Error("Rithmic's protocol files are not installed in this copy of Keel.");
  const r = new protobuf.Root();
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.proto'))) r.loadSync(path.join(dir, f), { keepCase: false });
  ROOT = r; return r;
}
const T = (name: string) => root().lookupType(name);
/** Only when a proxy is configured (e.g. a locked-down network); a normal PC connects directly. */
function proxyAgent(): any {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy; if (!proxy) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { HttpsProxyAgent } = require('https-proxy-agent'); return new HttpsProxyAgent(proxy);
}
const ok = (m: any) => Array.isArray(m.rpCode) && m.rpCode.length > 0 && m.rpCode[0] === '0';
const errText = (m: any) => (m.rpCode?.length > 1 ? `${m.rpCode[1]} (code ${m.rpCode[0]})` : `code ${m.rpCode?.[0] ?? '?'}`);
const num = (x: unknown) => (x === undefined || x === null || x === '' ? NaN : Number(x));
/** Keel's symbol for a Rithmic contract: MNQZ6 -> MNQ, GCG7 -> GC. */
const rootOf = (sym: string) => sym.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '');

class Plant {
  private ws: WebSocket | null = null; private seq = 0; private hb?: ReturnType<typeof setInterval>;
  private pending = new Map<string, { msgs: any[]; resolve: (m: any[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onPush: (name: string, msg: any) => void = () => {};
  onClose: (why: string) => void = () => {};
  login: any = null;
  constructor(readonly infra: number, private url: string) {}

  async open(creds: { user: string; password: string; system: string }) {
    this.ws = new WebSocket(this.url, { agent: proxyAgent(), handshakeTimeout: 15_000 });
    await new Promise<void>((res, rej) => { this.ws!.once('open', () => res()); this.ws!.once('error', e => rej(new Error(`Could not reach Rithmic (${e.message}).`))); });
    this.ws.on('message', (d: Buffer) => this.receive(d));
    this.ws.on('close', (_c, reason) => { clearInterval(this.hb); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Rithmic connection closed.')); } this.pending.clear(); this.onClose(reason?.toString() || 'closed'); });
    const r = (await this.request('RequestLogin', { templateId: 10, templateVersion: TEMPLATE_VERSION, user: creds.user, password: creds.password,
      appName: APP.name, appVersion: APP.version, systemName: creds.system, infraType: this.infra }))[0];
    this.login = r;
    const every = Math.max(5, Math.min(60, num(r.heartbeatInterval) || 30)) * 1000 * 0.8;
    this.hb = setInterval(() => this.send('RequestHeartbeat', { templateId: 18 }), every); (this.hb as any).unref?.();
  }
  send(type: string, payload: object) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Rithmic is not connected.');
    const t = T(type); this.ws.send(t.encode(t.create(payload)).finish());
  }
  /** One request; resolves with every response message (several for lists), rejects on a bad rp_code. */
  request(type: string, payload: Record<string, unknown>, timeoutMs = 20_000): Promise<any[]> {
    const tag = `k${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(tag); reject(new Error(`Rithmic did not answer (${type}).`)); }, timeoutMs);
      this.pending.set(tag, { msgs: [], resolve, reject, timer });
      try { this.send(type, { ...payload, userMsg: [tag] }); } catch (e) { clearTimeout(timer); this.pending.delete(tag); reject(e as Error); }
    });
  }
  private receive(d: Buffer) {
    let tid: number;
    try { tid = (T('Base').decode(d) as any).templateId; } catch { return; }
    const rname = RESPONSE[tid];
    if (rname) {
      const m: any = T(rname).decode(d), tag = m.userMsg?.[0], p = tag ? this.pending.get(tag) : undefined;
      if (!p) return;
      if (m.rpCode && m.rpCode.length) {               // last message of this request
        clearTimeout(p.timer); this.pending.delete(tag);
        if (ok(m)) { p.msgs.push(m); p.resolve(p.msgs); } else p.reject(new Error(`Rithmic: ${errText(m)}`));
      } else p.msgs.push(m);                           // one row of a multi-message answer
      return;
    }
    const pname = PUSH[tid];
    if (pname) this.onPush(pname, T(pname).decode(d));
  }
  async close() {
    clearInterval(this.hb);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { try { await this.request('RequestLogout', { templateId: 12 }, 5000); } catch { /* closing anyway */ } this.ws.close(1000, 'bye'); }
    this.ws = null;
  }
}

interface ROrder { basketId: string; symbol: string; root: string; exchange: string; side: 'buy' | 'sell'; qty: number; type: WorkingOrder['type']; price: number | null; status: string; working: boolean }

export class RithmicBroker implements BrokerAdapter {
  readonly id = 'rithmic'; readonly name = 'Rithmic';
  private plants: Partial<Record<keyof typeof INFRA, Plant>> = {};
  private fcmId = ''; private ibId = ''; private accountId = ''; private accountName = '';
  private routes = new Map<string, string>();                 // exchange -> trade route
  private front = new Map<string, { symbol: string; exchange: string }>();
  private last = new Map<string, number>();                   // root -> last trade price
  private orders = new Map<string, ROrder>();
  private positions = new Map<string, { qty: number; avg: number; open: number; closed: number }>();
  private acct: { balance: number; dayPnl: number; open: number; closed: number } | null = null;
  private quoteCbs: ((q: Quote) => void)[] = [];
  private markerIsEnd: boolean | null = null;
  accounts: { id: string; name: string }[] = [];
  error = '';

  constructor(private acctRec?: AccountRecord) {}

  async connect(creds: Record<string, string>) {
    const user = (creds.user || '').trim(), password = creds.password || '';
    if (!user || !password) throw new Error('Enter your Rithmic username and password under Logins.');
    const gateway = (creds.gateway || '').trim() || DEFAULT_GATEWAY, system = (creds.system || '').trim() || DEFAULT_SYSTEM;
    if (!/^wss:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(gateway)) throw new Error('The Rithmic gateway must look like wss://name.rithmic.com:443');
    const c = { user, password, system };
    const order = new Plant(INFRA.ORDER, gateway);
    await order.open(c);
    this.plants.ORDER = order;
    this.fcmId = order.login.fcmId || ''; this.ibId = order.login.ibId || '';
    // accounts: pick the one this Keel account is linked to (brokerRef), else the first
    const rows = await order.request('RequestAccountList', { templateId: 302, fcmId: this.fcmId, ibId: this.ibId, userType: 3 });
    this.accounts = rows.filter(r => r.accountId).map(r => ({ id: r.accountId, name: r.accountName || r.accountId }));
    if (!this.accounts.length) throw new Error('This Rithmic login has no trading accounts.');
    const want = creds.accountId || this.acctRec?.brokerRef || '';
    const a = this.accounts.find(x => x.id === want) ?? this.accounts[0];
    this.accountId = a.id; this.accountName = a.name;
    for (const r of await order.request('RequestTradeRoutes', { templateId: 310, subscribeForUpdates: false }))
      if (r.exchange && r.tradeRoute && r.fcmId === this.fcmId && r.ibId === this.ibId && (!this.routes.has(r.exchange) || r.isDefault)) this.routes.set(r.exchange, r.tradeRoute);
    order.onPush = (n, m) => this.onOrderPush(n, m);
    await order.request('RequestSubscribeForOrderUpdates', { templateId: 308, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId });
    // the other three plants
    const [tick, hist, pnl] = [new Plant(INFRA.TICKER, gateway), new Plant(INFRA.HISTORY, gateway), new Plant(INFRA.PNL, gateway)];
    await Promise.all([tick.open(c), hist.open(c), pnl.open(c)]);
    this.plants.TICKER = tick; this.plants.HISTORY = hist; this.plants.PNL = pnl;
    tick.onPush = (n, m) => { if (n === 'LastTrade' && Number.isFinite(m.tradePrice)) { const r = rootOf(m.symbol); this.last.set(r, m.tradePrice); for (const cb of this.quoteCbs) cb({ symbol: r, price: m.tradePrice, ts: Date.now() }); } };
    pnl.onPush = (n, m) => this.onPnl(n, m);
    for (const p of Object.values(this.plants)) p!.onClose = why => { this.error = `Rithmic disconnected (${why}).`; };
    await pnl.request('RequestPnLPositionUpdates', { templateId: 400, request: 1, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId });
    for (const m of await pnl.request('RequestPnLPositionSnapshot', { templateId: 402, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId })) void m;
    for (const m of await order.request('RequestShowOrders', { templateId: 320, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId })) void m;   // replays working orders
  }

  async disconnect() { await Promise.all(Object.values(this.plants).map(p => p!.close())); this.plants = {}; }

  // ---------- symbols and prices ----------
  private async contract(sym: string): Promise<{ symbol: string; exchange: string }> {
    const hit = this.front.get(sym); if (hit) return hit;
    const exchange = EXCHANGE[sym]; if (!exchange) throw new Error(`Keel doesn't know which exchange ${sym} trades on.`);
    const r = (await this.plants.TICKER!.request('RequestFrontMonthContract', { templateId: 113, symbol: sym, exchange, needUpdates: false })).slice(-1)[0];
    const c = { symbol: r.tradingSymbol || r.symbol, exchange: r.tradingExchange || r.exchange || exchange };
    if (!c.symbol) throw new Error(`Rithmic has no front-month contract for ${sym}.`);
    this.front.set(sym, c); return c;
  }
  async subscribe(symbols: string[]) {
    for (const s of symbols) {
      if (!EXCHANGE[s]) continue;
      const c = await this.contract(s);
      await this.plants.TICKER!.request('RequestMarketDataUpdate', { templateId: 100, symbol: c.symbol, exchange: c.exchange, request: 1, updateBits: 1 });
    }
  }
  onQuote(cb: (q: Quote) => void) { this.quoteCbs.push(cb); }
  lastPrice(sym: string) { return this.last.get(sym); }

  // ---------- history ----------
  async getHistory(sym: string, unit: HistUnit, count: number, partial = false): Promise<HistBar[]> {
    const P: Record<HistUnit, [number, number, number]> = { min1: [2, 1, 60], min5: [2, 5, 300], min15: [2, 15, 900], hour: [2, 60, 3600], hour4: [2, 240, 14400], day: [3, 1, 86400] };
    const [barType, period, sec] = P[unit], c = await this.contract(sym), now = Math.floor(Date.now() / 1000);
    const span = unit === 'day' ? count * 1.6 * 86400 : (count / (unit === 'hour4' ? 6 : 23 * 3600 / sec)) * 86400 * 1.45 + 4 * 86400;
    const rows = await this.plants.HISTORY!.request('RequestTimeBarReplay', { templateId: 202, symbol: c.symbol, exchange: c.exchange, barType, barTypePeriod: period,
      startIndex: Math.floor(now - span), finishIndex: now, userMaxCount: Math.min(10_000, count + 5), direction: 2, timeOrder: 1 }, 60_000);
    const raw = rows.filter(r => Number.isFinite(r.marker) && r.marker > 0 && Number.isFinite(r.openPrice));
    if (this.markerIsEnd === null && raw.length && unit !== 'day') {
      // Is a bar stamped with its start or its end? The newest completed 1-period bar tells us.
      const m = raw[raw.length - 1].marker; this.markerIsEnd = m % sec === 0 && m > now - sec && m <= now + 2 ? true : false;
    }
    const shift = unit !== 'day' && this.markerIsEnd ? sec : 0;
    const bars = raw.map(r => ({ t: (r.marker - shift) * 1000, o: r.openPrice, h: r.highPrice, l: r.lowPrice, c: r.closePrice, v: Number(r.volume ?? 0) }))
      .filter(b => partial || b.t + sec * 1000 <= Date.now()).sort((a, b) => a.t - b.t);
    return bars.filter((b, i) => i === 0 || b.t !== bars[i - 1].t).slice(-count);
  }

  // ---------- orders ----------
  async placeOrder(o: Order): Promise<string> {
    if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error('Order size must be a whole number.');
    const c = await this.contract(o.symbol), route = this.routes.get(c.exchange);
    if (!route) throw new Error(`No Rithmic trade route for ${c.exchange} on this account.`);
    const priceType = o.type === 'market' ? 2 : o.type === 'limit' ? 1 : 4;
    if (o.type !== 'market' && !(Number.isFinite(o.price) && (o.price as number) > 0)) throw new Error(`A ${o.type} order needs a price.`);
    const r = (await this.plants.ORDER!.request('RequestNewOrder', { templateId: 312, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId,
      symbol: c.symbol, exchange: c.exchange, quantity_64: o.qty, transactionType: o.side === 'buy' ? 1 : 2, duration: 1, priceType, tradeRoute: route, manualOrAuto: 2,
      ...(o.type === 'limit' ? { price: o.price } : o.type === 'stop' ? { triggerPrice: o.price } : {}) })).find(m => m.basketId);
    if (!r?.basketId) throw new Error('Rithmic accepted the order but returned no order id.');
    this.orders.set(r.basketId, { basketId: r.basketId, symbol: c.symbol, root: o.symbol, exchange: c.exchange, side: o.side, qty: o.qty, type: o.type,
      price: o.type === 'market' ? null : (o.price as number), status: 'sent', working: o.type !== 'market' });
    return r.basketId;
  }
  async getOpenOrders(): Promise<WorkingOrder[]> {
    return [...this.orders.values()].filter(o => o.working).map(o => ({ id: o.basketId, symbol: o.root, side: o.side, qty: o.qty, type: o.type, price: o.price }));
  }
  async modifyOrder(id: string, change: { price: number }) {
    const o = this.orders.get(id); if (!o || !o.working) throw new Error('That order is no longer working.');
    await this.plants.ORDER!.request('RequestModifyOrder', { templateId: 314, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId, basketId: id, symbol: o.symbol, exchange: o.exchange,
      quantity_64: o.qty, priceType: o.type === 'limit' ? 1 : 4, manualOrAuto: 2, ...(o.type === 'limit' ? { price: change.price } : { triggerPrice: change.price }) });
    o.price = change.price;
  }
  async cancelOrder(id: string) {
    await this.plants.ORDER!.request('RequestCancelOrder', { templateId: 316, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId, basketId: id, manualOrAuto: 2 });
  }
  async closeAll() {
    await this.plants.ORDER!.request('RequestCancelAllOrders', { templateId: 346, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId }).catch(() => {});
    await this.plants.ORDER!.request('RequestExitPosition', { templateId: 3504, fcmId: this.fcmId, ibId: this.ibId, accountId: this.accountId, manualOrAuto: 2 });
  }
  private onOrderPush(name: string, m: any) {
    if (name === 'ForcedLogout') { this.error = 'Rithmic logged Keel out (this login may be in use elsewhere).'; return; }
    if (name !== 'RithmicOrderNotification' || !m.basketId || (m.accountId && m.accountId !== this.accountId)) return;
    const status = String(m.status || '').toLowerCase(), done = m.notifyType === 15 || /complete|cancel|reject|filled/.test(status);
    const pt = m.priceType === 1 ? 'limit' : m.priceType === 4 || m.priceType === 3 ? 'stop' : m.priceType === 2 ? 'market' : 'other';
    const cur = this.orders.get(m.basketId);
    const o: ROrder = cur ?? { basketId: m.basketId, symbol: m.symbol, root: rootOf(m.symbol || ''), exchange: m.exchange, side: m.transactionType === 1 ? 'buy' : 'sell',
      qty: num(m.quantity_64 ?? m.quantity) || 0, type: pt, price: null, status, working: false };
    o.status = status || o.status;
    const px = pt === 'stop' ? num(m.triggerPrice) : num(m.price); if (Number.isFinite(px) && px > 0) o.price = px;
    o.working = !done && pt !== 'market' && (m.notifyType === 13 || m.notifyType === 14 || m.notifyType === 18 || /open|trigger|pending/.test(status));
    this.orders.set(o.basketId, o);
    if (this.orders.size > 2000) for (const [k, v] of this.orders) { if (!v.working) this.orders.delete(k); if (this.orders.size < 1500) break; }
  }

  // ---------- positions, P&L, account ----------
  private onPnl(name: string, m: any) {
    if (m.accountId && m.accountId !== this.accountId) return;
    if (name === 'InstrumentPnLPositionUpdate' && m.symbol) {
      this.positions.set(rootOf(m.symbol), { qty: num(m.netQuantity ?? (num(m.buyQty) - num(m.sellQty))) || 0, avg: num(m.avgOpenFillPrice),
        open: num(m.openPositionPnl) || 0, closed: num(m.closedPositionPnl) || 0 });
    } else if (name === 'AccountPnLPositionUpdate') {
      this.acct = { balance: num(m.accountBalance), dayPnl: num(m.dayPnl), open: num(m.openPositionPnl) || 0, closed: num(m.closedPositionPnl) || 0 };
    }
  }
  async getPositions(): Promise<Position[]> {
    return [...this.positions].filter(([, p]) => p.qty !== 0).map(([symbol, p]) => ({ symbol, qty: p.qty, avgPrice: p.avg, pnl: p.open }));
  }
  async getPnLBreakdown() {
    const a = this.acct, positions = await this.getPositions();
    if (!a) throw new Error("Rithmic hasn't sent today's P&L yet.");
    return { realized: a.closed, unrealized: a.open, positions };
  }
  async getDailyPnL() { const b = await this.getPnLBreakdown(); return Number.isFinite(this.acct!.dayPnl) ? this.acct!.dayPnl : b.realized + b.unrealized; }
  async getAccount(): Promise<AccountInfo | null> {
    if (!this.acct || !Number.isFinite(this.acct.balance)) return null;
    const size = this.acctRec?.size || 50000;
    return { name: this.accountName, size, startBalance: size, balance: this.acct.balance, maxLoss: this.acctRec?.maxLoss || 2000, days: [] };
  }
}

/** Every account a Rithmic login can trade (for the Accounts list). Connects the order plant only. */
export async function listRithmicAccounts(creds: Record<string, string>): Promise<{ id: string; name: string }[]> {
  const gateway = (creds.gateway || '').trim() || DEFAULT_GATEWAY, system = (creds.system || '').trim() || DEFAULT_SYSTEM;
  const p = new Plant(INFRA.ORDER, gateway);
  try {
    await p.open({ user: creds.user, password: creds.password, system });
    const rows = await p.request('RequestAccountList', { templateId: 302, fcmId: p.login.fcmId, ibId: p.login.ibId, userType: 3 });
    return rows.filter(r => r.accountId).map(r => ({ id: r.accountId, name: r.accountName || r.accountId }));
  } finally { await p.close(); }
}
/** The systems a gateway offers (no login needed). */
export async function listRithmicSystems(gateway = DEFAULT_GATEWAY): Promise<string[]> {
  const ws = new WebSocket(gateway, { agent: proxyAgent(), handshakeTimeout: 15_000 });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', e => rej(e)); });
  const t = T('RequestRithmicSystemInfo'); ws.send(t.encode(t.create({ templateId: 16, userMsg: ['keel'] })).finish());
  const d: Buffer = await new Promise((res, rej) => { ws.once('message', res); setTimeout(() => rej(new Error('Rithmic did not answer.')), 15_000); });
  ws.close(); const r: any = T('ResponseRithmicSystemInfo').decode(d); return r.systemName ?? [];
}
