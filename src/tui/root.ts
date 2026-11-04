// Top-level TUI: connect with the saved session if possible, otherwise show setup; `A` in the game
// returns to setup (re-capture fingerprint / log in again) without leaving the TUI. After the
// machine slept, everything is rebuilt (new session check, game state, live updates, TUI).

import { join } from 'node:path';
import { render, useApp, useInput, useWindowSize } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { AuthError, type OpenGame } from '../auth/login.ts';
import { ensureGame } from '../auth/session.ts';
import { CONFIG_DIR } from '../auth/session-store.ts';
import { Calibration } from '../game/calibration.ts';
import { GameState } from '../game/state.ts';
import { errorMessage } from '../util/errors.ts';
import { WakeDetector } from '../util/wake.ts';
import { App, LoadingFrame } from './app.ts';
import { formatDuration } from './format.ts';
import { SetupScreen } from './setup.ts';

const createElement = React.createElement;

type Phase =
  | { kind: 'connecting'; message?: string; startedAt: number }
  | { kind: 'setup'; message?: string; canGoBack: boolean }
  | { kind: 'game' };

const noPrompt = async (): Promise<never> => {
  throw new Error('Session expired: press g A, then log in.');
};

const CONNECT_LABEL = 'Connecting to The West';

/** `connectedSince`: when connecting began, so the loading screen lists it as its first step. */
function makeState(game: OpenGame, prev?: GameState | null, connectedSince?: number): GameState {
  const state = new GameState(game, () => ensureGame({ credentials: noPrompt }));
  state.debug.dir = join(CONFIG_DIR, 'debug'); // hourly files, kept 24 h
  state.calibration = new Calibration(); // calibration.json: what the autopilot learned
  if (prev) state.carryOver(prev);
  void state.start(
    connectedSince ? { connect: { label: CONNECT_LABEL, startedAt: connectedSince, endedAt: Date.now() } } : {},
  );
  return state;
}

const RETRY_MS = 10_000;

export function Root() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>(() => ({ kind: 'connecting', startedAt: Date.now() }));
  const windowSize = useWindowSize();
  const [, setFrame] = useState(0);
  const connecting = phase.kind === 'connecting';
  // Spinner and timer while connecting (the game's own ticker is not running yet).
  useEffect(() => {
    if (!connecting) return;
    const timer = setInterval(() => setFrame((frame) => frame + 1), 120);
    return () => clearInterval(timer);
  }, [connecting]);
  useInput(
    (input) => {
      if (input === 'q') exit();
    },
    { isActive: connecting },
  );
  const [state, setState] = useState<GameState | null>(null);
  const [generation, setGeneration] = useState(0);
  const stateRef = useRef<GameState | null>(null);
  stateRef.current = state;

  // Sleep/wake: rebuild from scratch (the old long-poll, clock offset and queue are stale).
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const reconnect = (why: string, attempt = 1) => {
      if (cancelled) return;
      const prev = stateRef.current;
      prev?.stopLive();
      const startedAt = Date.now();
      setPhase({
        kind: 'connecting',
        message: attempt > 1 ? `${why} Network not back yet (try ${attempt})…` : why,
        startedAt,
      });
      ensureGame({ credentials: noPrompt })
        .then((game) => {
          if (cancelled) return;
          const next = makeState(game, prev, startedAt);
          next.info(`${why.replace(/…$/, '')} Reloaded.`);
          setState(next);
          setGeneration((value) => value + 1);
          setPhase({ kind: 'game' });
        })
        .catch((entry) => {
          if (cancelled) return;
          if (entry instanceof AuthError) return setPhase({ kind: 'setup', canGoBack: false, message: entry.message });
          retry = setTimeout(() => reconnect(why, attempt + 1), RETRY_MS);
        });
    };
    const wake = new WakeDetector(
      (slept) => {
        if (!stateRef.current) return; // still in setup / first connect
        if (retry) clearTimeout(retry);
        reconnect(`Woke up after ${formatDuration(Math.round(slept / 1000))}: reconnecting…`);
      },
      { intervalMs: 2_000, gapMs: 30_000 },
    ).start();
    return () => {
      cancelled = true;
      wake.stop();
      if (retry) clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    ensureGame({ credentials: noPrompt })
      .then((game) => {
        if (cancelled) return;
        setState(makeState(game, null, startedAt));
        setPhase({ kind: 'game' });
      })
      .catch((entry) => {
        if (!cancelled) setPhase({ kind: 'setup', canGoBack: false, message: errorMessage(entry) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === 'connecting') {
    return createElement(LoadingFrame, {
      width: windowSize.columns || 80,
      height: windowSize.rows || 24,
      steps: [{ label: CONNECT_LABEL, status: 'running', startedAt: phase.startedAt }],
      latest: phase.message,
      keys: 'q quit',
    });
  }
  if (phase.kind === 'setup' || !state) {
    return createElement(SetupScreen, {
      message: phase.kind === 'setup' ? phase.message : undefined,
      onReady: (game: OpenGame) => {
        setState(makeState(game));
        setPhase({ kind: 'game' });
      },
      onBack: phase.kind === 'setup' && phase.canGoBack && state ? () => setPhase({ kind: 'game' }) : undefined,
      onQuit: () => exit(),
    });
  }
  return createElement(App, {
    key: `${generation}:${state.client.h}:${state.character.playerId}`,
    state,
    onAccount: () => setPhase({ kind: 'setup', canGoBack: true }),
  });
}

export async function runRoot(): Promise<void> {
  const app = render(createElement(Root), { alternateScreen: true, exitOnCtrlC: true });
  await app.waitUntilExit();
}
