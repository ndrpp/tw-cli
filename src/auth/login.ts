// Portal → world login, ported from tw-market src/lib/market/login.ts (same 4 steps the browser takes):
//  1. GET  https://www.the-west.net/            sets the cookies the login form expects
//  2. POST /index.php?ajax=check_login&locale=  name+password → player_id, login token, playerWorlds
//  3. POST /index.php?action=login              world_id, player_id, token → redirect to game.php?sid=…
//  4. GET  that URL, following redirects        sets the world's session cookies
// then openGame(): GET game.php → Player.init h + state, and record_fp like the page's fp-script.
import { CookieJar } from '../http/cookie-jar.ts';
import { GameClient, HTML_ACCEPT, send, type Identity } from '../http/game-client.ts';
import { INTERACTIVE_POLICY, type HostPolicy } from '../http/throttle.ts';
import { parseBootstrap, type Bootstrap } from './bootstrap.ts';
import type { FingerprintProfile } from '../fingerprint/profile.ts';
import { recordFingerprint } from '../fingerprint/record.ts';

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
  const langs = profile.languages.length ? profile.languages : ['en-US'];
  const acceptLanguage = langs.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(',');
  return { userAgent: profile.userAgent, acceptLanguage };
}

/** www host of the world's portal: https://en32.the-west.net → https://www.the-west.net */
export function portalUrl(worldUrl: string): string {
  const u = new URL(worldUrl);
  return `${u.protocol}//www.${u.hostname.split('.').slice(1).join('.')}`;
}

interface Account {
  playerId: number;
  token: string;
  worlds: number[];
}

async function checkLogin(world: WorldConfig, creds: Credentials, jar: CookieJar, id: Identity, policy: HostPolicy): Promise<Account> {
  const portal = portalUrl(world.url);
  const res = await send(jar, id, `${portal}/index.php?ajax=check_login&locale=${encodeURIComponent(world.locale)}`, {
    method: 'POST',
    body: new URLSearchParams({ name: creds.name, password: creds.password }).toString(),
    referer: `${portal}/`,
    origin: portal,
    ajax: true,
  }, policy);
  const text = await res.text();
  let data: { player_id?: unknown; password?: unknown; playerWorlds?: Record<string, unknown>; error?: unknown; msg?: unknown; message?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    throw new AuthError(`Login check returned non-JSON (${text.slice(0, 80)}…)`);
  }
  const playerId = Number(data.player_id);
  if (!Number.isInteger(playerId) || playerId <= 0 || typeof data.password !== 'string' || !data.password) {
    const reason = [data.error, data.msg, data.message].find((v) => typeof v === 'string' && v) as string | undefined;
    throw new AuthError(`Login rejected${reason ? `: ${reason}` : ' (wrong name or password?)'}`);
  }
  const worlds = Object.keys(data.playerWorlds ?? {}).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return { playerId, token: data.password, worlds };
}

async function gameUrlFrom(res: Response, from: string): Promise<string | null> {
  const loc = res.headers.get('location');
  if (loc) {
    await res.body?.cancel().catch(() => {});
    return new URL(loc, from).href;
  }
  const m = /https?:\/\/[a-z0-9.-]+\/game\.php\?[^"'\s<>]*sid=[^"'\s<>]+/i.exec(await res.text());
  return m ? m[0].replace(/&amp;/g, '&') : null;
}

async function enterWorld(world: WorldConfig, jar: CookieJar, id: Identity, account: Account, portalWorldId: number, policy: HostPolicy): Promise<boolean> {
  const portal = portalUrl(world.url);
  const worldHost = new URL(world.url).host;
  const res = await send(jar, id, `${portal}/index.php?action=login`, {
    method: 'POST',
    body: new URLSearchParams({
      world_id: String(portalWorldId),
      player_id: String(account.playerId),
      password: account.token,
      set_cookie: '1',
    }).toString(),
    referer: `${portal}/`,
    origin: portal,
  }, policy);
  let url = await gameUrlFrom(res, `${portal}/index.php`);
  if (!url) throw new AuthError('Login did not lead to the game');
  if (new URL(url).host !== worldHost) return false;

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const r = await send(jar, id, url, { referer: `${portal}/` }, policy);
    const loc = r.headers.get('location');
    await r.body?.cancel().catch(() => {});
    if (r.status < 300 || r.status >= 400 || !loc) return true;
    url = new URL(loc, url).href;
    if (new URL(url).host !== worldHost) throw new AuthError(`Game sent the login back to ${new URL(url).host}: login failed`);
  }
  throw new AuthError('Too many redirects while entering the game');
}

/** Steps 1–4. Returns a jar holding the world's session cookies. */
export async function loginToWorld(world: WorldConfig, creds: Credentials, profile: FingerprintProfile, policy: HostPolicy = INTERACTIVE_POLICY): Promise<CookieJar> {
  const jar = new CookieJar();
  const id = identityFrom(profile);
  const first = await send(jar, id, `${portalUrl(world.url)}/`, {}, policy);
  await first.body?.cancel().catch(() => {});

  const account = await checkLogin(world, creds, jar, id, policy);
  for (const worldId of account.worlds) {
    if (await enterWorld(world, jar, id, account, worldId, policy)) return jar;
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
export async function openGame(world: WorldConfig, jar: CookieJar, profile: FingerprintProfile, policy: HostPolicy = INTERACTIVE_POLICY): Promise<OpenGame> {
  const id = identityFrom(profile);
  const res = await send(jar, id, `${world.url}/game.php`, { accept: HTML_ACCEPT, referer: `${portalUrl(world.url)}/` }, policy);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new AuthError(`Game redirected to ${res.headers.get('location') ?? 'the start page'}: session expired`);
  }
  const bootstrap = parseBootstrap(await res.text());
  const client = new GameClient({ worldUrl: world.url, h: bootstrap.h, jar, identity: id, policy });
  await recordFingerprint(client, profile);
  return { client, bootstrap };
}
