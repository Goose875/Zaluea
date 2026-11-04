// Publishes the built installer to Cloudflare R2 so every installed Keel updates itself.
// Uploads: Keel-Setup-<version>.exe, its .blockmap, then latest.yml (last, so clients never see a half-uploaded release).
// Credentials from the environment only (Cloudflare dashboard > R2 > Manage R2 API tokens > Object Read & Write):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, [R2_BUCKET=keel-updates]
// Usage: node scripts/publish-update.js            (after building dist-installer/Keel-Setup-<version>.exe)
//        node scripts/publish-update.js --check    (download latest.yml through updates.keeltrading.net with the update key)
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');
const pkg = require('../package.json'), V = pkg.version, DIR = path.join(__dirname, '../dist-installer');
const env = process.env, BUCKET = env.R2_BUCKET || 'keel-updates';
const sha = (d, enc = 'hex') => crypto.createHash('sha256').update(d).digest(enc);
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

function put(key, body, type) {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, p = `/${BUCKET}/${encodeURIComponent(key)}`;
  const now = new Date(), amz = now.toISOString().replace(/[-:]|\.\d{3}/g, ''), day = amz.slice(0, 8), hash = sha(body);
  const hdrs = { 'content-length': String(body.length), 'content-type': type, host, 'x-amz-content-sha256': hash, 'x-amz-date': amz };
  const names = Object.keys(hdrs).sort(), canon = names.map(h => `${h}:${hdrs[h]}\n`).join(''), signed = names.join(';');
  const req = ['PUT', p, '', canon, signed, hash].join('\n'), scope = `${day}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha(req)].join('\n');
  const kS = hmac(hmac(hmac(hmac('AWS4' + env.R2_SECRET_ACCESS_KEY, day), 'auto'), 's3'), 'aws4_request');
  const auth = `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${crypto.createHmac('sha256', kS).update(toSign).digest('hex')}`;
  return new Promise((ok, bad) => {
    const r = https.request({ host, path: p, method: 'PUT', headers: { ...hdrs, Authorization: auth } }, res => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => (res.statusCode === 200 ? ok() : bad(new Error(`${key}: HTTP ${res.statusCode} ${t.slice(0, 300)}`))));
    });
    r.on('error', bad); r.end(body);
  });
}
function get(url, headers) {
  return new Promise((ok, bad) => https.get(url, { headers }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => ok({ status: res.statusCode, body: t })); }).on('error', bad));
}
(async () => {
  const key = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../.secrets/update-key.json'), 'utf8')).key; } catch { return ''; } })();
  if (process.argv.includes('--check')) {
    const a = await get('https://updates.keeltrading.net/latest.yml', { 'x-keel-key': key }), b = await get('https://updates.keeltrading.net/latest.yml', {});
    console.log(`with the key: HTTP ${a.status}\n${a.body.slice(0, 200)}\nwithout the key: HTTP ${b.status} (must be 403)`);
    process.exit(a.status === 200 && b.status === 403 ? 0 : 1);
  }
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!env[k]) { console.error(`Set ${k}.`); process.exit(2); }
  const exe = `Keel-Setup-${V}.exe`;
  for (const f of [exe, `${exe}.blockmap`, 'latest.yml']) if (!fs.existsSync(path.join(DIR, f))) { console.error(`Missing ${f}: build the installer first.`); process.exit(2); }
  for (const [f, type] of [[exe, 'application/octet-stream'], [`${exe}.blockmap`, 'application/octet-stream'], ['latest.yml', 'text/yaml']]) {
    const body = fs.readFileSync(path.join(DIR, f)); process.stdout.write(`uploading ${f} (${(body.length / 1e6).toFixed(1)} MB)... `);
    await put(f, body, type); console.log('done');
  }
  console.log(`Keel ${V} published. Installed copies update within 4 hours, or when restarted.`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
