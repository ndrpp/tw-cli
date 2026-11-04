// Portal → world login, ported from tw-market src/lib/market/login.ts (same 4 steps the browser takes):
//  1. GET  https://www.the-west.net/            sets the cookies the login form expects
//  2. POST /index.php?ajax=check_login&locale=  name+password → player_id, login token, playerWorlds
//  3. POST /index.php?action=login              world_id, player_id, token → redirect to game.php?sid=…
//  4. GET  that URL, following redirects        sets the world's session cookies
// then openGame(): GET game.php → Player.init h + state, and record_fp like the page's fp-script.

import type { FingerprintProfile } from '../fingerprint/profile.ts';
import { recordFingerprint } from '../fingerprint/record.ts';
import { CookieJar } from '../http/cookie-jar.ts';
import { GameClient, HTML_ACCEPT, type Identity, isRedirect, send } from '../http/game-client.ts';
import { type HostPolicy, INTERACTIVE_POLICY } from '../http/throttle.ts';
import { type JsonObject, obj } from '../util/json.ts';
import { type Bootstrap, parseBootstrap } from './bootstrap.ts';

export class AuthError extends Error {}

const MAX_REDIRECTS = 4;

export interface WorldConfig {
  /** e.g. https://en32.the-west.net */
  url: string;
  /** portal locale, e.g. en_DK for the English market */
  locale: string;
}

export interface Credentials {
  name: string;
  password: string;
}

export function identityFrom(profile: FingerprintProfile): Identity {
  const languages = profile.languages.length ? profile.languages : ['en-US'];
  const acceptLanguage = languages
    .map((language, index) => (index === 0 ? language : `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`))
    .join(',');
  return { userAgent: profile.userAgent, acceptLanguage };
}

/** www host of the world's portal: https://en32.the-west.net → https://www.the-west.net */
export function portalUrl(worldUrl: string): string {
  const world = new URL(worldUrl);
  return `${world.protocol}//www.${world.hostname.split('.').slice(1).join('.')}`;
}

interface Account {
  playerId: number;
  token: string;
  worlds: number[];
}

async function checkLogin(
  world: WorldConfig,
  credentials: Credentials,
  jar: CookieJar,
  identity: Identity,
  policy: HostPolicy,
): Promise<Account> {
  const portal = portalUrl(world.url);
  const response = await send(
    jar,
    identity,
    `${portal}/index.php?ajax=check_login&locale=${encodeURIComponent(world.locale)}`,
    {
      method: 'POST',
      body: new URLSearchParams({ name: credentials.name, password: credentials.password }).toString(),
      referer: `${portal}/`,
      origin: portal,
      ajax: true,
    },
    policy,
  );
  const text = await response.text();
  let data: JsonObject;
  try {
    data = obj(JSON.parse(text));
  } catch {
    throw new AuthError(`Login check returned non-JSON (${text.slice(0, 80)}…)`);
  }
  const playerId = Number(data.player_id);
  if (!Number.isInteger(playerId) || playerId <= 0 || typeof data.password !== 'string' || !data.password) {
    const reason = [data.error, data.msg, data.message].find(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    throw new AuthError(`Login rejected${reason ? `: ${reason}` : ' (wrong name or password?)'}`);
  }
  const worlds = Object.keys(obj(data.playerWorlds))
    .map(Number)
    .filter((worldId) => Number.isInteger(worldId) && worldId > 0);
  return { playerId, token: data.password, worlds };
}

async function gameUrlFrom(response: Response, baseUrl: string): Promise<string | null> {
  const location = response.headers.get('location');
  if (location) {
    await response.body?.cancel().catch(() => {});
    return new URL(location, baseUrl).href;
  }
  const match = /https?:\/\/[a-z0-9.-]+\/game\.php\?[^"'\s<>]*sid=[^"'\s<>]+/i.exec(await response.text());
  return match ? match[0].replace(/&amp;/g, '&') : null;
}

async function enterWorld(
  world: WorldConfig,
  jar: CookieJar,
  identity: Identity,
  account: Account,
  portalWorldId: number,
  policy: HostPolicy,
): Promise<boolean> {
  const portal = portalUrl(world.url);
  const worldHost = new URL(world.url).host;
  const response = await send(
    jar,
    identity,
    `${portal}/index.php?action=login`,
    {
      method: 'POST',
      body: new URLSearchParams({
        world_id: String(portalWorldId),
        player_id: String(account.playerId),
        password: account.token,
        set_cookie: '1',
      }).toString(),
      referer: `${portal}/`,
      origin: portal,
    },
    policy,
  );
  let url = await gameUrlFrom(response, `${portal}/index.php`);
  if (!url) {
    throw new AuthError('Login did not lead to the game');
  }
  if (new URL(url).host !== worldHost) {
    return false;
  }

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const redirect = await send(jar, identity, url, { referer: `${portal}/` }, policy);
    const location = redirect.headers.get('location');
    await redirect.body?.cancel().catch(() => {});
    if (!isRedirect(redirect.status) || !location) {
      return true;
    }
    url = new URL(location, url).href;
    if (new URL(url).host !== worldHost) {
      throw new AuthError(`Game sent the login back to ${new URL(url).host}: login failed`);
    }
  }
  throw new AuthError('Too many redirects while entering the game');
}

/** Steps 1–4. Returns a jar holding the world's session cookies. */
export async function loginToWorld(
  world: WorldConfig,
  credentials: Credentials,
  profile: FingerprintProfile,
  policy: HostPolicy = INTERACTIVE_POLICY,
): Promise<CookieJar> {
  const jar = new CookieJar();
  const identity = identityFrom(profile);
  const portalPage = await send(jar, identity, `${portalUrl(world.url)}/`, {}, policy);
  await portalPage.body?.cancel().catch(() => {});

  const account = await checkLogin(world, credentials, jar, identity, policy);
  // One at a time: each attempt rewrites the jar's session cookies.
  for (const worldId of account.worlds) {
    if (await enterWorld(world, jar, identity, account, worldId, policy)) {
      return jar;
    }
  }
  throw new AuthError(`This account has no character on ${new URL(world.url).host}`);
}

export interface OpenGame {
  client: GameClient;
  bootstrap: Bootstrap;
}

/**
 * Loads game.php with the session cookies (what a page load does), parses the bootstrap state, and
 * sends anti_cheat/record_fp exactly as the page's fp-script would.
 */
export async function openGame(
  world: WorldConfig,
  jar: CookieJar,
  profile: FingerprintProfile,
  policy: HostPolicy = INTERACTIVE_POLICY,
): Promise<OpenGame> {
  const identity = identityFrom(profile);
  const response = await send(
    jar,
    identity,
    `${world.url}/game.php`,
    { accept: HTML_ACCEPT, referer: `${portalUrl(world.url)}/` },
    policy,
  );
  if (isRedirect(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw new AuthError(`Game redirected to ${response.headers.get('location') ?? 'the start page'}: session expired`);
  }
  const bootstrap = parseBootstrap(await response.text());
  const client = new GameClient({ worldUrl: world.url, h: bootstrap.h, jar, identity, policy });
  await recordFingerprint(client, profile);
  return { client, bootstrap };
}
