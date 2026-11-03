import * as http from 'http';
import * as crypto from 'crypto';
import { Signal } from '../core/types';

/**
 * Receives TradingView alerts. Listens on this computer only (127.0.0.1).
 * To reach it from TradingView, the user runs their own tunnel
 * (for example Cloudflare Tunnel). We never run a server that sees your trades or keys.
 *
 * Alert message body in TradingView, either:
 * {"secret":"<your secret>","symbol":"ES","side":"buy","qty":1}
 * {"secret":"<your secret>","strategy":"s-1234abcd5678","side":"{{strategy.order.action}}"}  (market and size come from Keel)
 */
export function startWebhook(port: number, secret: string, onSignal: (s: Signal) => void) {
  const want = Buffer.from(secret);
  const hits: number[] = [];

  const server = http.createServer((req, res) => {
    const end = (code: number) => { res.writeHead(code); res.end(); };
    if (req.method !== 'POST' || req.url !== '/signal') return end(404);

    const now = Date.now();
    while (hits.length && now - hits[0] > 60_000) hits.shift();
    if (hits.length >= 30) return end(429);
    hits.push(now);

    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) { req.destroy(); } });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const got = Buffer.from(String(j.secret ?? ''));
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return end(401);
        const side = String(j.side ?? '').toLowerCase();
        if (side !== 'buy' && side !== 'sell') return end(400);
        if (j.strategy !== undefined) {
          if (typeof j.strategy !== 'string' || !/^s-[0-9a-f]{12}$/.test(j.strategy)) return end(400);
          onSignal({ symbol: '', side, qty: 0, source: 'tradingview', strategyId: j.strategy });
          return end(200);
        }
        if (typeof j.symbol !== 'string' || !/^[A-Z0-9._-]{1,12}$/.test(j.symbol)) return end(400);
        if (!Number.isInteger(j.qty) || j.qty < 1) return end(400);
        onSignal({ symbol: j.symbol, side, qty: j.qty, source: 'tradingview' });
        end(200);
      } catch { end(400); }
    });
  });

  server.listen(port, '127.0.0.1');
  return server;
}
