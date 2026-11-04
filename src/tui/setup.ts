// Setup screen inside the TUI: everything `tw web` / `tw fp …` / `tw login` can do.

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Box, Text, useInput } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { OpenGame } from '../auth/login.ts';
import { DEFAULT_WORLD, ensureGame } from '../auth/session.ts';
import { PROFILE_FILE, SESSION_FILE } from '../auth/session-store.ts';
import {
  type FingerprintProfile,
  loadProfile,
  readProfileRaw,
  validateProfile,
  writeProfileFields,
} from '../fingerprint/profile.ts';
import type { HostPolicy } from '../http/throttle.ts';
import { errorMessage } from '../util/errors.ts';
import { defaultWebAddress, startWebServer } from '../web/server.ts';

const createElement = React.createElement;

type Field = 'fp' | 'ua' | 'import' | 'name' | 'password';

const PROMPTS: Record<Field, string> = {
  fp: 'Fingerprint hash (32 hex chars)',
  ua: 'Browser User-Agent (navigator.userAgent)',
  import: 'Path to a profile JSON from capture-fingerprint.js',
  name: 'Account name',
  password: 'Password',
};

interface ProfileStatus {
  ok: boolean;
  fp?: string | undefined;
  detail: string;
}

function profileStatus(): ProfileStatus {
  const raw = readProfileRaw(PROFILE_FILE);
  if (!raw) return { ok: false, detail: 'none saved' };
  try {
    const profileValue = validateProfile(raw as FingerprintProfile);
    return {
      ok: true,
      fp: profileValue.fp,
      detail: profileValue.components.length
        ? `${profileValue.components.length} components, verified`
        : 'hash only (not re-verifiable)',
    };
  } catch (entry) {
    return { ok: false, fp: raw.fp, detail: errorMessage(entry) };
  }
}

export interface SetupProps {
  onReady: (game: OpenGame) => void;
  onBack?: (() => void) | undefined;
  onQuit: () => void;
  message?: string | undefined;
  /** Request pacing override (tests). */
  policy?: HostPolicy | undefined;
}

