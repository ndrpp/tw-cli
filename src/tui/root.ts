// Top-level TUI: connect with the saved session if possible, otherwise show setup; `A` in the game
// returns to setup (re-capture fingerprint / log in again) without leaving the TUI. After the
// machine slept, everything is rebuilt (new session check, game state, live updates, TUI).
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp } from 'ink';
import { ensureGame } from '../auth/session.ts';
import { AuthError, type OpenGame } from '../auth/login.ts';
import { GameState } from '../game/state.ts';
import { App } from './app.ts';
import { SetupScreen } from './setup.ts';
import { formatDuration } from './format.ts';
import { WakeDetector } from '../util/wake.ts';

const h = React.createElement;

type Phase = { kind: 'connecting'; message?: string } | { kind: 'setup'; message?: string; canGoBack: boolean } | { kind: 'game' };

const noPrompt = async (): Promise<never> => {
  throw new Error('Session expired: press A, then log in.');
};

function makeState(game: OpenGame, prev?: GameState | null): GameState {
  const state = new GameState(game, () => ensureGame({ credentials: noPrompt }));
  if (prev) state.carryOver(prev);
  void state.start();
  return state;
}

const RETRY_MS = 10_000;

export function Root() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
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
      setPhase({ kind: 'connecting', message: attempt > 1 ? `${why} Network not back yet (try ${attempt})…` : why });
      ensureGame({ credentials: noPrompt })
        .then((game) => {
          if (cancelled) return;
          const next = makeState(game, prev);
          next.info(why.replace(/…$/, '') + ' Reloaded.');
          setState(next);
          setGeneration((g) => g + 1);
          setPhase({ kind: 'game' });
        })
        .catch((e) => {
          if (cancelled) return;
          if (e instanceof AuthError) return setPhase({ kind: 'setup', canGoBack: false, message: e.message });
          retry = setTimeout(() => reconnect(why, attempt + 1), RETRY_MS);
        });
    };
    const wake = new WakeDetector((slept) => {
      if (!stateRef.current) return; // still in setup / first connect
      if (retry) clearTimeout(retry);
      reconnect(`Woke up after ${formatDuration(Math.round(slept / 1000))}: reconnecting…`);
    }, { intervalMs: 2_000, gapMs: 30_000 }).start();
    return () => {
      cancelled = true;
      wake.stop();
      if (retry) clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    ensureGame({ credentials: noPrompt })
      .then((game) => {
        if (cancelled) return;
        setState(makeState(game));
        setPhase({ kind: 'game' });
      })
      .catch((e) => {
        if (!cancelled) setPhase({ kind: 'setup', canGoBack: false, message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === 'connecting') return h(Box, { padding: 1 }, h(Text, { color: 'yellow' }, phase.message ?? 'Connecting to The West…'));
  if (phase.kind === 'setup' || !state) {
    return h(SetupScreen, {
      message: phase.kind === 'setup' ? phase.message : undefined,
      onReady: (game: OpenGame) => {
        setState(makeState(game));
        setPhase({ kind: 'game' });
      },
      onBack: phase.kind === 'setup' && phase.canGoBack && state ? () => setPhase({ kind: 'game' }) : undefined,
      onQuit: () => exit(),
    });
  }
  return h(App, { key: `${generation}:${state.client.h}:${state.character.playerId}`, state, onAccount: () => setPhase({ kind: 'setup', canGoBack: true }) });
}

export async function runRoot(): Promise<void> {
  const app = render(h(Root), { alternateScreen: true, exitOnCtrlC: true });
  await app.waitUntilExit();
}
