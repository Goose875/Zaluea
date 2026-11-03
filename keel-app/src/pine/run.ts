import { Node, Program, Stmt, PineError, parsePine } from './parse';

export interface Bar { t: number; o: number; h: number; l: number; c: number }
export type Intent = { k: 'entry'; dir: 'long' | 'short' } | { k: 'close'; was?: number };

const TA = ['ta.sma', 'ta.ema', 'ta.rma', 'ta.wma', 'ta.rsi', 'ta.highest', 'ta.lowest', 'ta.crossover', 'ta.crossunder', 'ta.cross', 'ta.change',
  'ta.atr', 'ta.tr', 'ta.stdev', 'ta.mom', 'ta.roc', 'ta.barssince'];
const MATH = ['math.abs', 'math.max', 'math.min', 'math.round', 'math.floor', 'math.ceil', 'math.sqrt', 'math.pow', 'math.log', 'math.exp', 'math.sign', 'math.avg'];
const STRAT = ['strategy.entry', 'strategy.close', 'strategy.close_all', 'strategy.exit', 'strategy.cancel', 'strategy.cancel_all'];
const INPUT = ['input', 'input.int', 'input.float', 'input.bool', 'input.string', 'input.source', 'input.timeframe', 'input.session', 'input.color', 'input.symbol', 'input.price'];
const IGNORED = ['plot', 'plotshape', 'plotchar', 'plotarrow', 'plotcandle', 'plotbar', 'hline', 'fill', 'bgcolor', 'barcolor', 'alertcondition', 'alert', 'label.new', 'line.new', 'box.new',
  'label.delete', 'line.delete', 'box.delete', 'color.new', 'color.rgb', 'strategy', 'indicator', 'study', 'log.info', 'log.warning', 'log.error', 'runtime.error'];
const MISC = ['na', 'nz', 'fixnan', 'str.tostring', 'int', 'float', 'bool', 'timestamp', 'hour', 'minute', 'dayofweek'];
// v4 names without the namespace still work
const ALIAS: Record<string, string> = { sma: 'ta.sma', ema: 'ta.ema', rma: 'ta.rma', wma: 'ta.wma', rsi: 'ta.rsi', highest: 'ta.highest', lowest: 'ta.lowest', crossover: 'ta.crossover',
  crossunder: 'ta.crossunder', cross: 'ta.cross', change: 'ta.change', atr: 'ta.atr', stdev: 'ta.stdev', mom: 'ta.mom', roc: 'ta.roc', barssince: 'ta.barssince',
  abs: 'math.abs', max: 'math.max', min: 'math.min', round: 'math.round', floor: 'math.floor', ceil: 'math.ceil', sqrt: 'math.sqrt', pow: 'math.pow', log: 'math.log', exp: 'math.exp', sign: 'math.sign', avg: 'math.avg',
  tostring: 'str.tostring', study: 'indicator' };
