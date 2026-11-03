/**
 * Pine Script reader for Keel. It turns a script into a tree that src/pine/run.ts walks.
 * Nothing is ever handed to JavaScript to execute: unknown functions are refused with a clear message.
 * Covers the parts most TradingView strategies use. See SUPPORTED in run.ts.
 */
export type Node =
  | { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'bool'; v: boolean } | { k: 'na' }
  | { k: 'id'; name: string; line: number }
  | { k: 'bin'; op: string; a: Node; b: Node } | { k: 'un'; op: string; a: Node }
  | { k: 'tern'; c: Node; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[]; named: Record<string, Node>; id: number; line: number }
  | { k: 'idx'; name: string; off: Node; line: number };
export type Stmt =
  | { k: 'decl'; name: string; value: Node; persist: boolean; line: number }
  | { k: 'assign'; name: string; op: string; value: Node; line: number }
  | { k: 'if'; cond: Node; then: Stmt[]; else: Stmt[]; line: number }
  | { k: 'for'; v: string; from: Node; to: Node; by: Node | null; body: Stmt[]; line: number }
  | { k: 'fn'; name: string; params: string[]; body: Stmt[]; line: number }
  | { k: 'expr'; e: Node; line: number };

export class PineError extends Error { constructor(msg: string, public line: number) { super(line ? `Line ${line}: ${msg}` : msg); } }

type Tok = { t: 'num' | 'str' | 'id' | 'op'; v: string; line: number };
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'na', 'if', 'else', 'for', 'to', 'by', 'var', 'varip', 'while', 'switch', 'import', 'export', 'type', 'method']);
const TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'series', 'simple', 'const', 'label', 'line', 'box', 'table']);
const OPS = [':=', '+=', '-=', '*=', '/=', '==', '!=', '<=', '>=', '=>', '+', '-', '*', '/', '%', '<', '>', '=', '?', ':', '(', ')', '[', ']', ','];

function lex(text: string, line: number): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)/.exec(text.slice(i))!; out.push({ t: 'num', v: m[1], line }); i += m[1].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = ''; while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; s += text[j++]; }
      if (j >= text.length) throw new PineError('A text value is missing its closing quote.', line);
      out.push({ t: 'str', v: s, line }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_][\w.]*/.exec(text.slice(i))!; out.push({ t: 'id', v: m[0].replace(/\.$/, ''), line }); i += m[0].length; continue; }
    if (c === '#') { const m = /^#[0-9A-Fa-f]{6,8}/.exec(text.slice(i)); if (m) { out.push({ t: 'str', v: m[0], line }); i += m[0].length; continue; } }
    const op = OPS.find(o => text.startsWith(o, i));
    if (!op) throw new PineError(`Keel doesn't understand "${c}".`, line);
    out.push({ t: 'op', v: op, line }); i += op.length;
  }
  return out;
}

interface Ln { indent: number; toks: Tok[]; line: number }

function logicalLines(src: string): Ln[] {
  const raw = src.replace(/\r/g, '').split('\n'), out: Ln[] = [];
  let pending: Ln | null = null, depth = 0;
  raw.forEach((rawLine, idx) => {
    let s = '', q = '';
    for (let i = 0; i < rawLine.length; i++) {   // strip comments outside quotes
      const c = rawLine[i];
      if (q) { if (c === q) q = ''; s += c; continue; }
      if (c === '"' || c === "'") { q = c; s += c; continue; }
      if (c === '/' && rawLine[i + 1] === '/') break;
      s += c;
    }
    if (!s.trim()) return;
    const indent = (/^[ \t]*/.exec(s)![0]).replace(/\t/g, '    ').length;
    const toks = lex(s, idx + 1);
    if (pending) { pending.toks.push(...toks); }
    else pending = { indent, toks, line: idx + 1 };
    for (const t of toks) if (t.t === 'op') { if (t.v === '(' || t.v === '[') depth++; if (t.v === ')' || t.v === ']') depth--; }
    const last = pending.toks[pending.toks.length - 1];
    const continues = depth > 0 || (last.t === 'op' && [',', '+', '-', '*', '/', '?', ':', 'and', 'or', '==', '!=', '<', '>', '<=', '>=', '='].includes(last.v) && !(last.v === '=' && false))
      || (last.t === 'id' && (last.v === 'and' || last.v === 'or'));
    if (!continues) { out.push(pending); pending = null; depth = 0; }
  });
  const left = pending as Ln | null;   // set inside the loop above, which TypeScript can't follow
  if (left) throw new PineError('The script ends in the middle of a line.', left.line);
  return out;
}

