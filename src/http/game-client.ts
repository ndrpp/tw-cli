// game.php client mirroring the browser's Ajax module (tw2game.en_DK.js @~43000):
//   POST game.php?window=<w>[&action=<a>&h=<Player.h>][&mode=<m>], form body ($.param), JSON reply.
//   resp.logout -> session invalid; resp.error === 'fatal' -> server error.

import { type JsonObject, obj } from '../util/json.ts';
import type { CookieJar } from './cookie-jar.ts';
import { type FormValue, jqueryParam } from './form.ts';
import { type HostPolicy, INTERACTIVE_POLICY, throttledFetch } from './throttle.ts';

export interface Identity {
  /** Same User-Agent as the browser the fingerprint profile was captured in. */
  userAgent: string;
  acceptLanguage: string;
}

export class SessionInvalidError extends Error {}
export class FatalServerError extends Error {}

export const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
export const isRedirect = (status: number): boolean => status >= 300 && status < 400;
const JSON_ACCEPT = 'application/json, text/javascript, */*; q=0.01';

/** Shared request helper: identity headers, cookie jar in/out, throttled, no auto-redirects. */
export async function send(
  jar: CookieJar,
  identity: Identity,
  url: string,
  init: {
    method?: string;
    body?: string;
    accept?: string;
    referer?: string;
    origin?: string;
    ajax?: boolean;
    signal?: AbortSignal | undefined;
  } = {},
  policy: HostPolicy = INTERACTIVE_POLICY,
): Promise<Response> {
  const headers: Record<string, string> = {
    'user-agent': identity.userAgent,
    'accept-language': identity.acceptLanguage,
    accept: init.accept ?? HTML_ACCEPT,
  };
  const cookie = jar.header(url);
  if (cookie) {
    headers.cookie = cookie;
  }
  if (init.referer) {
    headers.referer = init.referer;
  }
  if (init.origin) {
    headers.origin = init.origin;
  }
  if (init.body !== undefined) {
    headers['content-type'] = init.ajax
      ? 'application/x-www-form-urlencoded; charset=UTF-8'
      : 'application/x-www-form-urlencoded';
  }
  if (init.ajax) {
    headers['x-requested-with'] = 'XMLHttpRequest';
    headers.accept = init.accept ?? JSON_ACCEPT;
  }
  const res = await throttledFetch(
    url,
    { method: init.method ?? 'GET', headers, body: init.body ?? null, redirect: 'manual', signal: init.signal ?? null },
    policy,
  );
  jar.store(url, res);
  return res;
}

export class GameClient {
  worldUrl: string;
  h: string;
  jar: CookieJar;
  identity: Identity;
  policy: HostPolicy;

  constructor(opts: { worldUrl: string; h: string; jar: CookieJar; identity: Identity; policy?: HostPolicy }) {
    this.worldUrl = opts.worldUrl;
    this.h = opts.h;
    this.jar = opts.jar;
    this.identity = opts.identity;
    this.policy = opts.policy ?? INTERACTIVE_POLICY;
  }

  buildUrl(opts: { window?: string; action?: string; mode?: string; ajax?: string }): string {
    const params: string[] = [];
    if (opts.window) {
      params.push(`window=${opts.window}`);
    }
    if (opts.action) {
      params.push(`action=${opts.action}`, `h=${this.h}`);
    }
    if (opts.ajax) {
      params.push(`ajax=${opts.ajax}`);
    }
    if (opts.mode) {
      params.push(`mode=${opts.mode}`);
    }
    return `${this.worldUrl}/game.php${params.length ? `?${params.join('&')}` : ''}`;
  }

  /** The parsed reply as is: most are objects, a few (messages/reply, messages/send, reports delete) arrays. */
  async requestRaw(url: string, data: Record<string, FormValue> = {}): Promise<unknown> {
    const res = await send(
      this.jar,
      this.identity,
      url,
      {
        method: 'POST',
        body: jqueryParam(data),
        ajax: true,
        referer: `${this.worldUrl}/game.php`,
        origin: this.worldUrl,
      },
      this.policy,
    );
    if (isRedirect(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new SessionInvalidError(`redirected to ${res.headers.get('location') ?? '?'}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response from ${url}: ${text.slice(0, 80)}`);
    }
    const json = obj(parsed);
    if (json.logout) {
      throw new SessionInvalidError(typeof json.message === 'string' ? json.message : 'session invalid');
    }
    if (json.error === 'fatal') {
      throw new FatalServerError(`fatal server error for ${url}`);
    }
    return parsed;
  }

  /** The reply as an object (`{}` if it was not one). */
  async request(url: string, data: Record<string, FormValue> = {}): Promise<JsonObject> {
    return obj(await this.requestRaw(url, data));
  }

  remoteCall(window: string, action: string, data: Record<string, FormValue> = {}): Promise<JsonObject> {
    return this.request(this.buildUrl({ window, action }), data);
  }

  remoteCallRaw(window: string, action: string, data: Record<string, FormValue> = {}): Promise<unknown> {
    return this.requestRaw(this.buildUrl({ window, action }), data);
  }

  /** Ajax.get: game.php?window=<w>&ajax=<a> (no h). */
  get(window: string, ajax: string, data: Record<string, FormValue> = {}): Promise<JsonObject> {
    return this.request(this.buildUrl({ window, ajax }), data);
  }

  remoteCallMode(window: string, mode: string, data: Record<string, FormValue> = {}): Promise<JsonObject> {
    return this.request(this.buildUrl({ window, mode }), data);
  }
}
