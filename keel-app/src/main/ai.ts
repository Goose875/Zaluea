/**
 * Claude inside Keel (main process only: the API key never reaches the window).
 *  - Morning pre-flight: today's US economic calendar (web search) -> high-impact windows.
 *  - News pause: no new entries within N minutes of a high-impact release (if allowed).
 *  - Entry check: Claude reviews each entry and can veto it (paper only unless you allow live).
 *  - News trade: a few minutes after a high-impact release Claude may take ONE trade (paper only unless you allow live),
 *    with hard limits: 1 per day, your risk per trade, stop 'at the broker', same daily loss limit and flat-by.
 *  - Daily review + why each loser lost, and an "Ask Keel" chat. Both read-only.
 * Model: Claude Opus 5.5 with the API's server-side refusal fallback switched on.
 */
import Anthropic from '@anthropic-ai/sdk';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { vault } from './vault';
import { wallOf } from '../ksys/time';

const MODEL = 'claude-opus-5-5';
const BETAS = ['server-side-fallback-2026-07-01'];
const file = (n: string) => path.join(app.getPath('userData'), n);

export type Gate = 'off' | 'paper' | 'live';
export interface AIConfig { autoPreflight: boolean; autoReview: boolean; newsPause: boolean; pauseMin: number; entryCheck: Gate; newsTrades: Gate; vetoOnError: boolean }
export const DEFAULT_AI: AIConfig = { autoPreflight: true, autoReview: true, newsPause: true, pauseMin: 5, entryCheck: 'paper', newsTrades: 'paper', vetoOnError: false };
export interface NewsEvent { time: string; name: string; impact: 'high' | 'medium' | 'low'; forecast?: string; previous?: string }
export interface Preflight { date: string; at: number; summary: string; events: NewsEvent[] }
interface State { preflight: Preflight | null; review: { date: string; at: number; text: string } | null; newsTradeDay: string; chat: { role: 'user' | 'assistant'; text: string }[] }

export function parseAIConfig(x: any): AIConfig {
  const c = { ...DEFAULT_AI }; if (!x || typeof x !== 'object') return c;
  for (const k of ['autoPreflight', 'autoReview', 'newsPause', 'vetoOnError'] as const) if (typeof x[k] === 'boolean') c[k] = x[k];
  if (typeof x.pauseMin === 'number' && x.pauseMin >= 1 && x.pauseMin <= 30) c.pauseMin = Math.round(x.pauseMin);
  for (const k of ['entryCheck', 'newsTrades'] as const) if (['off', 'paper', 'live'].includes(x[k])) c[k] = x[k];
  return c;
}
const nyDate = (t = Date.now()) => new Date(wallOf(t)).toISOString().slice(0, 10);
const nyMin = (t = Date.now()) => { const w = new Date(wallOf(t)); return w.getUTCHours() * 60 + w.getUTCMinutes(); };
const hm = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s.trim()); return m ? +m[1] * 60 + +m[2] : NaN; };

const PREFLIGHT_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'events'], properties: {
  summary: { type: 'string' },
  events: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['time', 'name', 'impact', 'forecast', 'previous'], properties: {
    time: { type: 'string', description: 'HH:MM, 24-hour New York time' }, name: { type: 'string' }, impact: { type: 'string', enum: ['high', 'medium', 'low'] },
    forecast: { type: 'string' }, previous: { type: 'string' } } } } } };
const VETO_SCHEMA = { type: 'object', additionalProperties: false, required: ['allow', 'reason'], properties: { allow: { type: 'boolean' }, reason: { type: 'string' } } };
const NEWS_SCHEMA = { type: 'object', additionalProperties: false, required: ['trade', 'symbol', 'direction', 'stop_points', 'target_r', 'reason'], properties: {
  trade: { type: 'boolean' }, symbol: { type: 'string', enum: ['NQ', 'GC'] }, direction: { type: 'string', enum: ['long', 'short'] },
  stop_points: { type: 'number' }, target_r: { type: 'number' }, reason: { type: 'string' } } };

const SYSTEM = `You are the analyst inside Keel, a personal futures trading bot that trades NQ and GC (via MNQ / MGC micros) on a Topstep prop account
(50K Static: $4,000 target, $2,000 static drawdown, $1,000 daily loss limit, 55% consistency, flat by 4:10 PM ET).
Keel runs rule-based strategies that were backtested (K1-K9, P1-P3). Be direct and specific; use numbers from the data you are given and never invent trades,
prices or results. If the data does not answer something, say so. Times are New York time.`;

