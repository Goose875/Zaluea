import { randomBytes } from 'crypto';
import { Goals, STAGES, Stage } from './goals';

export type Drawdown = 'eod' | 'intraday' | 'static';
export interface AccountRecord {
  id: string; label: string; firm: string; connection: string; brokerRef: string;
  stage: Stage; plan: string; size: number; drawdown: Drawdown; maxLoss: number; dailyLoss: number;
  profitTarget: number; consistencyPct: number; consistencyBasis: 'target' | 'total'; minDays: number;
  maxMini: number; maxMicro: number; dailyGoal: number; pauseAtGoal: boolean;
  cost: number; purchaseDate: string; notes: string;
  /** Keel may trade this account when the bot runs (Accounts page switch). */
  trade: boolean;
}
export interface AccountStore { selected: string; accounts: AccountRecord[] }
export const MAX_ACCOUNTS = 200;

export const BLANK: Omit<AccountRecord, 'id'> = {
  label: '', firm: 'Topstep', connection: 'projectx', brokerRef: '', stage: 'evaluation', plan: '', size: 50000, drawdown: 'eod', maxLoss: 2000,
  dailyLoss: 0, profitTarget: 3000, consistencyPct: 0, consistencyBasis: 'target', minDays: 0, maxMini: 0, maxMicro: 0, dailyGoal: 0, pauseAtGoal: true,
  cost: 0, purchaseDate: '', notes: '', trade: true
};

export function parseAccount(x: any, connections: string[]): Omit<AccountRecord, 'id'> {
  if (!x || typeof x !== 'object') throw new Error('That account is not valid.');
  const text = (v: unknown, max: number, what: string, required = false) => {
    const s = String(v ?? '').trim();
    if (s.length > max) throw new Error(`${what} can be up to ${max} characters.`);
    if (required && !s) throw new Error(`${what} is required.`);
    return s;
  };
  const num = (v: unknown, hi: number, what: string, whole = false) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > hi || (whole && !Number.isInteger(v))) throw new Error(`${what} must be ${whole ? 'a whole number' : 'a number'} from 0 to ${hi.toLocaleString('en-US')}.`);
    return v;
  };
  if (!STAGES.includes(x.stage)) throw new Error('Pick an account type.');
  if (!['eod', 'intraday', 'static'].includes(x.drawdown)) throw new Error('Pick a drawdown type.');
  if (!connections.includes(x.connection)) throw new Error('Pick a connection.');
  const date = text(x.purchaseDate, 10, 'Purchase date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Purchase date must look like 2026-11-02.');
  return {
    label: text(x.label, 60, 'Account name', true), firm: text(x.firm, 60, 'Prop firm') || 'Other', connection: x.connection,
    brokerRef: text(x.brokerRef, 60, 'Account ID'), stage: x.stage, plan: text(x.plan, 40, 'Plan name'),
    size: num(x.size, 10_000_000, 'Account size'), drawdown: x.drawdown, maxLoss: num(x.maxLoss, 1_000_000, 'Max loss'),
    dailyLoss: num(x.dailyLoss, 1_000_000, 'Daily loss'), profitTarget: num(x.profitTarget, 10_000_000, 'Profit target'),
    consistencyPct: num(x.consistencyPct, 100, 'Consistency'), consistencyBasis: x.consistencyBasis === 'total' ? 'total' : 'target',
    minDays: num(x.minDays, 365, 'Minimum trading days', true), maxMini: num(x.maxMini, 1000, 'Max mini contracts', true),
    maxMicro: num(x.maxMicro, 10000, 'Max micro contracts', true), dailyGoal: num(x.dailyGoal, 1_000_000, 'Daily goal'),
    pauseAtGoal: x.pauseAtGoal !== false, cost: num(x.cost, 1_000_000, 'Cost'), purchaseDate: date, notes: text(x.notes, 500, 'Notes'), trade: x.trade !== false
  };
}

const newId = () => 'a-' + randomBytes(6).toString('hex');
export function addAccount(st: AccountStore, x: unknown, conns: string[]): AccountStore {
  if (st.accounts.length >= MAX_ACCOUNTS) throw new Error(`You can keep up to ${MAX_ACCOUNTS} accounts.`);
  const a = { id: newId(), ...parseAccount(x, conns) };
  return { selected: st.selected || a.id, accounts: [...st.accounts, a] };
}
/** Applies only the fields given, so "edit all" can leave mixed values alone. */
export function updateAccounts(st: AccountStore, ids: unknown, patch: any, conns: string[]): AccountStore {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Pick at least one account.');
  if (!patch || typeof patch !== 'object') throw new Error('Nothing to change.');
  const keys = Object.keys(BLANK);
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => keys.includes(k)));
  const accounts = st.accounts.map(a => (ids.includes(a.id) ? { id: a.id, ...parseAccount({ ...a, ...clean }, conns) } : a));
  if (!accounts.some(a => ids.includes(a.id))) throw new Error('Those accounts no longer exist.');
  return { ...st, accounts };
}
export function removeAccount(st: AccountStore, id: unknown): AccountStore {
  const accounts = st.accounts.filter(a => a.id !== id);
  return { selected: st.selected === id ? '' : st.selected, accounts };
}
export function selectAccount(st: AccountStore, id: unknown): AccountStore {
  if (id !== '' && !st.accounts.some(a => a.id === id)) throw new Error('That account no longer exists.');
  return { ...st, selected: id as string };
}
export function cleanStore(raw: any, conns: string[]): AccountStore {
  const accounts: AccountRecord[] = [];
  for (const x of Array.isArray(raw?.accounts) ? raw.accounts : []) {
    try { if (typeof x.id === 'string' && /^a-[0-9a-f]{12}$/.test(x.id)) accounts.push({ id: x.id, ...parseAccount(x, conns) }); } catch { /* skip bad rows */ }
  }
  const selected = accounts.some(a => a.id === raw?.selected) ? raw.selected : '';
  return { selected, accounts: accounts.slice(0, MAX_ACCOUNTS) };
}

