// Narrowing helpers for JSON from the server or from disk, which arrives as `unknown` (see reset.d.ts). Each
// returns an empty value when the shape is not what was asked for, so parsers stay as forgiving as the
// browser client, and every field read from them is `unknown` until coerced (Number(), String(), plainText()).

export type JsonObject = { [key: string]: unknown };

export const isObj = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `v` if it is a plain object, else `{}`. */
export const obj = (value: unknown): JsonObject => (isObj(value) ? value : {});

/** `v` if it is an array, else `[]`. */
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The objects in array `v` (anything else dropped). */
export const objs = (value: unknown): JsonObject[] => arr(value).filter(isObj);

/** Values of an object or array (PHP serialises small keyed arrays either way). */
export const vals = (value: unknown): unknown[] =>
  typeof value === 'object' && value !== null ? Object.values(value) : [];

/** Entries of an object or array. */
export const entries = (value: unknown): [string, unknown][] =>
  typeof value === 'object' && value !== null ? Object.entries(value) : [];

/** Saved values over the defaults, recursively, keeping only keys the default has, with the default's type (a null default takes anything). */
export function mergeDefaults<Value extends object>(defaults: Value, saved: unknown): Value {
  if (!isObj(saved)) {
    return structuredClone(defaults);
  }
  const merged: JsonObject = Object.fromEntries(entries(structuredClone(defaults)));
  for (const [key, defaultValue] of entries(defaults)) {
    const savedValue = saved[key];
    if (savedValue === undefined) {
      continue;
    }
    if (isObj(defaultValue) && isObj(savedValue)) {
      merged[key] = mergeDefaults(defaultValue, savedValue);
    } else if (defaultValue === null || typeof savedValue === typeof defaultValue) {
      merged[key] = savedValue;
    }
  }
  return merged as Value;
}

/** An object's values as numbers (non-numbers → 0); `{}` when `v` is not an object. */
export const nums = (value: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(obj(value)).map(([entryKey, count]) => [entryKey, Number(count) || 0]));

/** Number(v), or null when `v` is null or missing. */
export const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** String(v), or null when `v` is null or missing. */
export const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