export const SUPPORTED = new Set([...TA, ...MATH, ...STRAT, ...INPUT, ...IGNORED, ...MISC]);
const SERIES = new Set(['open', 'high', 'low', 'close', 'volume', 'time', 'bar_index', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']);
const CONSTS = new Set(['strategy.long', 'strategy.short', 'barstate.isconfirmed', 'barstate.isrealtime', 'barstate.islast', 'barstate.isnew', 'barstate.isfirst',
  'syminfo.mintick', 'syminfo.ticker', 'syminfo.tickerid', 'timeframe.period', 'strategy.position_size', 'strategy.position_avg_price', 'strategy.opentrades']);
const fnName = (f: string) => ALIAS[f] ?? f;

export interface Checked { ok: true; program: Program; title: string; warnings: string[] }

/** Parses and checks a script once, so problems show before it is ever switched on. */
export function checkPine(src: string): Checked | { ok: false; error: string } {
  let program: Program;
  try { program = parsePine(src); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const userFns = new Set<string>(), problems: string[] = [], warn = new Set<string>();
  const walkS = (ss: Stmt[]) => ss.forEach(s => {
    if (s.k === 'fn') { userFns.add(s.name); walkS(s.body); }
    else if (s.k === 'if') { walkN(s.cond); walkS(s.then); walkS(s.else); }
    else if (s.k === 'for') { walkN(s.from); walkN(s.to); if (s.by) walkN(s.by); walkS(s.body); }
    else if (s.k === 'expr') walkN(s.e); else walkN(s.value);
  });
  const walkN = (n: Node): void => {
    if (n.k === 'call') {
      const f = fnName(n.fn);
      if (!SUPPORTED.has(f) && !userFns.has(n.fn)) problems.push(`Line ${n.line}: ${n.fn}() is not supported yet.`);
      if (f === 'strategy.exit' && Object.keys(n.named).some(k => k.startsWith('trail'))) problems.push(`Line ${n.line}: trailing stops in strategy.exit are not supported yet.`);
      if ((f === 'strategy.entry') && (n.named.limit || n.named.stop || n.args[3] || n.args[4])) warn.add('Limit and stop entry prices are treated as market orders.');
      if (f === 'strategy.entry' && (n.named.qty || n.args[2])) warn.add("Order sizes in the script are ignored. Keel uses the contracts setting you choose.");
      n.args.forEach(walkN); Object.values(n.named).forEach(walkN);
    } else if (n.k === 'bin') { walkN(n.a); walkN(n.b); } else if (n.k === 'un') walkN(n.a);
    else if (n.k === 'tern') { walkN(n.c); walkN(n.a); walkN(n.b); } else if (n.k === 'idx') walkN(n.off);
    else if (n.k === 'id' && n.name.includes('.') && !CONSTS.has(n.name) && !n.name.startsWith('color.') && !n.name.startsWith('shape.') && !n.name.startsWith('location.')
      && !n.name.startsWith('size.') && !n.name.startsWith('plot.') && !n.name.startsWith('display.') && !n.name.startsWith('position.') && !n.name.startsWith('format.') && !n.name.startsWith('alert.'))
      problems.push(`Line ${n.line}: ${n.name} is not supported yet.`);
  };
  walkS(program.stmts);
  if (problems.length) return { ok: false, error: problems.slice(0, 3).join(' ') + (problems.length > 3 ? ` (and ${problems.length - 3} more)` : '') };
  if (program.kind !== 'strategy') return { ok: false, error: "This looks like an indicator, not a strategy. Keel needs strategy.entry() calls to know when to trade. Use \u201cFollow my TradingView alerts\u201d for indicators." };
  if (!JSON.stringify(program.stmts).includes('"strategy.entry"')) return { ok: false, error: 'This strategy never calls strategy.entry(), so it would never trade.' };
  warn.add("Bars are built from live prices, so trades can differ from TradingView's backtest.");
  return { ok: true, program, title: program.title || 'Pine strategy', warnings: [...warn] };
}

const isNa = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN);
const truthy = (v: unknown) => !isNa(v) && !!v;

/** Runs a checked program bar by bar. Every step is counted, so a runaway script stops instead of freezing the app. */
export class PineRunner {
  private bars: Bar[] = [];
  private hist = new Map<string, unknown[]>();
  private persist = new Map<string, unknown>();
  private state = new Map<string, any>();
  private fns = new Map<string, Extract<Stmt, { k: 'fn' }>>();
  private steps = 0; private path = '';
  private frames: Map<string, unknown[]>[] = [];   // history of function arguments, per call site
  pos = 0; entryPrice = NaN; exitTp = NaN; exitSl = NaN;
  constructor(private prog: Program, private opts: { symbol: string; mintick: number; timeframe: string }) {
    for (const s of prog.stmts) if (s.k === 'fn') this.fns.set(s.name, s);
  }

  /** Feed one closed bar. Returns what the script asked for on that bar. */
  onBar(bar: Bar): Intent[] {
    this.bars.push(bar); if (this.bars.length > 2000) this.bars.shift();
    this.steps = 0;
    const scope = new Map<string, unknown>(), intents: Intent[] = [], exits: { tp: number; sl: number }[] = [];
    this.run(this.prog.stmts, [scope], intents, exits);
    for (const [k, v] of scope) { const h = this.hist.get(k) ?? []; h.push(v); if (h.length > 2000) h.shift(); this.hist.set(k, h); }
    for (const [k, v] of this.persist) { if (scope.has(k)) continue; const h = this.hist.get(k) ?? []; h.push(v); if (h.length > 2000) h.shift(); this.hist.set(k, h); }
    // apply the script's orders at this bar's close
    const out: Intent[] = [];
    for (const it of intents) {
      if (it.k === 'close') { if (this.pos !== 0) { out.push({ k: 'close', was: this.pos }); this.pos = 0; this.exitTp = this.exitSl = NaN; } continue; }
      const want = it.dir === 'long' ? 1 : -1;
      if (this.pos === want) continue;
      if (this.pos !== 0) out.push({ k: 'close', was: this.pos });
      out.push(it); this.pos = want; this.entryPrice = bar.c; this.exitTp = this.exitSl = NaN;
    }
    const ex = exits[exits.length - 1];
    if (ex && this.pos !== 0) { this.exitTp = ex.tp; this.exitSl = ex.sl; }
    return out;
  }

  /** Checks strategy.exit levels against a live price between bars. */
  exitHit(price: number): boolean {
    if (this.pos === 0) return false;
    const hit = this.pos > 0 ? (price >= this.exitTp || price <= this.exitSl) : (price <= this.exitTp || price >= this.exitSl);
    if (hit) { this.pos = 0; this.exitTp = this.exitSl = NaN; }
    return hit;
  }

  reset() { this.pos = 0; this.exitTp = this.exitSl = NaN; }

  private tick(line: number) { if (++this.steps > 200_000) throw new PineError('The script took too long on one bar, so it was stopped.', line); }

  private lookup(name: string, scopes: Map<string, unknown>[]): unknown {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name);
    if (this.persist.has(name)) return this.persist.get(name);
    const b = this.bars[this.bars.length - 1];
    switch (name) {
      case 'open': return b.o; case 'high': return b.h; case 'low': return b.l; case 'close': return b.c; case 'volume': return 0; case 'time': return b.t;
      case 'bar_index': return this.bars.length - 1; case 'hl2': return (b.h + b.l) / 2; case 'hlc3': return (b.h + b.l + b.c) / 3;
      case 'ohlc4': return (b.o + b.h + b.l + b.c) / 4; case 'hlcc4': return (b.h + b.l + 2 * b.c) / 4;
      case 'strategy.long': return 'long'; case 'strategy.short': return 'short';
      case 'barstate.isconfirmed': case 'barstate.isnew': return true; case 'barstate.isrealtime': return true; case 'barstate.islast': return false; case 'barstate.isfirst': return this.bars.length === 1;
      case 'syminfo.mintick': return this.opts.mintick; case 'syminfo.ticker': case 'syminfo.tickerid': return this.opts.symbol; case 'timeframe.period': return this.opts.timeframe;
      case 'strategy.position_size': return this.pos; case 'strategy.position_avg_price': return this.pos ? this.entryPrice : NaN; case 'strategy.opentrades': return this.pos ? 1 : 0;
    }
    if (/^(color|shape|location|size|plot|display|position|format|alert)\./.test(name)) return null;
    throw new PineError(`"${name}" is used before it has a value.`, 0);
  }

  private past(name: string, n: number): unknown {
    if (!Number.isInteger(n) || n < 0) return NaN;
    if (SERIES.has(name)) {
      const b = this.bars[this.bars.length - 1 - n]; if (!b) return NaN;
      switch (name) { case 'open': return b.o; case 'high': return b.h; case 'low': return b.l; case 'close': return b.c; case 'time': return b.t;
        case 'hl2': return (b.h + b.l) / 2; case 'hlc3': return (b.h + b.l + b.c) / 3; case 'ohlc4': return (b.o + b.h + b.l + b.c) / 4; default: return NaN; }
    }
    const h = this.hist.get(name); if (!h) return NaN;
    const v = h[h.length - n]; return v === undefined ? NaN : v;
  }

  private run(ss: Stmt[], scopes: Map<string, unknown>[], intents: Intent[], exits: { tp: number; sl: number }[]): unknown {
    let last: unknown = NaN;
    for (const s of ss) {
      this.tick(s.line);
      switch (s.k) {
        case 'fn': break;
        case 'decl':
          if (s.persist) { if (!this.persist.has(s.name)) this.persist.set(s.name, this.ev(s.value, scopes, intents, exits)); }
          else scopes[scopes.length - 1].set(s.name, this.ev(s.value, scopes, intents, exits));
          break;
        case 'assign': {
          const cur = this.lookup(s.name, scopes), v = this.ev(s.value, scopes, intents, exits);
          const nv = s.op === ':=' ? v : s.op === '+=' ? num(cur) + num(v) : s.op === '-=' ? num(cur) - num(v) : s.op === '*=' ? num(cur) * num(v) : num(cur) / num(v);
          let set = false;
          for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(s.name)) { scopes[i].set(s.name, nv); set = true; break; }
          if (!set) { if (this.persist.has(s.name)) this.persist.set(s.name, nv); else throw new PineError(`"${s.name}" must be declared with = before using :=.`, s.line); }
          break;
        }
        case 'if': {
          const inner = new Map<string, unknown>();
          last = truthy(this.ev(s.cond, scopes, intents, exits)) ? this.run(s.then, [...scopes, inner], intents, exits) : this.run(s.else, [...scopes, inner], intents, exits);
          break;
        }
        case 'for': {
          const from = num(this.ev(s.from, scopes, intents, exits)), to = num(this.ev(s.to, scopes, intents, exits));
          const by = s.by ? Math.abs(num(this.ev(s.by, scopes, intents, exits))) : 1;
          if (!Number.isFinite(from) || !Number.isFinite(to) || !(by > 0)) break;
          let count = 0;
          for (let i = from; from <= to ? i <= to : i >= to; i += from <= to ? by : -by) {
            if (++count > 5000) throw new PineError('A for loop ran more than 5,000 times on one bar, so it was stopped.', s.line);
            this.run(s.body, [...scopes, new Map([[s.v, i]])], intents, exits);
          }
          break;
        }
        case 'expr': last = this.ev(s.e, scopes, intents, exits); break;
      }
    }
    return last;
  }

  private ev(n: Node, scopes: Map<string, unknown>[], intents: Intent[], exits: { tp: number; sl: number }[]): unknown {
    this.tick((n as any).line ?? 0);
    switch (n.k) {
      case 'num': return n.v; case 'str': return n.v; case 'bool': return n.v; case 'na': return NaN;
      case 'id': return this.lookup(n.name, scopes);
      case 'idx': {
        const off = num(this.ev(n.off, scopes, intents, exits));
        const frame = this.frames[this.frames.length - 1];
        if (frame && frame.has(n.name)) { const h = frame.get(n.name)!; const v = Number.isInteger(off) && off >= 0 ? h[h.length - 1 - off] : undefined; return v === undefined ? NaN : v; }
        if (off === 0) return this.lookup(n.name, scopes);
        return this.past(n.name, off);
      }
      case 'un': { const a = this.ev(n.a, scopes, intents, exits); return n.op === 'not' ? !truthy(a) : n.op === '-' ? -num(a) : num(a); }
      case 'tern': return truthy(this.ev(n.c, scopes, intents, exits)) ? this.ev(n.a, scopes, intents, exits) : this.ev(n.b, scopes, intents, exits);
      case 'bin': {
        if (n.op === 'and') return truthy(this.ev(n.a, scopes, intents, exits)) && truthy(this.ev(n.b, scopes, intents, exits));
        if (n.op === 'or') return truthy(this.ev(n.a, scopes, intents, exits)) || truthy(this.ev(n.b, scopes, intents, exits));
        const a = this.ev(n.a, scopes, intents, exits), b = this.ev(n.b, scopes, intents, exits);
        if (n.op === '+' && (typeof a === 'string' || typeof b === 'string')) return String(a) + String(b);
        if (n.op === '==') return typeof a === 'string' || typeof b === 'string' ? a === b : num(a) === num(b);
        if (n.op === '!=') return typeof a === 'string' || typeof b === 'string' ? a !== b : num(a) !== num(b);
        const x = num(a), y = num(b);
        switch (n.op) { case '+': return x + y; case '-': return x - y; case '*': return x * y; case '/': return y === 0 ? NaN : x / y; case '%': return x % y;
          case '<': return x < y; case '>': return x > y; case '<=': return x <= y; case '>=': return x >= y; }
        return NaN;
      }
      case 'call': return this.call(n, scopes, intents, exits);
    }
  }

  private call(n: Extract<Node, { k: 'call' }>, scopes: Map<string, unknown>[], intents: Intent[], exits: { tp: number; sl: number }[]): unknown {
    const f = fnName(n.fn);
    const A = (i: number, key?: string) => { const node = (key && n.named[key]) || n.args[i]; return node ? this.ev(node, scopes, intents, exits) : undefined; };
    const key = n.id + this.path;
    const st = <T>(init: () => T): T => { if (!this.state.has(key)) this.state.set(key, init()); return this.state.get(key); };
    const len = (i: number, k = 'length') => { const v = Math.round(num(A(i, k))); if (!(v >= 1 && v <= 2000)) throw new PineError(`${n.fn}() needs a length from 1 to 2,000.`, n.line); return v; };
    const window = (src: number, L: number) => { const w = st<number[]>(() => []); w.push(src); if (w.length > L) w.shift(); return w; };
    const seeded = (src: number, L: number, alpha: number) => {
      const s = st(() => ({ seed: [] as number[], v: NaN }));
      if (isNa(src)) return s.v;
      if (Number.isNaN(s.v)) { s.seed.push(src); if (s.seed.length >= L) s.v = s.seed.reduce((a, b) => a + b, 0) / L; return s.v; }
      s.v = alpha * src + (1 - alpha) * s.v; return s.v;
    };
    const user = this.fns.get(n.fn);
    if (user) {
      if (this.path.split('/').length > 30) throw new PineError('Functions call each other too deeply.', n.line);
      const local = new Map<string, unknown>(), frame = new Map<string, unknown[]>();
      user.params.forEach((p, i) => {
        const v = A(i); local.set(p, v);
        const h = st<Record<string, unknown[]>>(() => ({}));   // this call site's argument history
        (h[p] ??= []).push(v); if (h[p].length > 2000) h[p].shift(); frame.set(p, h[p]);
      });
      const saved = this.path; this.path += '/' + n.id; this.frames.push(frame);
      try { return this.run(user.body, [scopes[0], local], intents, exits); } finally { this.path = saved; this.frames.pop(); }
    }
    switch (f) {
      case 'ta.sma': { const L = len(1); const w = window(num(A(0, 'source')), L); return w.length < L || w.some(isNa) ? NaN : w.reduce((a, b) => a + b, 0) / L; }
      case 'ta.ema': { const L = len(1); return seeded(num(A(0, 'source')), L, 2 / (L + 1)); }
      case 'ta.rma': { const L = len(1); return seeded(num(A(0, 'source')), L, 1 / L); }
      case 'ta.wma': { const L = len(1); const w = window(num(A(0, 'source')), L); if (w.length < L) return NaN; let s = 0; w.forEach((v, i) => { s += v * (i + 1); }); return s / ((L * (L + 1)) / 2); }
      case 'ta.rsi': {
        const L = len(1), src = num(A(0, 'source')), s = st(() => ({ prev: NaN, up: { seed: [] as number[], v: NaN }, dn: { seed: [] as number[], v: NaN } }));
        const ch = src - s.prev; s.prev = src; if (Number.isNaN(ch)) return NaN;
        const upd = (r: { seed: number[]; v: number }, x: number) => { if (Number.isNaN(r.v)) { r.seed.push(x); if (r.seed.length >= L) r.v = r.seed.reduce((a, b) => a + b, 0) / L; } else r.v = (x + (L - 1) * r.v) / L; return r.v; };
        const up = upd(s.up, Math.max(ch, 0)), dn = upd(s.dn, -Math.min(ch, 0));
        if (Number.isNaN(up) || Number.isNaN(dn)) return NaN;
        return dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
      }
      case 'ta.highest': case 'ta.lowest': {
        const one = n.args.length === 1 && !n.named.source;
        const L = one ? len(0) : len(1), b = this.bars[this.bars.length - 1];
        const src = one ? (f === 'ta.highest' ? b.h : b.l) : num(A(0, 'source'));
        const w = window(src, L); if (w.length < L) return NaN;
        return f === 'ta.highest' ? Math.max(...w) : Math.min(...w);
      }
      case 'ta.crossover': case 'ta.crossunder': case 'ta.cross': {
        const a = num(A(0)), b = num(A(1)), s = st(() => ({ a: NaN, b: NaN }));
        const up = s.a <= s.b && a > b, down = s.a >= s.b && a < b; s.a = a; s.b = b;
        return f === 'ta.crossover' ? up : f === 'ta.crossunder' ? down : up || down;
      }
      case 'ta.change': case 'ta.mom': case 'ta.roc': {
        const L = n.args[1] || n.named.length ? len(1) : 1, w = window(num(A(0, 'source')), L + 1);
        if (w.length < L + 1) return NaN; const d = w[w.length - 1] - w[0];
        return f === 'ta.roc' ? (w[0] === 0 ? NaN : (100 * d) / w[0]) : d;
      }
      case 'ta.tr': case 'ta.atr': {
        const b = this.bars[this.bars.length - 1], p = this.bars[this.bars.length - 2];
        const tr = p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l;
        if (f === 'ta.tr') return tr; const L = len(0); return seeded(tr, L, 1 / L);
      }
      case 'ta.stdev': { const L = len(1); const w = window(num(A(0, 'source')), L); if (w.length < L) return NaN; const m = w.reduce((a, b) => a + b, 0) / L; return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / L); }
      case 'ta.barssince': { const s = st(() => ({ n: NaN })); if (truthy(A(0))) s.n = 0; else if (!Number.isNaN(s.n)) s.n++; return s.n; }

      case 'math.abs': return Math.abs(num(A(0))); case 'math.round': return Math.round(num(A(0))); case 'math.floor': return Math.floor(num(A(0)));
      case 'math.ceil': return Math.ceil(num(A(0))); case 'math.sqrt': return Math.sqrt(num(A(0))); case 'math.pow': return Math.pow(num(A(0)), num(A(1)));
      case 'math.log': return Math.log(num(A(0))); case 'math.exp': return Math.exp(num(A(0))); case 'math.sign': return Math.sign(num(A(0)));
      case 'math.max': return Math.max(...n.args.map(a => num(this.ev(a, scopes, intents, exits))));
      case 'math.min': return Math.min(...n.args.map(a => num(this.ev(a, scopes, intents, exits))));
      case 'math.avg': { const v = n.args.map(a => num(this.ev(a, scopes, intents, exits))); return v.reduce((a, b) => a + b, 0) / v.length; }

      case 'na': return isNa(A(0)); case 'nz': { const v = A(0); return isNa(v) ? (n.args[1] ? A(1) : 0) : v; }
      case 'fixnan': { const s = st(() => ({ v: NaN })); const v = A(0); if (!isNa(v)) s.v = num(v); return s.v; }
      case 'int': return Math.trunc(num(A(0))); case 'float': return num(A(0)); case 'bool': return truthy(A(0)); case 'str.tostring': return String(A(0));
      case 'hour': return new Date(this.bars[this.bars.length - 1].t).getHours(); case 'minute': return new Date(this.bars[this.bars.length - 1].t).getMinutes();
      case 'dayofweek': return new Date(this.bars[this.bars.length - 1].t).getDay() + 1; case 'timestamp': return NaN;

      case 'input': case 'input.int': case 'input.float': case 'input.bool': case 'input.string': case 'input.source': case 'input.timeframe':
      case 'input.session': case 'input.color': case 'input.symbol': case 'input.price': return A(0, 'defval');

      case 'strategy.entry': {
        const when = n.named.when; if (when && !truthy(this.ev(when, scopes, intents, exits))) return null;
        const dir = A(1, 'direction'); if (dir !== 'long' && dir !== 'short') throw new PineError('strategy.entry() needs strategy.long or strategy.short.', n.line);
        intents.push({ k: 'entry', dir }); return null;
      }
      case 'strategy.close': case 'strategy.close_all': {
        const when = n.named.when; if (when && !truthy(this.ev(when, scopes, intents, exits))) return null;
        intents.push({ k: 'close' }); return null;
      }
      case 'strategy.exit': {
        const when = n.named.when; if (when && !truthy(this.ev(when, scopes, intents, exits))) return null;
        const pending = intents.filter(i => i.k === 'entry').pop() as Extract<Intent, { k: 'entry' }> | undefined;
        const dir = pending ? (pending.dir === 'long' ? 1 : -1) : this.pos;
        const base = pending ? this.bars[this.bars.length - 1].c : this.entryPrice;
        const ticks = (k: string) => { const v = num(n.named[k] ? this.ev(n.named[k], scopes, intents, exits) : NaN); return v * this.opts.mintick; };
        const price = (k: string) => num(n.named[k] ? this.ev(n.named[k], scopes, intents, exits) : NaN);
        let tp = price('limit'), sl = price('stop');
        if (Number.isNaN(tp) && !Number.isNaN(ticks('profit'))) tp = base + dir * ticks('profit');
        if (Number.isNaN(sl) && !Number.isNaN(ticks('loss'))) sl = base - dir * ticks('loss');
        exits.push({ tp, sl }); return null;
      }
      case 'strategy.cancel': case 'strategy.cancel_all': return null;
    }
    if (IGNORED.includes(f) || f.startsWith('color.')) return null;
    throw new PineError(`${n.fn}() is not supported yet.`, n.line);
  }
}

export const TICK: Record<string, number> = { ES: 0.25, MES: 0.25, NQ: 0.25, MNQ: 0.25, YM: 1, MYM: 1, RTY: 0.1, M2K: 0.1, CL: 0.01, MCL: 0.01, GC: 0.1, MGC: 0.1, SI: 0.005, NG: 0.001 };
export { parsePine };
