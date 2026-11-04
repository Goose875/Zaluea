# Keel (personal)

My own futures trading bot for my Topstep and Lucid accounts.

## Install once
Easiest: get `Keel-Setup-x.y.z.exe` from your releases page (see UPDATES.md) and run it. Keel gets a desktop shortcut and updates itself after that.

Or build it on this PC once (PowerShell, in this folder):

    npm.cmd install
    npm.cmd run dist

The installer lands in `dist-installer`. Run it, then open Keel from the desktop shortcut. Windows shows a "protected your PC" warning because the installer isn't signed: click More info, then Run anyway.

## Logins
- Topstep: TopstepX username and API key (needs Topstep's API subscription). Beta: try a practice account first.
- Lucid: Rithmic login. Saved now, trades once Rithmic approves Keel's API access (email rapi@rithmic.com).
Logins are encrypted by Windows and never leave this PC.

## While developing
`npm.cmd start` runs it from source with a pretend account and pretend prices for testing.

## Building the Windows installer on Linux
Needs Wine with 32-bit support (`dpkg --add-architecture i386 && apt-get install wine64 wine32:i386`, then `wineboot -i`).

    npx tsc -p . && node scripts/copy.js
    npx electron-builder --win dir --x64 --publish never -c.win.signAndEditExecutable=false
    wine ~/.cache/electron-builder/winCodeSign/winCodeSign-2.6.0/rcedit-x64.exe dist-installer/win-unpacked/Keel.exe \
      --set-version-string ProductName Keel --set-version-string FileDescription Keel --set-file-version <version> --set-icon build/icon.ico
    npx electron-builder --win nsis --x64 --publish never --prepackaged dist-installer/win-unpacked -c.win.signAndEditExecutable=false

The installer is `dist-installer/Keel-Setup-<version>.exe`. It is not code-signed, so Windows shows a warning the first time.
