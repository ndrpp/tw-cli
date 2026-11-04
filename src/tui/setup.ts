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
import { defaultWebAddress, startWebServer } from '../web/server.ts';

const h = React.createElement;

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
    const p = validateProfile(raw as FingerprintProfile);
    return {
      ok: true,
      fp: p.fp,
      detail: p.components.length ? `${p.components.length} components, verified` : 'hash only (not re-verifiable)',
    };
  } catch (e) {
    return { ok: false, fp: raw.fp, detail: e instanceof Error ? e.message : String(e) };
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
  const refresh = () => setVersion((v) => v + 1);
  const [field, setField] = useState<Field | null>(null);
  const [buf, setBuf] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(message ? { text: message, bad: true } : null);
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
    setMsg({ text: 'Logging in… (requests are paced, a few seconds)' });
    try {
      const profile = loadProfile(PROFILE_FILE);
      const game = await ensureGame({
        forceLogin: true,
        profile,
        policy,
        credentials: async () => ({ name, password }),
      });
      finish(game);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const doContinue = async () => {
    setBusy(true);
    setMsg({ text: 'Connecting with the saved session…' });
    try {
      const game = await ensureGame({
        policy,
        credentials: async () => {
          throw new Error('Saved session expired. Log in with l.');
        },
      });
      finish(game);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const toggleWeb = async () => {
    if (webRef.current) {
      await webRef.current.close();
      webRef.current = null;
      setWeb(null);
      setMsg({ text: 'Browser setup page stopped.' });
      return;
    }
    const addr = defaultWebAddress();
    try {
      const srv = await startWebServer({
        ...addr,
        log: () => {},
        onFingerprint: (fp) => {
          setMsg({ text: `Fingerprint ${fp} saved from the browser.` });
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
          const c = game.bootstrap.character ?? {};
          return {
            name: String(c.name ?? '?'),
            level: Number(c.level ?? 0),
            world: String(game.bootstrap.game?.currentWorldName ?? DEFAULT_WORLD.url),
          };
        },
      });
      webRef.current = srv;
      setWeb({ url: srv.url, ...addr });
      setMsg({ text: 'Open the URL below in your browser. Fingerprint and login there update this screen.' });
    } catch (e) {
      setMsg({ text: `Could not start the page: ${e instanceof Error ? e.message : String(e)}`, bad: true });
    }
  };

  const submit = (f: Field, value: string) => {
    try {
      if (f === 'fp') {
        writeProfileFields(PROFILE_FILE, { fp: value.trim().toLowerCase() });
        setMsg({ text: 'Fingerprint saved (hash only).' });
      } else if (f === 'ua') {
        writeProfileFields(PROFILE_FILE, { userAgent: value.trim() });
        setMsg({ text: 'User-Agent saved.' });
      } else if (f === 'import') {
        const path = value.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
        const p = loadProfile(path);
        mkdirSync(dirname(PROFILE_FILE), { recursive: true, mode: 0o700 });
        copyFileSync(path, PROFILE_FILE);
        chmodSync(PROFILE_FILE, 0o600);
        setMsg({ text: `Imported fingerprint ${p.fp} (${p.components.length} components).` });
      } else if (f === 'name') {
        setAccount(value.trim());
        setField('password');
        setBuf('');
        return;
      } else if (f === 'password') {
        setField(null);
        setBuf('');
        void doLogin(account, value);
        return;
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
    setField(null);
    setBuf('');
    refresh();
  };

  useInput((input, key) => {
    if (field) {
      if (key.escape) {
        setField(null);
        setBuf('');
      } else if (key.return) submit(field, buf);
      else if (key.backspace || key.delete) setBuf((b) => b.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
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
      if (!status.ok) return setMsg({ text: 'Set up the fingerprint first (w, f/a or i).', bad: true });
      setBuf('');
      return setField('name');
    }
    if (input === 'c' && haveSession && status.ok) return void doContinue();
  });

  const item = (k: string, label: string, enabled = true) =>
    h(
      Text,
      { key: k, dimColor: !enabled },
      h(Text, { color: enabled ? 'yellow' : 'gray', bold: true }, ` ${k} `),
      ` ${label}`,
    );

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 2, paddingY: 0 },
    h(Text, { bold: true, color: 'yellow' }, 'Setup · fingerprint & login'),
    h(Text, { dimColor: true }, `World ${DEFAULT_WORLD.url} (${DEFAULT_WORLD.locale})`),
    h(Text, null, ' '),
    h(
      Text,
      null,
      'Fingerprint  ',
      status.ok ? h(Text, { color: 'green' }, `✔ ${status.fp}`) : h(Text, { color: 'red' }, `✘ ${status.fp ?? ''}`),
      h(Text, { dimColor: true }, `  ${status.detail}`),
    ),
    h(
      Text,
      null,
      'Session      ',
      haveSession ? h(Text, { color: 'green' }, 'saved') : h(Text, { color: 'red' }, 'none'),
      h(Text, { dimColor: true }, haveSession ? '  (c to continue with it)' : ''),
    ),
    h(Text, null, ' '),
    h(Text, { bold: true }, 'Fingerprint'),
    item('w', web ? 'stop the browser setup page' : 'open a setup page in your browser (fingerprint + login)'),
    item('f', 'type a fingerprint hash'),
    item('a', 'type the browser User-Agent'),
    item('i', 'import a profile JSON file'),
    h(Text, { bold: true }, 'Account'),
    item('l', 'log in here (name + password)', status.ok),
    item('c', 'continue with the saved session', haveSession && status.ok),
    onBack ? item('Esc', 'back to the game') : null,
    item('q', 'quit'),
    web
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, null, 'Browser page: ', h(Text, { color: 'cyan', bold: true }, web.url)),
          web.host === '0.0.0.0'
            ? h(
                Text,
                { dimColor: true },
                `Running in a container: port ${web.port} must be published (compose: ports "127.0.0.1:${web.port}:${web.port}", run with --service-ports).`,
              )
            : null,
        )
      : null,
    field
      ? h(
          Box,
          { marginTop: 1 },
          h(Text, { color: 'cyan' }, `${PROMPTS[field]}: `),
          h(Text, null, field === 'password' ? '•'.repeat(buf.length) : buf),
          h(Text, { inverse: true }, ' '),
          h(Text, { dimColor: true }, '  Enter save · Esc cancel'),
        )
      : null,
    msg ? h(Text, { color: msg.bad ? 'red' : busy ? 'yellow' : 'green', wrap: 'wrap' }, msg.text) : null,
  );
}
