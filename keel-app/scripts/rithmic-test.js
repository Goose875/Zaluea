// End-to-end check of Keel's Rithmic connection on Rithmic's TEST system (no real money).
// Credentials from the environment only:  RITHMIC_USER, RITHMIC_PASSWORD  [RITHMIC_SYSTEM, RITHMIC_GATEWAY, RITHMIC_ACCOUNT]
// Usage: npm run build && node scripts/rithmic-test.js
// Steps: login on all 4 plants -> accounts -> front-month MNQ -> 5-min history -> live price -> P&L ->
//        a buy LIMIT far below the market (cannot fill) -> modify it -> cancel it.
'use strict';
const { RithmicBroker } = require('../dist/brokers/rithmic');
const env = process.env;
if (!env.RITHMIC_USER || !env.RITHMIC_PASSWORD) { console.error('Set RITHMIC_USER and RITHMIC_PASSWORD.'); process.exit(2); }
const step = (s) => console.log('\n== ' + s);
(async () => {
  const b = new RithmicBroker();
  step('login (order, ticker, history, P&L plants)');
  await b.connect({ user: env.RITHMIC_USER, password: env.RITHMIC_PASSWORD, system: env.RITHMIC_SYSTEM || '', gateway: env.RITHMIC_GATEWAY || '', accountId: env.RITHMIC_ACCOUNT || '' });
  console.log('accounts:', b.accounts);
  step('history: last 6 five-minute bars of MNQ');
  const h = await b.getHistory('MNQ', 'min5', 6);
  for (const x of h) console.log(new Date(x.t).toISOString(), x.o, x.h, x.l, x.c, x.v);
  step('live price');
  let px;
  b.onQuote(q => { if (q.symbol === 'MNQ' && px === undefined) { px = q.price; } });
  await b.subscribe(['MNQ']);
  for (let i = 0; i < 30 && px === undefined; i++) await new Promise(r => setTimeout(r, 500));
  px = px ?? b.lastPrice('MNQ') ?? h[h.length - 1]?.c;
  console.log('MNQ last price:', px);
  step('P&L and positions');
  await new Promise(r => setTimeout(r, 1500));
  try { console.log(await b.getPnLBreakdown()); } catch (e) { console.log('P&L:', e.message); }
  if (px && env.RITHMIC_SKIP_ORDERS !== '1') {
    const far = Math.round((px * 0.9) / 0.25) * 0.25;
    step(`buy LIMIT 1 MNQ @ ${far} (10% below, cannot fill), modify, cancel`);
    const id = await b.placeOrder({ symbol: 'MNQ', side: 'buy', qty: 1, type: 'limit', price: far });
    console.log('order id:', id);
    await new Promise(r => setTimeout(r, 2000)); console.log('working:', await b.getOpenOrders());
    await b.modifyOrder(id, { price: far - 10 }); await new Promise(r => setTimeout(r, 1500)); console.log('after modify:', await b.getOpenOrders());
    await b.cancelOrder(id); await new Promise(r => setTimeout(r, 1500)); console.log('after cancel:', await b.getOpenOrders());
  }
  await b.disconnect(); console.log('\nAll steps finished.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
