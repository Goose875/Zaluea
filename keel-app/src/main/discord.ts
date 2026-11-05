/**
 * Discord: a ping for every trade Keel enters or closes (strategies, chart orders, kill switch, daily target), on every account,
 * with @everyone when that is switched on; and one live status message (each account's P&L today, every open trade with its live
 * P&L, working orders) that Keel edits in place while the bot runs, so it doesn't flood the channel.
 * Uses a Discord channel webhook (Server Settings > Integrations > Webhooks > New Webhook > Copy Webhook URL),
 * saved encrypted in Keel's vault. Messages go out one at a time, at most one per second (Discord's limits).
 */
import * as https from 'https';
import { vault } from './vault';

const OK_HOST = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
export function checkWebhook(url: string) { if (!OK_HOST.test(url.trim())) throw new Error('That is not a Discord webhook URL (it starts with https://discord.com/api/webhooks/).'); return url.trim(); }

interface DiscordCfg { url: string; everyone: boolean }
const cfg = (): DiscordCfg | null => { const c = vault.get('discord'); return c && typeof c.url === 'string' ? { url: c.url, everyone: c.everyone !== '0' } : null; };   // vault holds strings: '0' = off
export const everyoneOn = () => cfg()?.everyone !== false;   // on unless switched off

/** One request to the webhook. Resolves with the status code and the parsed reply (when Discord sends one); never rejects. */
function send(method: 'POST' | 'PATCH', url: string, payload: object): Promise<{ status: number; json: any }> {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const req = https.request(url, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10_000 }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { if (data.length < 100_000) data += c; });
      res.on('end', () => { let json: any = null; try { json = JSON.parse(data); } catch { /* empty reply */ } const status = res.statusCode ?? 0; setTimeout(() => resolve({ status, json }), status === 429 ? 2000 : 1000); });
    });
    req.on('error', () => resolve({ status: 0, json: null })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.end(body);
  });
}
/** A Discord embed card: coloured bar, title, fields (inline ones sit side by side), footer. */
export interface Embed { title?: string; description?: string; color?: number; fields?: { name: string; value: string; inline?: boolean }[]; footer?: { text: string }; timestamp?: string }
export const COLOR = { green: 0x22c55e, red: 0xef4444, blue: 0x3b82f6, grey: 0x6b7280 };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Discord's limits: 25 fields, names 256, values 1024, description 4096, 6000 in all. */
function tidy(e: Embed): Embed {
  const out: Embed = { ...e, title: e.title && clip(e.title, 256), description: e.description && clip(e.description, 4000) };
  if (e.fields) out.fields = e.fields.slice(0, 25).map(f => ({ name: clip(f.name || '​', 256), value: clip(f.value || '​', 1024), inline: !!f.inline }));
  let size = JSON.stringify(out).length;
  while (out.fields && out.fields.length && size > 5800) { out.fields.pop(); size = JSON.stringify(out).length; }
  return out;
}
// @everyone has to be in the message text (not the card) to notify anyone
const message = (embed: Embed, everyone: boolean) => ({ content: everyone ? '@everyone' : '', embeds: [tidy(embed)], username: 'Keel', allowed_mentions: { parse: everyone ? ['everyone'] : [] as string[] } });

let queue: Promise<unknown> = Promise.resolve();
const enqueue = (fn: () => Promise<unknown>) => { queue = queue.then(fn).catch(() => {}); return queue; };

/** Queue a trade ping (no-op when no webhook is saved). Never throws: a Discord problem must never touch trading. */
export function ping(text: string) {
  const c = cfg(); if (!c) return;
  const out = /closed|flatten|stop|kill|halt/i.test(text), inn = /filled|sent|working|Long|Short|buy|sell/i.test(text);
  const m = /^\[([^\]]+)\]\s*(.*)$/s.exec(text), account = m ? m[1] : '', body = m ? m[2] : text;
  const embed: Embed = { title: out ? '🔴 Trade closed / stopped' : inn ? '🟢 Trade' : 'ℹ️ Keel', description: body, color: out ? COLOR.red : inn ? COLOR.green : COLOR.blue,
    ...(account ? { fields: [{ name: '🏦 Account', value: account, inline: true }] } : {}), footer: { text: 'Keel' }, timestamp: new Date().toISOString() };
  void enqueue(() => send('POST', c.url, message(embed, c.everyone)));
}

