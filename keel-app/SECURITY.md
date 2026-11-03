# Security

- Logins are encrypted with Windows' own protection (DPAPI) on this PC. The window can save or remove them but never read them back.
- No account server, no sign-in, no website. Nothing about your accounts leaves this PC except your own trading connections.
- The window is locked down: sandboxed, no Node access, strict content rules, no navigation, no developer tools in the menu.
- Strategies are data, and Pine Script runs in Keel's own interpreter with step limits. No pasted code is ever run as JavaScript.
- The TradingView receiver listens on this PC only and checks a secret.
- Every trade passes your risk limits and your account's rules first. The engine checks P&L every 2 seconds and stops at the daily loss limit, and blocks trades when it can't read P&L.
- Electron is downloaded only from GitHub and checked against its published checksum. Updates come only from your own releases repository.
