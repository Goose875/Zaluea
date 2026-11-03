import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { KConfig, LiveTrade, parseKConfig } from '../ksys/live';

/** K system settings and the K trades Keel is running, kept next to Keel's other settings. */
const file = (n: string) => path.join(app.getPath('userData'), n);
export function loadKConfig(): KConfig { try { return parseKConfig(JSON.parse(fs.readFileSync(file('ksystem.json'), 'utf8'))); } catch { return parseKConfig(null); } }
export function saveKConfig(c: KConfig) { fs.writeFileSync(file('ksystem.json'), JSON.stringify(c, null, 1)); }

const isTrade = (t: any): t is LiveTrade => t && typeof t.id === 'string' && typeof t.orderSym === 'string' && (t.dir === 'long' || t.dir === 'short')
  && [t.qty, t.entry, t.entryUtc, t.stop].every(Number.isFinite);
/** Paper and live trades are kept apart so a paper session never touches live orders. */
export const kTradeStore = (mode: 'paper' | 'live') => ({
  load(): LiveTrade[] { try { const x = JSON.parse(fs.readFileSync(file(`k_trades_${mode}.json`), 'utf8')); return Array.isArray(x) ? x.filter(isTrade) : []; } catch { return []; } },
  save(t: LiveTrade[]) { fs.writeFileSync(file(`k_trades_${mode}.json`), JSON.stringify(t, null, 1)); }
});
