const fs = require('fs');
fs.cpSync('src/renderer', 'dist/renderer', { recursive: true, filter: s => !s.endsWith('.ts') });
fs.copyFileSync('src/ksys/keel_strategies.json', 'dist/ksys/keel_strategies.json');