let nextId = 1;

class P {
  private i = 0;
  constructor(private toks: Tok[], private line: number) {}
  peek(o = 0) { return this.toks[this.i + o]; }
  done() { return this.i >= this.toks.length; }
  is(v: string, o = 0) { const t = this.peek(o); return !!t && (t.t === 'op' || t.t === 'id') && t.v === v; }
  eat(v: string) { if (!this.is(v)) throw new PineError(`Expected "${v}".`, this.line); this.i++; }
  next() { const t = this.toks[this.i++]; if (!t) throw new PineError('This line ends too early.', this.line); return t; }

  expr(): Node { return this.ternary(); }
  ternary(): Node { const c = this.or(); if (this.is('?')) { this.i++; const a = this.expr(); this.eat(':'); const b = this.expr(); return { k: 'tern', c, a, b }; } return c; }
  or(): Node { let a = this.and(); while (this.is('or')) { this.i++; a = { k: 'bin', op: 'or', a, b: this.and() }; } return a; }
  and(): Node { let a = this.eq(); while (this.is('and')) { this.i++; a = { k: 'bin', op: 'and', a, b: this.eq() }; } return a; }
  eq(): Node { let a = this.cmp(); while (this.is('==') || this.is('!=')) { const op = this.next().v; a = { k: 'bin', op, a, b: this.cmp() }; } return a; }
  cmp(): Node { let a = this.add(); while (['<', '>', '<=', '>='].some(o => this.is(o))) { const op = this.next().v; a = { k: 'bin', op, a, b: this.add() }; } return a; }
  add(): Node { let a = this.mul(); while (this.is('+') || this.is('-')) { const op = this.next().v; a = { k: 'bin', op, a, b: this.mul() }; } return a; }
  mul(): Node { let a = this.unary(); while (this.is('*') || this.is('/') || this.is('%')) { const op = this.next().v; a = { k: 'bin', op, a, b: this.unary() }; } return a; }
  unary(): Node { if (this.is('-') || this.is('+') || this.is('not')) { const op = this.next().v; return { k: 'un', op, a: this.unary() }; } return this.postfix(); }
  postfix(): Node {
    let n = this.primary();
    while (this.is('[')) {
      if (n.k !== 'id') throw new PineError('Keel can only look back on named values, like close[1] or myValue[2].', this.line);
      this.i++; const off = this.expr(); this.eat(']'); n = { k: 'idx', name: n.name, off, line: this.line };
    }
    return n;
  }
  primary(): Node {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'op' && t.v === '(') { const e = this.expr(); this.eat(')'); return e; }
    if (t.t === 'op' && t.v === '[') throw new PineError('Lists like [a, b] are not supported yet.', this.line);
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
      if (t.v === 'na' && !this.is('(')) return { k: 'na' };
      if (t.v === 'if' || t.v === 'switch') throw new PineError(`"${t.v}" as a value is not supported yet. Use the ? : form instead.`, this.line);
      if (this.is('(')) {
        this.i++; const args: Node[] = [], named: Record<string, Node> = {};
        while (!this.is(')')) {
          if (this.peek()?.t === 'id' && this.is('=', 1)) { const key = this.next().v; this.i++; named[key] = this.expr(); }
          else args.push(this.expr());
          if (!this.is(')')) this.eat(',');
        }
        this.eat(')');
        return { k: 'call', fn: t.v, args, named, id: nextId++, line: this.line };
      }
      return { k: 'id', name: t.v, line: this.line };
    }
    throw new PineError(`Didn't expect "${t.v}" here.`, this.line);
  }
}

export interface Program { stmts: Stmt[]; title: string; kind: 'strategy' | 'indicator' | 'none'; version: number }