export function goalsFor(a: AccountRecord | null): Goals {
  if (!a) return { stage: 'practice', profitTarget: 0, dailyProfitTarget: 0, pauseAtDailyTarget: false, consistencyPct: 0, consistencyBasis: 'target', drawdown: 'eod' };
  return { stage: a.stage, profitTarget: a.profitTarget, dailyProfitTarget: a.dailyGoal, pauseAtDailyTarget: a.pauseAtGoal,
    consistencyPct: a.consistencyPct, consistencyBasis: a.consistencyBasis, drawdown: a.drawdown };
}

/** DEV ONLY: a spread of pretend accounts across firms, for trying the list, the drawer and progress tracking. */
export function sampleAccounts(): Omit<AccountRecord, 'id'>[] {
  const n = () => String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
  const base = { ...BLANK, connection: 'topstep-test', drawdown: 'eod' as Drawdown, size: 50000, maxLoss: 2000 };
  return [
    { ...base, label: `50KTC-V2-${n()}`, firm: 'Topstep', stage: 'evaluation', plan: 'Combine $50K', profitTarget: 3000, consistencyPct: 55, maxMini: 5, maxMicro: 50, cost: 49 },
    { ...base, label: `EXPR-${n()}`, firm: 'Topstep', stage: 'funded', plan: 'XFA $50K', profitTarget: 0, consistencyPct: 40, consistencyBasis: 'total', maxMini: 5, maxMicro: 50, dailyGoal: 300 },
    { ...base, label: `LTF0-${n()}`, firm: 'Lucid Trading', stage: 'funded', plan: 'Pro $50K', profitTarget: 3000, consistencyPct: 40, consistencyBasis: 'total', maxMini: 4, maxMicro: 40 },
    { ...base, label: `LDE0-${n()}`, firm: 'Lucid Trading', stage: 'evaluation', plan: 'Daily $50K', drawdown: 'intraday', dailyLoss: 1000, profitTarget: 3000, consistencyPct: 50, maxMini: 4, maxMicro: 40 },
    { ...base, label: `MFFU-${n()}`, firm: 'My Funded Futures', stage: 'evaluation', plan: 'Rapid $50K', profitTarget: 3000, consistencyPct: 50, maxMini: 5, maxMicro: 50 }
  ];
}

const MINI = new Set(['ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'SI', 'NG', 'HG', '6E', '6J', 'ZB', 'ZN']);
const MICRO = new Set(['MES', 'MNQ', 'MYM', 'M2K', 'MCL', 'MGC', 'SIL', 'MHG', 'M6E']);
export const sizeClass = (sym: string): 'mini' | 'micro' | null => (MICRO.has(sym) ? 'micro' : MINI.has(sym) ? 'mini' : null);

/** Starting values for common plans. Firms change their rules, so these are a starting point to check, not the source of truth. */
export const PRESETS: (Partial<Omit<AccountRecord, 'id'>> & { firm: string; plan: string })[] = [
  { firm: 'Topstep', plan: 'Combine $50K', stage: 'evaluation', size: 50000, drawdown: 'eod', maxLoss: 2000, dailyLoss: 0, profitTarget: 3000, consistencyPct: 55, consistencyBasis: 'target', maxMini: 5, maxMicro: 50, connection: 'projectx' },
  { firm: 'Topstep', plan: 'XFA $50K', stage: 'funded', size: 50000, drawdown: 'eod', maxLoss: 2000, dailyLoss: 0, profitTarget: 0, consistencyPct: 40, consistencyBasis: 'total', maxMini: 5, maxMicro: 50, connection: 'projectx' },
  { firm: 'Lucid Trading', plan: 'Pro $50K', stage: 'funded', size: 50000, drawdown: 'eod', maxLoss: 2000, dailyLoss: 0, profitTarget: 3000, consistencyPct: 40, consistencyBasis: 'total', maxMini: 4, maxMicro: 40, connection: 'rithmic' },
  { firm: 'Lucid Trading', plan: 'Daily $50K (evaluation)', stage: 'evaluation', size: 50000, drawdown: 'eod', maxLoss: 2000, dailyLoss: 0, profitTarget: 3000, consistencyPct: 50, consistencyBasis: 'total', maxMini: 4, maxMicro: 40, connection: 'rithmic' },
  { firm: 'Lucid Trading', plan: 'Daily $50K (funded)', stage: 'funded', size: 50000, drawdown: 'intraday', maxLoss: 2000, dailyLoss: 0, profitTarget: 0, consistencyPct: 0, consistencyBasis: 'total', maxMini: 4, maxMicro: 40, connection: 'rithmic' }
];
