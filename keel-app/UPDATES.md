# Updates without the command prompt

Keel checks for a new version when it opens and every 4 hours, downloads it in the background, and installs it when you close Keel. If the bot is stopped you can also press "Restart and update". It never restarts while the bot is running.

## One-time setup (about 15 minutes, all in the browser)
1. Make two repositories on github.com:
   - `keel` (Private): your code. Upload the contents of this folder.
   - `keel-releases` (Public): stays empty. Only the installers go here, so your code stays private.
2. Make a token: GitHub, Settings, Developer settings, Fine-grained tokens, Generate new token.
   Repository access: only `keel-releases`. Permissions: Contents, Read and write. Copy the token.
3. In the `keel` repository: Settings, Secrets and variables, Actions, New repository secret.
   Name: `RELEASES_TOKEN`. Value: the token.
4. In `package.json`, change `YOUR-GITHUB-NAME` to your GitHub username (you can edit it on github.com).

## Every update
1. Upload the changed files to the `keel` repository (Add file, Upload files, then Commit).
2. Actions tab, "Release Keel", Run workflow, type a version higher than the last (0.2.1, 0.2.2, ...).
3. About 10 minutes later the new installer is on your releases page, and Keel picks it up by itself.

The first time, download `Keel-Setup-x.y.z.exe` from the `keel-releases` page and install it. After that you never need the installer again.

Note: the installer contains the app's code, including your strategies. Anyone with the release link could unpack it. Keep the releases repo name to yourself, or make it private later and update by downloading installers by hand.
