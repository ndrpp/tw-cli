# TUI conventions

Ink (React without JSX: `const h = React.createElement`). Shell in `src/tui/app.ts`, connect/setup in `root.ts`.

## Startup
- `Root` connects (`ensureGame`) and shows `LoadingFrame` with a running "Connecting to The West" step; the
  connect time is passed to `GameState.start({ connect })`, which lists it as the first, finished loading step.
- `LoadingScreen` (in `App`) shows `state.startup.steps` until `startup.done` (Esc skips).

## Keys
- `App`'s `useInput` handles **global keys first**, then screens get the rest: `? q m p u r A i o L W M $ D C
  G s`. A screen cannot use these unless it captures input.
- Screens (`SCREEN_MODES`) receive `onCapture(bool)`: while true, global keys are skipped (text entry, confirm
  prompts, the autopilot's queue view). Always release it on close/unmount.
- Taken screen-level uppercase keys: `P` (trade: pick up), `R` (quests/mail; autopilot: run/pause), `T`
  (character), `U` (character: use item), `X`/`Q` (autopilot). Check `grep "input === '<k>'" src/tui` first.
- Help text lives in `SHORTCUTS` in `overlays.ts`; add a section for every new screen (`Record<Mode, …>` is
  exhaustive, so does `MODE_TITLE`).

## Rendering
- The 1 s ticker in `App` re-renders and drives `state.tick()`, queue polls, syncs and `state.runner.step()`.
- `GameState` emits `change`; `useGameState` re-renders on it. Components read state directly (no copies).
- Lists use `scrollWindow(selected, total, rows)`; text is `wrap: 'truncate'` with `truncate()` for columns.
- Coloured wrapped text (chat lines): `wrapSegments()` in `form.ts` wraps `{text, color}` runs like `wrap()`.
- Tests render with a `PassThrough` stdout (`isTTY`, `columns`, `rows`) and strip ANSI; a stub state must be
  re-rendered by hand (`app.rerender`) since it does not emit `change`.
