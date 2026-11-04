// Narrowing helpers for JSON from the server or from disk, which arrives as `unknown` (see reset.d.ts). Each
// returns an empty value when the shape is not what was asked for, so parsers stay as forgiving as the
// browser client, and every field read from them is `unknown` until coerced (Number(), String(), plainText()).

export type JsonObject = { [key: string]: unknown };

export const isObj = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `v` if it is a plain object, else `{}`. */
export const obj = (v: unknown): JsonObject => (isObj(v) ? v : {});

/** `v` if it is an array, else `[]`. */
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The objects in array `v` (anything else dropped). */
export const objs = (v: unknown): JsonObject[] => arr(v).filter(isObj);

/** Values of an object or array (PHP serialises small keyed arrays either way). */
export const vals = (v: unknown): unknown[] => (typeof v === 'object' && v !== null ? Object.values(v) : []);

/** Entries of an object or array. */
export const entries = (v: unknown): [string, unknown][] => (typeof v === 'object' && v !== null ? Object.entries(v) : []);

/** Saved values over the defaults, recursively, keeping only keys the default has, with the default's type (a null default takes anything). */
export function mergeDefaults<T extends object>(def: T, saved: unknown): T {
  if (!isObj(saved)) return structuredClone(def);
  const out: JsonObject = Object.fromEntries(entries(structuredClone(def)));
  for (const [k, d] of entries(def)) {
    const v = saved[k];
    if (v === undefined) continue;
    if (isObj(d) && isObj(v)) out[k] = mergeDefaults(d, v);
    else if (d === null || typeof v === typeof d) out[k] = v;
  }
  return out as T;
}

/** An object's values as numbers (non-numbers → 0); `{}` when `v` is not an object. */
export const nums = (v: unknown): Record<string, number> => Object.fromEntries(Object.entries(obj(v)).map(([k, n]) => [k, Number(n) || 0]));

/** Number(v), or null when `v` is null or missing. */
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** String(v), or null when `v` is null or missing. */
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
