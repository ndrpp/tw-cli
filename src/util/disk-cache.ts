// Small on-disk JSON cache for large, slow-changing game data (default 12 h).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';

export const CACHE_TTL_MS = 12 * 3600_000;

const fileFor = (name: string) => join(CONFIG_DIR, 'cache', `${name.replace(/[^\w.-]/g, '_')}.json`);

/** Cached value if younger than `ttlMs`, else `fetch()` (stored on success). `fresh` skips the cache. */
export async function cachedJson<T>(name: string, fetch: () => Promise<T>, opts: { ttlMs?: number; fresh?: boolean } = {}): Promise<T> {
  const file = fileFor(name);
  if (!opts.fresh && existsSync(file) && Date.now() - statSync(file).mtimeMs < (opts.ttlMs ?? CACHE_TTL_MS)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      /* refetch */
    }
  }
  const value = await fetch();
  mkdirSync(join(CONFIG_DIR, 'cache'), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return value;
}
