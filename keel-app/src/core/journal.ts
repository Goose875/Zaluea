import { mult } from './contracts';

/** One finished trade, as Keel saw it. Exit prices are the stop / target level, or the last price for a forced exit
 *  (approx = true), so the P&L can differ from the broker's by slippage and fees. */
export interface ClosedTrade {
  uid: string;
  account: string; accountId: string; mode: 'paper' | 'live';
  system: 'K' | 'PO3/Fractal' | 'chart' | 'AI';
  id: string; sym: string; orderSym: string; dir: 'long' | 'short'; qty: number;
  entry: number; exit: number | null; how: 'stop' | 'target' | 'forced' | 'flatten';
  why: string; approx: boolean; pnl: number | null;
  openedAt: number; closedAt: number;
  note: string; tags: string[];
}
/** What a trading system hands over when a trade closes; the journal adds the account, uid and P&L. */
export type CloseReport = Pick<ClosedTrade, 'id' | 'sym' | 'orderSym' | 'dir' | 'qty' | 'entry' | 'exit' | 'how' | 'why' | 'approx' | 'openedAt' | 'closedAt'> & { system?: ClosedTrade['system'] };

export const systemOf = (id: string): ClosedTrade['system'] => (id === 'MANUAL' ? 'chart' : id === 'AI' ? 'AI' : /^K[1-7]$/.test(id) ? 'K' : 'PO3/Fractal');
export function pnlOf(dir: 'long' | 'short', entry: number, exit: number | null, qty: number, orderSym: string): number | null {
  if (exit === null || !Number.isFinite(exit) || !Number.isFinite(entry)) return null;
  return Math.round((exit - entry) * (dir === 'long' ? 1 : -1) * qty * mult(orderSym) * 100) / 100;
}

export interface Stats {
  trades: number; counted: number; wins: number; losses: number; flat: number; winRate: number;
  net: number; grossWin: number; grossLoss: number; profitFactor: number | null;
  avgWin: number; avgLoss: number; expectancy: number; best: number; worst: number;
  maxDrawdown: number; longestLosing: number;
  bySystem: { key: string; trades: number; net: number; winRate: number }[];
  byStrategy: { key: string; trades: number; net: number; winRate: number }[];
  byDay: { date: string; trades: number; net: number }[];
  curve: { t: number; equity: number }[];
}
/** New York calendar day of a time (for grouping). */
export const nyDay = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

function group(list: ClosedTrade[], key: (t: ClosedTrade) => string) {
  const m = new Map<string, ClosedTrade[]>();
  for (const t of list) { const k = key(t); m.set(k, [...(m.get(k) ?? []), t]); }
  return [...m].map(([k, ts]) => ({ key: k, trades: ts.length, net: round(ts.reduce((a, t) => a + (t.pnl ?? 0), 0)), winRate: pct(ts.filter(t => (t.pnl ?? 0) > 0).length, ts.filter(t => t.pnl !== null).length) }))
    .sort((a, b) => b.net - a.net);
}
const round = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** Pure statistics over closed trades (oldest first or not; they are sorted here). */
export function stats(all: ClosedTrade[]): Stats {
  const list = [...all].sort((a, b) => a.closedAt - b.closedAt), counted = list.filter(t => t.pnl !== null), p = counted.map(t => t.pnl as number);
  const wins = p.filter(x => x > 0), losses = p.filter(x => x < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0), net = grossWin - grossLoss;
  let eq = 0, peak = 0, dd = 0, run = 0, longest = 0;
  const curve: { t: number; equity: number }[] = [];
  for (const t of counted) {
    eq += t.pnl as number; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); curve.push({ t: t.closedAt, equity: round(eq) });
    run = (t.pnl as number) < 0 ? run + 1 : 0; longest = Math.max(longest, run);
  }
  const days = new Map<string, { trades: number; net: number }>();
  for (const t of counted) { const d = nyDay(t.closedAt), x = days.get(d) ?? { trades: 0, net: 0 }; x.trades++; x.net += t.pnl as number; days.set(d, x); }
  return {
    trades: list.length, counted: counted.length, wins: wins.length, losses: losses.length, flat: p.length - wins.length - losses.length,
    winRate: pct(wins.length, p.length), net: round(net), grossWin: round(grossWin), grossLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    avgWin: wins.length ? round(grossWin / wins.length) : 0, avgLoss: losses.length ? round(-grossLoss / losses.length) : 0,
    expectancy: p.length ? round(net / p.length) : 0, best: p.length ? Math.max(...p) : 0, worst: p.length ? Math.min(...p) : 0,
    maxDrawdown: round(dd), longestLosing: longest,
    bySystem: group(list, t => t.system), byStrategy: group(list, t => t.id),
    byDay: [...days].map(([date, x]) => ({ date, trades: x.trades, net: round(x.net) })).sort((a, b) => (a.date < b.date ? 1 : -1)),
    curve
  };
}

export interface JournalFilter { accountId?: string; from?: number; to?: number; system?: string; id?: string; sym?: string; mode?: 'paper' | 'live' }
export function filter(list: ClosedTrade[], f: JournalFilter): ClosedTrade[] {
  const root = (s: string) => s.replace(/^M(?=NQ|ES|GC|YM|CL)/, '');
  return list.filter(t => (!f.accountId || t.accountId === f.accountId) && (!f.from || t.closedAt >= f.from) && (!f.to || t.closedAt < f.to)
    && (!f.system || t.system === f.system) && (!f.id || t.id === f.id) && (!f.sym || root(t.sym) === root(f.sym)) && (!f.mode || t.mode === f.mode));
}

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(list: ClosedTrade[]): string {
  const cols: (keyof ClosedTrade)[] = ['closedAt', 'openedAt', 'account', 'mode', 'system', 'id', 'orderSym', 'dir', 'qty', 'entry', 'exit', 'how', 'approx', 'pnl', 'why', 'note', 'tags'];
  const iso = (t: number) => new Date(t).toISOString();
  return [cols.join(','), ...list.map(t => cols.map(c => csvCell(c === 'closedAt' || c === 'openedAt' ? iso(t[c] as number) : c === 'tags' ? t.tags.join(' ') : t[c])).join(','))].join('\n') + '\n';
}
