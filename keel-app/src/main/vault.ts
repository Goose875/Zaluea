import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Credentials are encrypted with the operating system's keychain
 * (Windows DPAPI / macOS Keychain) and stay on this computer.
 * The renderer can save and delete them but can never read them back.
 */
const file = () => path.join(app.getPath('userData'), 'vault.json');

function load(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
}

export const vault = {
  set(name: string, value: Record<string, string>) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system.');
    const all = load();
    all[name] = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
    fs.writeFileSync(file(), JSON.stringify(all), { mode: 0o600 });
  },
  get(name: string): Record<string, string> | null {
    const enc = load()[name];
    if (!enc) return null;
    return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64')));
  },
  has: (name: string) => name in load(),
  remove(name: string) {
    const all = load(); delete all[name];
    fs.writeFileSync(file(), JSON.stringify(all), { mode: 0o600 });
  }
};