export class KeelAI {
  cfg: AIConfig; state: State; busy = new Set<string>();
  constructor() {
    this.cfg = (() => { try { return parseAIConfig(JSON.parse(fs.readFileSync(file('ai.json'), 'utf8'))); } catch { return parseAIConfig(null); } })();
    this.state = (() => { try { return { preflight: null, review: null, newsTradeDay: '', chat: [], ...JSON.parse(fs.readFileSync(file('ai_state.json'), 'utf8')) }; } catch { return { preflight: null, review: null, newsTradeDay: '', chat: [] }; } })();
  }
  hasKey() { return vault.has('anthropic'); }
  setKey(key: string) { if (!/^sk-ant-[\w-]{20,}$/.test(key.trim())) throw new Error('That does not look like an Anthropic API key (it starts with sk-ant-).'); vault.set('anthropic', { key: key.trim() }); }
  removeKey() { vault.remove('anthropic'); }
  setConfig(c: AIConfig) { this.cfg = c; fs.writeFileSync(file('ai.json'), JSON.stringify(c, null, 1)); }
  private save() { fs.writeFileSync(file('ai_state.json'), JSON.stringify(this.state)); }
  private client() { const k = vault.get('anthropic')?.key; if (!k) throw new Error('Add your Anthropic API key on the Claude page first.'); return new Anthropic({ apiKey: k, timeout: 120_000, maxRetries: 2 }); }

