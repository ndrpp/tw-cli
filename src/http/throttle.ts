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

export const randomIn = ([min, max]: Range): number => min + Math.random() * Math.max(0, max - min);

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
const sleep = (ms: number) => new Promise((transform) => setTimeout(transform, ms));

function state(host: string): HostState {
  let entry = hosts.get(host);
  if (!entry) {
    entry = { active: 0, nextStart: 0, queue: [], failures: 0, pausedUntil: 0 };
    hosts.set(host, entry);
  }
  return entry;
}

async function acquire(source: HostState, policy: HostPolicy): Promise<void> {
  if (source.active >= policy.concurrency) await new Promise<void>((resolve) => source.queue.push(resolve));
  source.active++;
  const start = Math.max(Date.now(), source.nextStart);
  let gap = policy.minIntervalMs + Math.random() * policy.jitterMs;
  if (policy.breakEvery && policy.breakMs) {
    source.untilBreak ??= Math.round(randomIn(policy.breakEvery));
    if (--source.untilBreak <= 0) {
      gap += randomIn(policy.breakMs);
      source.untilBreak = Math.round(randomIn(policy.breakEvery));
    }
  }
  source.nextStart = start + gap;
  const wait = start - Date.now();
  if (wait > 0) await sleep(wait);
}

function release(source: HostState): void {
  source.active--;
  source.queue.shift()?.();
}

const RATE_LIMIT_BACKOFF_FACTOR = 2;
const BACKOFF_JITTER_FLOOR = 0.5;
const RETRY_AFTER_JITTER_MS: Range = [1_000, 5_000];

function retryAfterMs(res: Response): number | undefined {
  const entry = res.headers.get('retry-after');
  if (!entry) return undefined;
  const secs = Number(entry);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(entry);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const retryable = (status: number) => status === 429 || status >= 500;

export async function throttledFetch(
  url: string,
  init: RequestInit = {},
  policy: HostPolicy = INTERACTIVE_POLICY,
): Promise<Response> {
  const host = new URL(url).host;
  const source = state(policy.lane ? `${host}#${policy.lane}` : host);
  if (source.pausedUntil > Date.now()) throw new HostPausedError(host, source.pausedUntil);

  for (let attempt = 0; ; attempt++) {
    await acquire(source, policy);
    let res: Response | undefined;
    let error: unknown;
    try {
      const timeout = AbortSignal.timeout(policy.timeoutMs);
      res = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } catch (err) {
      error = err;
    } finally {
      release(source);
    }

    if (res && !retryable(res.status)) {
      if (res.status >= 400) throw new HttpError(res.status, url);
      source.failures = 0;
      return res;
    }

    if (init.signal?.aborted) throw error ?? new Error('aborted');
    source.failures++;
    if (source.failures >= policy.breakerThreshold) {
      source.pausedUntil = Date.now() + policy.breakerCooldownMs;
      throw new HostPausedError(host, source.pausedUntil);
    }
    if (attempt >= policy.maxRetries) {
      if (res) throw new HttpError(res.status, url);
      throw error;
    }
    const exp = policy.baseBackoffMs * 2 ** attempt * (res?.status === 429 ? RATE_LIMIT_BACKOFF_FACTOR : 1);
    const backoff = Math.min(policy.maxBackoffMs, exp) * (BACKOFF_JITTER_FLOOR + Math.random());
    const retryAfter = res ? retryAfterMs(res) : undefined;
    const wait = Math.max(backoff, retryAfter === undefined ? 0 : retryAfter + randomIn(RETRY_AFTER_JITTER_MS));
    source.nextStart = Math.max(source.nextStart, Date.now() + wait);
    await res?.body?.cancel().catch(() => {});
    await sleep(wait);
  }
}

/** Test hook. */
export function resetThrottle(): void {
  hosts.clear();
}
