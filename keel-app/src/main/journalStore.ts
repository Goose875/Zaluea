import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ClosedTrade, CloseReport, pnlOf, systemOf } from '../core/journal';
import { DEFAULT_RULES, PayoutRecord, parseRules, parsePayout } from '../core/payouts';

/** The trade journal and payout records, next to Keel's other settings (never leave this PC). */
const file = (n: string) => path.join(app.getPath('userData'), n);
const MAX = 20_000;
let cache: ClosedTrade[] | null = null;

const isTrade = (t: any): t is ClosedTrade => t && typeof t.uid === 'string' && typeof t.orderSym === 'string' && (t.dir === 'long' || t.dir === 'short')
  && Number.isFinite(t.qty) && Number.isFinite(t.entry) && Number.isFinite(t.closedAt);
export function loadJournal(): ClosedTrade[] {
  if (cache) return cache;
  try { const x = JSON.parse(fs.readFileSync(file('trade_journal.json'), 'utf8')); cache = Array.isArray(x) ? x.filter(isTrade).map(t => ({ ...t, note: typeof t.note === 'string' ? t.note : '', tags: Array.isArray(t.tags) ? t.tags : [] })) : []; }
  catch { cache = []; }
  return cache!;
}
function save() {
  const tmp = file('trade_journal.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(loadJournal())); fs.renameSync(tmp, file('trade_journal.json'));
}

/** Adds one closed trade. Returns it (with its P&L) so the caller can announce it. */
export function recordTrade(r: CloseReport, account: { id: string; label: string }, mode: 'paper' | 'live'): ClosedTrade {
  const t: ClosedTrade = { uid: randomBytes(8).toString('hex'), account: account.label, accountId: account.id, mode, system: r.system ?? systemOf(r.id),
    id: r.id, sym: r.sym, orderSym: r.orderSym, dir: r.dir, qty: r.qty, entry: r.entry, exit: r.exit, how: r.how, why: r.why, approx: r.approx,
    pnl: pnlOf(r.dir, r.entry, r.exit, r.qty, r.orderSym), openedAt: r.openedAt, closedAt: r.closedAt, note: '', tags: [] };
  const list = loadJournal(); list.push(t); if (list.length > MAX) list.splice(0, list.length - MAX);
  try { save(); } catch { /* best effort: kept in memory */ }
  return t;
}
/** Your own notes and tags on a trade; and correcting the exit price (e.g. from the broker's fill) recomputes its P&L. */
export function editTrade(uid: string, patch: { note?: unknown; tags?: unknown; exit?: unknown }): ClosedTrade {
  const t = loadJournal().find(x => x.uid === uid);
  if (!t) throw new Error('That trade is not in the journal.');
  if (patch.note !== undefined) t.note = String(patch.note).slice(0, 2000);
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags)) throw new Error('Tags must be a list.');
    t.tags = [...new Set(patch.tags.map(x => String(x).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter(Boolean))].slice(0, 12);
  }
  if (patch.exit !== undefined) {
    const x = Number(patch.exit); if (!Number.isFinite(x) || x <= 0) throw new Error('The exit price must be a number above 0.');
    t.exit = x; t.approx = false; t.pnl = pnlOf(t.dir, t.entry, x, t.qty, t.orderSym);
  }
  save(); return t;
}
export function removeTrade(uid: string) { const list = loadJournal(), i = list.findIndex(x => x.uid === uid); if (i >= 0) { list.splice(i, 1); save(); } }

// ---------- payouts ----------
type Payouts = Record<string, PayoutRecord>;
function loadAll(): Payouts { try { const x = JSON.parse(fs.readFileSync(file('payouts.json'), 'utf8')); return x && typeof x === 'object' ? x : {}; } catch { return {}; } }
const saveAll = (p: Payouts) => fs.writeFileSync(file('payouts.json'), JSON.stringify(p, null, 1));
export function payoutRecord(id: string): PayoutRecord {
  const r = loadAll()[id];
  let rules = DEFAULT_RULES; try { if (r?.rules) rules = parseRules(r.rules); } catch { /* defaults */ }
  return { rules, taken: Array.isArray(r?.taken) ? r.taken.filter(p => { try { parsePayout(p); return true; } catch { return false; } }) : [] };
}
export const allPayouts = (): Payouts => { const all = loadAll(), out: Payouts = {}; for (const id of Object.keys(all)) out[id] = payoutRecord(id); return out; };
export function setPayoutRules(id: string, rules: unknown) { const all = loadAll(); all[id] = { ...payoutRecord(id), rules: parseRules(rules) }; saveAll(all); return all[id]; }
export function addPayout(id: string, p: unknown) { const all = loadAll(), r = payoutRecord(id); r.taken.push(parsePayout(p)); all[id] = r; saveAll(all); return r; }
export function removePayout(id: string, index: number) {
  const all = loadAll(), r = payoutRecord(id), sorted = [...r.taken].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!Number.isInteger(index) || index < 0 || index >= sorted.length) throw new Error('That payout is not in the list.');
  sorted.splice(index, 1); r.taken = sorted; all[id] = r; saveAll(all); return r;
}