// ---------- the live status message ----------
let statusId: string | null = null, statusUrl = '', lastText = '';
/** Post the status message the first time, then edit that same message (a new one if it was deleted). Edits never notify anyone. */
export function status(embed: Embed) {
  const c = cfg(); if (!c) return Promise.resolve();
  if (c.url !== statusUrl) { statusId = null; statusUrl = c.url; }
  const { timestamp: _t, ...same } = embed, text = JSON.stringify(same);   // nothing changed but the time: skip the edit
  if (text === lastText && statusId) return Promise.resolve();
  lastText = text;
  return enqueue(async () => {
    if (statusId) {
      const r = await send('PATCH', `${c.url}/messages/${statusId}`, message(embed, false));
      if (r.status >= 200 && r.status < 300) return;
      if (r.status !== 404) return;   // Discord hiccup: try again on the next update
      statusId = null;                // the message was deleted: post a new one
    }
    const r = await send('POST', `${c.url}?wait=true`, message(embed, false));
    if (r.json && typeof r.json.id === 'string') statusId = r.json.id;
  });
}
/** Last edit when the bot stops; the next start posts a fresh status message. */
export async function statusEnd(embed: Embed) { if (statusId) await status(embed); statusId = null; lastText = ''; }

export async function testPing(url: string, everyone = true) {
  const r = await send('POST', `${checkWebhook(url)}?wait=true`, message({ title: '✅ Keel is connected', color: COLOR.blue,
    description: 'A card here whenever a trade is entered or closed on any account, and one live status card (P&L today and every open trade) that updates while the bot runs.',
    fields: [{ name: '🔔 Trade pings', value: everyone ? '@everyone' : 'no mention', inline: true }, { name: '📊 Live status', value: 'every 30 s', inline: true }],
    footer: { text: 'Keel' }, timestamp: new Date().toISOString() }, everyone));
  if (r.status < 200 || r.status >= 300) throw new Error(r.status === 0 ? "Couldn't reach Discord. Check your internet connection." : `Discord refused the message (HTTP ${r.status}). Check the webhook URL.`);
}

// ---------- bot log channel: every log-file line, batched (a separate webhook, never mentions anyone) ----------
const logUrl = () => { const c = vault.get('discordLog'); return c && typeof c.url === 'string' ? c.url : null; };
let logBuf: string[] = [], logTimer: ReturnType<typeof setTimeout> | null = null, logQueue: Promise<unknown> = Promise.resolve();
/** Queue one log line; lines go out together about every 5 s, as code blocks of up to ~1,850 characters. */
export function logLine(line: string) {
  if (!logUrl()) return;
  logBuf.push(line); if (logBuf.length > 400) logBuf.splice(0, logBuf.length - 400);   // a long outage keeps the newest 400 lines
  if (!logTimer) { logTimer = setTimeout(() => void flushLog(), 5000); (logTimer as any).unref?.(); }
}
export function flushLog(): Promise<unknown> {
  if (logTimer) { clearTimeout(logTimer); logTimer = null; }
  const url = logUrl(), lines = logBuf.splice(0); if (!url || !lines.length) return logQueue;
  const chunks: string[] = []; let cur = '';
  for (const l of lines) { const s = l.replace(/```/g, "'''").slice(0, 1800); if (cur && cur.length + s.length + 1 > 1850) { chunks.push(cur); cur = ''; } cur += (cur ? '\n' : '') + s; }
  if (cur) chunks.push(cur);
  for (const c of chunks) logQueue = logQueue.then(() => send('POST', url, { content: '```\n' + c + '\n```', username: 'Keel log', allowed_mentions: { parse: [] as string[] } })).catch(() => {});
  return logQueue;
}
export async function testLog(url: string) {
  const r = await send('POST', `${checkWebhook(url)}?wait=true`, { content: '✅ **Keel bot log connected.** Every line of Keel\'s log (checks, entries, skips, blocks, vetoes, errors) will appear here, about every 5 seconds.', username: 'Keel log', allowed_mentions: { parse: [] as string[] } });
  if (r.status < 200 || r.status >= 300) throw new Error(r.status === 0 ? "Couldn't reach Discord. Check your internet connection." : `Discord refused the message (HTTP ${r.status}). Check the webhook URL.`);
}
