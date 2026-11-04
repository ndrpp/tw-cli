# AGENTS.md

Guide for coding agents working on tw-cli, a terminal client for The West (world en32). Read this first, then
the relevant file in `docs/`.

## Keep this knowledge current (do this every time)
- **Update this file and `docs/` as part of every change**, in the same commit or edit session, without being
  asked. If you learn something non-obvious about the game, the code or the user's preferences, write it down.
- Put game behaviour (endpoints, formulas, units, quirks) in `docs/game-mechanics.md`, the autopilot in
  `docs/autopilot.md`, TUI conventions in `docs/tui.md`. Add a new `docs/*.md` for a new area and link it below.
- Improve what is there: fix anything you find wrong or stale, merge duplicates, move "unverified" items to
  verified once checked live (say how). Keep entries short and factual; no change logs (git has those).
- Keep the docs index below in sync with the files in `docs/`.

## Docs index
- `docs/autopilot.md`: Autopilot spec, architecture, modules, decisions, what is not built yet.
- `docs/game-mechanics.md`: The West as the client sees it: endpoints, formulas, units, verified vs unverified.
- `docs/tui.md`: screens, key handling (global vs screen keys), input capture, rendering conventions.
- `docs/endpoints.json`: game endpoints extracted from the client bundle (`npm run endpoints`).

## Commands
- `npm run tw`: full-screen TUI · `npm run tw -- <cmd>` for CLI commands (whoami, jobs, queue, login, …).
- `npm test`: all tests (`node --test test/*.test.ts`). Some skip without a saved `game.php`.
- `npm run typecheck`: `tsc -p .`. Run it and the tests after every change.

## Layout
- `src/game/`: game logic, no UI. `state.ts` (GameState: owns the client, keeps state in sync), one module per area
  (jobs, tasks, quests, hotel, trade, duels, …), the autopilot (`autopilot*.ts`, `timeline.ts`), `debug-log.ts` (`state.debug`: everything, with data;
  hourly JSONL files kept 24 h in `<config dir>/debug/`, Debug screen `B`), `calibration.ts` (what the
  autopilot learns from reports, health, motivation and sleeps; `calibration.json`).
- `src/tui/`: Ink (React) screens; `app.ts` is the shell (header, nav, ticker, global keys), `root.ts` connects.
- `src/http/`, `src/auth/`, `src/fingerprint/`, `src/realtime/`: transport, login, fingerprint, chat long-poll.
- `test/`: node:test. `features`/`social`/`setup` tests set `TW_CLI_HOME` to a temp dir; new tests that write
  config must do the same (never write the user's real `~/.config/tw-cli`).

## Conventions
- TypeScript run directly by Node ≥ 26 (no build). `.ts` import specifiers. ES modules.
- Match the surrounding style: short header comment per file saying what it mirrors in the browser client
  (often with `@offset` into tw2game), terse JSDoc on non-obvious members, no comments that restate code.
- Pure logic (planners, parsers, formulas) lives apart from requests so it can be unit-tested with fixtures.
- Requests go through `GameState`: `guard()` (busy lock, logs errors) for user actions; `autopilotCall()`
  (busy lock, throws) for the autopilot, which needs the error to back off.
- Line endings are mixed (several files are CRLF). The Edit tool handles both. When scripting edits with Node,
  normalise to `\n`, edit, and write back with the file's original ending. Backslashes do not survive JS
  strings inside heredoc'd Node scripts (`\d`, `\/`, `\n` come out wrong): write any line with a regex or an
  escape using the Edit tool, then grep for `(d+)` or broken string literals and typecheck. In a scripted
  `s.replace(a, b)`, `$'` / `$&` inside `b` are patterns (a `'$'` in `b` pasted the file's tail): use
  `s.split(a).join(b)`.
- New autopilot or state behaviour logs to `state.debug` (`add`, or `once` for per-tick decisions) with the data
  that drove it; label new `autopilotCall(fn, label)` calls so the request log says what they were.
- Settings and caches live in `CONFIG_DIR` (`TW_CLI_HOME` or `~/.config/tw-cli`), written with mode 0600.

## User preferences (learned)
- Plans are discussed and agreed before building ("grill" style: numbered questions with a recommended answer).
- Everything the autopilot does is a toggle; defaults are safe (starts paused unless it was running, dry run).
- Unverified game behaviour is labelled as such in code comments and docs, and checked live when possible.
