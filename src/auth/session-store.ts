// Persists session cookies between runs in ~/.config/tw-cli/session.json (mode 0600).
// The password is never stored; only the cookies the game set.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Cookie, CookieJar } from '../http/cookie-jar.ts';
import { arr, obj } from '../util/json.ts';

export const CONFIG_DIR = process.env.TW_CLI_HOME ?? join(homedir(), '.config', 'tw-cli');
export const SESSION_FILE = join(CONFIG_DIR, 'session.json');
export const PROFILE_FILE = process.env.TW_FP_PROFILE ?? join(CONFIG_DIR, 'fingerprint-profile.json');

interface StoredSession {
  worldUrl: string;
  savedAt: string;
  cookies: Cookie[];
}

export function saveSession(worldUrl: string, jar: CookieJar, file = SESSION_FILE): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const data: StoredSession = { worldUrl, savedAt: new Date().toISOString(), cookies: jar.toJSON() };
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadSession(worldUrl: string, file = SESSION_FILE): CookieJar | null {
  if (!existsSync(file)) return null;
  try {
    const data = obj(JSON.parse(readFileSync(file, 'utf8')));
    if (data.worldUrl !== worldUrl) return null;
    return CookieJar.fromJSON(arr(data.cookies) as Cookie[]);
  } catch {
    return null;
  }
}
