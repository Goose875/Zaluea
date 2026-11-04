/**
 * Discord pings: every trade Keel enters or closes (strategies, chart orders, kill switch), on every account.
 * Uses a Discord channel webhook (Server Settings > Integrations > Webhooks > New Webhook > Copy Webhook URL),
 * saved encrypted in Keel's vault. Messages go out one at a time, at most one per second (Discord's limits).
 */
import * as https from 'https';
import { vault } from './vault';

const OK_HOST = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
export function checkWebhook(url: string) { if (!OK_HOST.test(url.trim())) throw new Error('That is not a Discord webhook URL (it starts with https://discord.com/api/webhooks/).'); return url.trim(); }

let queue: Promise<void> = Promise.resolve();
function post(url: string, content: string): Promise<void> {
  return new Promise(resolve => {
    const body = JSON.stringify({ content: content.slice(0, 1900), username: 'Keel', allowed_mentions: { parse: [] as string[] } });
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10_000 }, res => {
      res.resume(); const wait = res.statusCode === 429 ? 2000 : 1000; setTimeout(resolve, wait);
    });
    req.on('error', () => resolve()); req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(body);
  });
}
/** Queue a ping (no-op when no webhook is saved). Never throws: a Discord problem must never touch trading. */
export function ping(message: string) {
  const url = vault.get('discord')?.url; if (!url) return;
  const emoji = /closed|flatten|stop|kill|halt/i.test(message) ? '🔴' : /filled|sent|working|Long|Short|buy|sell/i.test(message) ? '🟢' : 'ℹ️';
  queue = queue.then(() => post(url, `${emoji} ${message}`)).catch(() => {});
}
export async function testPing(url: string) { await post(checkWebhook(url), '✅ Keel is connected. You will get a message here when a trade is entered or closed.'); }
