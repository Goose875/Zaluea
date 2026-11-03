// Makes sure Electron's program file is in place. npm's own download step is sometimes skipped or blocked,
// so this does it directly, checks the file against Electron's published checksum, and unpacks it.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), cp = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const dir = path.join(process.env.KEEL_ROOT || path.join(__dirname, '..'), 'node_modules', 'electron');
if (!fs.existsSync(path.join(dir, 'package.json'))) { console.log('Keel: Electron is not installed yet. Run npm install first.'); process.exit(0); }

const version = require(path.join(dir, 'package.json')).version;
const key = `${process.platform}-${process.arch}`;
const EXE = { 'win32-x64': 'electron.exe', 'win32-arm64': 'electron.exe', 'darwin-x64': 'Electron.app/Contents/MacOS/Electron',
  'darwin-arm64': 'Electron.app/Contents/MacOS/Electron', 'linux-x64': 'electron' }[key];
if (!EXE) { console.log(`Keel: no Electron build for ${key}.`); process.exit(0); }

const ready = () => { try { return fs.readFileSync(path.join(dir, 'path.txt'), 'utf8') === EXE && fs.existsSync(path.join(dir, 'dist', ...EXE.split('/'))); } catch { return false; } };
if (ready()) process.exit(0);

(async () => {
  const base = process.env.KEEL_ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download';
  const name = `electron-v${version}-${key}.zip`;
  console.log(`Keel: setting up Electron ${version} (one time, about 100 MB)...`);

  const sums = await fetch(`${base}/v${version}/SHASUMS256.txt`).then(r => { if (!r.ok) throw new Error(`Could not get the checksum list (${r.status}).`); return r.text(); });
  const row = sums.split('\n').map(l => l.trim().split(/\s+\*?/)).find(c => c[1] === name);
  if (!row) throw new Error(`No checksum is published for ${name}.`);

  const res = await fetch(`${base}/v${version}/${name}`);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const tmp = path.join(os.tmpdir(), `keel-${name}`), hash = crypto.createHash('sha256');
  await pipeline(Readable.fromWeb(res.body), async function* (src) { for await (const c of src) { hash.update(c); yield c; } }, fs.createWriteStream(tmp));
  if (hash.digest('hex') !== row[0]) { fs.rmSync(tmp, { force: true }); throw new Error('The download did not match its checksum, so it was thrown away.'); }

  const dist = path.join(dir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true }); fs.mkdirSync(dist, { recursive: true });
  if (process.platform === 'win32') {
    cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:KZ -DestinationPath $env:KD -Force'],
      { stdio: 'inherit', env: { ...process.env, KZ: tmp, KD: dist } });
  } else cp.execFileSync('unzip', ['-q', '-o', tmp, '-d', dist], { stdio: 'inherit' });
  fs.writeFileSync(path.join(dir, 'path.txt'), EXE);
  fs.rmSync(tmp, { force: true });
  console.log('Keel: Electron is ready.');
})().catch(e => {
  console.error(`\nKeel could not set up Electron automatically: ${e.message}`);
  console.error(`You can do it by hand: download electron-v${version}-${key}.zip from https://github.com/electron/electron/releases/tag/v${version},`);
  console.error('unzip it into node_modules/electron/dist, and create node_modules/electron/path.txt containing: ' + EXE);
  process.exit(1);
});
