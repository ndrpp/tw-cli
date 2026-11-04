// Per-host throttled fetch, ported from tw-market src/lib/tw/http.ts. One request at a time per
// host, a randomised gap between requests, retries with randomised exponential backoff on 429/5xx
// (honouring Retry-After), and a circuit breaker after repeated failures.
// The default policy is tuned for interactive play (a person clicking), not bulk scraping.

export type Range = [min: number, max: number];

export interface HostPolicy {
  concurrency: number;
  minIntervalMs: number;
  jitterMs: number;
  breakEvery?: Range;
  breakMs?: Range;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  timeoutMs: number;
  /** Separate queue on the same host (e.g. the chat long-poll must not block game requests). */
  lane?: string;
}

export const INTERACTIVE_POLICY: HostPolicy = {
  concurrency: 1,
  minIntervalMs: 350,
  jitterMs: 650,
  maxRetries: 2,
  baseBackoffMs: 5_000,
  maxBackoffMs: 60_000,
  breakerThreshold: 4,
  breakerCooldownMs: 10 * 60_000,
  timeoutMs: 30_000,
};

export const randomIn = ([min, max]: Range) => min + Math.random() * Math.max(0, max - min);

export class HostPausedError extends Error {
  constructor(host: string, until: number) {
    super(`Requests to ${host} paused until ${new Date(until).toISOString()} after repeated failures`);
    this.name = 'HostPausedError';
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

interface HostState {
  active: number;
  nextStart: number;
  queue: (() => void)[];
  failures: number;
  pausedUntil: number;
  untilBreak?: number;
}

const hosts = new Map<string, HostState>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function state(host: string): HostState {
  let s = hosts.get(host);
  if (!s) {
    s = { active: 0, nextStart: 0, queue: [], failures: 0, pausedUntil: 0 };
    hosts.set(host, s);
  }
  return s;
}

async function acquire(s: HostState, policy: HostPolicy): Promise<void> {
  if (s.active >= policy.concurrency) await new Promise<void>((resolve) => s.queue.push(resolve));
  s.active++;
  const start = Math.max(Date.now(), s.nextStart);
  let gap = policy.minIntervalMs + Math.random() * policy.jitterMs;
  if (policy.breakEvery && policy.breakMs) {
    s.untilBreak ??= Math.round(randomIn(policy.breakEvery));
    if (--s.untilBreak <= 0) {
      gap += randomIn(policy.breakMs);
      s.untilBreak = Math.round(randomIn(policy.breakEvery));
    }
  }
  s.nextStart = start + gap;
  const wait = start - Date.now();
  if (wait > 0) await sleep(wait);
}

function release(s: HostState): void {
  s.active--;
  s.queue.shift()?.();
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const retryable = (status: number) => status === 429 || status >= 500;

export async function throttledFetch(
  url: string,
  init: RequestInit = {},
  policy: HostPolicy = INTERACTIVE_POLICY,
): Promise<Response> {
  const host = new URL(url).host;
  const s = state(policy.lane ? `${host}#${policy.lane}` : host);
  if (s.pausedUntil > Date.now()) throw new HostPausedError(host, s.pausedUntil);

  for (let attempt = 0; ; attempt++) {
    await acquire(s, policy);
    let res: Response | undefined;
    let error: unknown;
    try {
      const timeout = AbortSignal.timeout(policy.timeoutMs);
      res = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } catch (err) {
      error = err;
    } finally {
      release(s);
    }

    if (res && !retryable(res.status)) {
      if (res.ok || res.status < 400) {
        s.failures = 0;
        return res;
      }
      throw new HttpError(res.status, url);
    }

    if (init.signal?.aborted) throw error ?? new Error('aborted');
    s.failures++;
    if (s.failures >= policy.breakerThreshold) {
      s.pausedUntil = Date.now() + policy.breakerCooldownMs;
      throw new HostPausedError(host, s.pausedUntil);
    }
    if (attempt >= policy.maxRetries) {
      if (res) throw new HttpError(res.status, url);
      throw error;
    }
    const exp = policy.baseBackoffMs * 2 ** attempt * (res?.status === 429 ? 2 : 1);
    const backoff = Math.min(policy.maxBackoffMs, exp) * (0.5 + Math.random());
    const retryAfter = res ? retryAfterMs(res) : undefined;
    const wait = Math.max(backoff, retryAfter === undefined ? 0 : retryAfter + randomIn([1_000, 5_000]));
    s.nextStart = Math.max(s.nextStart, Date.now() + wait);
    await res?.body?.cancel().catch(() => {});
    await sleep(wait);
  }
}

/** Test hook. */
export function resetThrottle(): void {
  hosts.clear();
}
