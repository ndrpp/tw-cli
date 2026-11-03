# TUI conventions

Ink (React without JSX: `const h = React.createElement`). Shell in `src/tui/app.ts`, connect/setup in `root.ts`.

## Startup
- `Root` connects (`ensureGame`) and shows `LoadingFrame` with a running "Connecting to The West" step; the
  connect time is passed to `GameState.start({ connect })`, which lists it as the first, finished loading step.
- `LoadingScreen` (in `App`) shows `state.startup.steps` until `startup.done` (Esc skips).

## Keys
- `App`'s `useInput` handles **global keys first**, then screens get the rest: `? q m p u r A i o L H W M $ D C
  G s` (`H` is not global on the map, where it pans). A screen cannot use these unless it captures input.
- Screens (`SCREEN_MODES`) receive `onCapture(bool)`: while true, global keys are skipped (text entry, confirm
  prompts, the autopilot's queue view). Always release it on close/unmount.
- Taken screen-level uppercase keys: `P` (trade: pick up), `R` (quests/mail; autopilot: run/pause), `T`
  (character), `U` (character: use item), `X`/`Q` (autopilot). Check `grep "input === '<k>'" src/tui` first.
- Help text lives in `SHORTCUTS` in `overlays.ts`; add a section for every new screen (`Record<Mode, …>` is
  exhaustive, so does `MODE_TITLE`).

## Screens
- **Home** (`home.ts`, mode `home`, the start screen; Esc from any screen comes back here): working panel
  (queue head: progress bar, time left, expected rewards via `state.queuedJob()`, "✓ done" with the report
  summary for 30 s, autopilot status), session (measured XP/h and $/h from `state.rates`, queued rate from
  `state.timeline()`, level ETA, regen "full at"), attention list, minimap (`buildGrid` around `@`, +/-),
  newest reports (`state.recentReports`), interactive chat. Small terminals drop chat (< 24 rows), then the
  right column (< 96 cols).
- Reports on home cost no polling: one read on first show, then the live "new report" push (which already
  fetches page 1 for its log line) fills `recentReports`; without live updates, one re-read 5 s after a job ends.
- **Jobs** (mode `main`, `W`): full-height list (xp / $ of the longest run, LP, travel; `!` marks jobs for the
  highlighted quest), detail with xp per energy, queue with its end time and total. No chat here.
- **Map**: `m` / Esc go back to the screen it was opened from (`beforeMap`).

## Rendering
- The 1 s ticker in `App` re-renders and drives `state.tick()`, queue polls, syncs and `state.runner.step()`.
- `GameState` emits `change`; `useGameState` re-renders on it. Components read state directly (no copies).
- Lists use `scrollWindow(selected, total, rows)`; text is `wrap: 'truncate'` with `truncate()` for columns.
- Coloured wrapped text (chat lines): `wrapSegments()` in `form.ts` wraps `{text, color}` runs like `wrap()`.
- Tests render with a `PassThrough` stdout (`isTTY`, `columns`, `rows`) and strip ANSI; a stub state must be
  re-rendered by hand (`app.rerender`) since it does not emit `change`.
