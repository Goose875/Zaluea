import { assertSafeUrl } from '../core/net';

/**
 * Minimal SignalR (JSON over WebSocket) client, enough for ProjectX's price feed.
 * Uses the built-in WebSocket, which needs Node 22 or newer (Electron 35+).
 * Reconnects by itself and tells the caller to subscribe again.
 */
export class SignalRClient {
  onOpen: () => void = () => {};
  private ws?: WebSocket;
  private handlers = new Map<string, (args: any[]) => void>();
  private closed = false; private retry = 0; private nextId = 1;
  private ping?: ReturnType<typeof setInterval>;

  constructor(private hubUrl: string, private getToken: () => string) { assertSafeUrl(hubUrl); }

  on(target: string, h: (args: any[]) => void) { this.handlers.set(target, h); }
  start() { this.closed = false; return this.open(); }
  stop() { this.closed = true; clearInterval(this.ping); this.ws?.close(); }

  invoke(target: string, args: unknown[]) { this.send({ type: 1, invocationId: String(this.nextId++), target, arguments: args }); }
  private send(o: unknown) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o) + '\x1e'); }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') return reject(new Error('Live prices need a newer Electron (Node 22 or later).'));
      const u = new URL(this.hubUrl);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.searchParams.set('access_token', this.getToken());   // ProjectX takes the token in the URL
      const ws = new WebSocket(u.toString());
      this.ws = ws;
      let shook = false, buf = '';
      const fail = (m: string) => { if (!shook) reject(new Error(m)); };
      ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + '\x1e');
      ws.onmessage = ev => {
        buf += String(ev.data);
        const parts = buf.split('\x1e'); buf = parts.pop() as string;
        for (const p of parts) {
          if (!p) continue;
          let m: any; try { m = JSON.parse(p); } catch { continue; }
          if (!shook) {
            if (m.error) { fail('The price feed refused the connection.'); ws.close(); return; }
            shook = true; this.retry = 0;
            clearInterval(this.ping); this.ping = setInterval(() => this.send({ type: 6 }), 15_000);
            (this.ping as any).unref?.();
            resolve(); this.onOpen(); continue;
          }
          if (m.type === 1) { try { this.handlers.get(m.target)?.(m.arguments || []); } catch { /* one bad message must not stop the feed */ } }
          else if (m.type === 7) ws.close();
        }
      };
      ws.onerror = () => fail('Could not reach the price feed.');
      ws.onclose = () => {
        clearInterval(this.ping);
        if (!shook) fail('The price feed closed the connection.');
        else if (!this.closed) this.reconnect();
      };
    });
  }

  private reconnect() {
    const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
    const t = setTimeout(() => { if (!this.closed) this.open().catch(() => this.reconnect()); }, wait);
    (t as any).unref?.();
  }
}