export function parsePine(src: string): Program {
  if (src.length > 20000) throw new PineError('That script is too long (20,000 characters max).', 0);
  const version = Number((/\/\/\s*@version\s*=\s*(\d+)/.exec(src) || [])[1] || 0);
  const lines = logicalLines(src);
  let pos = 0, title = '', kind: Program['kind'] = 'none';

  const block = (indent: number): Stmt[] => {
    const out: Stmt[] = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      if (lines[pos].indent > indent) throw new PineError('This line is indented more than expected.', lines[pos].line);
      out.push(stmt(indent));
    }
    return out;
  };
  const child = (parentIndent: number, line: number): Stmt[] => {
    if (pos >= lines.length || lines[pos].indent <= parentIndent) throw new PineError('This block is empty. Indent the lines that belong to it.', line);
    return block(lines[pos].indent);
  };

  const stmt = (indent: number): Stmt => {
    const L = lines[pos++], p = new P(L.toks, L.line), line = L.line;
    const first = L.toks[0];
    if (first.t === 'id' && first.v === 'if') {
      p.next(); const cond = p.expr(); if (!p.done()) throw new PineError('Unexpected text after the if condition.', line);
      const then = child(indent, line); let els: Stmt[] = [];
      if (pos < lines.length && lines[pos].indent === indent && lines[pos].toks[0].v === 'else') {
        const E = lines[pos];
        if (E.toks[1]?.v === 'if') { lines[pos] = { ...E, toks: E.toks.slice(1) }; els = [stmt(indent)]; }
        else { if (E.toks.length > 1) throw new PineError('Put the else block on the next lines.', E.line); pos++; els = child(indent, E.line); }
      }
      return { k: 'if', cond, then, else: els, line };
    }
    if (first.t === 'id' && first.v === 'for') {
      p.next(); const v = p.next(); if (v.t !== 'id') throw new PineError('A for loop needs a counter name.', line);
      p.eat('='); const from = p.expr(); p.eat('to'); const to = p.expr(); let by: Node | null = null; if (p.is('by')) { p.next(); by = p.expr(); }
      return { k: 'for', v: v.v, from, to, by, body: child(indent, line), line };
    }
    if (first.t === 'id' && ['while', 'switch', 'import', 'export', 'type', 'method'].includes(first.v)) throw new PineError(`"${first.v}" is not supported yet.`, line);
    if (first.t === 'op' && first.v === '[') throw new PineError('Results like [a, b] = ... are not supported yet.', line);
    // function definition: name(params) =>
    const arrow = L.toks.findIndex(t => t.t === 'op' && t.v === '=>');
    if (first.t === 'id' && L.toks[1]?.v === '(' && arrow > 0) {
      const params = L.toks.slice(2, arrow - 1).filter(t => t.t === 'id').map(t => t.v);
      const rest = L.toks.slice(arrow + 1);
      if (rest.length) { const q = new P(rest, line); const e = q.expr(); return { k: 'fn', name: first.v, params, body: [{ k: 'expr', e, line }], line }; }
      return { k: 'fn', name: first.v, params, body: child(indent, line), line };
    }
    // declarations and assignments
    let j = 0, persist = false;
    if (L.toks[j]?.v === 'var' || L.toks[j]?.v === 'varip') { persist = true; j++; }
    while (L.toks[j]?.t === 'id' && TYPES.has(L.toks[j].v) && L.toks[j + 1]?.t === 'id' && !KEYWORDS.has(L.toks[j + 1].v)) j++;
    const nameTok = L.toks[j], opTok = L.toks[j + 1];
    if (nameTok?.t === 'id' && opTok?.t === 'op' && ['=', ':=', '+=', '-=', '*=', '/='].includes(opTok.v) && !KEYWORDS.has(nameTok.v)) {
      const q = new P(L.toks.slice(j + 2), line); const value = q.expr();
      if (!q.done()) throw new PineError('Unexpected text at the end of the line.', line);
      if (opTok.v === '=') return { k: 'decl', name: nameTok.v, value, persist, line };
      return { k: 'assign', name: nameTok.v, op: opTok.v, value, line };
    }
    const e = p.expr();
    if (!p.done()) throw new PineError('Unexpected text at the end of the line.', line);
    if (e.k === 'call' && (e.fn === 'strategy' || e.fn === 'indicator' || e.fn === 'study')) {
      kind = e.fn === 'strategy' ? 'strategy' : 'indicator';
      const t = e.args[0] ?? e.named.title; if (t && t.k === 'str') title = t.v.slice(0, 60);
    }
    return { k: 'expr', e, line };
  };

  const stmts = block(lines.length ? lines[0].indent : 0);
  return { stmts, title, kind, version };
}
