'use strict';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

const NAMES = { projectx: 'TopstepX', rithmic: 'Rithmic', cqg: 'CQG', tradovate: 'Tradovate', ninjatrader: 'NinjaTrader' };
const nm = v => NAMES[v] || v;
const STATUS = { ready: '', beta: ' (beta)', 'needs-approval': ' (needs approval)' };
const TITLES = { journal: 'Journal', ai: 'Claude', rank: 'Compare mixes', dash: 'Today', chart: 'Chart', acct: 'Progress', accts: 'Accounts', k: 'Strategies', kval: 'Validate the K system', strat: 'Custom strategies', conn: 'Connections', risk: 'Risk limits', alerts: 'TradingView alerts' };
// Mixes you picked from Compare mixes: always offered in the mix lists (Strategies page and each account).
const PINNED_MIXES = ['K8 + K9 + K1 + K3 + K4 + K6 + K7', 'K8 + K9 + K3 + K4 + K5 + K6 + K7'];
const STAGE = { evaluation: ['Evaluation', 'Profit target'], funded: ['Funded', 'Payout target'], live: ['Live', 'Payout target'], practice: ['Practice', 'Practice goal'] };
const DD = { eod: 'EOD trailing', intraday: 'Intraday trailing', static: 'Static' };
const MULT = { ES: 50, NQ: 20, MES: 5, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5, CL: 1000, MCL: 100, GC: 100, MGC: 10 };
const TF = { 15: '15s', 30: '30s', 60: '1m', 120: '2m', 300: '5m', 900: '15m', 3600: '1h' };
const tfl = sec => (sec < 60 ? `${sec}s` : sec < 3600 ? `${sec / 60}m` : `${sec / 3600}h`);
const SOURCE = { library: 'Keel library', tradingview: 'TradingView alerts', pine: 'Pine Script', custom: 'Custom' };

let poll = null, cat = null, last = null, running = false, noticeTimer = null;
let store = { selected: '', accounts: [] }, strats = [], savedRisk = null, symbols = [];
let stageTouched = 0;

// ---------- formatting ----------
const money = n => (n > 0.004 ? '+' : n < -0.004 ? '\u2212' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = n => '$' + Math.abs(Math.round(n)).toLocaleString();
const cents = n => '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const k$ = n => (n >= 1000 ? '$' + (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'k' : '$' + n.toLocaleString());
const sign = (node, n) => { node.textContent = money(n); node.classList.toggle('pos', n > 0.004); node.classList.toggle('neg', n < -0.004); };
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
function ago(t) { const s = Math.round((Date.now() - t) / 1000); if (s < 10) return 'just now'; if (s < 60) return `${s} sec ago`; const m = Math.round(s / 60); return m < 60 ? `${m} min ago` : new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function notice(msg, ok) { const n = $('notice'); n.textContent = msg; n.hidden = !msg; n.classList.toggle('ok', !!ok); clearTimeout(noticeTimer); if (msg) noticeTimer = setTimeout(() => { n.hidden = true; }, 9000); }
function flash(node, text, bad) { node.textContent = text; node.classList.toggle('bad', !!bad); clearTimeout(node._t); if (!bad) node._t = setTimeout(() => { node.textContent = ''; }, 4000); }
const selAcct = () => store.accounts.find(a => a.id === store.selected) || null;

// ---------- navigation ----------
let view = 'dash';
function go(v) {
  view = v; if (v === 'chart') { requestAnimationFrame(() => requestAnimationFrame(drawLive)); void tkRender(); } if (v === 'k') kLoad(); if (v === 'accts') loadAcctDefaults().then(renderAccounts); if (v === 'rank') rkLoad(); if (v === 'ai') aiLoad(); if (v === 'conn') dcLoad(); if (v === 'journal') void jLoad();
  for (const k of Object.keys(TITLES)) $('v-' + k).hidden = k !== v;
  document.querySelectorAll('#nav button').forEach(b => { if (b.dataset.go === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('title').textContent = v === 'dash' ? greeting() : TITLES[v];
  $('dateline').textContent = v === 'dash' ? new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) : '';
}
document.querySelectorAll('#nav button').forEach(b => { b.onclick = () => go(b.dataset.go); });

// ---------- account picker (grouped by prop firm) ----------
function renderPicker() {
  const sel = $('acctSel'), groups = new Map();
  for (const a of store.accounts) { if (!groups.has(a.firm)) groups.set(a.firm, []); groups.get(a.firm).push(a); }
  const opts = [new Option('Paper trading (no account)', '')];
  for (const firm of [...groups.keys()].sort()) {
    const g = document.createElement('optgroup'); g.label = firm;
    for (const a of groups.get(firm).sort((x, y) => x.label.localeCompare(y.label))) g.append(new Option(`${a.label} \u00b7 ${STAGE[a.stage][0]}${a.plan ? ' \u00b7 ' + a.plan : ''}`, a.id));
    opts.push(g);
  }
  sel.replaceChildren(...opts); sel.value = store.selected; sel.disabled = running;
  sel.title = running ? 'Stop the bot to switch accounts.' : '';
}
$('acctSel').onchange = async () => {
  const r = await window.keel.selectAccount($('acctSel').value);
  if (r.ok) { store = r.store; renderAccounts(); } else { notice(r.error); }
  renderPicker();
};

// ---------- today ----------
function numbers(s) {   // running: from the bot; stopped: from the account readout
  const st = s.stats, w = s.watch && s.watch.data;
  if (s.running && st) return { today: st.total, realized: st.realized, unrealized: st.unrealized, net: st.progress && st.account ? st.progress.netProfit : null, balance: st.progress ? st.progress.balance : null, progress: st.progress, account: st.account, positions: st.positions };
  if (w) return { today: w.today, realized: w.realized, unrealized: w.unrealized, net: w.total, balance: w.balance, progress: w.progress, account: w.account, positions: w.positions };
  return null;
}

function sayToday(s, n) {
  const st = s.stats;
  if (s.running && st && st.halted) return 'Trading is stopped for today because your daily loss limit was reached.';
  if (!n) return s.watch && s.watch.error ? s.watch.error : store.selected ? 'Connecting to your account\u2026' : "The bot is stopped. Pick an account at the top, then press Start bot when you're ready.";
  const t = n.today;
  let line = Math.abs(t) < 0.005 ? "You're flat so far today." : t > 0 ? `You're up ${cents(t)} today.` : `You're down ${cents(t)} today.`;
  if (s.running && st.paused) line += ' You reached your daily goal, so Keel closed everything and stopped trading this account for today.';
  else if (n.progress && n.progress.dailyTarget > 0 && t > 0) line += ` That's ${Math.round(n.progress.dailyPct)}% of your ${plain(n.progress.dailyTarget)} daily goal.`;
  if (s.running && t < 0) line += ` You have ${plain(st.limit + t)} left before your daily loss limit.`;
  if (!s.running) line += ' The bot is stopped.';
  return line;
}

// Today's P&L: a real chart (Lightweight Charts, in its own frame like the Chart page) - green above zero, red below.
let pnlFrame = null, pnlReady = false, pnlChart = null, pnlSeries = null, pnlLines = [], pnlLimit = null, pnlLast = null;
function drawChart(hist, limit) {
  const box = $('chart');
  if (!hist || hist.length < 2) {
    if (pnlFrame) { pnlFrame = null; pnlReady = false; pnlChart = null; pnlSeries = null; pnlLimit = null; }
    box.classList.remove('lw'); box.replaceChildren(el('p', 'empty', 'Once the bot is running, your day will draw itself here.')); return;
  }
  pnlLast = [hist, limit];
  if (!pnlFrame) {
    box.classList.add('lw');
    pnlFrame = document.createElement('iframe'); pnlFrame.title = "Today's profit and loss";
    pnlFrame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}#c{position:absolute;inset:0}</style>'
      + '<script src="vendor/lightweight-charts.js"><\/script></head><body><div id="c"></div></body></html>';
    pnlFrame.onload = () => { pnlReady = true; if (pnlLast) drawChart(pnlLast[0], pnlLast[1]); };
    box.replaceChildren(pnlFrame); return;
  }
  if (!pnlReady) return;
  const W = pnlFrame.contentWindow, LC = W && W.LightweightCharts; if (!LC) return;
  const usdFmt = v => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (!pnlChart) {
    pnlChart = LC.createChart(W.document.getElementById('c'), {
      autoSize: true, layout: { background: { type: 'solid', color: 'rgba(0,0,0,0)' }, textColor: '#7d8a90', fontSize: 11, fontFamily: getComputedStyle(document.body).fontFamily },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.045)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } }, timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: LC.CrosshairMode.Magnet, vertLine: { color: 'rgba(151,164,170,0.35)', style: LC.LineStyle.Dashed, labelBackgroundColor: '#1a252b' }, horzLine: { color: 'rgba(151,164,170,0.35)', style: LC.LineStyle.Dashed, labelBackgroundColor: '#1a252b' } },
      handleScroll: false, handleScale: false, localization: { priceFormatter: usdFmt }
    });
    pnlSeries = pnlChart.addSeries(LC.BaselineSeries, { baseValue: { type: 'price', price: 0 }, lineWidth: 2,
      topLineColor: '#4cc6a4', topFillColor1: 'rgba(76,198,164,0.30)', topFillColor2: 'rgba(76,198,164,0.02)',
      bottomLineColor: '#f0675d', bottomFillColor1: 'rgba(240,103,93,0.02)', bottomFillColor2: 'rgba(240,103,93,0.30)',
      priceLineVisible: false, lastValueVisible: true, priceFormat: { type: 'custom', formatter: usdFmt, minMove: 1 } });
  }
  // one point per second, in New York wall-clock time (the axis reads New York time, like the Chart page)
  const pts = []; for (const [t, v] of hist) { const s = nySec(t); if (pts.length && s <= pts[pts.length - 1].time) pts[pts.length - 1].value = v; else pts.push({ time: s, value: v }); }
  pnlSeries.setData(pts);
  if (pnlLimit !== limit) {
    for (const l of pnlLines) pnlSeries.removePriceLine(l);
    pnlLines = [pnlSeries.createPriceLine({ price: 0, color: 'rgba(151,164,170,0.35)', lineWidth: 1, lineStyle: LC.LineStyle.Solid, axisLabelVisible: false, title: '' }),
      pnlSeries.createPriceLine({ price: -Math.abs(limit), color: 'rgba(240,103,93,0.7)', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: 'Loss limit' })];
    pnlLimit = limit;
  }
  pnlChart.timeScale().fitContent();
}