export function SetupScreen({ onReady, onBack, onQuit, message, policy }: SetupProps) {
  const [, setVersion] = useState(0);
  const refresh = () => setVersion((currentValue) => currentValue + 1);
  const [field, setField] = useState<Field | null>(null);
  const [inputBuffer, setInputBuffer] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; bad?: boolean } | null>(
    message ? { text: message, bad: true } : null,
  );
  const [web, setWeb] = useState<{ url: string; host: string; port: number } | null>(null);
  const webRef = useRef<{ close: () => Promise<void> } | null>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => () => void webRef.current?.close(), []);

  const status = profileStatus();
  const haveSession = existsSync(SESSION_FILE);

  const finish = (game: OpenGame) => {
    void webRef.current?.close();
    webRef.current = null;
    readyRef.current(game);
  };

  const doLogin = async (name: string, password: string) => {
    setBusy(true);
    setStatusMessage({ text: 'Logging in… (requests are paced, a few seconds)' });
    try {
      const profile = loadProfile(PROFILE_FILE);
      const game = await ensureGame({
        forceLogin: true,
        profile,
        policy,
        credentials: async () => ({ name, password }),
      });
      finish(game);
    } catch (entry) {
      setStatusMessage({ text: errorMessage(entry), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const doContinue = async () => {
    setBusy(true);
    setStatusMessage({ text: 'Connecting with the saved session…' });
    try {
      const game = await ensureGame({
        policy,
        credentials: async () => {
          throw new Error('Saved session expired. Log in with l.');
        },
      });
      finish(game);
    } catch (entry) {
      setStatusMessage({ text: errorMessage(entry), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const toggleWeb = async () => {
    if (webRef.current) {
      await webRef.current.close();
      webRef.current = null;
      setWeb(null);
      setStatusMessage({ text: 'Browser setup page stopped.' });
      return;
    }
    const addr = defaultWebAddress();
    try {
      const server = await startWebServer({
        ...addr,
        log: () => {},
        onFingerprint: (fp) => {
          setStatusMessage({ text: `Fingerprint ${fp} saved from the browser.` });
          refresh();
        },
        login: async (name, password, profile) => {
          const game = await ensureGame({
            forceLogin: true,
            profile,
            policy,
            credentials: async () => ({ name, password }),
          });
          setTimeout(() => finish(game), 300);
          const json = game.bootstrap.character ?? {};
          return {
            name: String(json.name ?? '?'),
            level: Number(json.level ?? 0),
            world: String(game.bootstrap.game?.currentWorldName ?? DEFAULT_WORLD.url),
          };
        },
      });
      webRef.current = server;
      setWeb({ url: server.url, ...addr });
      setStatusMessage({ text: 'Open the URL below in your browser. Fingerprint and login there update this screen.' });
    } catch (entry) {
      setStatusMessage({ text: `Could not start the page: ${errorMessage(entry)}`, bad: true });
    }
  };

  const submit = (currentValue: Field, value: string) => {
    try {
      if (currentValue === 'fp') {
        writeProfileFields(PROFILE_FILE, { fp: value.trim().toLowerCase() });
        setStatusMessage({ text: 'Fingerprint saved (hash only).' });
      } else if (currentValue === 'ua') {
        writeProfileFields(PROFILE_FILE, { userAgent: value.trim() });
        setStatusMessage({ text: 'User-Agent saved.' });
      } else if (currentValue === 'import') {
        const path = value.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
        const profileValue = loadProfile(path);
        mkdirSync(dirname(PROFILE_FILE), { recursive: true, mode: 0o700 });
        copyFileSync(path, PROFILE_FILE);
        chmodSync(PROFILE_FILE, 0o600);
        setStatusMessage({
          text: `Imported fingerprint ${profileValue.fp} (${profileValue.components.length} components).`,
        });
      } else if (currentValue === 'name') {
        setAccount(value.trim());
        setField('password');
        setInputBuffer('');
        return;
      } else if (currentValue === 'password') {
        setField(null);
        setInputBuffer('');
        void doLogin(account, value);
        return;
      }
    } catch (entry) {
      setStatusMessage({ text: errorMessage(entry), bad: true });
    }
    setField(null);
    setInputBuffer('');
    refresh();
  };

  useInput((input, key) => {
    if (field) {
      if (key.escape) {
        setField(null);
        setInputBuffer('');
      } else if (key.return) submit(field, inputBuffer);
      else if (key.backspace || key.delete) setInputBuffer((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setInputBuffer((value) => value + input);
      return;
    }
    if (busy) return;
    if (input === 'q') return onQuit();
    if (key.escape && onBack) return onBack();
    if (input === 'w') return void toggleWeb();
    if (input === 'f') return setField('fp');
    if (input === 'a') return setField('ua');
    if (input === 'i') return setField('import');
    if (input === 'l') {
      if (!status.ok) return setStatusMessage({ text: 'Set up the fingerprint first (w, f/a or i).', bad: true });
      setInputBuffer('');
      return setField('name');
    }
    if (input === 'c' && haveSession && status.ok) return void doContinue();
  });

  const item = (entryKey: string, label: string, enabled = true) =>
    createElement(
      Text,
      { key: entryKey, dimColor: !enabled },
      createElement(Text, { color: enabled ? 'yellow' : 'gray', bold: true }, ` ${entryKey} `),
      ` ${label}`,
    );

  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 2, paddingY: 0 },
    createElement(Text, { bold: true, color: 'yellow' }, 'Setup · fingerprint & login'),
    createElement(Text, { dimColor: true }, `World ${DEFAULT_WORLD.url} (${DEFAULT_WORLD.locale})`),
    createElement(Text, null, ' '),
    createElement(
      Text,
      null,
      'Fingerprint  ',
      status.ok
        ? createElement(Text, { color: 'green' }, `✔ ${status.fp}`)
        : createElement(Text, { color: 'red' }, `✘ ${status.fp ?? ''}`),
      createElement(Text, { dimColor: true }, `  ${status.detail}`),
    ),
    createElement(
      Text,
      null,
      'Session      ',
      haveSession ? createElement(Text, { color: 'green' }, 'saved') : createElement(Text, { color: 'red' }, 'none'),
      createElement(Text, { dimColor: true }, haveSession ? '  (c to continue with it)' : ''),
    ),
    createElement(Text, null, ' '),
    createElement(Text, { bold: true }, 'Fingerprint'),
    item('w', web ? 'stop the browser setup page' : 'open a setup page in your browser (fingerprint + login)'),
    item('f', 'type a fingerprint hash'),
    item('a', 'type the browser User-Agent'),
    item('i', 'import a profile JSON file'),
    createElement(Text, { bold: true }, 'Account'),
    item('l', 'log in here (name + password)', status.ok),
    item('c', 'continue with the saved session', haveSession && status.ok),
    onBack ? item('Esc', 'back to the game') : null,
    item('q', 'quit'),
    web
      ? createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          createElement(Text, null, 'Browser page: ', createElement(Text, { color: 'cyan', bold: true }, web.url)),
          web.host === '0.0.0.0'
            ? createElement(
                Text,
                { dimColor: true },
                `Running in a container: port ${web.port} must be published (compose: ports "127.0.0.1:${web.port}:${web.port}", run with --service-ports).`,
              )
            : null,
        )
      : null,
    field
      ? createElement(
          Box,
          { marginTop: 1 },
          createElement(Text, { color: 'cyan' }, `${PROMPTS[field]}: `),
          createElement(Text, null, field === 'password' ? '•'.repeat(inputBuffer.length) : inputBuffer),
          createElement(Text, { inverse: true }, ' '),
          createElement(Text, { dimColor: true }, '  Enter save · Esc cancel'),
        )
      : null,
    statusMessage
      ? createElement(
          Text,
          { color: statusMessage.bad ? 'red' : busy ? 'yellow' : 'green', wrap: 'wrap' },
          statusMessage.text,
        )
      : null,
  );
}
