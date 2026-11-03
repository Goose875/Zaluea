import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { cleanList, SavedStrategy } from '../core/strategyList';

const file = () => path.join(app.getPath('userData'), 'strategies.json');
export function loadStrategies(): SavedStrategy[] { try { return cleanList(JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch { return []; } }
export function saveStrategies(list: SavedStrategy[]) { fs.writeFileSync(file(), JSON.stringify(list, null, 1)); }
