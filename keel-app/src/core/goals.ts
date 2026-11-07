import { AccountInfo, DayResult } from './types';

export type Stage = 'evaluation' | 'funded' | 'live' | 'practice';
export const STAGES: Stage[] = ['evaluation', 'funded', 'live', 'practice'];

export interface Goals {
  stage: Stage;
  profitTarget: number;          // total profit to pass (evaluation) or to reach a payout (funded, live). 0 = off
  dailyProfitTarget: number;     // 0 = off
  pauseAtDailyTarget: boolean;   // once the daily target is hit: close everything on the account and stop trading it for the day
  consistencyPct: number;        // 0 = off
  consistencyBasis: 'target' | 'total'; // best day measured against the profit target, or against total profit
  drawdown?: 'eod' | 'intraday' | 'static';
}

export const DEFAULT_GOALS: Goals = { stage: 'evaluation', profitTarget: 3000, dailyProfitTarget: 0, pauseAtDailyTarget: true, consistencyPct: 55, consistencyBasis: 'target', drawdown: 'eod' };

export function parseGoals(x: any): Goals {
  const num = (v: unknown, hi: number, what: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > hi) throw new Error(`${what} must be a number from 0 to ${hi.toLocaleString('en-US')}.`);
    return v;
  };
  if (!x || !STAGES.includes(x.stage)) throw new Error('Pick a stage for this account.');
  if (x.consistencyBasis !== 'target' && x.consistencyBasis !== 'total') throw new Error('Pick what the consistency rule is measured against.');
  return {
    stage: x.stage,
    profitTarget: num(x.profitTarget, 10_000_000, 'Profit target'),
    dailyProfitTarget: num(x.dailyProfitTarget, 1_000_000, 'Daily profit target'),
    pauseAtDailyTarget: x.pauseAtDailyTarget === true,
    consistencyPct: num(x.consistencyPct, 100, 'Consistency percent'),
    consistencyBasis: x.consistencyBasis,
    drawdown: ['eod', 'intraday', 'static'].includes(x.drawdown) ? x.drawdown : 'eod'
  };
}

export interface Progress {
  stage: Stage;
  netProfit: number; profitTarget: number; targetPct: number; targetMet: boolean;
  todayPnl: number; dailyTarget: number; dailyPct: number; dailyHit: boolean;
  bestDay: number; consistencyOn: boolean; consistencyLimit: number; consistencyUsedPct: number; consistencyOk: boolean;
  balance: number | null; floor: number | null; cushion: number | null;
  days: DayResult[];
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Works out where an account stands against its goals. Pure, so it is easy to test. */
export function evaluate(g: Goals, acct: AccountInfo | null, todayPnl: number, todayPeak = todayPnl): Progress {
  const days = acct ? acct.days : [];
  // Brokers that send no past days (TopstepX, Rithmic) still give the balance: profit since the start is balance - starting balance.
  // Without this, a running bot showed only today's P&L as the account's total (e.g. $0 instead of $800).
  const netProfit = days.length || !acct || !Number.isFinite(acct.balance) || !Number.isFinite(acct.startBalance) ? days.reduce((a, d) => a + d.pnl, 0) + todayPnl : acct.balance - acct.startBalance;
  const bestDay = Math.max(0, todayPnl, ...days.map(d => d.pnl));

  const consistencyOn = g.consistencyPct > 0 && g.stage !== 'practice';
  let limit = 0;
  if (consistencyOn) limit = g.consistencyBasis === 'target' ? (g.profitTarget * g.consistencyPct) / 100 : (Math.max(0, netProfit) * g.consistencyPct) / 100;
  const consistencyOk = !consistencyOn || (g.consistencyBasis === 'total' && netProfit <= 0) || (limit > 0 ? bestDay < limit : bestDay === 0);

  let floor: number | null = null;
  if (acct && acct.maxLoss > 0) {
    if (typeof acct.floor === 'number') floor = acct.floor;
    else if (g.drawdown === 'static') floor = acct.startBalance - acct.maxLoss;
    else {
      let run = acct.startBalance, peak = run;
      for (const d of days) { run += d.pnl; peak = Math.max(peak, run); }
      if (g.drawdown === 'intraday') peak = Math.max(peak, run + Math.max(0, todayPeak));   // intraday highs count too
      floor = Math.min(acct.startBalance, peak - acct.maxLoss);   // trails up, then stops at the starting balance
    }
  }
  const balance = acct ? acct.balance : null;

  return {
    stage: g.stage, netProfit, profitTarget: g.profitTarget,
    targetPct: g.profitTarget > 0 ? clamp((netProfit / g.profitTarget) * 100) : 0,
    targetMet: g.profitTarget > 0 && netProfit >= g.profitTarget && consistencyOk,
    todayPnl, dailyTarget: g.dailyProfitTarget,
    dailyPct: g.dailyProfitTarget > 0 ? clamp((todayPnl / g.dailyProfitTarget) * 100) : 0,
    dailyHit: g.dailyProfitTarget > 0 && todayPnl >= g.dailyProfitTarget,
    bestDay, consistencyOn, consistencyLimit: limit,
    consistencyUsedPct: consistencyOn && limit > 0 ? Math.min(150, (bestDay / limit) * 100) : 0, consistencyOk,
    balance, floor, cushion: balance !== null && floor !== null ? balance - floor : null,
    days
  };
}