/** The runway: today's P&L between your daily loss limit (left) and your daily goal (right). */
function drawGauge(n, s) {
  const box = $('gauge'); box.replaceChildren();
  const limit = s.stats ? s.stats.limit : (cat && cat.risk ? cat.risk.maxDailyLoss : 500);
  const goal = n && n.progress && n.progress.dailyTarget > 0 ? n.progress.dailyTarget : limit;
  const v = n ? n.today : 0, W = 900, H = 74, L = 6, R = 6, top = 26, h = 14;
  const x = val => L + ((Math.max(-limit, Math.min(goal, val)) + limit) / (limit + goal)) * (W - L - R);
  const NS = 'http://www.w3.org/2000/svg', mk = (nme, a, txt) => { const e = document.createElementNS(NS, nme); for (const k in a) e.setAttribute(k, a[k]); if (txt !== undefined) e.textContent = txt; return e; };
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Today ${money(v)}, between a daily loss limit of ${plain(limit)} and a ${n && n.progress && n.progress.dailyTarget > 0 ? 'daily goal' : 'matching gain'} of ${plain(goal)}` });
  const x0 = x(0);
  svg.append(mk('rect', { class: 'track', x: L, y: top, width: W - L - R, height: h, rx: 7 }));
  svg.append(mk('rect', { class: 'lossz', x: L + 1, y: top + 1, width: Math.max(0, (x(-limit * 0.8)) - L - 1), height: h - 2, rx: 6 }));
  svg.append(mk('rect', { class: 'goalz', x: x(goal * 0.8), y: top + 1, width: Math.max(0, W - R - x(goal * 0.8) - 1), height: h - 2, rx: 6 }));
  const xv = x(v);
  svg.append(mk('rect', { class: v >= 0 ? 'fillp' : 'filln', x: Math.min(x0, xv), y: top + 3, width: Math.max(1, Math.abs(xv - x0)), height: h - 6, rx: 3 }));
  svg.append(mk('line', { class: 'zero', x1: x0, x2: x0, y1: top - 4, y2: top + h + 4 }));
  svg.append(mk('path', { class: 'needle', d: `M${xv - 7} ${top - 12} L${xv + 7} ${top - 12} L${xv} ${top - 2} Z` }));
  const vt = mk('text', { class: 'val', x: Math.max(40, Math.min(W - 40, xv)), y: top - 15, 'text-anchor': 'middle' }, money(v)); svg.append(vt);
  svg.append(mk('text', { class: 'lbl', x: L, y: H - 4 }, `Loss limit \u2212${plain(limit).slice(1) ? '$' + plain(limit).slice(1) : ''}`));
  svg.append(mk('text', { class: 'lbl', x: x0, y: H - 4, 'text-anchor': 'middle' }, '0'));
  svg.append(mk('text', { class: 'lbl', x: W - R, y: H - 4, 'text-anchor': 'end' }, n && n.progress && n.progress.dailyTarget > 0 ? `Daily goal +${plain(goal)}` : `+${plain(goal)}`));
  box.append(svg);
}

function renderBoard(s) {
  const rows = (s.running && s.accounts) || [], panel = $('acctPanel');
  panel.hidden = rows.length < 2 && !(rows[0] && rows[0].state !== 'Trading' && rows[0].state !== 'Market closed');
  if (panel.hidden) return;
  const live = rows.filter(r => r.state === 'Trading').length;
  $('acctHead').textContent = rows.length > 1 ? (live === rows.length ? `all ${rows.length} trading` : `${live} of ${rows.length} trading`) : '';
  const td = (t, c) => { const x = document.createElement('td'); if (c) x.className = c; x.textContent = t; return x; };
  const pnl = v => { const x = td(v === null || v === undefined ? '\u2014' : money(v), 'r'); if (v > 0.004) x.classList.add('pos'); else if (v < -0.004) x.classList.add('neg'); return x; };
  $('acctRows').replaceChildren(...rows.map(r => {
    const tr = document.createElement('tr'), name = td(r.label + (r.main ? '' : ''));
    if (r.paper !== null && r.paper !== undefined) { const sp = document.createElement('span'); sp.className = 'hint'; sp.textContent = ` \u00b7 paper ${money(r.paper)}`; name.append(sp); }
    const st = td('', ''), dot = document.createElement('span'); dot.className = 'dot ' + (r.state === 'Trading' ? 'ok' : r.state === 'Market closed' || r.state.startsWith('Done') ? 'idle' : 'bad');
    st.append(dot, document.createTextNode(` ${r.state}${r.strategies ? ` \u00b7 ${r.strategies} strategies` : ''}`));
    const ago = r.pricesAgo === null ? 'none yet' : r.pricesAgo < 60 ? `${r.pricesAgo}s ago` : `${Math.round(r.pricesAgo / 60)} min ago`;
    tr.append(name, st, pnl(r.today), pnl(r.total), td(`${r.open}${r.working ? ` + ${r.working} working` : ''}`, 'r'), td(ago, 'r'));
    return tr;
  }));
}

function renderToday(s) {
  renderBoard(s);
  const st = s.stats, n = numbers(s); running = s.running;
  const pill = $('pill');
  pill.textContent = !s.running ? 'Bot stopped' : st && st.halted ? 'Stopped: loss limit' : st && st.paused ? 'Paused: goal reached' : 'Bot running';
  pill.className = 'pill ' + (!s.running ? 'off' : st && st.halted ? 'warn' : 'on');
  $('toggle').textContent = s.running ? 'Stop bot' : 'Start bot';
  $('toggle').className = s.running ? 'ghost' : '';
  $('dSay').textContent = sayToday(s, n);

  if (n) { sign($('sToday'), n.today); $('sSub').textContent = `Closed ${money(n.realized)} \u00b7 Open ${money(n.unrealized)}`; }
  else { $('sToday').textContent = '$0.00'; $('sToday').className = 'num'; $('sSub').textContent = ''; }
  if (n && n.net !== null && n.net !== undefined) { sign($('sNet'), n.net); $('sNetSub').textContent = n.progress && n.progress.profitTarget > 0 ? `${Math.round(n.progress.targetPct)}% of your ${plain(n.progress.profitTarget)} target` : 'Since the account started'; }
  else { $('sNet').textContent = '\u2014'; $('sNet').className = 'num'; $('sNetSub').textContent = store.selected ? '' : 'Pick an account to see it'; }
  if (n && n.balance !== null && n.balance !== undefined) { $('sBal').textContent = cents(n.balance); $('sBalSub').textContent = n.progress && n.progress.cushion !== null ? `${plain(n.progress.cushion)} above your max loss` : ''; }
  else { $('sBal').textContent = '\u2014'; $('sBalSub').textContent = ''; }
  drawGauge(n, s);
  drawChart(s.running && st ? st.history : null, st ? st.limit : 500);

  const box = $('posBox'); box.replaceChildren();
  const pos = n ? n.positions || [] : [];
  if (!pos.length) box.append(el('p', 'empty', 'No open positions right now.'));
  else {
    const t = el('table'), head = el('tr');
    for (const [h, c] of [['Market', ''], ['Side', ''], ['Qty', 'r'], ['Avg price', 'r'], ['Profit and loss', 'r']]) head.append(Object.assign(el('th', c, h), { scope: 'col' }));
    t.append(head);
    for (const p of pos) { const r = el('tr'), c = el('td', 'r'); sign(c, p.pnl || 0); r.append(el('td', '', p.symbol), el('td', '', p.qty > 0 ? 'Long' : 'Short'), el('td', 'r', String(Math.abs(p.qty))), el('td', 'r', Number(p.avgPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })), c); t.append(r); }
    box.append(t);
  }
  const ul = $('events'); ul.replaceChildren();
  const ev = st ? st.events.slice().reverse() : [];
  if (!ev.length) ul.append(el('li', 'empty', 'Nothing has happened yet today.'));
  for (const e of ev) { const li = el('li', e.kind); li.append(el('time', '', ago(e.t)), el('span', 'm', e.msg)); ul.append(li); }
  renderRadar(s.radar);
  renderProgress(s, n);
  updateStratStates(s);
}

// ---------- radar: what each strategy is doing right now ----------
function renderRadar(R) {
  $('radarPanel').hidden = !R || !R.rows.length; if (!R) return;
  $('radarHead').textContent = R.lastCheck ? `last check ${nyTime(R.lastCheck)}${R.nextCheck ? ' · next ' + nyTime(R.nextCheck).replace(/^[A-Za-z]+ \d+, /, '') : ''}` : '';
  const box = $('radar'); box.replaceChildren();
  const LBL = { open: 'In a trade', working: 'Order working', signal: 'Signal', note: 'Note', paused: 'Paused', wait: 'Watching' };
  for (const r of R.rows) {
    const c = el('div', 'rchip ' + r.kind);
    c.append(el('b', '', r.id), el('span', 'rstate', LBL[r.kind]), el('span', 'rtext', r.kind === 'wait' ? (r.last ? 'last signal ' + nyTime(r.last) : r.text || 'no signal in the loaded history') : r.text));
    box.append(c);
  }
}

// ---------- progress ----------
function setBar(bar, pct, state) { bar.value = Math.max(0, Math.min(100, pct)); bar.className = state || ''; }
function applyStage(st) { document.querySelectorAll('#stageSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.stage === st))); $('tLabel').textContent = STAGE[st][1]; }

function renderProgress(s, n) {
  const a = selAcct(), p = n && n.progress, info = n && n.account;
  document.querySelectorAll('#stageSeg button').forEach(b => { b.disabled = !a; });
  $('editRules').disabled = !a;
  $('aName').textContent = a ? `${a.label} \u00b7 ${a.firm}${a.plan ? ' \u00b7 ' + a.plan : ''}` : 'Pick an account at the top to see its progress.';
  $('aBal').textContent = n && n.balance !== null && n.balance !== undefined ? cents(n.balance) : '\u2014';
  if (a && Date.now() - stageTouched > 3000) applyStage(a.stage);
  if (!p) $('poPanel').hidden = true;
  if (!p) { for (const k of ['t', 'c', 'd', 'f']) { $(k + 'Text').textContent = '\u2014'; setBar($(k + 'Bar'), 0); $(k + 'Sub').textContent = ''; } $('daysBox').replaceChildren(el('p', 'empty', a ? (s.watch && s.watch.error) || 'Loading\u2026' : 'No account picked.')); return; }

  $('tText').textContent = p.profitTarget > 0 ? `${money(p.netProfit)} of ${plain(p.profitTarget)}` : money(p.netProfit);
  setBar($('tBar'), p.targetPct, p.targetMet ? 'ok' : '');
  $('tSub').textContent = p.profitTarget <= 0 ? 'No target set. Add one with Edit rules.' : p.targetMet ? "You've reached it, and the consistency rule is met."
    : p.netProfit >= p.profitTarget ? "You've reached it, but one day is too big a share. A few more steady days will even it out." : `${plain(p.profitTarget - p.netProfit)} to go.${p.consistencyOn && p.consistencyLimit > 0 ? ` Keep any single day under ${plain(p.consistencyLimit)} (the consistency rule${p.bestDay > 0 ? `; best day so far ${plain(p.bestDay)}` : ''}).` : ''}`;
  if (!p.consistencyOn) { $('cText').textContent = 'Off'; setBar($('cBar'), 0); $('cSub').textContent = p.stage === 'practice' ? "Practice accounts don't use it." : 'Turn it on with Edit rules.'; }
  else {
    $('cText').textContent = `Best day ${plain(p.bestDay)} \u00b7 limit ${plain(p.consistencyLimit)}`;
    setBar($('cBar'), p.consistencyUsedPct, p.consistencyOk ? (p.consistencyUsedPct > 80 ? '' : 'ok') : 'bad');
    $('cSub').textContent = p.consistencyOk ? (p.consistencyUsedPct > 80 ? "You're within the rule, but close to the limit." : "You're within the rule.") : `Your best day is ${plain(p.bestDay - p.consistencyLimit)} over. More profit on other days brings it back in line.`;
  }
  if (p.dailyTarget > 0) { $('dText').textContent = `${money(p.todayPnl)} of ${plain(p.dailyTarget)}`; setBar($('dBar'), p.dailyPct, p.dailyHit ? 'ok' : ''); $('dSub').textContent = p.dailyHit ? (s.stats && s.stats.paused ? 'Reached. Everything is closed and this account is stopped for today.' : 'Reached. Nice work.') : `${plain(p.dailyTarget - p.todayPnl)} to go today.`; }
  else { $('dText').textContent = 'Off'; setBar($('dBar'), 0); $('dSub').textContent = 'Set a daily goal with Edit rules.'; }
  if (p.floor !== null) {
    $('fText').textContent = `${plain(p.cushion)} of room`;
    const room = info ? info.startBalance - p.floor : 0;
    setBar($('fBar'), room > 0 ? (p.cushion / (p.cushion + Math.max(0, room))) * 100 : 100, p.cushion < 500 ? 'bad' : 'ok');
    $('fSub').textContent = `Your balance can fall to $${p.floor.toLocaleString()} before you hit the max loss.`;
  } else { $('fText').textContent = '\u2014'; setBar($('fBar'), 0); $('fSub').textContent = "Set a max loss with Edit rules, or this connection doesn't share your balance yet."; }

  void poRefresh(a, p);
  const box = $('daysBox'); box.replaceChildren();
  const t = el('table'), head = el('tr');
  for (const [h, c] of [['Day', ''], ['Profit and loss', 'r']]) head.append(Object.assign(el('th', c, h), { scope: 'col' }));
  t.append(head);
  const row = (label, v, best) => { const r = el('tr'), c = el('td', 'r'); sign(c, v); r.append(el('td', best ? 'best' : '', label + (best ? ' \u00b7 best day' : '')), c); t.append(r); };
  row('Today', p.todayPnl, p.todayPnl > 0 && p.todayPnl === p.bestDay);
  for (const d of p.days.slice().reverse()) row(new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), d.pnl, d.pnl > 0 && d.pnl === p.bestDay);
  box.append(t);
}
document.querySelectorAll('#stageSeg button').forEach(b => {
  b.onclick = async () => {
    const a = selAcct(); if (!a) return;
    stageTouched = Date.now(); applyStage(b.dataset.stage);
    const r = await window.keel.updateAccounts([a.id], { stage: b.dataset.stage });
    if (r.ok) { store = r.store; renderAccounts(); renderPicker(); flash($('stageMsg'), `Marked as ${STAGE[b.dataset.stage][0].toLowerCase()}.`); } else flash($('stageMsg'), r.error, true);
  };
});
// ---------- payouts ----------
let poAt = 0, poFor = '', poRulesFor = '', poP = null;
async function poRefresh(a, p, force) {
  $('poPanel').hidden = !a || !p || !['funded', 'live'].includes(a.stage);
  if ($('poPanel').hidden) return;
  poP = p;
  if (!force && poFor === a.id && Date.now() - poAt < 15000) return;
  poAt = Date.now(); poFor = a.id;
  const r = await window.keel.payouts(a.id, p.days, p.todayPnl, p.netProfit); if (!r) return;
  const st = r.status, R = r.rec.rules;
  if (poRulesFor !== a.id) {   // fill the rules form once per account, so typing is never overwritten
    poRulesFor = a.id;
    [['prWinDays', R.winDays], ['prWinMin', R.winDayMin], ['prPct', R.maxPct], ['prMax', R.maxAmount], ['prMin', R.minAmount], ['prBuf', R.buffer], ['prCons', R.consistencyPct], ['prAltDays', R.altDays ?? 0], ['prAltPct', R.altPct ?? 0], ['prSplit', R.split ?? 100]].forEach(([id, v]) => { $(id).value = v; });
    $('poDate').value = r.today;
  }
  $('poHead').textContent = st.eligible ? `Eligible now (${st.route} route): request up to ${cents(st.request)}${st.net && st.net !== st.request ? `, ${cents(st.net)} to you` : ''}` : `Not yet eligible · ${st.winDays} of ${st.winDaysNeeded} winning days${R.altDays ? ` · or ${st.tradedDays} of ${R.altDays} trading days` : ''}`;
  setBar($('poBar'), st.winDaysNeeded ? (st.winDays / st.winDaysNeeded) * 100 : 100, st.eligible ? 'ok' : '');
  $('poSub').textContent = [
    `This cycle${st.cycleStart ? ' (since your ' + new Date(st.cycleStart + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' payout)' : ''}: ${money(st.cycleProfit)} over ${st.cycleDays} day${st.cycleDays === 1 ? '' : 's'}; profit still in the account ${cents(st.available)}.`,
    st.reasons.length ? 'Still needed: ' + st.reasons.join('; ') + '.' : '',
    st.needFor2k > 0 ? `For a $2,000 request: ${cents(st.needFor2k)} more profit in the account.` : 'There is enough profit in the account for a $2,000 request.',
    `Paid out on this account: ${cents(st.totalPaid)} in ${st.payouts} payout${st.payouts === 1 ? '' : 's'}${st.cost ? `, account cost ${cents(st.cost)}, net ${money(st.netAfterCost)}` : ''}.`,
    `All accounts: ${cents(r.totals.paid)} paid out in ${r.totals.payouts}, ${cents(r.totals.cost)} spent on accounts, net ${money(r.totals.paid - r.totals.cost)}.`
  ].filter(Boolean).join(' ');
  const box = $('poList'); box.replaceChildren();
  if (r.rec.taken.length) {
    const t = el('table'), head = el('tr');
    for (const [h, c] of [['Date', ''], ['Amount', 'r'], ['Note', ''], ['', 'r']]) head.append(Object.assign(el('th', c, h), { scope: 'col' }));
    t.append(head);
    r.rec.taken.forEach((x, i) => {
      const row = el('tr'), del = el('button', 'ghost small', 'Remove');
      del.onclick = async () => { if (!confirm(`Remove the ${cents(x.amount)} payout on ${x.date}?`)) return; const q = await window.keel.payoutRemove(a.id, i); if (!q.ok) flash($('poMsg'), q.error, true); void poRefresh(a, p, true); };
      const dc = el('td', 'r'); dc.append(del);
      row.append(el('td', '', x.date), el('td', 'r', cents(x.amount)), el('td', '', x.note), dc); t.append(row);
    });
    box.append(t);
  }
}
$('poAdd').onclick = async () => {
  const a = selAcct(); if (!a) return;
  const amount = Number($('poAmt').value), date = $('poDate').value;
  if (!(amount > 0)) { flash($('poMsg'), 'Enter the payout amount.', true); return; }
  const r = await window.keel.payoutAdd(a.id, { date, amount, note: $('poNote').value });
  if (!r.ok) { flash($('poMsg'), r.error, true); return; }
  $('poAmt').value = ''; $('poNote').value = ''; flash($('poMsg'), `Recorded a ${cents(amount)} payout. The next cycle starts after ${date}.`);
  if (poP) void poRefresh(a, poP, true);
};
$('prSave').onclick = async () => {
  const a = selAcct(); if (!a) return;
  const n = id => Number($(id).value);
  const r = await window.keel.payoutRules(a.id, { winDays: n('prWinDays'), winDayMin: n('prWinMin'), maxPct: n('prPct'), maxAmount: n('prMax'), minAmount: n('prMin'), buffer: n('prBuf'), consistencyPct: n('prCons'), altDays: n('prAltDays'), altPct: n('prAltPct'), split: n('prSplit') });
  if (!r.ok) { flash($('poMsg'), r.error, true); return; }
  flash($('poMsg'), 'Payout rules saved.'); if (poP) void poRefresh(a, poP, true);
};

$('prPreset').onclick = () => {   // fill the form; Save rules stores it
  [['prWinDays', 5], ['prWinMin', 150], ['prPct', 50], ['prMax', 8000], ['prMin', 125], ['prBuf', 0], ['prCons', 0], ['prAltDays', 3], ['prAltPct', 40], ['prSplit', 90]].forEach(([id, v]) => { $(id).value = v; });
  flash($('poMsg'), 'Filled in the Topstep 50K Static payout rules (5 days of $150+, or 3 days with the best day at most 40%; 50% up to $8,000; 90% split). Check them, then Save rules.');
};
$('editRules').onclick = () => { const a = selAcct(); if (a) openDrawer('edit', [a.id], $('editRules')); };

// ---------- accounts list ----------
let acctDefaults = { risk: 0, mixes: [] };
async function loadAcctDefaults() {
  try {
    const k = await window.keel.kGet(); if (!k) return;
    const R = k.rankings, seen = new Set(), mixes = [];
    for (const r of [...(R ? R.mixes : [])].sort((x, y) => (y.score ?? 0) - (x.score ?? 0))) { if (!seen.has(r.strategies)) { seen.add(r.strategies); mixes.push(r.strategies); } if (mixes.length >= 10) break; }
    if (R && !seen.has(R.recommended.strategies)) mixes.unshift(R.recommended.strategies);
    for (const m of [...PINNED_MIXES].reverse()) if (!seen.has(m)) { seen.add(m); mixes.splice(R && mixes[0] === R.recommended.strategies ? 1 : 0, 0, m); }
    acctDefaults = { risk: k.cfg.riskUsd, mixes };
  } catch { /* keep defaults */ }
}
function renderAccounts() {
  const q = $('acctSearch').value.trim().toLowerCase(), box = $('acctGroups'); box.replaceChildren();
  const list = store.accounts.filter(a => !q || [a.label, a.firm, a.plan].some(v => v.toLowerCase().includes(q)));
  if (!store.accounts.length) { const p = el('div', 'panel'); p.append(el('h2', '', 'No accounts yet'), el('p', 'hint', 'Add your first account to track its rules and progress. Paper trading works without one.')); box.append(p); return; }
  if (!list.length) { box.append(el('p', 'empty', 'No accounts match that search.')); return; }
  const groups = new Map(); for (const a of list) { if (!groups.has(a.firm)) groups.set(a.firm, []); groups.get(a.firm).push(a); }
  for (const firm of [...groups.keys()].sort()) {
    const accts = groups.get(firm).sort((x, y) => x.label.localeCompare(y.label));
    const need = accts.filter(a => !(a.size > 0 && a.maxLoss > 0)).length;
    const g = el('section', 'group'), head = el('div', 'ghead');
    head.append(el('h2', '', firm), el('span', 'count', `${accts.length} account${accts.length === 1 ? '' : 's'}`), el('span', 'tag ' + (need ? 'need' : 'ok'), need ? `${need} need rules` : 'Rules set'), el('span', 'spacer'));
    if (accts.length > 1) { const b = el('button', 'ghost small', 'Edit all'); b.onclick = () => openDrawer('bulk', accts.map(a => a.id), b); head.append(b); }
    g.append(head);
    const wrap = el('div', 'tscroll'), t = el('table'), hr = el('tr');
    for (const h of ['Trade', 'Account', 'Risk / trade', 'Strategies', 'Type', 'Plan', 'Size', 'Drawdown', 'Max loss', 'Daily loss', 'Consistency', 'Target', 'Contracts', '']) hr.append(Object.assign(el('th', ['Size', 'Max loss', 'Daily loss', 'Consistency', 'Target', 'Contracts'].includes(h) ? 'r' : '', h), { scope: 'col' }));
    t.append(hr);
    for (const a of accts) {
      const r = el('tr'), name = el('td'), conn = cat.brokers.find(b => b.id === a.connection);
      const top = el('div', 'aname2'); top.append(document.createTextNode(a.label + ' '));
      if (a.id === store.selected) top.append(el('span', 'tag sel', 'In use'));
      name.append(top, el('div', 'asub', conn ? conn.name : a.connection));
      const caps = a.maxMini || a.maxMicro ? `${a.maxMini || '\u2014'} mini / ${a.maxMicro || '\u2014'} micro` : '\u2014';
      const tw = el('td'), lab = el('label', 'switch'), cb = el('input'); cb.type = 'checkbox'; cb.checked = a.trade !== false;
      cb.setAttribute('aria-label', `Keel may trade ${a.label}`); cb.disabled = running; cb.title = running ? 'Stop the bot to change which accounts trade.' : '';
      cb.onchange = async () => { const res = await window.keel.updateAccounts([a.id], { trade: cb.checked }); if (res.ok) { store = res.store; renderAccounts(); } else { notice(res.error); cb.checked = !cb.checked; } };
      lab.append(cb, el('span')); tw.append(lab); r.append(tw);
      // this account's risk per trade and strategy mix (empty = the Strategies page settings)
      const rk = el('td'), ri = el('input'); ri.type = 'number'; ri.min = '50'; ri.max = '5000'; ri.step = '25'; ri.style.width = '96px';
      ri.value = a.riskUsd > 0 ? String(a.riskUsd) : ''; ri.placeholder = acctDefaults.risk ? `$${acctDefaults.risk}` : 'default'; ri.setAttribute('aria-label', `Risk per trade for ${a.label}`);
      ri.onchange = async () => { const v = ri.value.trim() === '' ? 0 : Number(ri.value); const res = await window.keel.updateAccounts([a.id], { riskUsd: v }); if (res.ok) { store = res.store; notice(`${a.label}: risk per trade ${v ? '$' + v : 'from the Strategies page'}.`, true); } else { notice(res.error); ri.value = a.riskUsd > 0 ? String(a.riskUsd) : ''; } };
      rk.append(ri);
      const mx = el('td'), ms = el('select'); ms.style.minWidth = '240px'; ms.style.maxWidth = '300px'; ms.setAttribute('aria-label', `Strategies for ${a.label}`);
      const opts = [['', 'Strategies page switches'], ...acctDefaults.mixes.map(m => [m, m])]; if (a.mix && !opts.some(o => o[0] === a.mix)) opts.push([a.mix, a.mix]);
      for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; ms.append(o); } ms.value = a.mix || '';
      ms.onchange = async () => { const res = await window.keel.updateAccounts([a.id], { mix: ms.value }); if (res.ok) { store = res.store; notice(`${a.label}: ${ms.value || 'uses the Strategies page switches'}.`, true); } else { notice(res.error); ms.value = a.mix || ''; } };
      mx.append(ms);
      r.append(name, rk, mx, el('td', '', STAGE[a.stage][0]), el('td', '', a.plan || '\u2014'), el('td', 'r', a.size ? k$(a.size) : '\u2014'), el('td', '', DD[a.drawdown]),
        el('td', 'r', a.maxLoss ? plain(a.maxLoss) : '\u2014'), el('td', 'r', a.dailyLoss ? plain(a.dailyLoss) : '\u2014'), el('td', 'r', a.consistencyPct ? a.consistencyPct + '%' : '\u2014'),
        el('td', 'r', a.profitTarget ? plain(a.profitTarget) : '\u2014'), el('td', 'r', caps));
      const acts = el('td', 'acts'), wrapA = el('span', 'rowacts');
      if (a.id !== store.selected) { const u = el('button', 'ghost small', 'Use'); u.disabled = running; u.title = running ? 'Stop the bot to switch accounts.' : ''; u.onclick = async () => { const res = await window.keel.selectAccount(a.id); if (res.ok) { store = res.store; renderAccounts(); renderPicker(); } else notice(res.error); }; wrapA.append(u); }
      const e = el('button', 'small', 'Edit'); e.onclick = () => openDrawer('edit', [a.id], e); wrapA.append(e);
      acts.append(wrapA); r.append(acts); t.append(r);
    }
    wrap.append(t); g.append(wrap); box.append(g);
  }
}
$('acctSearch').oninput = renderAccounts;
let found = [];
$('findAccts').onclick = async () => {
  const b = $('findAccts'); b.disabled = true; b.textContent = 'Asking your logins…'; $('findMsg').textContent = '';
  try {
    const r = await window.keel.discoverAccounts();
    if (!r || !r.ok) { $('findMsg').textContent = r ? r.error : 'Something went wrong.'; return; }
    found = r.accounts; const t = $('foundTable'); t.replaceChildren();
    $('findMsg').textContent = `${found.length} account${found.length === 1 ? '' : 's'} found.` + (r.errors.length ? ' ' + r.errors.join(' ') : '');
    if (!found.length) { $('importAccts').hidden = true; return; }
    const hr = el('tr'); for (const h of ['', 'Account', 'Login', 'Balance', 'Status']) hr.append(el('th', '', h)); t.append(hr);
    found.forEach((x, i) => {
      const row = el('tr'), c = el('td'), cb = el('input'); cb.type = 'checkbox'; cb.dataset.i = String(i); cb.disabled = !!x.added; cb.checked = !x.added && x.canTrade;
      cb.setAttribute('aria-label', `Add ${x.name}`); c.append(cb);
      row.append(c, el('td', '', x.name), el('td', '', x.login), el('td', '', typeof x.balance === 'number' && isFinite(x.balance) ? usd0(x.balance) : '—'),
        el('td', x.added ? 'pos' : '', x.added ? 'Already added' : !x.canTrade ? "Can't trade (closed or blocked)" : x.simulated ? 'New (practice / evaluation)' : 'New'));
      t.append(row);
    });
    $('importAccts').hidden = false;
  } finally { b.disabled = false; b.textContent = 'Find my accounts'; }
};
$('importAccts').onclick = async () => {
  const items = [...document.querySelectorAll('#foundTable input[type=checkbox]:checked:not(:disabled)')].map(cb => found[Number(cb.dataset.i)]);
  if (!items.length) { $('findMsg').textContent = 'Tick at least one account.'; return; }
  const r = await window.keel.importAccounts(items);
  if (!r.ok) { $('findMsg').textContent = r.error; return; }
  store = r.store; renderAccounts(); renderPicker(); $('findMsg').textContent = `Added ${items.length}. They are switched off for trading: check their rules, then switch on the ones Keel should trade.`;
  $('findAccts').click();
};
$('addAcct').onclick = () => openDrawer('add', [], $('addAcct'));
$('sampleAccts').onclick = async () => { const r = await window.keel.addSampleAccounts(); if (r.ok) { store = r.store; renderAccounts(); renderPicker(); } else notice(r.error); };

// ---------- account drawer (add, edit, edit all) ----------
const FIELDS = [['label', 'dLabel', 'text'], ['firm', 'dFirm', 'sel'], ['connection', 'dConn', 'sel'], ['brokerRef', 'dRef', 'text'], ['stage', 'dStage', 'sel'], ['plan', 'dPlan', 'text'],
  ['size', 'dSize', 'num'], ['drawdown', 'dDD', 'sel'], ['maxLoss', 'dMaxLoss', 'num'], ['dailyLoss', 'dDailyLoss', 'num'], ['profitTarget', 'dTarget', 'num'], ['consistencyPct', 'dPct', 'num'],
  ['consistencyBasis', 'dBasis', 'sel'], ['minDays', 'dMinDays', 'num'], ['maxMini', 'dMini', 'num'], ['maxMicro', 'dMicro', 'num'], ['dailyGoal', 'dGoal', 'num'], ['pauseAtGoal', 'dPause', 'check'],
  ['cost', 'dCost', 'num'], ['purchaseDate', 'dDate', 'text'], ['notes', 'dNotes', 'text']];
const RULE_KEYS = ['stage', 'plan', 'size', 'drawdown', 'maxLoss', 'dailyLoss', 'profitTarget', 'consistencyPct', 'consistencyBasis', 'minDays', 'maxMini', 'maxMicro', 'dailyGoal', 'pauseAtGoal'];
const D = { mode: 'edit', ids: [], touched: new Set(), opener: null, confirmDelete: false };

function setField(id, type, v, mixed) {
  const e = $(id);
  if (type === 'check') { e.indeterminate = !!mixed; e.checked = !mixed && !!v; return; }
  if (type === 'sel') { [...e.options].filter(o => o.value === '__mixed').forEach(o => o.remove()); if (mixed) { const o = new Option('Mixed', '__mixed'); e.prepend(o); e.value = '__mixed'; } else e.value = v; return; }
  e.value = mixed ? '' : (v ?? ''); e.placeholder = mixed ? 'Mixed' : (e.dataset.ph ?? e.placeholder);
}
function readField(type, id) { const e = $(id); return type === 'check' ? e.checked : type === 'num' ? (e.value === '' ? 0 : Number(e.value)) : e.value; }

function openDrawer(mode, ids, opener) {
  D.mode = mode; D.ids = ids; D.touched = new Set(); D.opener = opener; D.confirmDelete = false;
  const firms = [...new Set(['Topstep', 'Lucid Trading', ...store.accounts.map(a => a.firm), 'Other'])];
  $('dPreset').replaceChildren(new Option('Choose a plan\u2026', ''), ...cat.presets.map((p, i) => new Option(`${p.firm}: ${p.plan}`, String(i))));
  $('dFirm').replaceChildren(...firms.map(f => new Option(f, f)));
  $('dConn').replaceChildren(...cat.brokers.map(b => new Option(b.name + STATUS[b.status], b.id)));
  const accts = store.accounts.filter(a => ids.includes(a.id));
  const others = store.accounts.filter(a => !ids.includes(a.id));
  $('dCopy').replaceChildren(new Option(others.length ? 'Choose an account\u2026' : 'No other accounts yet', ''), ...others.map(a => new Option(`${a.label} (${a.firm})`, a.id)));
  $('dCopy').disabled = !others.length;
  const base = mode === 'add' ? { ...cat.blank, connection: cat.dev ? 'topstep-test' : 'paper' } : accts[0];
  for (const [key, id, type] of FIELDS) {
    const vals = mode === 'bulk' ? accts.map(a => a[key]) : [base[key]];
    setField(id, type, vals[0], vals.some(v => v !== vals[0]));
  }
  document.querySelectorAll('#drawer [data-single]').forEach(x => { x.hidden = mode === 'bulk'; });
  $('drawerTitle').textContent = mode === 'add' ? 'Add an account' : mode === 'bulk' ? `Edit all ${accts.length} ${accts[0].firm} accounts` : `Edit ${base.label}`;
  $('drawerNote').textContent = mode === 'bulk' ? 'Fields marked Mixed differ between accounts. Only the fields you change are saved to every account.' : mode === 'add' ? 'Fill in the rules from your prop firm. You can change them any time.' : '';
  $('drawerDelete').hidden = mode !== 'edit'; $('drawerDelete').textContent = 'Delete account';
  $('drawerMsg').textContent = '';
  $('drawer').hidden = false; $('drawerBack').hidden = false;
  (mode === 'bulk' ? $('dFirm') : $('dLabel')).focus();
}
function closeDrawer() { $('drawer').hidden = true; $('drawerBack').hidden = true; if (D.opener) D.opener.focus(); }
for (const [key, id, type] of FIELDS) $(id).addEventListener(type === 'check' || type === 'sel' ? 'change' : 'input', () => { D.touched.add(key); $(id).indeterminate = false; });
$('dPreset').onchange = () => {
  const p = cat.presets[Number($('dPreset').value)]; if (!p) return;
  for (const [key, id, type] of FIELDS) if (key in p) { setField(id, type, p[key], false); D.touched.add(key); }
  $('dPreset').value = '';
};
$('dCopy').onchange = () => {
  const src = store.accounts.find(a => a.id === $('dCopy').value); if (!src) return;
  for (const [key, id, type] of FIELDS) if (RULE_KEYS.includes(key)) { setField(id, type, src[key], false); D.touched.add(key); }
  $('drawerMsg').textContent = ''; $('dCopy').value = '';
};
$('drawerSave').onclick = async () => {
  const all = Object.fromEntries(FIELDS.map(([key, id, type]) => [key, readField(type, id)]));
  let r;
  if (D.mode === 'add') r = await window.keel.addAccount(all);
  else if (D.mode === 'edit') r = await window.keel.updateAccounts(D.ids, all);
  else {
    const patch = Object.fromEntries([...D.touched].filter(k => !(FIELDS.find(f => f[0] === k)[2] === 'sel' && all[k] === '__mixed')).map(k => [k, all[k]]));
    if (!Object.keys(patch).length) { closeDrawer(); return; }
    r = await window.keel.updateAccounts(D.ids, patch);
  }
  if (!r.ok) { $('drawerMsg').textContent = r.error; return; }
  store = r.store; renderAccounts(); renderPicker(); closeDrawer();
  notice(D.mode === 'add' ? 'Account added.' : 'Saved.', true);
};
$('drawerDelete').onclick = async () => {
  if (!D.confirmDelete) { D.confirmDelete = true; $('drawerDelete').textContent = 'Click again to delete'; return; }
  const r = await window.keel.removeAccount(D.ids[0]);
  if (!r.ok) { $('drawerMsg').textContent = r.error; return; }
  store = r.store; renderAccounts(); renderPicker(); closeDrawer(); notice('Account deleted.', true);
};
$('drawerCancel').onclick = closeDrawer; $('drawerX').onclick = closeDrawer; $('drawerBack').onclick = closeDrawer;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer(); });

// ---------- strategies ----------
function describe(c) {
  const exits = [c.takeProfit ? `TP ${c.takeProfit}` : '', c.stopLoss ? `SL ${c.stopLoss}` : ''].filter(Boolean).join(' / ');
  const size = `${c.symbol} \u00b7 ${c.qty} contract${c.qty === 1 ? '' : 's'}` + (exits ? ` \u00b7 ${exits} pts` : '');
  switch (c.type) {
    case 'ma_cross': return `${c.ma.toUpperCase()} ${c.fast}/${c.slow} cross \u00b7 ${size}`;
    case 'rsi': return `RSI ${c.period}: buy under ${c.low}, exit over ${c.high} \u00b7 ${size}`;
    case 'breakout': return `Breakout of the last ${c.lookback} prices \u00b7 ${size}`;
    case 'tradingview': return `Follows your TradingView alerts \u00b7 ${size}`;
    case 'pine': return `Pine Script on ${TF[c.timeframe]} bars \u00b7 ${size}`;
    case 'keels_special': return `${tfl(c.ltf)} entries, ${tfl(c.ltf * c.htfMult)} bias, ${c.rr}R target \u00b7 ${size}`;
  }
  return size;
}
const perPoint = sym => (MULT[sym] ? ` \u2248 $${MULT[sym]} per point per contract` : '');
const openEdits = new Set(), confirmRemove = new Set(), saveTimers = {};

function field(label, input, cls) { const d = el('div', cls || ''); const l = el('label', '', label); l.htmlFor = input.id; d.append(l, input); return d; }
function numInput(id, v, step, min = 0) { const i = el('input'); i.id = id; i.type = 'number'; i.step = String(step); i.min = String(min); i.value = v; return i; }
function textInput(id, v, max) { const i = el('input'); i.id = id; i.type = 'text'; i.maxLength = max; i.value = v; i.spellcheck = false; return i; }
function selectInput(id, opts, v) { const s = el('select'); s.id = id; s.replaceChildren(...opts.map(([val, t]) => new Option(t, val))); s.value = String(v); return s; }

function editForm(x) {
  const c = x.cfg, p = 's' + x.id + '_', wrap = el('div', 'fgrid4');
  wrap.append(field('Name', textInput(p + 'name', c.name, 60)), field('Market', textInput(p + 'symbol', c.symbol, 12)), field('Contracts', numInput(p + 'qty', c.qty, 1, 1)));
  if (c.type === 'ma_cross') wrap.append(field('Average', selectInput(p + 'ma', [['ema', 'EMA'], ['sma', 'SMA']], c.ma)), field('Fast length', numInput(p + 'fast', c.fast, 1, 2)), field('Slow length', numInput(p + 'slow', c.slow, 1, 3)));
  if (c.type === 'rsi') wrap.append(field('RSI length', numInput(p + 'period', c.period, 1, 2)), field('Buy under', numInput(p + 'low', c.low, 1, 1)), field('Exit over', numInput(p + 'high', c.high, 1, 1)));
  if (c.type === 'breakout') wrap.append(field('Lookback (prices)', numInput(p + 'lookback', c.lookback, 1, 5)));
  if (c.type === 'pine') wrap.append(field('Bar size', selectInput(p + 'timeframe', Object.entries(TF).map(([k, v]) => [k, v]), c.timeframe)));
  if (c.type === 'keels_special') wrap.append(
    field('Entry bars', selectInput(p + 'ltf', [[15, '15 seconds'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']], c.ltf)),
    field('Bias bars (x entry bars)', numInput(p + 'htfMult', c.htfMult, 1, 2)), field('Bias fast EMA', numInput(p + 'fastEma', c.fastEma, 1, 2)), field('Bias slow EMA', numInput(p + 'slowEma', c.slowEma, 1, 3)),
    field('Swing size (bars each side)', numInput(p + 'swing', c.swing, 1, 1)), field('Pullback into first leg (%)', numInput(p + 'retrace', c.retrace, 5, 10)),
    field('Target (x risk)', numInput(p + 'rr', c.rr, 0.25, 0.5)), field('Stop buffer (ticks)', numInput(p + 'buffer', c.buffer, 1, 0)), field('Wait per step (bars)', numInput(p + 'timeout', c.timeout, 1, 3)));
  const tp = numInput(p + 'takeProfit', c.takeProfit, 0.25), sl = numInput(p + 'stopLoss', c.stopLoss, 0.25);
  const tpBox = field('Take profit (points, 0 = off)', tp), slBox = field('Stop loss (points, 0 = off)', sl);
  tpBox.append(el('p', 'hint2', c.type === 'keels_special' ? 'Leave at 0 to use the strategy\u2019s own target.' : perPoint(c.symbol).trim())); slBox.append(el('p', 'hint2', c.type === 'keels_special' ? 'Leave at 0 to use the stop under the pullback.' : 'Closes the trade if price moves this far against you.'));
  wrap.append(tpBox, slBox);
  if (c.type === 'pine') { const ta = el('textarea'); ta.id = p + 'script'; ta.rows = 10; ta.spellcheck = false; ta.value = c.script; wrap.append(field('Pine Script', ta, 'full')); }
  return wrap;
}
function readForm(x) {
  const c = x.cfg, p = 's' + x.id + '_', v = k => $(p + k), n = k => Number(v(k).value);
  const out = { type: c.type, name: v('name').value, symbol: v('symbol').value.trim().toUpperCase(), qty: n('qty'), takeProfit: n('takeProfit'), stopLoss: n('stopLoss') };
  if (c.type === 'ma_cross') Object.assign(out, { ma: v('ma').value, fast: n('fast'), slow: n('slow') });
  if (c.type === 'rsi') Object.assign(out, { period: n('period'), low: n('low'), high: n('high') });
  if (c.type === 'breakout') Object.assign(out, { lookback: n('lookback') });
  if (c.type === 'pine') Object.assign(out, { timeframe: n('timeframe'), script: v('script').value });
  if (c.type === 'keels_special') Object.assign(out, { ltf: n('ltf'), htfMult: n('htfMult'), fastEma: n('fastEma'), slowEma: n('slowEma'), swing: n('swing'), retrace: n('retrace'), rr: n('rr'), buffer: n('buffer'), timeout: n('timeout') });
  return out;
}
function tvMessage(x) { return JSON.stringify({ secret: last ? last.webhookSecret : '', strategy: x.id, side: '{{strategy.order.action}}' }); }

function renderStrats() {
  const box = $('myStrats'); box.replaceChildren();
  if (!strats.length) { box.append(el('p', 'empty', 'No strategies yet. Add one below.')); return; }
  for (const x of strats) {
    const card = el('div', 'scard' + (x.enabled ? '' : ' off')); card.dataset.id = x.id;
    const row = el('div', 'srow');
    const sw = el('label', 'switch'), cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('role', 'switch'); cb.checked = x.enabled; cb.setAttribute('aria-label', `Run ${x.cfg.name}`);
    sw.append(cb, Object.assign(el('span'), { ariaHidden: 'true' }));
    cb.onchange = async () => { const r = await window.keel.updateStrategy(x.id, { enabled: cb.checked }); if (r.ok) { strats = r.list; renderStrats(); } else { cb.checked = !cb.checked; notice(r.error); } };
    const info = el('div'); info.append(el('p', 'sname', x.cfg.name), el('p', 'sdesc', describe(x.cfg)));
    const meta = el('div', 'smeta'); meta.append(el('span', 'chip', SOURCE[x.source]), el('span', 'sstate', ''));
    const eb = el('button', 'ghost small', openEdits.has(x.id) ? 'Done' : 'Edit'); eb.setAttribute('aria-expanded', String(openEdits.has(x.id)));
    eb.onclick = () => { openEdits.has(x.id) ? openEdits.delete(x.id) : openEdits.add(x.id); renderStrats(); };
    meta.append(eb);
    if (confirmRemove.has(x.id)) {
      const yes = el('button', 'small danger', 'Yes, remove'), no = el('button', 'ghost small', 'Cancel');
      yes.onclick = async () => { const r = await window.keel.removeStrategy(x.id); confirmRemove.delete(x.id); if (r.ok) { strats = r.list; renderStrats(); } else notice(r.error); };
      no.onclick = () => { confirmRemove.delete(x.id); renderStrats(); };
      meta.append(yes, no);
    } else { const rb = el('button', 'ghost small', 'Remove'); rb.onclick = () => { confirmRemove.add(x.id); renderStrats(); }; meta.append(rb); }
    row.append(sw, info, meta); card.append(row);
    if (savedRisk && !savedRisk.allowedSymbols.includes(x.cfg.symbol)) card.append(el('p', 'swarn', `${x.cfg.symbol} isn't in your allowed markets, so its trades will be blocked. Add it under Risk limits.`));
    if (openEdits.has(x.id)) {
      const ed = el('div', 'sedit'), status = el('p', 'saved'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      ed.append(editForm(x));
      if (x.cfg.type === 'tradingview') {
        ed.append(el('p', 'hint', 'In TradingView, create an alert on your strategy, turn on Webhook URL, paste your Keel address, and use this as the message:'));
        const pre = el('pre', '', tvMessage(x)), cp = el('button', 'ghost small', 'Copy message');
        cp.onclick = async () => flash(status, (await window.keel.copyStrategyAlert(x.id)) ? 'Message copied.' : "Couldn't copy.");
        ed.append(pre, cp);
      }
      ed.append(status);
      ed.addEventListener('input', () => {
        clearTimeout(saveTimers[x.id]); status.textContent = 'Saving\u2026'; status.classList.remove('bad');
        saveTimers[x.id] = setTimeout(async () => {
          const r = await window.keel.updateStrategy(x.id, { cfg: readForm(x) });
          if (r.ok) { strats = r.list; const nx = strats.find(s => s.id === x.id); x.cfg = nx.cfg; info.firstChild.textContent = nx.cfg.name; info.lastChild.textContent = describe(nx.cfg); flash(status, 'Saved.'); }
          else flash(status, r.error, true);
        }, 800);
      });
      card.append(ed);
    }
    box.append(card);
  }
  if (last) updateStratStates(last);
}
function updateStratStates(s) {
  const active = new Set(s.running && s.stats ? s.stats.active || [] : []);
  document.querySelectorAll('#myStrats .scard').forEach(card => {
    const x = strats.find(v => v.id === card.dataset.id), st = card.querySelector('.sstate'); if (!x || !st) return;
    const on = x.enabled && s.running && active.has(x.id);
    st.textContent = !x.enabled ? 'Off' : on ? 'Running' : s.running ? 'On' : 'On \u00b7 starts with the bot';
    st.className = 'sstate' + (on ? ' on' : '');
  });
}

document.querySelectorAll('.tabs2 button').forEach(t => {
  t.onclick = () => document.querySelectorAll('.tabs2 button').forEach(b => { const on = b === t; b.setAttribute('aria-selected', String(on)); $(b.dataset.pane).hidden = !on; });
});

const EXAMPLE = `//@version=5
strategy("EMA cross with brackets", overlay=true)
fastLen = input.int(9, "Fast")
slowLen = input.int(21, "Slow")
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
strategy.exit("Exit", "Long", profit=80, loss=40)
`;
$('pineExample').onclick = () => { $('pineText').value = EXAMPLE; $('pineCheck').click(); };
$('pineText').oninput = () => { $('pineForm').hidden = true; $('pineResult').replaceChildren(); };
$('pineCheck').onclick = async () => {
  const box = $('pineResult'); box.replaceChildren();
  const r = await window.keel.checkPine($('pineText').value);
  if (!r.ok) { box.append(el('p', 'bad', r.error)); $('pineForm').hidden = true; return; }
  box.append(el('p', 'ok', `\u201c${r.title}\u201d is ready to run.`));
  const ul = el('ul'); for (const w of r.warnings) ul.append(el('li', '', w)); box.append(ul);
  $('pName').value = r.title; $('pineForm').hidden = false;
};
$('pineAdd').onclick = async () => {
  const cfg = { type: 'pine', name: $('pName').value, symbol: $('pSym').value.trim().toUpperCase(), qty: Number($('pQty').value), timeframe: Number($('pTf').value),
    takeProfit: Number($('pTp').value), stopLoss: Number($('pSl').value), script: $('pineText').value };
  const r = await window.keel.addStrategy(cfg, 'pine');
  if (r.ok) { strats = r.list; renderStrats(); flash($('pineMsg'), 'Added to your strategies. Switch it on when you\u2019re ready.'); } else flash($('pineMsg'), r.error, true);
};
$('tvAdd').onclick = async () => {
  const cfg = { type: 'tradingview', name: $('tName').value || 'TradingView strategy', symbol: $('tSym').value.trim().toUpperCase(), qty: Number($('tQty').value), takeProfit: Number($('tTp').value), stopLoss: Number($('tSl').value) };
  const r = await window.keel.addStrategy(cfg, 'tradingview');
  if (r.ok) { strats = r.list; openEdits.add(strats[strats.length - 1].id); renderStrats(); flash($('tvMsg'), 'Added. Its alert message is open in Your strategies above.'); } else flash($('tvMsg'), r.error, true);
};

// ---------- live chart (TradingView Lightweight Charts) ----------
let chartTf = 'min5', chartSym = '', lw = null, lwLC = null, lwMk = null, lwWm = null, lwSeries = null, lwLines = [], lwKey = '', lwLast = 0, lwBusy = false, lwN = 0;
// Lightweight Charts shows times as UTC: shift each bar to New York wall-clock so the axis reads New York time.
const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const nySec = ms => { const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000; };
const toBar = b => ({ time: nySec(b.t), open: b.o, high: b.h, low: b.l, close: b.c, v: Number.isFinite(b.v) ? b.v : 0 });
const candle = ({ time, open, high, low, close }) => ({ time, open, high, low, close });
function chartSymbols(extra) {
  const list = [...new Set([...(savedRisk ? savedRisk.allowedSymbols : []), ...(extra || [])])];
  const sel = $('cSym'), keep = chartSym || list[0] || '';
  if ([...sel.options].map(o => o.value).join() !== list.join()) sel.replaceChildren(...list.map(x => new Option(x, x)));
  sel.value = keep; chartSym = sel.value;
}
// The chart draws inside its own iframe, so none of Keel's page styles or layout can reach it.
let lwFrame = null, lwReady = false;
function lwEnsure() {
  if (lw) return;
  const box = $('cBox');
  if (!box.clientWidth || !box.clientHeight) return;            // page not visible yet: try again on the next refresh
  if (!lwFrame) {
    lwFrame = document.createElement('iframe'); lwFrame.title = 'Price chart';
    lwFrame.style.cssText = 'border:0;width:100%;height:100%;display:block;background:transparent';
    lwFrame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}#c{position:absolute;left:0;top:0;right:0;bottom:0}</style>'
      + '<script src="vendor/lightweight-charts.js"><\/script></head><body><div id="c"></div></body></html>';
    lwFrame.onload = () => { lwReady = true; lwKey = ''; lwLast = 0; void drawLive(); };
    box.replaceChildren(lwFrame); return;
  }
  const W = lwReady ? lwFrame.contentWindow : null, LC = W && W.LightweightCharts;
  if (!LC) return;
  const hair = { color: 'rgba(151,164,170,0.45)', width: 1, style: LC.LineStyle.Dashed, labelBackgroundColor: '#1c272d' };
  lw = LC.createChart(W.document.getElementById('c'), {
    autoSize: true, localization: { priceFormatter: v => v.toLocaleString('en-US', { minimumFractionDigits: /GC/.test(chartSym) ? 1 : 2, maximumFractionDigits: /GC/.test(chartSym) ? 1 : 2 }) },
    layout: { background: { type: 'solid', color: '#0b1114' }, textColor: '#7f8c92', fontSize: 11, fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.035)' } },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.07)', minimumWidth: 78 }, timeScale: { borderColor: 'rgba(255,255,255,0.07)', timeVisible: true, secondsVisible: false, rightOffset: 8, minBarSpacing: 1.5 },
    crosshair: { mode: LC.CrosshairMode.Normal, vertLine: hair, horzLine: hair }, handleScroll: true, handleScale: true
  });
  lw.applyOptions({ layout: { panes: { separatorColor: '#1d2c31', separatorHoverColor: 'rgba(240,164,58,0.25)', enableResize: true } } });
  lwLC = LC;
  lwSeries = lw.addSeries(LC.CandlestickSeries, { upColor: '#26a69a', downColor: '#ef5350', borderUpColor: '#26a69a', borderDownColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
  lwMk = LC.createSeriesMarkers(lwSeries, []);
  lwWm = LC.createTextWatermark(lw.panes()[0], { horzAlign: 'center', vertAlign: 'center', lines: [{ text: '', color: 'rgba(147,167,166,0.06)', fontSize: 56 }] });
  lw.subscribeCrosshairMove(p => { const i = p && p.time !== undefined ? lwIdx.get(p.time) : undefined; const n = i === undefined ? null : i; if (n !== ohlcAt) { ohlcAt = n; ohlcRender(); } });
  indBuild();
  lwDragSetup(W);
  lw.subscribeClick(p => { if (!p.point || (p.paneIndex || 0) !== 0 || Date.now() - lwNoClick < 500) return; const px = lwSeries.coordinateToPrice(p.point.y); if (px === null) return; const t = /GC/.test(chartSym) ? 0.1 : 0.25; const v = (Math.round(px / t) * t).toFixed(/GC/.test(chartSym) ? 1 : 2), sl = $('tkType').value === 'stoplimit'; $(sl ? 'tkTrig' : 'tkPx').value = v; $('tkMsg').textContent = sl ? 'Trigger price set from the chart.' : 'Limit price set from the chart. Clear it for a market order.'; });
}
// ---------- trades on the chart: drag a stop / target (or a working limit's entry) to move it at the broker ----------
let lwMeta = [], lwDrag = null, lwNoClick = 0;
const chartTick = () => (/GC/.test(chartSym) ? 0.1 : 0.25), chartFmt = n => n.toFixed(/GC/.test(chartSym) ? 1 : 2);
function lwHit(y) {
  let best = null, bd = 7;
  if (y > lw.panes()[0].getHeight()) return null;
  for (const m of lwMeta) { if (!m.drag) continue; const c = lwSeries.priceToCoordinate(m.price); if (c === null) continue; const d = Math.abs(c - y); if (d < bd) { bd = d; best = m; } }
  return best;
}
function lwDragSetup(W) {
  const doc = W.document, box = doc.getElementById('c'), cur = doc.createElement('style'); doc.head.append(cur);
  const yOf = ev => ev.clientY - box.getBoundingClientRect().top, xOk = ev => ev.clientX - box.getBoundingClientRect().left < box.clientWidth - lw.priceScale('right').width();
  const setCur = c => { cur.textContent = c ? `*{cursor:${c} !important}` : ''; };
  const down = ev => {
    if (ev.button !== 0 || !lwSeries || !xOk(ev)) return;
    const m = lwHit(yOf(ev)); if (!m) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (ev.type === 'mousedown') { lwDrag = { m, from: m.price }; lw.applyOptions({ handleScroll: false, handleScale: false }); setCur('ns-resize'); }
  };
  doc.addEventListener('pointerdown', down, true); doc.addEventListener('mousedown', down, true);
  doc.addEventListener('mousemove', ev => {
    if (!lwSeries) return;
    if (lwDrag) {
      ev.stopImmediatePropagation();
      const px = lwSeries.coordinateToPrice(yOf(ev)); if (px === null) return;
      const t = chartTick(), m = lwDrag.m; m.price = Math.round(px / t) * t;
      m.line.applyOptions({ price: m.price, title: `${m.title} → ${chartFmt(m.price)}` }); return;
    }
    setCur(xOk(ev) && lwHit(yOf(ev)) ? 'ns-resize' : '');
  }, true);
  const up = ev => {
    if (!lwDrag) return;
    ev.stopImmediatePropagation();
    const d = lwDrag; lwDrag = null; lwNoClick = Date.now(); setCur(''); lw.applyOptions({ handleScroll: true, handleScale: true });
    if (Math.abs(d.m.price - d.from) < chartTick() / 2) return;
    setTimeout(() => void lwMoved(d), 0);   // confirm() outside the event so the chart sees the button released
  };
  doc.addEventListener('mouseup', up, true);
  W.addEventListener('blur', () => { if (lwDrag) { lwDrag.m.price = lwDrag.from; const d = lwDrag; lwDrag = null; setCur(''); lw.applyOptions({ handleScroll: true, handleScale: true }); d.m.line.applyOptions({ price: d.from, title: d.m.title }); } });
}
async function lwMoved(d) {
  const m = d.m, what = m.which === 'entry' ? 'limit entry' : m.which, on = m.accounts.length ? m.accounts.join(', ') : 'this account';
  if (!confirm(`Move the ${m.name} ${what} from ${chartFmt(d.from)} to ${chartFmt(m.price)}?\n\nOn: ${on}`)) { lwLast = 0; void drawLive(); return; }
  $('tkMsg').textContent = 'Moving…';
  const r = await window.keel.chartMove(m.ref, m.which, m.price);
  if (!r || !r.ok) $('tkMsg').textContent = r ? r.error : 'Something went wrong.';
  else $('tkMsg').textContent = `${m.name} ${what}: ` + r.results.map(x => `${x.account} ${x.ok ? 'moved' : 'not moved (' + x.why + ')'}`).join(' · ');
  lwLast = 0; void drawLive();
}
/** Entry arrows and exit dots for trades on this market (open ones and the journal's closed ones). */
function lwMarkers(closed, lines) {
  const data = lwSeries.data(); if (!data.length) { lwMk.setMarkers([]); return; }
  const snap = ms => { const s = nySec(ms); if (s < data[0].time) return null; let lo = 0, hi = data.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (data[mid].time <= s) lo = mid; else hi = mid - 1; } return data[lo].time; };
  const mk = [];
  const entry = (t, dir, text) => { const time = snap(t); if (time !== null) mk.push({ time, position: dir === 'long' ? 'belowBar' : 'aboveBar', color: dir === 'long' ? '#6fd3b8' : '#ff7b70', shape: dir === 'long' ? 'arrowUp' : 'arrowDown', text }); };
  for (const t of closed) {
    entry(t.openedAt, t.dir, `${t.id === 'MANUAL' ? '' : t.id + ' '}${t.dir === 'long' ? 'B' : 'S'}${t.qty}`);
    const time = snap(t.closedAt);
    if (time !== null) mk.push({ time, position: t.dir === 'long' ? 'aboveBar' : 'belowBar', color: t.pnl === null ? '#93a7a6' : t.pnl >= 0 ? '#6fd3b8' : '#ff7b70', shape: 'circle',
      text: t.pnl === null ? 'exit' : `${t.pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(t.pnl))}` });
  }
  for (const l of lines) if (l.opened) entry(l.opened, l.side === 'buy' ? 'long' : 'short', `${l.name === 'Chart' ? '' : l.name + ' '}${l.side === 'buy' ? 'B' : 'S'}${l.qty}`);
  mk.sort((a, b) => a.time - b.time); lwMk.setMarkers(mk);
}
function lwPriceLines(lines) {
  if (lwDrag) return;                                  // never redraw under the mouse
  for (const p of lwLines) lwSeries.removePriceLine(p); lwLines = []; lwMeta = [];
  const add = (t, which, price, color, title, style) => {
    if (typeof price !== 'number') return;
    const drag = !!t.drag && (which !== 'entry' || !!t.working);
    const line = lwSeries.createPriceLine({ price, color, lineWidth: drag ? 2 : 1, lineStyle: style, axisLabelVisible: true, title }); lwLines.push(line);
    lwMeta.push({ line, ref: t.ref, which, price, title, name: t.name, accounts: t.accounts || [], drag });
  };
  for (const t of lines) { const nm = t.name === 'Chart' ? '' : t.name + ' '; add(t, 'entry', t.entry, '#e8a33d', `${nm}${t.working ? 'Limit' : 'Entry'}`, t.working ? 1 : 0); add(t, 'target', t.tp, '#26a69a', `${nm}Target`, 2); add(t, 'stop', t.sl, '#ef5350', `${nm}Stop`, 2); }
  const leg = $('cLegend'); leg.replaceChildren();
  for (const t of lines) {
    const row = el('div', 'row2'); row.append(el('strong', '', `${t.side === 'buy' ? 'Long' : 'Short'} ${t.qty} · ${t.name}${t.working ? ' (limit working)' : ''}${t.accounts && t.accounts.length ? ' · ' + t.accounts.join(', ') : ''}`));
    if (t.ref && t.ref.startsWith('K|')) row.title = 'K1-K7 stops are trailed by the strategy, so their lines cannot be dragged.';
    const part = (cls, label, v) => { const sp = el('span'); sp.append(el('span', 'dot ' + cls), document.createTextNode(`${label} ${typeof v === 'number' ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'none'}`)); return sp; };
    row.append(part('e', 'Entry', t.entry), part('t', 'Target', t.tp), part('s', 'Stop', t.sl)); leg.append(row);
  }
  if (!lines.length) leg.append(el('p', 'empty', 'No open trades on this market. Entry, target and stop lines show on the chart when the bot opens one.'));
}
$('cSym').onchange = () => { chartSym = $('cSym').value; drawLive(); };
const tfPress = () => document.querySelectorAll('#cTf button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.tf === chartTf)));
document.querySelectorAll('#cTf button').forEach(b => { b.onclick = () => { chartTf = b.dataset.tf; store_.set('keel.chart.tf', chartTf); tfPress(); drawLive(); }; });
// ---------- trading from the chart ----------
let tkSel = null, tkCan = false;
async function tkRender() {
  const r = await window.keel.chartAccounts(); if (!r) return;
  const box = $('tkAccts'), keep = tkSel; box.replaceChildren();
  $('tkHint').textContent = !r.running ? 'Start the bot to trade from the chart. Orders go to every account you tick below, through the same connections, risk limits and flat-by time as the bot.'
    : `Orders go to every ticked account (${r.mode === 'paper' ? 'PAPER mode: pretend orders' : 'LIVE mode: real orders'}). Stops and targets go to the broker as soon as each entry fills. A market a Keel strategy already holds is skipped on that account.`;
  for (const a of r.accounts) {
    const l = el('label', 'check'), cb = el('input'); cb.type = 'checkbox'; cb.value = a.id; cb.checked = keep ? keep.has(a.id) : true;
    cb.onchange = () => { tkSel = new Set([...document.querySelectorAll('#tkAccts input:checked')].map(x => x.value)); };
    l.append(cb, document.createTextNode(' ' + a.label)); box.append(l);
  }
  tkCan = r.running && r.accounts.length > 0;
  ['tkBuy', 'tkSell', 'tkFlat', 'tkPair'].forEach(id => { $(id).disabled = !tkCan || (id !== 'tkFlat' && lwStale); });
}
const tkAccounts = () => [...document.querySelectorAll('#tkAccts input:checked')].map(x => x.value);
const tkReport = res => { if (!res || !res.ok) { $('tkMsg').textContent = res ? res.error : 'Something went wrong.'; return; }
  $('tkMsg').textContent = res.results.map(x => `${x.account}: ${x.ok ? 'sent' : 'not sent (' + x.why + ')'}`).join(' · '); };
// Order type: Market / Limit (the price box), Stop-limit (a trigger and a worst price), Breakout pair (OCO at the broker).
function tkMode() {
  const m = $('tkType').value;
  $('tkRowStd').hidden = m !== 'std'; $('tkRowSl').hidden = m !== 'stoplimit'; $('tkRowBo').hidden = m !== 'breakout'; $('tkRowSlip').hidden = m === 'std';
  $('tkSides').hidden = m === 'breakout'; $('tkPair').hidden = m !== 'breakout';
  $('tkMsg').textContent = m === 'stoplimit' ? 'Buys when price trades up to the trigger (sells when it trades down to it), but never fills more than the max slippage past it. If price jumps past that, nothing fills.'
    : m === 'breakout' ? 'A buy stop-limit above and a sell stop-limit below the current price, held by the broker as one-cancels-other: the first fill cancels the other side instantly. Needs a Rithmic or paper account.' : '';
}
$('tkType').onchange = tkMode;
$('tkPair').onclick = () => tkSend('long', true);
async function tkSend(dir, pair = false) {
  if (lwStale) { $('tkMsg').textContent = 'The chart is not live right now (no price for 20 seconds), so chart trading is paused.'; return; }
  const px = $('tkPx').value.trim(), qty = Number($('tkQty').value), ids = tkAccounts(), mode = pair ? 'breakout' : $('tkType').value;
  if (!ids.length) { $('tkMsg').textContent = 'Tick at least one account.'; return; }
  if (mode !== 'std') {
    const slip = Number($('tkSlip').value) || 0, cancelMin = Number($('tkCancel').value) || 0, stopPts = Number($('tkStop').value) || 0, tgtPts = Number($('tkTgt').value) || 0;
    const prot = (stopPts ? `, stop ${stopPts} pts` : ', NO stop') + (tgtPts ? `, target ${tgtPts} pts` : '') + (cancelMin ? `, cancel after ${cancelMin} min` : '');
    let payload, what;
    if (mode === 'stoplimit') {
      const trig = Number($('tkTrig').value); if (!(trig > 0)) { $('tkMsg').textContent = 'Set a trigger price (type it or click the chart).'; return; }
      payload = { type: 'stoplimit', trigger: trig }; what = `${dir === 'long' ? 'BUY' : 'SELL'} STOP-LIMIT ${qty} ${chartSym}: trigger ${trig}, worst fill ${dir === 'long' ? trig + slip : trig - slip}${prot}`;
    } else {
      const off = Number($('tkOff').value); if (!(off > 0)) { $('tkMsg').textContent = 'Set the distance in points.'; return; }
      payload = { type: 'breakout', offsetPts: off }; what = `BREAKOUT PAIR ${qty} ${chartSym}: buy ${off} pts above and sell ${off} pts below the current price, max slippage ${slip} pts${prot}`;
    }
    if (!confirm(`${what}\n\non ${ids.length} account${ids.length === 1 ? '' : 's'}?`)) return;
    $('tkMsg').textContent = 'Sending…';
    tkReport(await window.keel.chartOrder({ orderSym: chartSym, dir, qty, ...payload, slipPts: slip, cancelMin, stopPts, tgtPts, accounts: ids }));
    $('tkTrig').value = ''; lwLast = 0; return;
  }
  const what = `${dir === 'long' ? 'BUY' : 'SELL'} ${qty} ${chartSym} ${px ? 'limit @ ' + px : 'at market'}${Number($('tkStop').value) ? ', stop ' + $('tkStop').value + ' pts' : ', NO stop'}${Number($('tkTgt').value) ? ', target ' + $('tkTgt').value + ' pts' : ''}`;
  if (!confirm(`${what}\n\non ${ids.length} account${ids.length === 1 ? '' : 's'}?`)) return;
  $('tkMsg').textContent = 'Sending…';
  tkReport(await window.keel.chartOrder({ orderSym: chartSym, dir, qty, type: px ? 'limit' : 'market', price: px ? Number(px) : undefined, stopPts: Number($('tkStop').value) || 0, tgtPts: Number($('tkTgt').value) || 0, accounts: ids }));
  $('tkPx').value = ''; lwLast = 0;
}
$('tkBuy').onclick = () => tkSend('long');
$('tkSell').onclick = () => tkSend('short');
$('tkFlat').onclick = async () => {
  const ids = tkAccounts(); if (!ids.length) { $('tkMsg').textContent = 'Tick at least one account.'; return; }
  if (!confirm(`Flatten ${chartSym} on ${ids.length} account${ids.length === 1 ? '' : 's'}? Working orders are cancelled and positions closed at market.`)) return;
  tkReport(await window.keel.chartFlatten(chartSym, ids)); lwLast = 0;
};

$('cFit').onclick = () => { if (lw && lwN) lw.timeScale().setVisibleLogicalRange({ from: Math.max(0, lwN - 150), to: lwN + 8 }); };

// Live prices: the forming candle follows each tick; a chart without a tick for 20 s is STALE and can't be traded from.
let lwTick = null, lwStale = true;
const TF_MS = { min1: 60e3, min5: 3e5, min15: 9e5, hour: 36e5, hour4: 144e5, day: 864e5 };
function lwLiveUpdate(tick, now) {
  const age = tick ? Math.max(0, (now - tick.ts) / 1000) : null; lwStale = age === null || age > 20;
  const pill = $('cLive'); pill.className = 'livepill ' + (lwStale ? 'off' : 'on');
  pill.textContent = age === null ? '● NO LIVE PRICES' : lwStale ? `● STALE · last tick ${age < 120 ? Math.round(age) + 's' : Math.round(age / 60) + 'm'} ago` : `● LIVE · ${age < 1 ? 'now' : Math.round(age) + 's ago'}`;
  pill.title = lwStale ? 'No new price for 20 seconds (market closed, or the price feed stopped). Trading from the chart is paused.' : 'Prices are streaming.';
  for (const id of ['tkBuy', 'tkSell', 'tkPair']) { const b = $(id); b.disabled = lwStale || !tkCan; b.title = lwStale ? 'The chart is not live, so trading from it is paused.' : ''; }
  if (!tick || lwStale || !lwSeries) return;
  const data = lwSeries.data(); if (!data.length) return;
  const lastBar = data[data.length - 1], period = (TF_MS[chartTf] || 3e5) / 1000, tSec = nySec(tick.ts);
  let nb = null;
  if (chartTf !== 'day' && tSec >= lastBar.time + period) nb = { time: lastBar.time + Math.floor((tSec - lastBar.time) / period) * period, open: tick.price, high: tick.price, low: tick.price, close: tick.price };
  else if (tSec >= lastBar.time || chartTf === 'day') nb = { ...lastBar, high: Math.max(lastBar.high, tick.price), low: Math.min(lastBar.low, tick.price), close: tick.price };
  if (nb) { lwSeries.update(candle(nb)); barsPut(nb); indApply(); }
  lastShow(tick.price);
}
async function drawLive() {
  if (!cat || lwBusy) return;
  chartSymbols(); if (!chartSym) return;
  lwEnsure(); if (!lw) return;
  const key = chartSym + '|' + chartTf, full = key !== lwKey;
  if (!full && Date.now() - lwLast < 5000) { const t = await window.keel.chartTick(chartSym); if (t) lwLiveUpdate(t.tick, t.now); return; }   // ticks every refresh, bars every 5 s
  lwBusy = true;
  try {
    const r = await window.keel.chartHist(chartSym, chartTf, full ? (chartTf === 'day' ? 600 : 2000) : 3);
    if (!r || !r.ok) { if (full) { lwSeries.setData([]); barsSet([]); indApply(); lwKey = ''; } lastShow(null); $('cLegend').replaceChildren(el('p', 'empty', r ? r.error : 'Start the bot or pick an account.')); return; }
    const data = r.bars.filter(b => [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.h >= b.l).map(toBar).sort((x, y) => x.time - y.time)
      .filter((x, i, a) => i === a.length - 1 || x.time !== a[i + 1].time);   // one bar per time (the newest wins)
    if (full) {
      lwSeries.setData(data.map(candle)); barsSet(data); lwKey = key; lwN = data.length; ohlcAt = null;
      lwSeries.applyOptions({ priceFormat: { type: 'price', precision: /GC/.test(chartSym) ? 1 : 2, minMove: /GC/.test(chartSym) ? 0.1 : 0.25 } });
      lwWm.applyOptions({ lines: [{ text: `${chartSym} · ${TF_NAME[chartTf] || ''}`, color: 'rgba(147,167,166,0.06)', fontSize: 56 }] }); indBuild();
      const show = () => lw.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - 150), to: data.length + 8 });
      show(); requestAnimationFrame(show); setTimeout(show, 120);   // again once the chart knows its width
    } else {
      const lastT = lwSeries.data().length ? lwSeries.data()[lwSeries.data().length - 1].time : 0;
      for (const bar of data) if (bar.time >= lastT) { lwSeries.update(candle(bar)); barsPut(bar); if (bar.time > lastT) lwN++; }
      indApply();
    }
    lwLast = Date.now();
    const lastBar = data[data.length - 1];
    lastShow(lastBar ? lastBar.close : null);
    lwPriceLines(r.lines || []); lwMarkers(r.closed || [], r.lines || []); lwLiveUpdate(r.tick, Date.now());
  } catch (err) { $('cLegend').replaceChildren(el('p', 'empty', String(err.message || err))); }
  finally { lwBusy = false; }
}

