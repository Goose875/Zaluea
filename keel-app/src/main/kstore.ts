import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { KConfig, LiveTrade, parseKConfig } from '../ksys/live';
import { XLiveTrade, XStore } from '../ksys/xlive';

/** K system settings and the K trades Keel is running, kept next to Keel's other settings. */
const file = (n: string) => path.join(app.getPath('userData'), n);
export function loadKConfig(): KConfig { try { return parseKConfig(JSON.parse(fs.readFileSync(file('ksystem.json'), 'utf8'))); } catch { return parseKConfig(null); } }
export function saveKConfig(c: KConfig) { fs.writeFileSync(file('ksystem.json'), JSON.stringify(c, null, 1)); }

const isTrade = (t: any): t is LiveTrade => t && typeof t.id === 'string' && typeof t.orderSym === 'string' && (t.dir === 'long' || t.dir === 'short')
  && [t.qty, t.entry, t.entryUtc, t.stop].every(Number.isFinite);
/** Paper and live trades are kept apart so a paper session never touches live orders. */
export const kTradeStore = (mode: 'paper' | 'live', acct = '') => ({
  load(): LiveTrade[] { try { const x = JSON.parse(fs.readFileSync(file(`k_trades_${mode}${acct ? '_' + acct : ''}.json`), 'utf8')); return Array.isArray(x) ? x.filter(isTrade) : []; } catch { return []; } },
  save(t: LiveTrade[]) { fs.writeFileSync(file(`k_trades_${mode}${acct ? '_' + acct : ''}.json`), JSON.stringify(t, null, 1)); }
});

const isX = (t: any): t is XLiveTrade => t && typeof t.key === 'string' && typeof t.orderSym === 'string' && (t.dir === 'long' || t.dir === 'short')
  && (t.state === 'working' || t.state === 'open') && Number.isFinite(t.qty) && Number.isFinite(t.stopPts);
/** K8 / K9 / P1-P3 trades and the setups already decided (so nothing is sent twice), paper and live apart. */
export const xTradeStore = (mode: 'paper' | 'live', acct = ''): XStore => ({
  load() {
    try { const x = JSON.parse(fs.readFileSync(file(`x_trades_${mode}${acct ? '_' + acct : ''}.json`), 'utf8'));
      return { trades: Array.isArray(x.trades) ? x.trades.filter(isX) : [], done: Array.isArray(x.done) ? x.done.filter((k: unknown) => typeof k === 'string') : [] }; }
    catch { return { trades: [], done: [] }; }
  },
  save(x) { fs.writeFileSync(file(`x_trades_${mode}${acct ? '_' + acct : ''}.json`), JSON.stringify(x, null, 1)); }
});
