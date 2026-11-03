// Top-level TUI: connect with the saved session if possible, otherwise show setup; `A` in the game
// returns to setup (re-capture fingerprint / log in again) without leaving the TUI.
import React, { useEffect, useState } from 'react';
import { Box, Text, render, useApp } from 'ink';
import { ensureGame } from '../auth/session.ts';
import type { OpenGame } from '../auth/login.ts';
import { GameState } from '../game/state.ts';
import { App } from './app.ts';
import { SetupScreen } from './setup.ts';

const h = React.createElement;

type Phase = { kind: 'connecting' } | { kind: 'setup'; message?: string; canGoBack: boolean } | { kind: 'game' };

const noPrompt = async (): Promise<never> => {
  throw new Error('Session expired: press A, then log in.');
};

function makeState(game: OpenGame): GameState {
  const state = new GameState(game, () => ensureGame({ credentials: noPrompt }));
  void state.start();
  return state;
}

export function Root() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [state, setState] = useState<GameState | null>(null);

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

  if (phase.kind === 'connecting') return h(Box, { padding: 1 }, h(Text, { color: 'yellow' }, 'Connecting to The West…'));
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
  return h(App, { key: String(state.client.h) + state.character.playerId, state, onAccount: () => setPhase({ kind: 'setup', canGoBack: true }) });
}

export async function runRoot(): Promise<void> {
  const app = render(h(Root), { alternateScreen: true, exitOnCtrlC: true });
  await app.waitUntilExit();
}
