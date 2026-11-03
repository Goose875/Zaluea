# Adding a broker or prop firm

1. Copy `paper.ts` to `yourbroker.ts` and implement `BrokerAdapter` using that broker's official API docs.
2. `connect(creds)` receives credentials from the main process. Keep them in memory only. Never log them.
3. Register it in `src/main/main.ts` in the `ADAPTERS` map.

Planned order: ProjectX (TopstepX and other prop firms), Tradovate, Interactive Brokers, Alpaca.
Check each firm's rules on automated trading before shipping its adapter.
