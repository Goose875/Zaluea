const fs = require('fs');
fs.cpSync('src/renderer', 'dist/renderer', { recursive: true, filter: s => !s.endsWith('.ts') });
fs.copyFileSync('src/ksys/keel_strategies.json', 'dist/ksys/keel_strategies.json');
// Rithmic protocol files (your licensed dev kit, kept out of git in vendor/rithmic/proto)
if (fs.existsSync('vendor/rithmic/proto/base.proto')) fs.cpSync('vendor/rithmic/proto', 'dist/rithmic-proto', { recursive: true });
else console.warn('Rithmic dev kit not found in vendor/rithmic/proto: the Rithmic connection will not be available in this build.');
// TradingView Lightweight Charts (Apache-2.0), bundled so the chart works offline
fs.mkdirSync('dist/renderer/vendor', { recursive: true });
fs.copyFileSync('node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js', 'dist/renderer/vendor/lightweight-charts.js');
fs.copyFileSync('node_modules/lightweight-charts/LICENSE', 'dist/renderer/vendor/lightweight-charts-LICENSE.txt');

// auto-update key (git-ignored secret)
if (fs.existsSync('.secrets/update-key.json')) fs.copyFileSync('.secrets/update-key.json', 'dist/main/update-key.json');
