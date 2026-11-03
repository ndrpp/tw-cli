// Gets a working game session: reuse saved cookies if game.php still accepts them, otherwise log in
// (credentials from TW_LOGIN_NAME / TW_LOGIN_PASSWORD or the caller), then save the new cookies.
import { loadProfile, type FingerprintProfile } from '../fingerprint/profile.ts';
import { INTERACTIVE_POLICY, type HostPolicy } from '../http/throttle.ts';
import { AuthError, loginToWorld, openGame, type Credentials, type OpenGame, type WorldConfig } from './login.ts';
import { loadSession, PROFILE_FILE, saveSession } from './session-store.ts';

export const DEFAULT_WORLD: WorldConfig = {
  url: process.env.TW_WORLD_URL ?? 'https://en32.the-west.net',
  locale: process.env.TW_LOCALE ?? 'en_DK',
};

export interface EnsureOptions {
  world?: WorldConfig;
  profile?: FingerprintProfile;
  credentials?: () => Promise<Credentials>;
  forceLogin?: boolean;
  policy?: HostPolicy;
  sessionFile?: string;
  log?: (msg: string) => void;
}

export function envCredentials(): Credentials | null {
  const name = process.env.TW_LOGIN_NAME ?? '';
  const password = process.env.TW_LOGIN_PASSWORD ?? '';
  return name && password ? { name, password } : null;
}

export async function ensureGame(opts: EnsureOptions = {}): Promise<OpenGame> {
  const world = opts.world ?? DEFAULT_WORLD;
  const profile = opts.profile ?? loadProfile(PROFILE_FILE);
  const policy = opts.policy ?? INTERACTIVE_POLICY;
  const log = opts.log ?? (() => {});

  if (!opts.forceLogin) {
    const jar = loadSession(world.url, opts.sessionFile);
    if (jar) {
      try {
        const game = await openGame(world, jar, profile, policy);
        saveSession(world.url, jar, opts.sessionFile);
        log('Reused saved session.');
        return game;
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        log('Saved session expired; logging in again.');
      }
    }
  }

  const creds = envCredentials() ?? (opts.credentials ? await opts.credentials() : null);
  if (!creds) throw new AuthError('No session and no credentials: set TW_LOGIN_NAME / TW_LOGIN_PASSWORD or run `tw login`');
  const jar = await loginToWorld(world, creds, profile, policy);
  const game = await openGame(world, jar, profile, policy);
  saveSession(world.url, jar, opts.sessionFile);
  log('Logged in.');
  return game;
}
