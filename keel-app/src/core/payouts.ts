import { DayResult } from './types';

/** Payout rules for a funded / live account. Firms change these often: the defaults are a starting point, not the firm's rules. */
export interface PayoutRules {
  winDays: number;          // winning days needed since the last payout (0 = no rule)
  winDayMin: number;        // a day counts as winning at this profit or more
  maxPct: number;           // share of the available profit you may request (1-100)
  maxAmount: number;        // cap per payout (0 = no cap)
  minAmount: number;        // smallest payout the firm pays (0 = none)
  buffer: number;           // profit that must stay in the account (0 = none)
  consistencyPct: number;   // best day in the cycle must be at most this % of the cycle's profit (0 = off)
  altDays: number;          // second route (e.g. Topstep's consistency path): this many trading days... (0 = no second route)
  altPct: number;           // ...with the best day at most this % of the cycle's profit
  split: number;            // your share of a payout, % (e.g. 90)
}
export interface Payout { date: string; amount: number; note: string }
export interface PayoutRecord { rules: PayoutRules; taken: Payout[] }
export const DEFAULT_RULES: PayoutRules = { winDays: 5, winDayMin: 200, maxPct: 50, maxAmount: 5000, minAmount: 125, buffer: 0, consistencyPct: 0, altDays: 0, altPct: 0, split: 100 };
/** Topstep 50K Static (Labs) Express Funded: 5 days of $150+, or 3 trading days with the best day <= 40% of profit; up to 50% of profit, $8,000 cap, 90% split. */
export const TOPSTEP_50K_STATIC: PayoutRules = { winDays: 5, winDayMin: 150, maxPct: 50, maxAmount: 8000, minAmount: 125, buffer: 0, consistencyPct: 0, altDays: 3, altPct: 40, split: 90 };

