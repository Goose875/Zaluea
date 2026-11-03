import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AccountStore, cleanStore } from '../core/accounts';

const file = () => path.join(app.getPath('userData'), 'accounts.json');
export function loadAccounts(conns: string[]): AccountStore { try { return cleanStore(JSON.parse(fs.readFileSync(file(), 'utf8')), conns); } catch { return { selected: '', accounts: [] }; } }
export function saveAccounts(st: AccountStore) { fs.writeFileSync(file(), JSON.stringify(st, null, 1)); }
