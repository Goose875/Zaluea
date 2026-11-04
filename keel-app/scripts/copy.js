const fs = require('fs');
fs.cpSync('src/renderer', 'dist/renderer', { recursive: true, filter: s => !s.endsWith('.ts') });
fs.copyFileSync('src/ksys/keel_strategies.json', 'dist/ksys/keel_strategies.json');
// TradingView Lightweight Charts (Apache-2.0), bundled so the chart works offline
fs.mkdirSync('dist/renderer/vendor', { recursive: true });
fs.copyFileSync('node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js', 'dist/renderer/vendor/lightweight-charts.js');
fs.copyFileSync('node_modules/lightweight-charts/LICENSE', 'dist/renderer/vendor/lightweight-charts-LICENSE.txt');
