'use strict';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

const NAMES = { projectx: 'TopstepX', rithmic: 'Rithmic', cqg: 'CQG', tradovate: 'Tradovate', ninjatrader: 'NinjaTrader' };
const nm = v => NAMES[v] || v;
const STATUS = { ready: '', beta: ' (beta)', 'needs-approval': ' (needs approval)' };
const TITLES = { ai: 'Claude', rank: 'Compare mixes', dash: 'Today', chart: 'Chart', acct: 'Progress', accts: 'Accounts', k: 'Strategies', kval: 'Validate the K system', strat: 'Custom strategies', test: 'Backtest', conn: 'Logins', risk: 'Risk limits', alerts: 'TradingView alerts' };
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
  view = v; if (v === 'chart') drawLive(); if (v === 'test') fillBtStrats(); if (v === 'k') kLoad(); if (v === 'rank') rkLoad(); if (v === 'ai') aiLoad();
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
  if (s.running && st.paused) line += ' You reached your daily goal, so new trades are paused.';
  else if (n.progress && n.progress.dailyTarget > 0 && t > 0) line += ` That's ${Math.round(n.progress.dailyPct)}% of your ${plain(n.progress.dailyTarget)} daily goal.`;
  if (s.running && t < 0) line += ` You have ${plain(st.limit + t)} left before your daily loss limit.`;
  if (!s.running) line += ' The bot is stopped.';
  return line;
}