// ---------- indicators (drawn on the chart, saved on this PC) ----------
const IND_TYPES = {
  sma: { name: 'SMA', params: [['Length', 20]] },
  ema: { name: 'EMA', params: [['Length', 21]] },
  vwap: { name: 'VWAP', params: [] },
  bb: { name: 'Bollinger Bands', short: 'BB', params: [['Length', 20], ['StdDev', 2]] },
  vol: { name: 'Volume', short: 'Vol', params: [] },
  rsi: { name: 'RSI', params: [['Length', 14]], osc: true },
  macd: { name: 'MACD', params: [['Fast', 12], ['Slow', 26], ['Signal', 9]], osc: true },
  atr: { name: 'ATR', params: [['Length', 14]], osc: true }
};
const IND_COLORS = ['#4fc3f7', '#f0a43a', '#c792ea', '#ffd54f', '#81c784', '#f06292', '#90a4ae'];
const IND_DEFAULT = [{ t: 'vol' }, { t: 'ema', p: [9], c: '#4fc3f7' }, { t: 'ema', p: [21], c: '#f0a43a' }, { t: 'vwap', c: '#c792ea' }];
const store_ = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not saved */ } } };
let indSeq = 0;
const indNorm = x => { const T = IND_TYPES[x && x.t]; if (!T) return null;
  const p = T.params.map(([, d], i) => { const v = Number(x.p && x.p[i]); return Number.isFinite(v) && v > 0 ? Math.min(500, v) : d; });
  return { id: ++indSeq, t: x.t, p, c: /^#[0-9a-f]{6}$/i.test(x.c || '') ? x.c : IND_COLORS[indSeq % IND_COLORS.length] }; };
let inds = (Array.isArray(store_.get('keel.chart.inds', null)) ? store_.get('keel.chart.inds', null) : IND_DEFAULT).map(indNorm).filter(Boolean).slice(0, 12);
const indSave = () => store_.set('keel.chart.inds', inds.map(({ t, p, c }) => ({ t, p, c })));
const indLabel = d => { const T = IND_TYPES[d.t]; return (T.short || T.name) + (d.p.length ? ' ' + d.p.join(' ') : ''); };
let lwBars = [], lwIdx = new Map(), indSer = [], indOut = [], ohlcAt = null;

// --- maths: every function returns one value per bar (null while warming up) ---
function smaA(v, n) { const o = new Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
function emaA(v, n) { const o = new Array(v.length).fill(null), k = 2 / (n + 1); let e = null, s = 0, c = 0;
  for (let i = 0; i < v.length; i++) { if (v[i] === null) continue; if (e === null) { s += v[i]; c++; if (c === n) { e = s / n; o[i] = e; } } else { e = v[i] * k + e * (1 - k); o[i] = e; } } return o; }
function wilder(v, n) { const o = new Array(v.length).fill(null); let a = null, s = 0;
  for (let i = 0; i < v.length; i++) { if (a === null) { s += v[i]; if (i === n - 1) { a = s / n; o[i] = a; } } else { a = (a * (n - 1) + v[i]) / n; o[i] = a; } } return o; }
function rsiA(c, n) { const g = [0], l = [0]; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  const ag = wilder(g.slice(1), n), al = wilder(l.slice(1), n); return [null, ...ag.map((x, i) => (x === null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i])))]; }
function atrA(b, n) { return wilder(b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low)), n); }
function vwapA(b) { const o = []; let key = null, pv = 0, vv = 0;
  for (const x of b) { const k = Math.floor((x.time - 18 * 3600) / 86400); if (k !== key) { key = k; pv = 0; vv = 0; }   // new session at 6 PM New York
    const tp = (x.high + x.low + x.close) / 3, v = x.v || 0; pv += tp * v; vv += v; o.push(vv > 0 ? pv / vv : tp); } return o; }
