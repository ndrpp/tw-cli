// Small on-disk JSON cache for large, slow-changing game data (default 12 h).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';

export const CACHE_TTL_MS = 12 * 3600_000;

const fileFor = (name: string) => join(CONFIG_DIR, 'cache', `${name.replace(/[^\w.-]/g, '_')}.json`);

/** Cached value if younger than `ttlMs`, else `load()` (stored on success). `fresh` skips the cache. */
export async function cachedJson<Value>(
  name: string,
  load: () => Promise<Value>,
  opts: { ttlMs?: number; fresh?: boolean } = {},
): Promise<Value> {
  const file = fileFor(name);
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  const freshOnDisk = !opts.fresh && existsSync(file) && Date.now() - statSync(file).mtimeMs < ttlMs;
  if (freshOnDisk) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Value;
    } catch {
      /* refetch */
    }
  }
  const value = await load();
  mkdirSync(join(CONFIG_DIR, 'cache'), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return value;
}
