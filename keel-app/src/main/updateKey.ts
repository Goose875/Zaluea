import * as fs from 'fs';
import * as path from 'path';

/** Sent with every update download; Cloudflare blocks updates.keeltrading.net requests without it, so the installers
 *  (which contain your licensed Rithmic files) are not public. The key lives in keel-app/.secrets/update-key.json
 *  (git-ignored) and is copied into the build by scripts/copy.js. Without it, Keel simply doesn't auto-update. */
export const UPDATE_KEY: string = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'update-key.json'), 'utf8')).key ?? ''; } catch { return ''; } })();