function indCalc(d, b) {
  const c = b.map(x => x.close), C = d.c, P = d.p;
  switch (d.t) {
    case 'sma': return [{ k: 'line', color: C, vals: smaA(c, P[0]) }];
    case 'ema': return [{ k: 'line', color: C, vals: emaA(c, P[0]) }];
    case 'vwap': return [{ k: 'line', color: C, vals: chartTf === 'day' ? c.map(() => null) : vwapA(b) }];
    case 'bb': { const m = smaA(c, P[0]), sd = m.map((x, i) => { if (x === null) return null; let s = 0; for (let j = i - P[0] + 1; j <= i; j++) s += (c[j] - x) ** 2; return Math.sqrt(s / P[0]); });
      return [{ k: 'line', color: C, vals: m, name: 'basis' }, { k: 'line', color: C + '99', vals: m.map((x, i) => (x === null ? null : x + P[1] * sd[i])), name: 'upper' }, { k: 'line', color: C + '99', vals: m.map((x, i) => (x === null ? null : x - P[1] * sd[i])), name: 'lower' }]; }
    case 'vol': return [{ k: 'vol', vals: b.map(x => x.v || 0), colors: b.map(x => (x.close >= x.open ? 'rgba(38,166,154,0.28)' : 'rgba(239,83,80,0.28)')) }];
    case 'rsi': return [{ k: 'line', color: C, vals: rsiA(c, P[0]) }];
    case 'atr': return [{ k: 'line', color: C, vals: atrA(b, P[0]) }];
    case 'macd': { const f = emaA(c, P[0]), s = emaA(c, P[1]), m = f.map((x, i) => (x === null || s[i] === null ? null : x - s[i])), sg = emaA(m, P[2]);
      return [{ k: 'hist', vals: m.map((x, i) => (x === null || sg[i] === null ? null : x - sg[i])), name: 'hist' }, { k: 'line', color: C, vals: m, name: 'macd' }, { k: 'line', color: '#f0a43a', vals: sg, name: 'signal' }]; }
  }
  return [];
}