export function parseRules(x: any): PayoutRules {
  const num = (v: unknown, lo: number, hi: number, what: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} must be a number from ${lo} to ${hi.toLocaleString('en-US')}.`);
    return v;
  };
  if (!x || typeof x !== 'object') throw new Error('Those payout rules are not valid.');
  return { winDays: Math.round(num(x.winDays, 0, 60, 'Winning days')), winDayMin: num(x.winDayMin, 0, 100_000, 'Winning day minimum'), maxPct: num(x.maxPct, 1, 100, 'Share of profit'),
    maxAmount: num(x.maxAmount, 0, 1_000_000, 'Payout cap'), minAmount: num(x.minAmount, 0, 100_000, 'Smallest payout'), buffer: num(x.buffer, 0, 1_000_000, 'Buffer'),
    consistencyPct: num(x.consistencyPct, 0, 100, 'Consistency'),
    altDays: Math.round(num(x.altDays ?? 0, 0, 60, 'Second route days')), altPct: num(x.altPct ?? 0, 0, 100, 'Second route best day'), split: num(x.split ?? 100, 1, 100, 'Profit split') };
}
export function parsePayout(x: any): Payout {
  if (!x || typeof x !== 'object' || typeof x.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) throw new Error('Pick the payout date.');
  if (typeof x.amount !== 'number' || !Number.isFinite(x.amount) || x.amount <= 0 || x.amount > 1_000_000) throw new Error('The payout amount must be more than $0.');
  return { date: x.date, amount: Math.round(x.amount * 100) / 100, note: String(x.note ?? '').trim().slice(0, 200) };
}

export interface PayoutStatus {
  cycleStart: string | null;            // days after this date count (the last payout), null = since the start
  cycleDays: number; winDays: number; winDaysNeeded: number;
  cycleProfit: number; bestDay: number; consistencyOk: boolean; consistencyLimit: number;
  available: number;                    // profit still in the account, minus the buffer
  request: number;                      // what you could ask for now (0 when not eligible)
  eligible: boolean; reasons: string[];
  route: 'winning days' | 'consistency' | null;   // which route makes it eligible
  net: number;                          // the request after the profit split
  tradedDays: number;                   // days with a result in this cycle (the second route counts these)
  needFor2k: number;                    // more profit needed in the account for a $2,000 request (0 = already there)
  totalPaid: number; payouts: number; cost: number; netAfterCost: number;
}

/**
 * Where an account stands for its next payout. days = the broker's past daily results, todayPnl = today so far
 * (counted as a day once it is positive, as most firms count the day at the close). netProfit = all profit since
 * the account started (before payouts), so profit still in the account = netProfit - payouts taken.
 */
export function payoutStatus(rec: PayoutRecord, days: DayResult[], todayPnl: number, today: string, netProfit: number, cost = 0): PayoutStatus {
  const r = { ...DEFAULT_RULES, ...rec.rules }, taken = [...rec.taken].sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = taken.length ? taken[taken.length - 1].date : null;
  const cycle = days.filter(d => !last || d.date > last).filter(d => d.date !== today).map(d => d.pnl);
  if (todayPnl !== 0 && (!last || today > last)) cycle.push(todayPnl);
  const totalPaid = Math.round(taken.reduce((a, p) => a + p.amount, 0) * 100) / 100;
  const winDays = cycle.filter(p => p >= Math.max(0.01, r.winDayMin)).length;
  const cycleProfit = Math.round(cycle.reduce((a, b) => a + b, 0) * 100) / 100, bestDay = Math.max(0, ...cycle);
  const consistencyLimit = r.consistencyPct > 0 ? (Math.max(0, cycleProfit) * r.consistencyPct) / 100 : 0;
  const consistencyOk = r.consistencyPct <= 0 || (cycleProfit > 0 && bestDay <= consistencyLimit);
  const available = Math.max(0, Math.round((netProfit - totalPaid - r.buffer) * 100) / 100);
  let request = Math.floor(available * r.maxPct) / 100; if (r.maxAmount > 0) request = Math.min(request, r.maxAmount);
  const reasons: string[] = [], tradedDays = cycle.filter(p => p !== 0).length;
  // route 1: winning days (+ optional consistency); route 2 (optional): N trading days with the best day <= altPct% of profit
  const r1 = winDays >= r.winDays && consistencyOk;
  const r2 = r.altDays > 0 && tradedDays >= r.altDays && cycleProfit > 0 && bestDay <= (cycleProfit * r.altPct) / 100;
  if (!r1 && !r2) {
    const w: string[] = [];
    if (winDays < r.winDays) w.push(`${r.winDays - winDays} more winning day${r.winDays - winDays === 1 ? '' : 's'} of $${r.winDayMin.toLocaleString('en-US')}+`);
    if (!consistencyOk) w.push(cycleProfit <= 0 ? 'profit in this cycle' : `best day ($${Math.round(bestDay).toLocaleString('en-US')}) is over ${r.consistencyPct}% of the cycle's profit`);
    if (r.altDays > 0) {
      const a: string[] = [];
      if (tradedDays < r.altDays) a.push(`${r.altDays - tradedDays} more trading day${r.altDays - tradedDays === 1 ? '' : 's'}`);
      if (!(cycleProfit > 0 && bestDay <= (cycleProfit * r.altPct) / 100)) a.push(cycleProfit <= 0 ? 'profit in this cycle' : `best day ($${Math.round(bestDay).toLocaleString('en-US')}) at most ${r.altPct}% of profit (needs $${Math.ceil((bestDay * 100) / r.altPct - cycleProfit).toLocaleString('en-US')} more profit without a bigger day)`);
      reasons.push(`${w.join(' and ')}, or ${a.join(' and ')}`);
    } else reasons.push(...w);
  }
  if (available <= 0) reasons.push(r.buffer > 0 ? `profit must stay above the $${r.buffer.toLocaleString('en-US')} buffer` : 'no profit available');
  else if (r.minAmount > 0 && request < r.minAmount) reasons.push(`the payout would be under the $${r.minAmount.toLocaleString('en-US')} minimum`);
  const eligible = reasons.length === 0, route = !eligible ? null : r1 ? 'winning days' as const : 'consistency' as const;
  const net = eligible ? Math.round(request * r.split) / 100 : 0, needFor2k = Math.max(0, Math.ceil(Math.min(2000, r.maxAmount || 2000) * 100 / r.maxPct - available));
  return { route, net, tradedDays, needFor2k, cycleStart: last, cycleDays: cycle.length, winDays, winDaysNeeded: r.winDays, cycleProfit, bestDay, consistencyOk, consistencyLimit: Math.round(consistencyLimit * 100) / 100,
    available, request: eligible ? Math.round(request * 100) / 100 : 0, eligible, reasons, totalPaid, payouts: taken.length, cost, netAfterCost: Math.round((totalPaid - cost) * 100) / 100 };
}