function drawChart(hist, limit) {
  const box = $('chart'); box.replaceChildren();
  if (!hist || hist.length < 2) { box.append(el('p', 'empty', 'Once the bot is running, your day will draw itself here.')); return; }
  const W = 640, H = 200, L = 8, R = 8, T = 14, B = 22, vals = hist.map(p => p[1]);
  const lo = Math.min(Math.min(...vals), -Math.abs(limit)) * 1.08, hi = Math.max(Math.max(...vals), Math.abs(limit) * 0.2) * 1.08;
  const t0 = hist[0][0], t1 = hist[hist.length - 1][0] || t0 + 1;
  const x = t => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R), y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const NS = 'http://www.w3.org/2000/svg', mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Profit and loss today compared with your daily loss limit' });
  svg.append(mk('line', { class: 'zero', x1: L, x2: W - R, y1: y(0), y2: y(0) }), mk('line', { class: 'lim', x1: L, x2: W - R, y1: y(-limit), y2: y(-limit) }));
  const lt = mk('text', { x: L + 2, y: y(-limit) - 5 }); lt.textContent = `Daily loss limit (${money(-limit)})`; svg.append(lt);
  svg.append(mk('polyline', { class: 'line', points: hist.map(p => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ') }));
  box.append(svg);
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

function renderToday(s) {
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
  renderProgress(s, n);
  updateStratStates(s);
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
  if (!p) { for (const k of ['t', 'c', 'd', 'f']) { $(k + 'Text').textContent = '\u2014'; setBar($(k + 'Bar'), 0); $(k + 'Sub').textContent = ''; } $('daysBox').replaceChildren(el('p', 'empty', a ? (s.watch && s.watch.error) || 'Loading\u2026' : 'No account picked.')); return; }

  $('tText').textContent = p.profitTarget > 0 ? `${money(p.netProfit)} of ${plain(p.profitTarget)}` : money(p.netProfit);
  setBar($('tBar'), p.targetPct, p.targetMet ? 'ok' : '');
  $('tSub').textContent = p.profitTarget <= 0 ? 'No target set. Add one with Edit rules.' : p.targetMet ? "You've reached it, and the consistency rule is met."
    : p.netProfit >= p.profitTarget ? "You've reached it, but one day is too big a share. A few more steady days will even it out." : `${plain(p.profitTarget - p.netProfit)} to go.`;
  if (!p.consistencyOn) { $('cText').textContent = 'Off'; setBar($('cBar'), 0); $('cSub').textContent = p.stage === 'practice' ? "Practice accounts don't use it." : 'Turn it on with Edit rules.'; }
  else {
    $('cText').textContent = `Best day ${plain(p.bestDay)} \u00b7 limit ${plain(p.consistencyLimit)}`;
    setBar($('cBar'), p.consistencyUsedPct, p.consistencyOk ? (p.consistencyUsedPct > 80 ? '' : 'ok') : 'bad');
    $('cSub').textContent = p.consistencyOk ? (p.consistencyUsedPct > 80 ? "You're within the rule, but close to the limit." : "You're within the rule.") : `Your best day is ${plain(p.bestDay - p.consistencyLimit)} over. More profit on other days brings it back in line.`;
  }
  if (p.dailyTarget > 0) { $('dText').textContent = `${money(p.todayPnl)} of ${plain(p.dailyTarget)}`; setBar($('dBar'), p.dailyPct, p.dailyHit ? 'ok' : ''); $('dSub').textContent = p.dailyHit ? (s.stats && s.stats.paused ? 'Reached. New trades are paused for the rest of the session.' : 'Reached. Nice work.') : `${plain(p.dailyTarget - p.todayPnl)} to go today.`; }
  else { $('dText').textContent = 'Off'; setBar($('dBar'), 0); $('dSub').textContent = 'Set a daily goal with Edit rules.'; }
  if (p.floor !== null) {
    $('fText').textContent = `${plain(p.cushion)} of room`;
    const room = info ? info.startBalance - p.floor : 0;
    setBar($('fBar'), room > 0 ? (p.cushion / (p.cushion + Math.max(0, room))) * 100 : 100, p.cushion < 500 ? 'bad' : 'ok');
    $('fSub').textContent = `Your balance can fall to $${p.floor.toLocaleString()} before you hit the max loss.`;
  } else { $('fText').textContent = '\u2014'; setBar($('fBar'), 0); $('fSub').textContent = "Set a max loss with Edit rules, or this connection doesn't share your balance yet."; }

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
$('editRules').onclick = () => { const a = selAcct(); if (a) openDrawer('edit', [a.id], $('editRules')); };

// ---------- accounts list ----------
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
    for (const h of ['Account', 'Type', 'Plan', 'Size', 'Drawdown', 'Max loss', 'Daily loss', 'Consistency', 'Target', 'Contracts', '']) hr.append(Object.assign(el('th', ['Size', 'Max loss', 'Daily loss', 'Consistency', 'Target', 'Contracts'].includes(h) ? 'r' : '', h), { scope: 'col' }));
    t.append(hr);
    for (const a of accts) {
      const r = el('tr'), name = el('td'), conn = cat.brokers.find(b => b.id === a.connection);
      const top = el('div', 'aname2'); top.append(document.createTextNode(a.label + ' '));
      if (a.id === store.selected) top.append(el('span', 'tag sel', 'In use'));
      name.append(top, el('div', 'asub', conn ? conn.name : a.connection));
      const caps = a.maxMini || a.maxMicro ? `${a.maxMini || '\u2014'} mini / ${a.maxMicro || '\u2014'} micro` : '\u2014';
      r.append(name, el('td', '', STAGE[a.stage][0]), el('td', '', a.plan || '\u2014'), el('td', 'r', a.size ? k$(a.size) : '\u2014'), el('td', '', DD[a.drawdown]),
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
  fillBtStrats();
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

// ---------- live chart ----------
let chartTf = 60, chartSym = '';
function chartSymbols(extra) {
  const list = [...new Set([...(savedRisk ? savedRisk.allowedSymbols : []), ...(extra || [])])];
  const sel = $('cSym'), keep = chartSym || list[0] || '';
  if ([...sel.options].map(o => o.value).join() !== list.join()) sel.replaceChildren(...list.map(x => new Option(x, x)));
  sel.value = keep; chartSym = sel.value;
}
$('cSym').onchange = () => { chartSym = $('cSym').value; drawLive(); };
document.querySelectorAll('#cTf button').forEach(b => { b.onclick = () => { chartTf = Number(b.dataset.tf); document.querySelectorAll('#cTf button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); drawLive(); }; });

async function drawLive() {
  if (!cat) return;
  chartSymbols();
  if (!chartSym) return;
  const d = await window.keel.chart(chartSym, chartTf); if (!d) return;
  chartSymbols(d.symbols);
  const box = $('cBox'), bars = d.bars;
  $('cLast').textContent = bars.length ? `${chartSym}  ${bars[bars.length - 1].c.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : chartSym;
  if (bars.length < 2) { box.replaceChildren(el('p', 'empty', 'Waiting for prices. Pick an account at the top or start the bot.')); $('cLegend').replaceChildren(); return; }
  const W = 900, H = 380, L = 8, R = 92, T = 12, B = 24, n = bars.length;
  const lv = d.trades.flatMap(t => [t.entry, t.tp, t.sl]).filter(v => typeof v === 'number');
  let lo = Math.min(...bars.map(b => b.l), ...lv), hi = Math.max(...bars.map(b => b.h), ...lv); const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const cw = (W - L - R) / n, x = i => L + i * cw + cw / 2, y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const NS = 'http://www.w3.org/2000/svg', mk = (nme, a) => { const e2 = document.createElementNS(NS, nme); for (const k in a) e2.setAttribute(k, a[k]); return e2; };
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${chartSym} price chart with open trade levels` });
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, yy = y(v); svg.append(mk('line', { class: 'grid', x1: L, x2: W - R, y1: yy, y2: yy })); const t = mk('text', { class: 'ax', x: W - R + 6, y: yy + 3 }); t.textContent = v.toFixed(2); svg.append(t); }
  bars.forEach((b, i) => {
    const up = b.c >= b.o, cls = up ? 'up' : 'dn';
    svg.append(mk('line', { class: 'wick ' + cls, x1: x(i), x2: x(i), y1: y(b.h), y2: y(b.l) }));
    const top = y(Math.max(b.o, b.c)), hgt = Math.max(1, Math.abs(y(b.o) - y(b.c)));
    svg.append(mk('rect', { class: cls, x: x(i) - Math.max(1, cw * 0.32), y: top, width: Math.max(2, cw * 0.64), height: hgt }));
  });
  for (const [lbl, anchor] of [[0, 'start'], [Math.floor(n / 2), 'middle'], [n - 1, 'end']]) { const t = mk('text', { class: 'ax', x: anchor === 'start' ? L : anchor === 'end' ? W - R : x(lbl), y: H - 6, 'text-anchor': anchor }); t.textContent = new Date(bars[lbl].t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); svg.append(t); }
  const tag = (v, cls, text, color) => {
    if (typeof v !== 'number') return;
    const yy = y(v); svg.append(mk('line', { class: 'lvl ' + cls, x1: L, x2: W - R, y1: yy, y2: yy }));
    const g = mk('g', { class: 'tag' }); g.append(mk('rect', { x: W - R + 2, y: yy - 8, width: R - 4, height: 16, fill: color }));
    const t = mk('text', { x: W - R + 6, y: yy + 3.5 }); t.textContent = text; g.append(t); svg.append(g);
  };
  const leg = $('cLegend'); leg.replaceChildren();
  for (const t of d.trades) {
    const dir = t.side === 'buy' ? 1 : -1, last = bars[n - 1].c;
    tag(t.entry, 'entry', `IN ${t.entry?.toFixed(2)}`, '#c8a24a'); tag(t.tp, 'tp', `TP ${t.tp?.toFixed(2)}`, '#6fd3b8'); tag(t.sl, 'sl', `SL ${t.sl?.toFixed(2)}`, '#ff7b70');
    const row = el('div', 'row2');
    row.append(el('strong', '', `${t.side === 'buy' ? 'Long' : 'Short'} ${t.qty} \u00b7 ${t.name}`));
    const part = (cls, label, v) => { const sp = el('span'); sp.append(el('span', 'dot ' + cls), document.createTextNode(`${label} ${typeof v === 'number' ? v.toFixed(2) : 'none'}`)); return sp; };
    row.append(part('e', 'Entry', t.entry), part('t', 'Target', t.tp), part('s', 'Stop', t.sl));
    if (typeof t.entry === 'number') row.append(el('span', (last - t.entry) * dir >= 0 ? 'pos' : 'neg', `${((last - t.entry) * dir >= 0 ? '+' : '\u2212')}${Math.abs(last - t.entry).toFixed(2)} pts`));
    leg.append(row);
  }
  if (!d.trades.length) leg.append(el('p', 'empty', 'No open trades on this market. Entry, target and stop lines show here when the bot opens one.'));
  box.replaceChildren(svg);
}

// ---------- backtest ----------
function fillBtStrats() {
  const sel = $('btStrat'), keep = sel.value;
  sel.replaceChildren(...strats.map(x => new Option(x.cfg.name + (x.cfg.type === 'tradingview' ? ' (alerts, not testable)' : ''), x.id)));
  if (keep && strats.some(x => x.id === keep)) sel.value = keep;
  $('btPretendWrap').hidden = !(cat && cat.dev);
}
async function runBt(useFile) {
  const id = $('btStrat').value; if (!id) { flash($('btMsg'), 'Add a strategy first.', true); return; }
  let csv = '';
  if (useFile) { const f = $('btFile').files[0]; if (!f) { flash($('btMsg'), 'Choose a price file first.', true); return; } if (f.size > 30e6) { flash($('btMsg'), 'That file is too big (30 MB max).', true); return; } csv = await f.text(); }
  $('btMsg').textContent = 'Running\u2026'; $('btRun').disabled = true;
  const r = await window.keel.backtest(id, csv, { slippageTicks: Number($('btSlip').value), feePerSide: Number($('btFee').value) });
  $('btRun').disabled = false;
  if (!r.ok) { flash($('btMsg'), r.error, true); return; }
  $('btMsg').textContent = '';
  const rep = r.report, days = Math.max(1, Math.round((rep.to - rep.from) / 86400000));
  $('btOut').hidden = false;
  const warn = [...(r.pretend ? ['These are pretend prices for trying the backtester. The results say nothing about real markets.'] : []), ...rep.notes];
  $('btWarn').hidden = !warn.length; $('btWarn').textContent = warn.join(' ');
  sign($('btNet'), rep.net); $('btNetSub').textContent = `${rep.tradeCount} trades over ${days} day${days === 1 ? '' : 's'}`;
  $('btWin').textContent = rep.tradeCount ? Math.round(rep.winRate) + '%' : '\u2014'; $('btWinSub').textContent = `${rep.wins} wins, ${rep.losses} losses`;
  $('btPf').textContent = rep.profitFactor === null ? '\u2014' : rep.profitFactor.toFixed(2); $('btPfSub').textContent = rep.avgR === null ? `Avg win ${cents(rep.avgWin)}, avg loss ${cents(rep.avgLoss)}` : `Average ${rep.avgR.toFixed(2)}R per trade`;
  $('btDd').textContent = cents(rep.maxDrawdown); $('btDdSub').textContent = `Best day ${money(rep.bestDay)}, worst ${money(rep.worstDay)}`;
  // equity line
  const box = $('btChart'); box.replaceChildren();
  const pts = rep.equity; if (pts.length > 1) {
    const W = 640, H = 200, L = 8, R = 8, T = 12, B = 14, v = pts.map(p => p[1]), lo = Math.min(0, ...v), hi = Math.max(0, ...v), sp = hi - lo || 1;
    const x = i => L + (i / (pts.length - 1)) * (W - L - R), y = val => T + (1 - (val - lo) / sp) * (H - T - B);
    const NS = 'http://www.w3.org/2000/svg', mk = (nme, a) => { const e2 = document.createElementNS(NS, nme); for (const k in a) e2.setAttribute(k, a[k]); return e2; };
    const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Equity after each trade' });
    svg.append(mk('line', { class: 'zero', x1: L, x2: W - R, y1: y(0), y2: y(0) }), mk('polyline', { class: 'line', points: pts.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ') }));
    box.append(svg);
  } else box.append(el('p', 'empty', 'No trades in this period.'));
  // trades
  const tb = $('btTrades'); tb.replaceChildren();
  if (rep.trades.length) {
    const t = el('table'), hr = el('tr');
    for (const h2 of ['Opened', 'Side', 'Qty', 'Entry', 'Exit', 'Points', 'R', 'Profit and loss']) hr.append(Object.assign(el('th', ['Qty', 'Entry', 'Exit', 'Points', 'R', 'Profit and loss'].includes(h2) ? 'r' : '', h2), { scope: 'col' }));
    t.append(hr);
    for (const x2 of rep.trades.slice().reverse()) {
      const r2 = el('tr'), c = el('td', 'r'); sign(c, x2.pnl);
      r2.append(el('td', '', new Date(x2.entryT).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), el('td', '', x2.side === 'long' ? 'Long' : 'Short'), el('td', 'r', String(x2.qty)),
        el('td', 'r', x2.entry.toFixed(2)), el('td', 'r', x2.exit.toFixed(2)), el('td', 'r', x2.points.toFixed(2)), el('td', 'r', x2.r === null ? '\u2014' : x2.r.toFixed(2)), c);
      t.append(r2);
    }
    tb.append(t);
    if (rep.tradeCount > rep.trades.length) tb.append(el('p', 'hint', `Showing the last ${rep.trades.length} of ${rep.tradeCount} trades.`));
  } else tb.append(el('p', 'empty', 'No trades.'));
}
$('btRun').onclick = () => runBt(true);
$('btPretend').onclick = () => runBt(false);

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
      const l = el('label', '', f.label), i = el('input'); i.id = `lg_${def.id}_${f.key}`; l.htmlFor = i.id;
      i.type = f.secret ? 'password' : 'text'; i.autocomplete = 'off'; i.spellcheck = false;
      if (saved) i.placeholder = f.secret ? 'Saved (hidden)' : 'Saved'; inputs[f.key] = i; card.append(l, i);
    }
    const msg = el('p', 'hint'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
    const save = el('button', '', saved ? 'Replace login' : 'Save login'), rm = el('button', 'ghost', 'Remove');
    rm.hidden = !saved;
    save.onclick = async () => {
      const creds = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
      const r = await window.keel.saveCreds(def.id, creds);
      if (r.ok) { if (!cat.saved.includes(def.id)) cat.saved.push(def.id); renderLogins(); notice('Login saved on this computer.', true); } else flash(msg, r.error, true);
    };
    rm.onclick = async () => { await window.keel.removeCreds(def.id); cat.saved = cat.saved.filter(x => x !== def.id); renderLogins(); notice('Login removed.', true); };
    const row = el('div', 'btns0'); row.append(save, rm); card.append(row, msg);
    box.append(card);
  }
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
    row.append(tcell, nm, el('td', '', `${m.symbol} → ${m.orderSymbol}`), el('td', '', alone(m.id)), el('td', '', now));
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

// ---------- Claude ----------
let aiData = null, aiFormDirty = false;
async function aiLoad() {
  aiData = await window.keel.aiGet(); if (!aiData) return;
  const c = aiData.cfg;
  if (!aiFormDirty) { $('aiPre').checked = c.autoPreflight; $('aiPause').checked = c.newsPause; $('aiPauseMin').value = c.pauseMin; $('aiCheck').value = c.entryCheck;
    $('aiNews').value = c.newsTrades; $('aiVetoErr').checked = c.vetoOnError; $('aiRev').checked = c.autoReview; }
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
    newsTrades: $('aiNews').value, vetoOnError: $('aiVetoErr').checked, autoReview: $('aiRev').checked };
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
  else { const r = await window.keel.start(); notice(r.ok ? '' : r.error); }
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
  if (view === 'chart') drawLive();
  if (view === 'k') kLoad();
  if (wasRunning !== s.running) { renderPicker(); renderAccounts(); }
}
const refresh = async () => render(await window.keel.status());

$('updateGo').onclick = async () => { const r = await window.keel.installUpdate(); if (r && !r.ok) notice(r.error); };

refresh();
