# Automatic updates (keeltrading.net)

Installed Keel checks **https://updates.keeltrading.net/** when it opens and every 4 hours. It downloads a new version in the background and installs it when you close Keel; it never restarts while the bot runs.

The installers contain your licensed Rithmic files, so the update site is **not public**. Keel sends a secret header with every request, and a Cloudflare rule blocks requests without it.

## One-time Cloudflare setup (about 10 minutes)
1. **R2 → Create bucket**: name it `keel-updates`.
2. **Bucket → Settings → Custom Domains → Connect domain**: `updates.keeltrading.net`. Leave "Public Development URL" OFF.
3. **keeltrading.net → Security → WAF → Custom rules → Create rule**:
   - Name: `Keel updates key`
   - Expression (Edit expression): `(http.host eq "updates.keeltrading.net" and not any(http.request.headers["x-keel-key"][*] eq "<your update key>"))`
   - Action: **Block** → Deploy.
   - The key is in `keel-app/.secrets/update-key.json` on the build machine (never in git); Claude gives it to you in chat.
4. **R2 → Manage R2 API tokens → Create Account API token**: permission **Object Read & Write**, bucket `keel-updates` only. Copy the **Token value**.
5. In the Claude environment settings (title bar → cloud environment → Edit):
   - **Network secret**: type Bearer, allowed website `api.cloudflare.com`, path prefix `/client/v4/accounts/`, header `Authorization`, prefix `Bearer`, value = the token value.
   - **Environment variable**: `KEEL_UPDATE_KEY=<your update key>` (so a fresh session's builds still carry it).
   - Start a new session, and upload the Rithmic dev kit zip again (it is never stored in git).

## Publishing a version
`npm run build && npx electron-builder --win nsis ...` (see README), then `node scripts/publish-update.js`.
Check the lock: `node scripts/publish-update.js --check` must show 200 with the key and 403 without it.

Install the first version that has this (0.7.1) by hand once; after that Keel updates itself.
