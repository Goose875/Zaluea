import { randomBytes } from 'crypto';
import { parseStrategy, StrategyConfig } from '../strategies/rules';

export type Source = 'library' | 'tradingview' | 'pine' | 'custom';
export interface SavedStrategy { id: string; enabled: boolean; source: Source; cfg: StrategyConfig }
const SOURCES: Source[] = ['library', 'tradingview', 'pine', 'custom'];
export const MAX_STRATEGIES = 50;

/** Pure list operations, so they can be tested without files. Every change is validated. */
export function addTo(list: SavedStrategy[], cfg: unknown, source: unknown): SavedStrategy[] {
  if (list.length >= MAX_STRATEGIES) throw new Error(`You can keep up to ${MAX_STRATEGIES} strategies.`);
  const item: SavedStrategy = { id: 's-' + randomBytes(6).toString('hex'), enabled: false, source: SOURCES.includes(source as Source) ? source as Source : 'custom', cfg: parseStrategy(cfg) };
  return [...list, item];
}
export function updateIn(list: SavedStrategy[], id: unknown, patch: any): SavedStrategy[] {
  const i = list.findIndex(s => s.id === id);
  if (i < 0) throw new Error('That strategy no longer exists.');
  const cur = list[i], next: SavedStrategy = { ...cur };
  if (patch && 'enabled' in patch) { if (typeof patch.enabled !== 'boolean') throw new Error('Not allowed.'); next.enabled = patch.enabled; }
  if (patch && 'cfg' in patch) {
    const cfg = parseStrategy(patch.cfg);
    if (cfg.type !== cur.cfg.type) throw new Error("A strategy's type can't be changed.");
    next.cfg = cfg;
  }
  return list.map((s, j) => (j === i ? next : s));
}
export function removeFrom(list: SavedStrategy[], id: unknown): SavedStrategy[] { return list.filter(s => s.id !== id); }
export function cleanList(raw: unknown): SavedStrategy[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x: any) => {
    try { return typeof x.id === 'string' && /^s-[0-9a-f]{12}$/.test(x.id) ? [{ id: x.id, enabled: x.enabled === true, source: SOURCES.includes(x.source) ? x.source : 'custom', cfg: parseStrategy(x.cfg) }] : []; }
    catch { return []; }
  }).slice(0, MAX_STRATEGIES);
}
