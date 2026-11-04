# tw-cli

[![Tests](https://github.com/saenai255/tw-cli/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/saenai255/tw-cli/actions/workflows/test.yml)

A terminal client for [The West](https://www.the-west.net) (world en32 "Quebec"). It uses the same HTTP requests as the browser game.

> Unofficial. Third-party clients may break InnoGames' terms of service. Use at your own risk.

## Install

Needs Node ≥ 26 (it runs the TypeScript directly).

```sh
git clone https://github.com/saenai255/tw-cli
cd tw-cli
npm install
```

## Set up (once)

The game records a browser fingerprint at login, so tw-cli needs the fingerprint of the browser you normally play with.

**Easiest:** run `npm run tw -- web`, open the local page it prints, and log in there. It captures the fingerprint and saves your session.

**Or by hand:**

1. Open `game.php` in your browser while logged in, paste `tools/capture-fingerprint.js` into the DevTools console, and save the copied JSON to a file.
2. `npm run tw -- fp import <file>`
3. `npm run tw -- login` (asks for name and password; or set `TW_LOGIN_NAME` / `TW_LOGIN_PASSWORD`)

Everything is stored in `~/.config/tw-cli/` (session with mode 0600). Set `TW_CLI_HOME` to use another folder.

## Use

```sh
npm run tw            # full-screen TUI
npm run tw -- whoami  # character status
npm run tw -- jobs    # doable jobs, nearest location, travel time
npm run tw -- queue   # task queue
```

In the TUI, press `?` for help on any screen.

| Key | Screen |
|---|---|
| `W` | jobs & queue (main view) |
| `m` | map ⇄ jobs |
| `1` `2` `3` | start the selected job (short / medium / long) |
| `i` | inventory, equipment sets & skills |
| `T` | town hall, building levels & construction |
| `o` | quests |
| `$` | bank, mobile trader, shops, market |
| `M` | reports & telegrams |
| `D` | duels |
| `Tab` | jobs → queue → chat (Enter to write, ←/→ room) |
| `C` | full chat with whispers (`L` turns live updates on) |
| `G` | autopilot: priorities, modules, projected queue (see `docs/autopilot.md`) |
| `s` | sleep in a hotel |
| `A` | account setup |
| `q` | quit |

## Develop

```sh
npm test          # tests (some skip without a saved game.php)
npm run typecheck
npm run endpoints # list game endpoints from the client bundle → docs/endpoints.json
```