// --- layout: volume sits under the candles; each oscillator (RSI, MACD, ATR) gets its own pane with its own scale ---
function indLayout() {
  if (!lw) return;
  const hasVol = inds.some(d => d.t === 'vol');
  lw.priceScale('right', 0).applyOptions({ scaleMargins: { top: 0.07, bottom: hasVol ? 0.15 : 0.05 } });
  if (hasVol) lw.priceScale('vol', 0).applyOptions({ scaleMargins: { top: 0.87, bottom: 0 } });
  const panes = lw.panes(); panes.forEach((p, i) => p.setStretchFactor(i === 0 ? 1 : 0.26));
  for (let i = 1; i < panes.length; i++) lw.priceScale('right', i).applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
}
/** Recreates the indicator series (after one is added, removed or changed). */
function indBuild() {
  if (!lw) return;
  for (const s of indSer) for (const x of s.list) lw.removeSeries(x);
  indSer = []; while (lw.panes().length > 1) lw.removePane(lw.panes().length - 1);
  let pane = 0;
  const prec = /GC/.test(chartSym) ? 1 : 2, base = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  for (const d of inds) {
    const T = IND_TYPES[d.t], scale = d.t === 'vol' ? 'vol' : 'right', list = [], at = T.osc ? ++pane : 0;
    const fmt = d.t === 'vol' ? { type: 'volume' } : T.osc ? { type: 'price', precision: 2, minMove: 0.01 } : { type: 'price', precision: prec, minMove: prec === 1 ? 0.1 : 0.25 };
    for (const part of indCalc(d, lwBars.length ? lwBars.slice(-3) : [])) {
      const opt = { ...base, priceScaleId: scale, priceFormat: fmt };
      list.push(part.k === 'line' ? lw.addSeries(lwLC.LineSeries, { ...opt, color: part.color, lineWidth: part.name === 'upper' || part.name === 'lower' ? 1 : 2 }, at)
        : lw.addSeries(lwLC.HistogramSeries, { ...opt, color: part.k === 'vol' ? 'rgba(147,167,166,0.35)' : '#5b7178' }, at));
    }
    if (d.t === 'rsi') for (const lv of [70, 30]) list[0].createPriceLine({ price: lv, color: 'rgba(147,167,166,0.45)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    if (d.t === 'macd') list[1].createPriceLine({ price: 0, color: 'rgba(147,167,166,0.3)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    indSer.push({ d, list, pane: at });
  }
  indLayout(); indApply();
}
/** Recomputes every indicator from the bars on the chart. */
function indApply() {
  if (!lw) return;
  indOut = [];
  for (const s of indSer) {
    const parts = indCalc(s.d, lwBars); indOut.push({ d: s.d, parts });
    parts.forEach((p, j) => {
      const ser = s.list[j]; if (!ser) return;
      const pts = [];
      for (let i = 0; i < lwBars.length; i++) { const v = p.vals[i]; if (v === null || !Number.isFinite(v)) continue;
        pts.push(p.k === 'vol' ? { time: lwBars[i].time, value: v, color: p.colors[i] } : p.k === 'hist' ? { time: lwBars[i].time, value: v, color: v >= 0 ? 'rgba(63,191,159,0.6)' : 'rgba(239,95,86,0.6)' } : { time: lwBars[i].time, value: v }); }
      ser.setData(pts);
    });
  }
  ohlcRender();
}
/** Keeps a copy of the bars (with volume) in step with the candles. */
function barsSet(data) { lwBars = data.slice(); lwIdx = new Map(lwBars.map((b, i) => [b.time, i])); }
function barsPut(bar) {
  const last = lwBars[lwBars.length - 1];
  if (last && bar.time === last.time) lwBars[lwBars.length - 1] = { ...last, ...bar, v: bar.v ?? last.v };
  else if (!last || bar.time > last.time) { lwBars.push({ v: 0, ...bar }); lwIdx.set(bar.time, lwBars.length - 1); }
}

// --- the legend in the chart's corner: OHLC of the bar under the mouse (or the latest), and each indicator's value ---
const pxFmt = n => n.toLocaleString(undefined, { minimumFractionDigits: /GC/.test(chartSym) ? 1 : 2, maximumFractionDigits: /GC/.test(chartSym) ? 1 : 2 });
const volFmt = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const TF_NAME = { min1: '1m', min5: '5m', min15: '15m', hour: '1h', hour4: '4h', day: 'D' };
function ohlcRender() {
  const box = $('cOhlc'); if (!box) return;
  box.replaceChildren(); document.querySelectorAll('.tchart .osclab').forEach(x => x.remove());
  if (!lwBars.length) return;
  const i = ohlcAt !== null && ohlcAt < lwBars.length ? ohlcAt : lwBars.length - 1, b = lwBars[i], prev = i ? lwBars[i - 1].close : b.open, ch = b.close - prev;
  const r1 = el('div', 'ol1'); r1.append(el('b', '', chartSym), el('span', 'oltf', TF_NAME[chartTf] || ''));
  for (const [k, v] of [['O', b.open], ['H', b.high], ['L', b.low], ['C', b.close]]) { const s = el('span', 'olv'); s.append(el('i', '', k), document.createTextNode(pxFmt(v))); r1.append(s); }
  r1.append(el('span', ch >= 0 ? 'pos' : 'neg', `${ch >= 0 ? '+' : '−'}${pxFmt(Math.abs(ch))} (${ch >= 0 ? '+' : '−'}${Math.abs(prev ? ch / prev * 100 : 0).toFixed(2)}%)`));
  if (b.v) { const s = el('span', 'olv'); s.append(el('i', '', 'Vol'), document.createTextNode(volFmt(b.v))); r1.append(s); }
  box.append(r1);
  const tch = box.parentElement, psw = lw ? lw.priceScale('right').width() : 60, panes = lw ? lw.panes() : [];
  for (const o of indOut) {
    if (o.d.t === 'vol') continue;
    const T = IND_TYPES[o.d.t], row = el('div', 'ol2'), name = el('span', 'olname', indLabel(o.d)); name.style.color = o.d.c; row.append(name);
    for (const p of o.parts) { const v = p.vals[i]; const s = el('span', 'olv', v === null || v === undefined ? '—' : T.osc ? v.toFixed(2) : pxFmt(v)); if (p.color) s.style.color = p.color.slice(0, 7); row.append(s); }
    if (!T.osc) { box.append(row); continue; }
    const pi = (indSer.find(x => x.d === o.d) || {}).pane || 0; let top = 0; for (let j = 0; j < pi && j < panes.length; j++) top += panes[j].getHeight() + 1;
    row.className = 'osclab'; row.style.top = top + 'px'; row.style.right = psw + 'px'; tch.append(row);
  }
}
function lastShow(price) {
  const box = $('cLast'); box.replaceChildren(); if (typeof price !== 'number') { box.textContent = chartSym; return; }
  // change since the previous session's close (sessions start at 6 PM New York; on the daily chart: since yesterday)
  let ref = null; const n = lwBars.length;
  if (n) { if (chartTf === 'day') ref = n > 1 ? lwBars[n - 2].close : null;
    else { const key = t => Math.floor((t - 18 * 3600) / 86400), k = key(lwBars[n - 1].time); for (let j = n - 1; j >= 0; j--) if (key(lwBars[j].time) < k) { ref = lwBars[j].close; break; } } }
  box.append(el('b', '', `${chartSym}  ${pxFmt(price)}`));
  if (ref) { const ch = price - ref; box.append(el('span', ch >= 0 ? 'pos' : 'neg', ` ${ch >= 0 ? '+' : '−'}${pxFmt(Math.abs(ch))}  ${ch >= 0 ? '+' : '−'}${Math.abs(ch / ref * 100).toFixed(2)}%`)); }
}

// --- the Indicators menu ---
function indMenu() {
  const on = $('cIndOn'); on.replaceChildren();
  if (!inds.length) on.append(el('p', 'empty', 'None yet. Add one below.'));
  for (const d of inds) {
    const T = IND_TYPES[d.t], row = el('div', 'indrow');
    const col = el('input'); col.type = 'color'; col.value = d.c; col.title = 'Colour'; col.setAttribute('aria-label', indLabel(d) + ' colour');
    col.oninput = () => { d.c = col.value; indSave(); indBuild(); };
    if (d.t === 'vol') col.disabled = true;
    row.append(col, el('span', 'indname', T.name));
    T.params.forEach(([lab], j) => { const inp = el('input'); inp.type = 'number'; inp.min = j === 1 && d.t === 'bb' ? '0.5' : '1'; inp.step = d.t === 'bb' && j === 1 ? '0.5' : '1'; inp.max = '500'; inp.value = String(d.p[j]); inp.title = lab; inp.setAttribute('aria-label', `${T.name} ${lab}`);
      inp.onchange = () => { const v = Number(inp.value); if (v > 0 && v <= 500) { d.p[j] = d.t === 'bb' && j === 1 ? v : Math.round(v); indSave(); indBuild(); } inp.value = String(d.p[j]); }; row.append(inp); });
    const x = el('button', 'tbtn indx', '×'); x.type = 'button'; x.title = 'Remove'; x.setAttribute('aria-label', 'Remove ' + indLabel(d));
    x.onclick = () => { inds = inds.filter(y => y !== d); indSave(); indBuild(); indMenu(); };
    row.append(x); on.append(row);
  }
  const add = $('cIndAdd'); add.replaceChildren();
  for (const [t, T] of Object.entries(IND_TYPES)) {
    if (t === 'vol' && inds.some(d => d.t === 'vol')) continue;
    const b = el('button', 'tbtn', '+ ' + T.name); b.type = 'button'; b.disabled = inds.length >= 12;
    b.onclick = () => { const used = new Set(inds.map(d => d.c)); const d = indNorm({ t, c: IND_COLORS.find(c => !used.has(c)) }); inds.push(d); indSave(); indBuild(); indMenu(); };
    add.append(b);
  }
}
$('cIndBtn').onclick = ev => { ev.stopPropagation(); const m = $('cIndMenu'), open = m.hidden; m.hidden = !open; $('cIndBtn').setAttribute('aria-expanded', String(open)); if (open) indMenu(); };
document.addEventListener('click', ev => { const m = $('cIndMenu'); const path = ev.composedPath(); if (!m.hidden && !path.includes(m) && !path.includes($('cIndBtn'))) { m.hidden = true; $('cIndBtn').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('cIndMenu').hidden) { $('cIndMenu').hidden = true; $('cIndBtn').setAttribute('aria-expanded', 'false'); $('cIndBtn').focus(); } });
document.querySelectorAll('.stepper [data-step]').forEach(b => { b.onclick = () => { const q = $('tkQty'); q.value = String(Math.max(1, Math.min(100, (Number(q.value) || 1) + Number(b.dataset.step)))); }; });

{ const t = store_.get('keel.chart.tf', ''); if (TF_MS[t]) { chartTf = t; tfPress(); } }   // the timeframe you last used

// ---------- risk limits ----------
const riskForm = () => ({ maxDailyLoss: Number($('rLoss').value), maxQtyPerOrder: Number($('rQty').value), maxOpenPositions: Number($('rPos').value), allowedSymbols: [...symbols] });
function riskErrors() {
  const e = {}, int = (id, hi) => { const n = Number($(id).value); return $(id).value !== '' && Number.isInteger(n) && n >= 1 && n <= hi; };
  const loss = Number($('rLoss').value);
  if ($('rLoss').value === '' || !(loss >= 1 && loss <= 1_000_000)) e.Loss = 'Enter an amount between $1 and $1,000,000.';
  if (!int('rQty', 1000)) e.Qty = 'Use a whole number from 1 to 1,000.';
  if (!int('rPos', 100)) e.Pos = 'Use a whole number from 1 to 100.';
  if (!symbols.length) e.Sym = 'Add at least one market, or the bot can\u2019t trade anything.';
  return e;
}
function riskChanged() {
  const e = riskErrors();
  for (const k of ['Loss', 'Qty', 'Pos', 'Sym']) $('e' + k).textContent = e[k] || '';
  $('riskBar').hidden = !savedRisk || JSON.stringify(riskForm()) === JSON.stringify(savedRisk);
  $('saveRisk').disabled = Object.keys(e).length > 0;
}
function renderSyms() {
  const box = $('symChips'); box.replaceChildren();
  for (const s of symbols) {
    const c = el('span', 'symchip', s), x = el('button', '', '\u00d7'); x.type = 'button'; x.setAttribute('aria-label', `Remove ${s}`);
    x.onclick = () => { symbols = symbols.filter(v => v !== s); renderSyms(); riskChanged(); };
    c.append(x); box.append(c);
  }
}
function addSym() {
  const v = $('symInput').value.trim().toUpperCase(); if (!v) return;
  if (!/^[A-Z0-9._-]{1,12}$/.test(v)) { $('eSym').textContent = 'Use letters and numbers only, like MNQ.'; return; }
  if (symbols.includes(v)) { $('eSym').textContent = `${v} is already on the list.`; return; }
  if (symbols.length >= 20) { $('eSym').textContent = 'You can list up to 20 markets.'; return; }
  symbols.push(v); $('symInput').value = ''; renderSyms(); riskChanged();
}
function fillRisk(r) { savedRisk = { ...r, allowedSymbols: [...r.allowedSymbols] }; $('rLoss').value = r.maxDailyLoss; $('rQty').value = r.maxQtyPerOrder; $('rPos').value = r.maxOpenPositions; symbols = [...r.allowedSymbols]; renderSyms(); riskChanged(); }
async function saveRisk() {
  if (Object.keys(riskErrors()).length) return;
  const f = riskForm(), r = await window.keel.setRisk(f);
  if (r.ok) { savedRisk = f; riskChanged(); renderStrats(); flash($('riskMsg'), 'Saved. These apply the next time you start the bot.'); } else $('riskMsg').textContent = r.error;
}
['rLoss', 'rQty', 'rPos'].forEach(id => { $(id).oninput = riskChanged; $(id).addEventListener('keydown', e => { if (e.key === 'Enter') saveRisk(); }); });
document.querySelectorAll('[data-step]').forEach(b => { b.onclick = () => { const i = $(b.dataset.step); i.value = Math.max(1, (parseInt(i.value, 10) || 0) + Number(b.dataset.d)); riskChanged(); }; });
$('symAdd').onclick = addSym;
$('symInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSym(); } });
$('saveRisk').onclick = saveRisk;
$('undoRisk').onclick = () => { fillRisk(savedRisk); flash($('riskMsg'), 'Changes undone.'); };

// ---------- logins ----------
const LOGIN_FOR = { projectx: 'Topstep', rithmic: 'Lucid Trading' };
function renderLogins() {
  const box = $('logins'); box.replaceChildren();
  for (const def of cat.brokers.filter(b => b.fields.length)) {
    const card = el('section', 'logcard'), head = el('div', 'loghead'), saved = cat.saved.includes(def.id);
    head.append(el('h2', '', LOGIN_FOR[def.id] ? `${LOGIN_FOR[def.id]} (${def.id === 'projectx' ? 'TopstepX' : 'Rithmic'})` : def.name),
      el('span', 'chip ' + (saved ? 'ok' : def.status === 'needs-approval' ? 'wait' : ''), saved ? 'Saved' : def.status === 'needs-approval' ? 'Waiting on Rithmic' : def.status === 'beta' ? 'Beta' : 'Not set up'));
    card.append(head, el('p', 'hint', def.note));
    const inputs = {};
    for (const f of def.fields) {
      if (def.id === 'rithmic' && (f.key === 'gateway' || f.key === 'system')) {   // picked from lists, not typed
        const l = el('label', '', f.label), s = el('select'); s.id = `lg_${def.id}_${f.key}`; l.htmlFor = s.id; s.append(new Option('Loading…', ''));
        inputs[f.key] = s; card.append(l, s); continue;
      }
      const l = el('label', '', f.label), i = el('input'); i.id = `lg_${def.id}_${f.key}`; l.htmlFor = i.id;
      i.type = f.secret ? 'password' : 'text'; i.autocomplete = 'off'; i.spellcheck = false;
      if (saved) i.placeholder = f.secret ? 'Saved (hidden)' : 'Saved'; else if (f.optional) i.placeholder = 'Optional: leave empty';
      inputs[f.key] = i; card.append(l, i);
    }
    const msg = el('p', 'hint'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
    const save = el('button', '', saved ? 'Replace login' : 'Save login'), rm = el('button', 'ghost', 'Remove');
    rm.hidden = !saved;
    save.onclick = async () => {
      const creds = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
      if (def.id === 'rithmic' && !creds.system) { flash(msg, "Pick your firm's system first (the list loads from the server you chose).", true); return; }
      const r = await window.keel.saveCreds(def.id, creds);
      if (r.ok) { if (!cat.saved.includes(def.id)) cat.saved.push(def.id); renderLogins(); notice('Login saved on this computer.', true); if (def.id === 'rithmic') void rithmicCheck(); } else flash(msg, r.error, true);
    };
    rm.onclick = async () => { await window.keel.removeCreds(def.id); cat.saved = cat.saved.filter(x => x !== def.id); renderLogins(); notice('Login removed.', true); };
    const row = el('div', 'btns0'); row.append(save, rm); card.append(row, msg);
    box.append(card);
    if (def.id === 'rithmic') void rithmicPickers(inputs, msg);
  }
}

// Rithmic: the server comes from Keel's approved list; the systems come live from the chosen server (Lucid's is LucidTrading).
async function rithmicPickers(inputs, msg) {
  const gw = inputs.gateway, sys = inputs.system, info = await window.keel.rithmicInfo().catch(() => null);
  if (!info || !gw.isConnected) return;
  gw.replaceChildren(...info.gateways.map(g => new Option(g.name, g.url)));
  gw.value = info.saved && info.gateways.some(g => g.url === info.saved.gateway) ? info.saved.gateway : info.gateways[0].url;
  let want = info.saved ? info.saved.system : '';
  const load = async () => {
    sys.replaceChildren(new Option('Loading the systems on this server…', '')); sys.disabled = true;
    const r = await window.keel.rithmicSystems(gw.value).catch(() => null);
    if (!sys.isConnected) return;
    sys.disabled = false;
    if (!r || !r.ok || !r.systems.length) {
      sys.replaceChildren(...(want ? [new Option(want, want)] : [new Option('No list: pick the server again', '')]));
      flash(msg, `Could not get the list of systems from this server${r && r.error ? ' (' + r.error + ')' : ''}. Check your internet, then pick the server again.`, true); return;
    }
    const list = [...r.systems].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    sys.replaceChildren(...list.map(s => new Option(s, s)));
    sys.value = list.includes(want) ? want : list.includes('LucidTrading') ? 'LucidTrading' : list[0];
  };
  gw.onchange = () => { want = ''; void load(); };
  await load();
}
async function rithmicCheck() {
  notice('Login saved. Checking it with Rithmic…', true);
  const r = await window.keel.rithmicCheck().catch(() => null);
  if (r && r.ok) notice(`Rithmic login works on ${r.system}: ${r.accounts.length} account${r.accounts.length === 1 ? '' : 's'} found (${r.accounts.slice(0, 4).join(', ')}${r.accounts.length > 4 ? ', …' : ''}). Add them under Accounts with Find my accounts.`, true);
  else notice(`Rithmic did not accept the login. ${r ? r.error : 'No answer.'}`);
}

// ---------- K system ----------
let kData = null, kDraft = null, kBusy = false;
const usd0 = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const nyTime = t => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
const MODE_HINT = {
  off: 'Off: no strategy trades.',
  paper: 'Paper: real prices from your login, pretend orders. Nothing reaches your account. Press Start bot to run it.',
  live: 'LIVE: real orders on the account selected at the top, with stops resting at the broker. Every entry still passes your risk limits.'
};
async function kLoad() {
  if (kBusy) return; kBusy = true;
  try { kData = await window.keel.kGet(); } finally { kBusy = false; }
  if (!kData) return;
  if (!kDraft) kDraft = JSON.parse(JSON.stringify(kData.cfg));
  kRender();
}
function kFillForm(c) {
  document.querySelectorAll('#kMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === c.mode)));
  $('kModeHint').textContent = MODE_HINT[c.mode]; $('kModeHint').classList.toggle('neg', c.mode === 'live');
  $('kSizing').value = c.sizing; $('kRisk').value = c.riskUsd; $('kDiv').value = c.divisor; $('kCap').value = c.capMult;
  $('kFlat').value = c.flatByHour === null ? 'none' : String(c.flatByHour); $('kPause').checked = c.pauseOn;
  $('kRiskWrap').hidden = c.sizing !== 'fixed'; $('kDivWrap').hidden = c.sizing !== 'cushion';
}
function kRender() {
  const d = kData, c = kDraft, st = d.status;
  if (document.activeElement === document.body || !document.activeElement || !$('v-k').contains(document.activeElement)) kFillForm(c);
  $('kStatus').textContent = !d.running ? 'The bot is stopped. K1-K7 run while the bot runs.'
    : !st ? (d.cfg.mode === 'off' ? 'The K system is off.' : 'Starting…')
    : `Last hourly check ${st.lastRun ? nyTime(st.lastRun) : '—'} (bar ${st.lastBarUtc ? nyTime(st.lastBarUtc) : '—'}). Risk per trade now ${usd0(st.riskNow)}.${st.error ? ' Problem: ' + st.error : ''}`;
  if (d.followers && d.followers.length) $('kStatus').textContent += ` Also trading: ${d.followers.map(f => `${f.label} (${f.open} open${f.working ? `, ${f.working} working` : ''}${f.paper !== null ? `, paper ${usd0(f.paper)}` : ''})`).join('; ')}.`;
  const t = $('kTable'); t.replaceChildren();
  const head = el('tr'); for (const h of ['On', 'Strategy', 'Market', 'Alone on 50K', 'Now']) head.append(el('th', '', h)); t.append(head);
  const R = d.rankings, risk = nearestRisk(c.riskUsd);
  const alone = id => { const r = R && ([...(R.singles || []), ...(R.paper || [])]).find(x => x.strategies === id && x.risk === risk);
    if (!r) return '—';
    if (!r.pass_pct) return 'Never passed alone (use it in a mix)';
    const slow = r.median_days_to_pass > 63 ? ' — too slow alone for a 90-day Combine' : '';
    return `${pct(r.pass_pct)} pass, ~${num(r.median_days_to_pass)} trading days${slow}${R.paper.includes(r) ? ' (10 weeks of data)' : ''}`; };
  const all = [...d.meta.map(m => ({ ...m, kind: 'k' })), ...(d.xmeta || []).map(m => ({ ...m, kind: 'x' }))];
  for (const m of all) {
    const row = el('tr');
    const lab = el('label', 'switch'), cb = el('input'); cb.type = 'checkbox'; cb.checked = !!c.enabled[m.id]; cb.setAttribute('aria-label', `${m.id} on or off`);
    cb.onchange = () => { kDraft.enabled[m.id] = cb.checked; kSave(true); };
    lab.append(cb, el('span')); const tcell = el('td'); tcell.append(lab);
    let now = '';
    if (!c.enabled[m.id]) now = 'Off';
    else if (m.paperOnly && c.mode === 'live') now = 'Paper only: skipped in live mode';
    else if (!d.running) now = 'On (bot stopped)';
    else if (m.kind === 'k') {
      const s = st ? st.strategies.find(x => x.id === m.id) : null;
      now = !s ? '—' : s.paused ? `Paused ${nyTime(s.paused)} (last 30 trades below -0.2R)` : 'Waiting for a signal';
      if (s && s.live) now = `${s.live.dir === 'long' ? 'Long' : 'Short'} ${s.live.qty} ${s.live.orderSym} @ ${s.live.entry.toFixed(2)}, stop ${s.live.stop.toFixed(2)}${s.live.target !== null ? `, target ${s.live.target.toFixed(2)}` : ''}`;
      else if (s && s.pending && !s.paused) now = s.pending.kind === 'confirm' ? `Signal ${s.pending.dir}, waiting for a confirming close` : `Entry ${s.pending.dir} at the next open`;
    } else {
      const s = d.x ? d.x.find(x => x.id === m.id) : null; now = !s ? '—' : s.note || 'Waiting for a setup';
      if (s && s.trade) { const q = s.trade; now = q.state === 'working' ? `Limit ${q.dir} ${q.qty} ${q.orderSym} @ ${q.limitPx.toFixed(2)} until ${nyTime(q.liveUntil)}`
        : `${q.dir === 'long' ? 'Long' : 'Short'} ${q.qty} ${q.orderSym} @ ${q.entry.toFixed(2)}, stop ${q.stop.toFixed(2)}${q.target !== null ? `, target ${q.target.toFixed(2)}` : ''}${q.endAt ? `, out by ${nyTime(q.endAt)}` : ''}`; }
    }
    const nm = el('td'); nm.append(el('b', '', m.id), document.createTextNode(' ' + (DESC[m.id] ? DESC[m.id][0] : m.name)));
    if (m.paperOnly) nm.append(el('span', 'tag', 'paper only')); if (m.id === 'K2') nm.append(el('span', 'tag', 'not for flat-daily accounts'));
    nm.append(el('span', 'sdesc', DESC[m.id] ? DESC[m.id][1] : ''));
    const sig = m.kind === 'k' ? (st ? st.strategies.find(x => x.id === m.id) : null) : (d.x ? d.x.find(x => x.id === m.id) : null);
    const nowCell = el('td', '', now);
    if (d.running && sig && sig.lastSignal) nowCell.append(el('span', 'sdesc', `Last signal ${nyTime(sig.lastSignal)}${sig.lastSignalDir ? ' ' + sig.lastSignalDir : ''} (from the live prices)`));
    else if (d.running && sig && c.enabled[m.id] && (m.kind === 'x' ? sig.lastScan : st && st.lastRun)) nowCell.append(el('span', 'sdesc', 'No signal in the price history Keel has loaded'));
    row.append(tcell, nm, el('td', '', `${m.symbol} → ${m.orderSymbol}`), el('td', '', alone(m.id)), nowCell);
    t.append(row);
  }
  mixRender();
  $('kPaperBox').hidden = !d.paper;
  if (d.paper) {
    $('kPaperText').textContent = `Paper P&L ${usd0(d.paper.realized + d.paper.unrealized)} (closed ${usd0(d.paper.realized)}, open ${usd0(d.paper.unrealized)})`;
    const f = $('kFills'); f.replaceChildren();
    if (d.paper.fills.length) {
      const ft = el('table'), hr = el('tr'); for (const h of ['Time', 'Fill', 'Price', 'How']) hr.append(el('th', '', h)); ft.append(hr);
      for (const x of d.paper.fills.slice().reverse()) { const r = el('tr'); r.append(el('td', '', nyTime(x.t)), el('td', '', `${x.side} ${x.qty} ${x.symbol}`), el('td', '', x.price.toFixed(2)), el('td', '', x.why)); ft.append(r); }
      f.append(ft);
    }
  }
}
const DESC = {
  K1: ["NQ break of yesterday's POC", "Trades a break of yesterday's busiest price (point of control), both ways, 5R target."],
  K2: ['NQ narrow-range swing', 'Needs overnight holds; about breakeven when you must be flat every day.'],
  K3: ['NQ NR7 breakout with the trend', 'Breakout of the narrowest hourly bar of the last 7, with the EMA20/50 trend.'],
  K4: ['NQ VWAP +1σ retest short', 'Sells a failed retest of VWAP +1 standard deviation in the New York morning.'],
  K5: ["Gold break below yesterday's value-area low", "Sells when gold breaks yesterday's value-area low, 2R target."],
  K6: ['Gold Asia NR7 long', 'Buys a narrow-range breakout in the Asia session when volatility is low, 5R target.'],
  K7: ['Gold value-area low break', "Trades a break of yesterday's value-area low either way, 1.5R target."],
  K8: ['Gold Fractal breakout (day trade)', 'Daily fractal breakout; market entry at the 6 PM reopen, 3R target, flat by the cut-off.'],
  K9: ['Gold PO3, 1h rejection block', '4h Power of Three: after the fake move, a limit order at the 1h rejection block; out at the 4h close.'],
  P1: ['Gold PO3, 15m FVG midpoint', '4h Power of Three: limit at the 15-minute fair value gap midpoint; out at the 4h close.'],
  P2: ['Gold PO3, 15m rejection block', '4h Power of Three: limit at the 15-minute rejection block, 3R target.'],
  P3: ['NQ PO3, 15m FVG midpoint', '4h Power of Three on NQ: limit at the 15-minute fair value gap midpoint.']
};
const nearestRisk = r => [150, 250, 350, 500].reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 350);
const idsOf = str => str.split(' + ');
function mixList() {
  const R = kData && kData.rankings; if (!R || !kDraft) return [];
  const risk = nearestRisk(kDraft.riskUsd);
  const rows = [...R.mixes, ...R.singles].filter(r => r.risk === risk).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.median_days_to_pass ?? 99) - (b.median_days_to_pass ?? 99));
  const recRow = R.mixes.find(r => r.strategies === R.recommended.strategies && r.risk === risk) || { strategies: R.recommended.strategies, risk };
  const out = [{ ...recRow, label: 'Recommended' }];
  const fastest = rows.filter(r => r.pass_pct >= 0.85 && r.xfa_first_payout_pct >= 0.8).sort((a, b) => a.median_days_to_pass - b.median_days_to_pass)[0];
  if (fastest && fastest.strategies !== recRow.strategies) out.push({ ...fastest, label: 'Fastest pass' });
  for (const m of PINNED_MIXES) if (!out.some(o => o.strategies === m)) { const r = rows.find(x => x.strategies === m) || R.mixes.find(x => x.strategies === m); if (r) out.push({ ...r, label: 'Pinned' }); }
  for (const r of rows.slice(0, 15)) if (!out.some(o => o.strategies === r.strategies)) out.push({ ...r, label: '' });
  return out;
}
function mixRender() {
  const sel = $('mixSel'); if (!sel || document.activeElement === sel) return;
  const list = mixList(), on = Object.keys(kDraft.enabled).filter(k => kDraft.enabled[k]).sort().join(',');
  const prev = sel.value; sel.replaceChildren();
  list.forEach((r, i) => { const o = el('option', '', `${r.label ? r.label + ': ' : ''}${r.strategies}  ·  pass ${pct(r.pass_pct)}, ~${num(r.median_days_to_pass)} days, payout ${pct(r.xfa_first_payout_pct)}`); o.value = String(i); sel.append(o); });
  const match = list.findIndex(r => idsOf(r.strategies).sort().join(',') === on);
  sel.value = prev && Number(prev) < list.length ? prev : String(Math.max(0, match));
  const cur = list[Number(sel.value)];
  $('mixInfo').textContent = (match >= 0 ? `You are running: ${list[match].strategies}. ` : 'You are running your own selection. ')
    + (cur ? `Selected mix at $${cur.risk} risk: passed ${pct(cur.pass_pct)} of the time in ~${num(cur.median_days_to_pass)} trading days; ${pct(cur.xfa_first_payout_pct)} reached a first payout ~${num(cur.median_days_pass_to_1st_payout)} days later.` : '');
}
$('mixSel').onchange = () => { $('mixSel').blur(); mixRender(); };
$('mixUse').onclick = async () => {
  const r = mixList()[Number($('mixSel').value)]; if (!r) return;
  const want = idsOf(r.strategies);
  kDraft.enabled = Object.fromEntries(Object.keys(kDraft.enabled).map(id => [id, want.includes(id)]));
  await kSave(true); flash($('kMsg'), `Turned on: ${r.strategies}.`);
};
function kReadForm() {
  const f = $('kFlat').value;
  return { ...kDraft, sizing: $('kSizing').value, riskUsd: Number($('kRisk').value), divisor: Number($('kDiv').value), capMult: Number($('kCap').value),
    flatByHour: f === 'none' ? null : Number(f), pauseOn: $('kPause').checked };
}
async function kSave(quiet) {
  const next = quiet ? kDraft : kReadForm();
  const r = await window.keel.kSet(next);
  if (!r.ok) { flash($('kMsg'), r.error, true); kDraft = JSON.parse(JSON.stringify(kData.cfg)); kRender(); return; }
  kDraft = JSON.parse(JSON.stringify(r.cfg)); if (!quiet) flash($('kMsg'), 'Saved.'); await kLoad();
}
$('kSizing').onchange = () => { $('kRiskWrap').hidden = $('kSizing').value !== 'fixed'; $('kDivWrap').hidden = $('kSizing').value !== 'cushion'; };
$('kSave').onclick = () => kSave(false);
document.querySelectorAll('#kMode button').forEach(b => {
  b.onclick = async () => {
    const mode = b.dataset.mode;
    if (mode === 'live' && !confirm('Turn on LIVE trading?\n\nKeel will place real orders on the account selected at the top whenever the bot runs. Run paper mode first, and check the Validate page.')) return;
    kDraft = { ...kReadForm(), mode }; await kSave(true);
  };
});

// ---------- Discord ----------
async function suLoad() { const s = await window.keel.startupGet(); if (s) { $('suResume').checked = s.autoResume; $('suLogin').checked = s.openAtLogin; $('suBg').checked = s.background !== false; } }
async function suSave() { const r = await window.keel.startupSet({ autoResume: $('suResume').checked, openAtLogin: $('suLogin').checked, background: $('suBg').checked }); $('suMsg').textContent = r && r.ok ? 'Saved.' : 'Could not save.'; }
$('suResume').onchange = suSave; $('suLogin').onchange = suSave; $('suBg').onchange = suSave;
async function dcLoad() { void suLoad(); const r = await window.keel.discordGet(); if (r) { $('dcUrl').placeholder = r.saved ? 'Saved (paste a new one to replace it)' : 'https://discord.com/api/webhooks/...'; $('dcDel').hidden = !r.saved; $('dcEveryone').checked = r.everyone !== false; $('dlUrl').placeholder = r.logSaved ? 'Saved (paste a new one to replace it)' : 'https://discord.com/api/webhooks/...'; $('dlDel').hidden = !r.logSaved; } }
$('dlSave').onclick = async () => { const u = $('dlUrl').value.trim(); if (!u) return; $('dlMsg').textContent = 'Sending a test message…';
  const r = await window.keel.discordLogSave(u); $('dlUrl').value = ''; $('dlMsg').textContent = r.ok ? 'Saved. Check Discord for the test message.' : r.error; dcLoad(); };
$('dlDel').onclick = async () => { await window.keel.discordLogRemove(); $('dlMsg').textContent = 'Bot log to Discord turned off.'; dcLoad(); };
$('dcSave').onclick = async () => { const u = $('dcUrl').value.trim(); if (!u) return; $('dcMsg').textContent = 'Sending a test message…';
  const r = await window.keel.discordSave(u, $('dcEveryone').checked); $('dcUrl').value = ''; $('dcMsg').textContent = r.ok ? 'Saved. Check Discord for the test message.' : r.error; dcLoad(); };
$('dcEveryone').onchange = async () => { const r = await window.keel.discordEveryone($('dcEveryone').checked); $('dcMsg').textContent = r && r.ok ? ($('dcEveryone').checked ? 'Trade pings will mention @everyone.' : 'Trade pings will not mention @everyone.') : 'Save a webhook first; this setting is saved with it.'; };
$('dcDel').onclick = async () => { await window.keel.discordRemove(); $('dcMsg').textContent = 'Discord pings turned off.'; dcLoad(); };

// ---------- Claude ----------
let aiData = null, aiFormDirty = false;
async function aiLoad() {
  aiData = await window.keel.aiGet(); if (!aiData) return;
  const c = aiData.cfg;
  if (!aiFormDirty) { $('aiPre').checked = c.autoPreflight; $('aiPause').checked = c.newsPause; $('aiPauseMin').value = c.pauseMin; $('aiCheck').value = c.entryCheck;
    $('aiNews').value = c.newsTrades; $('aiVetoErr').checked = c.vetoOnError; $('aiRev').checked = c.autoReview; $('aiMgmt').value = c.tradeMgmt || 'shadow'; }
  { const m = aiData.mgmt; $('aiMgmtStats').textContent = !m || !m.checks ? 'No trade checks yet. Claude checks open trades while the bot runs.' :
    `${m.checks} checks: ${m.holds} hold, ${m.breakevens} breakeven, ${m.closes} close.` + (m.closeCalls ? ` Close calls vs holding: ${m.closeBetterR >= 0 ? '+' : ''}${m.closeBetterR.toFixed(2)}R in total over ${m.closeCalls} trade${m.closeCalls > 1 ? 's' : ''}.` : '') +
    (m.beCalls ? ` Breakeven calls would have saved ${m.beSavedR.toFixed(2)}R over ${m.beCalls} trade${m.beCalls > 1 ? 's' : ''}.` : '') + (m.moved ? ` Stops moved to breakeven: ${m.moved}.` : ''); }
  $('aiKey').placeholder = aiData.hasKey ? 'Key saved (type a new one to replace it)' : 'sk-ant-...';
  const p = aiData.preflight;
  $('aiNow').textContent = !aiData.hasKey ? 'Add your API key to start.' : aiData.newsNow ? `News pause on now: ${aiData.newsNow}.` : 'No news pause right now.';
  $('aiPreText').textContent = p ? `${p.date}: ${p.summary}` : 'No pre-flight yet today.';
  const t = $('aiEvents'); t.replaceChildren();
  if (p && p.events.length) { const h = el('tr'); for (const x of ['Time (ET)', 'Event', 'Impact', 'Forecast', 'Previous']) h.append(el('th', '', x)); t.append(h);
    for (const ev of p.events) { const r = el('tr'); r.append(el('td', '', ev.time), el('td', '', ev.name), el('td', ev.impact === 'high' ? 'neg' : '', ev.impact), el('td', '', ev.forecast || '—'), el('td', '', ev.previous || '—')); t.append(r); } }
  $('aiRevWhen').textContent = aiData.review ? `Written ${nyTime(aiData.review.at)}.` : 'No review yet.';
  $('aiRevText').textContent = aiData.review ? aiData.review.text : '';
  const ch = $('aiChat'); ch.replaceChildren();
  for (const m of aiData.chat) ch.append(el('div', m.role === 'user' ? 'q' : 'a', m.text));
  ch.scrollTop = ch.scrollHeight;
}
['aiPre', 'aiPause', 'aiPauseMin', 'aiCheck', 'aiNews', 'aiVetoErr', 'aiRev'].forEach(id => { $(id).addEventListener('input', () => { aiFormDirty = true; }); $(id).addEventListener('change', () => { aiFormDirty = true; }); });
$('aiSave').onclick = async () => {
  const next = { autoPreflight: $('aiPre').checked, newsPause: $('aiPause').checked, pauseMin: Number($('aiPauseMin').value), entryCheck: $('aiCheck').value,
    newsTrades: $('aiNews').value, vetoOnError: $('aiVetoErr').checked, autoReview: $('aiRev').checked, tradeMgmt: $('aiMgmt').value };
  const was = aiData ? aiData.cfg : {};
  if ((next.entryCheck === 'live' && was.entryCheck !== 'live') || (next.newsTrades === 'live' && was.newsTrades !== 'live')) {
    if (!confirm('Let Claude affect LIVE trading?\n\nThe entry check can block real entries and news trades place real orders. Neither was backtested. Run them in paper mode first.')) return;
  }
  const r = await window.keel.aiSet(next); aiFormDirty = false;
  if (!r.ok) { flash($('aiMsg'), r.error, true); return; } flash($('aiMsg'), 'Saved.'); aiLoad();
};
$('aiKeySave').onclick = async () => { const k = $('aiKey').value.trim(); if (!k) return; const r = await window.keel.aiKey(k); $('aiKey').value = '';
  flash($('aiKeyMsg'), r.ok ? 'Key saved on this computer.' : r.error, !r.ok); aiLoad(); };
$('aiKeyDel').onclick = async () => { await window.keel.aiKey(null); flash($('aiKeyMsg'), 'Key removed.'); aiLoad(); };
const aiBusy = async (btn, fn, label) => { const old = btn.textContent; btn.disabled = true; btn.textContent = label; try { const r = await fn(); if (r && !r.ok) notice(r.error); } finally { btn.disabled = false; btn.textContent = old; aiLoad(); } };
$('aiPreRun').onclick = () => aiBusy($('aiPreRun'), () => window.keel.aiPreflight(), 'Searching the calendar…');
$('aiRevRun').onclick = () => aiBusy($('aiRevRun'), () => window.keel.aiReview(), 'Writing…');
$('aiClear').onclick = async () => { await window.keel.aiClearChat(); aiLoad(); };
async function aiAsk() {
  const q = $('aiQ').value.trim(); if (!q) return; $('aiQ').value = '';
  $('aiChat').append(el('div', 'q', q), el('div', 'a', 'Thinking…')); $('aiChat').scrollTop = $('aiChat').scrollHeight;
  await aiBusy($('aiAsk'), () => window.keel.aiChat(q), '…');
}
$('aiAsk').onclick = aiAsk;
$('aiQ').addEventListener('keydown', ev => { if (ev.key === 'Enter') aiAsk(); });

// ---------- Rankings ----------
let rkData = null, rkTab = 'mixes', rkSort = { key: 'score', dir: -1 };
const pct = x => (x === null || x === undefined ? '—' : Math.round(x * 100) + '%'), num = x => (x === null || x === undefined ? '—' : String(Math.round(x * 10) / 10));
const RK_COLS = {
  mixes: [['strategies', 'Mix'], ['risk', 'Risk'], ['pass_pct', 'Pass'], ['median_days_to_pass', 'Days to pass'], ['xfa_first_payout_pct', 'Reached payout'],
    ['median_days_pass_to_1st_payout', 'Days pass → payout'], ['xfa_blown_before_payout_pct', 'Funded lost before payout'], ['median_cash_first60d', 'Cash in 60 funded days'],
    ['oos_pass_pct', 'Pass (last year only)'], ['oos_days_to_pass', 'Days (last year)'], ['score', 'Pass × payout']],
  paper: [['strategies', 'Strategy'], ['risk', 'Risk'], ['pass_pct', 'Pass'], ['median_days_to_pass', 'Days to pass'], ['note', 'Note']]
};
RK_COLS.singles = RK_COLS.mixes.map(c => (c[0] === 'strategies' ? ['strategies', 'Strategy'] : c));
const rkFmt = (k, v) => (v === null || v === undefined ? '—' : /pct|score/.test(k) ? pct(v) : k === 'risk' || k === 'median_cash_first60d' ? usd0(v) : typeof v === 'number' ? num(v) : String(v));
async function rkLoad() {
  if (!kData) { try { kData = await window.keel.kGet(); } catch { return; } if (kData && !kDraft) kDraft = JSON.parse(JSON.stringify(kData.cfg)); }
  rkData = kData && kData.rankings; if (!rkData) return;
  $('rkSource').textContent = rkData.source + ` Recommended: ${rkData.recommended.strategies} at ${usd0(rkData.recommended.risk)} risk.`;
  rkRender();
}
function rkRender() {
  const cols = RK_COLS[rkTab], riskF = $('rkRisk').value, t = $('rkTable'); t.replaceChildren();
  let rows = (rkData[rkTab] || []).filter(r => riskF === 'all' || String(r.risk) === riskF);
  const k = rkSort.key in (rows[0] || {}) ? rkSort.key : 'pass_pct';
  rows = rows.slice().sort((a, b) => { const x = a[k], y = b[k]; if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return (x < y ? -1 : 1) * rkSort.dir; });
  const hr = el('tr');
  for (const [key, label] of cols) {
    const th = el('th', '', label + (k === key ? (rkSort.dir < 0 ? ' ▼' : ' ▲') : '')); th.style.cursor = 'pointer'; th.tabIndex = 0;
    th.onclick = th.onkeydown = ev => { if (ev.type === 'keydown' && ev.key !== 'Enter') return; rkSort = { key, dir: rkSort.key === key ? -rkSort.dir : (/days|blown/.test(key) ? 1 : -1) }; rkRender(); };
    hr.append(th);
  }
  if (rkTab !== 'paper') hr.append(el('th', '', ''));
  t.append(hr);
  const rec = rkData.recommended;
  for (const r of rows.slice(0, 150)) {
    const row = el('tr'); if (r.strategies === rec.strategies && r.risk === rec.risk) row.className = 'pos';
    for (const [key] of cols) row.append(el('td', '', rkFmt(key, r[key])));
    if (rkTab !== 'paper') {
      const b = el('button', 'small', 'Use'); b.type = 'button';
      b.onclick = async () => {
        const ids = r.strategies.split(' + ');
        if (!confirm(`Switch the K system to ${r.strategies} at ${usd0(r.risk)} risk per trade?\n\nEvery other strategy is switched off. Paper/live mode is not changed.`)) return;
        const en = Object.fromEntries(Object.keys(kDraft.enabled).map(id => [id, ids.includes(id)]));
        const res = await window.keel.kSet({ ...kDraft, enabled: en, sizing: 'fixed', riskUsd: r.risk });
        if (!res.ok) { flash($('rkMsg'), res.error, true); return; }
        kDraft = JSON.parse(JSON.stringify(res.cfg)); kData = await window.keel.kGet(); flash($('rkMsg'), `K system set to ${r.strategies} at ${usd0(r.risk)}.`);
      };
      const td = el('td'); td.append(b); row.append(td);
    }
    t.append(row);
  }
}
document.querySelectorAll('#rkTabs button').forEach(b => { b.onclick = () => { rkTab = b.dataset.tab; document.querySelectorAll('#rkTabs button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); rkRender(); }; });
$('rkRisk').onchange = () => rkRender();

// ---------- K system: validation ----------
$('kvRun').onclick = async () => {
  const read = async id => { const f = $(id).files[0]; if (!f) return ''; if (f.size > 60e6) throw new Error('A file is too big (60 MB max).'); return f.text(); };
  let files;
  try { files = { NQ: await read('kvNq'), GC: await read('kvGc'), NQdaily: await read('kvNqD'), GCdaily: await read('kvGcD') }; }
  catch (e) { flash($('kvMsg'), e.message, true); return; }
  if (!files.NQ && !files.GC) { flash($('kvMsg'), 'Choose the NQ1! or GC1! hourly file first.', true); return; }
  $('kvMsg').textContent = 'Running…'; $('kvRun').disabled = true;
  const r = await window.keel.kValidate(files, $('kvFlat').value === 'none' ? null : Number($('kvFlat').value));
  $('kvRun').disabled = false;
  if (!r.ok) { flash($('kvMsg'), r.error, true); return; }
  $('kvMsg').textContent = ''; $('kvOut').hidden = false;
  const flagged = r.rows.filter(x => x.flags.length).length, covered = r.rows.filter(x => x.covered).length;
  const noDaily = Object.entries(r.daily).filter(([k, v]) => !v && r.bars[k]).map(([k]) => k);
  $('kvSummary').textContent = `${Object.entries(r.bars).map(([k, v]) => `${k}: ${v.toLocaleString()} hourly bars`).join(', ')}, ${new Date(r.from).toISOString().slice(0, 10)} to ${new Date(r.to).toISOString().slice(0, 10)}. `
    + `${covered} of ${r.rows.length} strategy periods are fully covered by your data; ${flagged ? `${flagged} are more than 10% off the research (marked).` : 'all of them are within 10% of the research.'}`
    + (noDaily.length ? ` No daily file for ${noDaily.join(' and ')}: the daily trend needs 50 sessions to start, so K1 and K7 trade less in the first months.` : '')
    + (r.flatBy !== null ? ' Flat-by 4 PM is on, so differences from the research are expected (K2 most).' : '');
  const t = $('kvTable'); t.replaceChildren();
  const hr = el('tr'); for (const h of ['Strategy', 'Period', 'Keel: trades / win / avg R / PF', 'Research', 'Check']) hr.append(el('th', '', h)); t.append(hr);
  const P = { train: 'Jun 2024 – Mar 2025', valid: 'Apr – Nov 2025', test: 'Dec 2025 – Nov 2026' };
  for (const x of r.rows) {
    const row = el('tr'), g = x.got, w = x.want;
    row.append(el('td', '', x.id), el('td', '', P[x.period]),
      el('td', '', `${g.trades} / ${Math.round(g.win)}% / ${g.avgR >= 0 ? '+' : ''}${g.avgR.toFixed(2)} / ${g.pf === null ? '—' : g.pf.toFixed(2)}`),
      el('td', '', `${w[0]} / ${w[1]}% / ${w[2] >= 0 ? '+' : ''}${w[2].toFixed(2)} / ${w[3].toFixed(2)}`),
      el('td', !x.covered ? '' : x.flags.length ? 'neg' : 'pos', !x.covered ? 'Not enough data' : x.flags.length ? x.flags.join('; ') : 'Matches'));
    t.append(row);
  }
};

// ---------- catalog and session ----------
async function loadCatalog() {
  cat = await window.keel.catalog(); if (!cat) return;
  store = cat.accounts; strats = cat.strategies;
  $('sampleAccts').hidden = !cat.dev;
  $('version').textContent = `Keel ${cat.version}`;
  fillRisk(cat.risk); renderLogins(); renderAccounts(); renderPicker(); renderStrats();
}
$('toggle').onclick = async () => {
  $('toggle').disabled = true;
  if (running) await window.keel.stop();
  else { const r = await window.keel.start(); notice(r.ok ? (r.warnings && r.warnings.length ? 'Started, but check your settings: ' + r.warnings.join(' ') : '') : r.error); }
  $('toggle').disabled = false; await refresh(); renderPicker(); renderAccounts();
};
$('kill').onclick = async () => { await window.keel.kill(); await refresh(); };
$('copyAlert').onclick = async () => flash($('copyMsg'), (await window.keel.copyAlert()) ? 'Copied.' : "Couldn't copy.");

function render(s) {
  if (!s) return;
  last = s;
  const u = s.update || {};
  $('update').hidden = u.state !== 'ready';
  $('updateText').textContent = u.state === 'ready' ? `Keel ${u.version} is ready.${s.running ? ' Stop the bot, then restart to update. Or it updates next time you close Keel.' : ' Restart to update now, or it updates next time you close Keel.'}` : '';
  $('updateGo').disabled = s.running;
  $('alert').textContent = JSON.stringify({ secret: s.webhookSecret, symbol: 'ES', side: 'buy', qty: 1 });
  const wasRunning = running;
  if (!poll) poll = setInterval(refresh, 1500);
  if (!cat) { loadCatalog().then(() => renderToday(last)); go('dash'); return; }
  renderToday(s);
  if (view === 'chart') { drawLive(); if (Date.now() - (window._tkAt || 0) > 3000) { window._tkAt = Date.now(); void tkRender(); } }
  if (view === 'k') kLoad();
  if (wasRunning !== s.running) { renderPicker(); renderAccounts(); }
}
const refresh = async () => render(await window.keel.status());

$('updateGo').onclick = async () => { const r = await window.keel.installUpdate(); if (r && !r.ok) notice(r.error); };

refresh();

// ---------- trade journal + stats ----------
let jPer = 'month', jData = null, jEdit = null;
const DAY = 86400000;
function jFilter() {
  const f = { accountId: $('jAcct').value, id: $('jStrat').value, mode: $('jMode').value };
  if (jPer === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); f.from = d.getTime(); }
  else if (jPer === 'week') f.from = Date.now() - 7 * DAY; else if (jPer === 'month') f.from = Date.now() - 30 * DAY;
  return f;
}
function jSelect(sel, items, all) {
  const keep = sel.value;
  sel.replaceChildren(new Option(all, ''), ...items.map(([v, t]) => new Option(t, v)));
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}
async function jLoad() {
  const r = await window.keel.journal(jFilter()); if (!r) return;
  jData = r;
  jSelect($('jAcct'), r.accounts.map(a => [a.id, a.label]), 'All accounts');
  jSelect($('jStrat'), r.strategies.map(x => [x, x === 'MANUAL' ? 'Chart trades' : x]), 'All strategies');
  const S = r.stats, cards = $('jCards'); cards.replaceChildren();
  const card = (k, v, cls) => { const c = el('div', 'jcard'); c.append(el('p', 'k', k)); const n = el('p', 'v ' + (cls || ''), v); c.append(n); cards.append(c); return n; };
  const net = card('Net P&L', money(S.net), S.net > 0 ? 'pos' : S.net < 0 ? 'neg' : '');
  net.title = `${S.counted} trades with a P&L (of ${S.trades})`;
  card('Trades · win rate', `${S.trades} · ${S.winRate}%`);
  card('Profit factor', S.profitFactor === null ? (S.grossWin > 0 ? '∞' : '—') : String(S.profitFactor));
  card('Expectancy / trade', money(S.expectancy), S.expectancy > 0 ? 'pos' : S.expectancy < 0 ? 'neg' : '');
  card('Average win', money(S.avgWin), 'pos'); card('Average loss', money(S.avgLoss), 'neg');
  card('Best · worst', `${money(S.best)} · ${money(S.worst)}`);
  card('Max drawdown · losing streak', `${plain(S.maxDrawdown)} · ${S.longestLosing}`);
  jCurve(S.curve);
  const by = $('jBy'); by.replaceChildren();
  by.append(jTable([['Strategy', ''], ['Trades', 'r'], ['Win rate', 'r'], ['Net', 'r']], S.byStrategy.map(x => [x.key === 'MANUAL' ? 'Chart trades' : x.key, String(x.trades), x.winRate + '%', x.net])));
  if (!S.byStrategy.length) by.append(el('p', 'empty', 'No trades yet.'));
  const dy = $('jDays'); dy.replaceChildren();
  dy.append(jTable([['Day', ''], ['Trades', 'r'], ['Net', 'r']], S.byDay.slice(0, 60).map(x => [new Date(x.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), String(x.trades), x.net])));
  if (!S.byDay.length) dy.append(el('p', 'empty', 'No trades yet.'));
  const box = $('jList'); box.replaceChildren();
  if (!r.trades.length) { box.append(el('p', 'empty', 'No closed trades in this period. Keel adds every trade it closes, on every account.')); return; }
  const t = el('table'), head = el('tr');
  for (const [h, c] of [['Closed', ''], ['Account', ''], ['Strategy', ''], ['Trade', ''], ['Entry', 'r'], ['Exit', 'r'], ['P&L', 'r']]) head.append(Object.assign(el('th', c, h), { scope: 'col' }));
  t.append(head);
  for (const x of r.trades) {
    const row = el('tr', 'click'), when = new Date(x.closedAt);
    row.tabIndex = 0; row.onclick = () => jOpen(x); row.onkeydown = ev => { if (ev.key === 'Enter') jOpen(x); };
    const strat = el('td', '', x.id === 'MANUAL' ? 'Chart' : x.id); for (const g of x.tags) strat.append(el('span', 'tag', g)); if (x.note) strat.title = x.note;
    const pnl = el('td', 'r'); if (x.pnl === null) pnl.textContent = '—'; else { sign(pnl, x.pnl); if (x.approx) pnl.textContent = '≈ ' + pnl.textContent; }
    row.append(el('td', '', when.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
      el('td', '', x.account + (x.mode === 'paper' ? ' (paper)' : '')), strat, el('td', '', `${x.dir === 'long' ? 'Long' : 'Short'} ${x.qty} ${x.orderSym} · ${x.how}`),
      el('td', 'r', x.entry.toFixed(2)), el('td', 'r', x.exit === null ? '—' : x.exit.toFixed(2)), pnl);
    t.append(row);
  }
  box.append(t);
  if (r.total > r.trades.length) box.append(el('p', 'hint', `Showing the newest ${r.trades.length} of ${r.total}. Export CSV for all of them.`));
}
function jTable(cols, rows) {
  const t = el('table'), head = el('tr');
  for (const [h, c] of cols) head.append(Object.assign(el('th', c, h), { scope: 'col' }));
  t.append(head);
  for (const r of rows) { const tr = el('tr'); r.forEach((v, i) => { const td = el('td', cols[i][1]); if (typeof v === 'number') sign(td, v); else td.textContent = v; tr.append(td); }); t.append(tr); }
  return t;
}
function jCurve(curve) {
  const box = $('jCurve'); box.replaceChildren();
  if (curve.length < 2) return;
  const NS = 'http://www.w3.org/2000/svg', W = 800, H = 140, P = 6, ys = [0, ...curve.map(c => c.equity)], lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const x = i => P + (i / (curve.length - 1)) * (W - 2 * P), y = v => H - P - ((v - lo) / span) * (H - 2 * P);
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Equity curve: ${money(curve[curve.length - 1].equity)} over ${curve.length} trades`);
  const z = document.createElementNS(NS, 'line'); z.setAttribute('class', 'zero'); z.setAttribute('x1', P); z.setAttribute('x2', W - P); z.setAttribute('y1', y(0)); z.setAttribute('y2', y(0));
  const path = document.createElementNS(NS, 'path'); path.setAttribute('class', 'eq'); path.setAttribute('vector-effect', 'non-scaling-stroke');
  path.setAttribute('d', curve.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(c.equity).toFixed(1)}`).join(''));
  svg.append(z, path); box.append(svg);
}
function jOpen(x) {
  jEdit = x;
  $('jDlgTitle').textContent = `${x.dir === 'long' ? 'Long' : 'Short'} ${x.qty} ${x.orderSym} · ${x.id === 'MANUAL' ? 'Chart trade' : x.id}`;
  $('jDlgInfo').textContent = `${x.account}${x.mode === 'paper' ? ' (paper)' : ''}. Opened ${new Date(x.openedAt).toLocaleString()}, closed ${new Date(x.closedAt).toLocaleString()} (${x.why}). Entry ${x.entry.toFixed(2)}, exit ${x.exit === null ? 'unknown' : x.exit.toFixed(2) + (x.approx ? ' (last price, approximate)' : '')}.`;
  $('jNote').value = x.note; $('jTags').value = x.tags.join(' '); $('jExit').value = x.exit === null ? '' : String(x.exit);
  $('jDlg').showModal();
}
$('jDlg').addEventListener('close', async () => {
  const x = jEdit, v = $('jDlg').returnValue; jEdit = null; if (!x) return;
  if (v === 'del') { if (confirm('Remove this trade from the journal? Your stats will no longer count it.')) { await window.keel.journalRemove(x.uid); void jLoad(); } return; }
  if (v !== 'save') return;
  const patch = { note: $('jNote').value, tags: $('jTags').value.split(/\s+/).filter(Boolean) }, ex = $('jExit').value.trim();
  if (ex && Number(ex) !== x.exit) patch.exit = Number(ex);
  const r = await window.keel.journalEdit(x.uid, patch); if (!r.ok) notice(r.error); void jLoad();
});
['jAcct', 'jStrat', 'jMode'].forEach(id => { $(id).onchange = () => void jLoad(); });
document.querySelectorAll('#jPer button').forEach(b => { b.onclick = () => { jPer = b.dataset.p; document.querySelectorAll('#jPer button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); void jLoad(); }; });
$('jCsv').onclick = async () => { const r = await window.keel.journalCsv(jFilter()); if (r && r.ok) notice(`Saved ${r.path}`, true); else if (r && r.error) notice(r.error); };