  /** One request. With `web`, Claude can search; with `schema`, the answer is JSON matching it. */
  private async ask(user: string, o: { effort: 'low' | 'medium' | 'high'; schema?: object; web?: boolean; maxTokens?: number; history?: { role: 'user' | 'assistant'; text: string }[] }): Promise<string> {
    const client = this.client();
    const messages: Anthropic.Beta.BetaMessageParam[] = [...(o.history ?? []).map(m => ({ role: m.role, content: m.text })), { role: 'user', content: user }];
    for (let turn = 0; turn < 4; turn++) {
      const r = await client.beta.messages.create({
        model: MODEL, max_tokens: o.maxTokens ?? 16000, betas: BETAS, fallbacks: 'default', system: SYSTEM, messages,
        thinking: { type: 'adaptive' }, output_config: { effort: o.effort, ...(o.schema ? { format: { type: 'json_schema', schema: o.schema as Record<string, unknown> } } : {}) },
        ...(o.web ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] } : {})
      });
      if (r.stop_reason === 'refusal') throw new Error('Claude declined this request.');
      if (r.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: r.content }); continue; }   // long web search: let it continue
      const text = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map(b => b.text).join('').trim();
      if (r.stop_reason === 'max_tokens' && o.schema) throw new Error('Claude ran out of room for its answer.');
      return text;
    }
    throw new Error('Claude did not finish (too many search rounds).');
  }
  private async json<T>(user: string, schema: object, effort: 'low' | 'medium' | 'high', web = false): Promise<T> {
    if (!web) return JSON.parse(await this.ask(user, { effort, schema })) as T;
    // web search answers carry citations, so read first, then convert the notes to JSON in a second, schema-checked call
    const notes = await this.ask(user, { effort, web: true });
    return JSON.parse(await this.ask(`Convert these notes into the requested JSON. Use only what the notes say.\n\n${notes}`, { effort: 'low', schema })) as T;
  }

  // ---------- pre-flight and news windows ----------
  async preflight(force = false): Promise<Preflight> {
    const date = nyDate();
    if (!force && this.state.preflight?.date === date) return this.state.preflight;
    const r = await this.json<{ summary: string; events: NewsEvent[] }>(
      `Today is ${date} (New York). Search for today's US economic calendar and any scheduled market-moving events (Fed speakers, FOMC, CPI, PPI, NFP, jobless claims, retail sales, ISM, PCE, GDP, Treasury auctions, big earnings after hours that move NQ).
List each event with its New York time (HH:MM, 24-hour), name, impact for NQ and gold (high/medium/low), forecast and previous ("" if unknown).
Then write a 3-5 sentence summary of what matters for trading NQ and GC today and which windows to be careful in.`, PREFLIGHT_SCHEMA, 'medium', true);
    const p: Preflight = { date, at: Date.now(), summary: r.summary, events: r.events.filter(e => Number.isFinite(hm(e.time))).sort((a, b) => hm(a.time) - hm(b.time)) };
    this.state.preflight = p; this.save(); return p;
  }
  /** A high-impact release within +/- pauseMin minutes (null = clear). */
  newsBlock(now = Date.now()): string | null {
    const p = this.state.preflight; if (!this.cfg.newsPause || !p || p.date !== nyDate(now)) return null;
    const m = nyMin(now), ev = p.events.find(e => e.impact === 'high' && Math.abs(hm(e.time) - m) <= this.cfg.pauseMin);
    return ev ? `${ev.name} at ${ev.time} ET` : null;
  }
  /** The high-impact event released 3-4 minutes ago (when a news trade may be considered). */
  dueRelease(now = Date.now()): NewsEvent | null {
    const p = this.state.preflight; if (!p || p.date !== nyDate(now) || this.state.newsTradeDay === nyDate(now)) return null;
    const m = nyMin(now); return p.events.find(e => e.impact === 'high' && m - hm(e.time) >= 3 && m - hm(e.time) < 5) ?? null;
  }
  gateOn(g: Gate, mode: string) { return g === 'live' ? mode === 'paper' || mode === 'live' : g === 'paper' ? mode === 'paper' : false; }

  // ---------- entry check ----------
  async entryCheck(ctx: object): Promise<{ allow: boolean; reason: string }> {
    const run = this.json<{ allow: boolean; reason: string }>(
      `A backtested strategy wants to enter now. Veto it ONLY for a concrete reason visible in the data (e.g. a high-impact release minutes away, price already far past the planned stop, a gap or spike that makes the stop meaningless, or the market being closed/illiquid). Otherwise allow it: the strategies are tested and you should not second-guess ordinary setups.
Answer in one short sentence.\n\n${JSON.stringify(ctx)}\n\nToday's calendar: ${JSON.stringify(this.state.preflight?.date === nyDate() ? this.state.preflight.events : [])}`, VETO_SCHEMA, 'low');
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Claude took longer than 25 s')), 25_000));
    return Promise.race([run, timeout]);
  }

  // ---------- news trade ----------
  async newsIdea(ev: NewsEvent, bars: Record<string, object[]>, riskUsd: number) {
    this.state.newsTradeDay = nyDate(); this.save();                 // decided once per day, whatever the answer
    return this.json<{ trade: boolean; symbol: 'NQ' | 'GC'; direction: 'long' | 'short'; stop_points: number; target_r: number; reason: string }>(
      `${ev.name} was released at ${ev.time} ET today (forecast ${ev.forecast || '?'}, previous ${ev.previous || '?'}). Search for the actual number and how markets read it.
Below are the 5-minute bars of NQ and GC from 30 minutes before the release to now. Decide whether ONE trade in NQ or GC has a clear edge right now, in the direction of the surprise.
Only say trade=true when the surprise is large and the price reaction confirms it; otherwise trade=false (that is the normal answer). If you trade, give a stop in points beyond a real level
(NQ 15-80 points, GC 3-20 points) and a target of 1-3R. Risk per trade is $${riskUsd}. Reason in 2 sentences.\n\n${JSON.stringify(bars)}`, NEWS_SCHEMA, 'medium', true);
  }

  // ---------- review and chat ----------
  async review(journal: string[], bars: Record<string, object[]>, pnl: string): Promise<string> {
    const date = nyDate(), text = await this.ask(
      `Write today's trading review (${date}) for Keel. Use the bot journal and 5-minute bars below.
Sections: 1) Summary: P&L, trades, how far along the Combine is. 2) Each trade: strategy, entry, exit, result. 3) Why each LOSER lost: look at the bars around it (stopped by noise, wrong-way trend, news, late entry, stop too tight, against the higher timeframe) and say whether it was a normal loss the backtest expects or something to fix.
4) Anything odd (skips, warnings, blocked entries, AI vetoes) and what to check tomorrow. Keep it under 400 words, plain language.
\nP&L: ${pnl}\n\nJournal:\n${journal.join('\n')}\n\nBars:\n${JSON.stringify(bars)}`, { effort: 'medium', maxTokens: 8000 });
    this.state.review = { date, at: Date.now(), text }; this.save(); return text;
  }
  async chat(q: string, snapshot: object): Promise<string> {
    const hist = this.state.chat.slice(-12);
    const a = await this.ask(`Keel's current state (JSON):\n${JSON.stringify(snapshot)}\n\nQuestion: ${q}`, { effort: 'low', maxTokens: 4000, history: hist });
    this.state.chat.push({ role: 'user', text: q }, { role: 'assistant', text: a }); this.state.chat = this.state.chat.slice(-40); this.save(); return a;
  }
  clearChat() { this.state.chat = []; this.save(); }
}
