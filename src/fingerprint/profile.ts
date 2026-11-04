// Fingerprint profile: the component list your real browser produced for the game's
// Fingerprint2 v1.8.0 call (captured once with tools/capture-fingerprint.js), plus the hash it
// computed. The CLI recomputes the hash from the components and refuses to use a profile whose
// recomputed hash does not match, so what we send is exactly what that browser would send.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { x64hash128 } from './murmur.ts';
import { obj, objs } from '../util/json.ts';

export type ComponentValue = string | number | boolean | null | Array<string | number | boolean | null>;

export interface FpComponent {
  key: string;
  value: ComponentValue;
}

export interface FingerprintProfile {
  version: 1;
  capturedAt: string;
  /** Captured from the same browser; used as the HTTP User-Agent so headers stay consistent. */
  userAgent: string;
  /** navigator.languages, used for Accept-Language. */
  languages: string[];
  /** navigator.webdriver as the browser reported it (false for a normal browser). */
  webdriver: boolean | null;
  /** Hash computed by the browser's own Fingerprint2. */
  fp: string;
  /** Empty for a hash-only profile (only the hash was copied from the browser; it can't be re-verified). */
  components: FpComponent[];
}

// Order in which Fingerprint2 v1.8.0 get() pushes components, after the game's options
// (excludeDoNotTrack, excludeUserAgent, excludeHasLiedOs, excludePlugins) and the library default
// excludePixelRatio. Keys marked optional are only pushed when the browser supports the feature.
export const COMPONENT_ORDER = [
  'language',
  'color_depth',
  'device_memory',
  'hardware_concurrency',
  'resolution',
  'available_resolution',
  'timezone_offset',
  'session_storage',
  'local_storage',
  'indexed_db',
  'add_behavior',
  'open_database',
  'cpu_class',
  'navigator_platform',
  'canvas',
  'webgl',
  'webgl_vendor',
  'adblock',
  'has_lied_languages',
  'has_lied_resolution',
  'has_lied_browser',
  'touch_support',
  'js_fonts',
  'audio_fp',
] as const;

const REQUIRED = new Set([
  'language', 'color_depth', 'device_memory', 'hardware_concurrency', 'resolution',
  'timezone_offset', 'cpu_class', 'navigator_platform', 'adblock', 'has_lied_languages',
  'has_lied_resolution', 'has_lied_browser', 'touch_support', 'js_fonts', 'audio_fp',
]);

/** Array.prototype.join semantics: null/undefined become '', everything else String(x). */
function joinLike(values: readonly unknown[], sep: string): string {
  return values.map((v) => (v == null ? '' : String(v))).join(sep);
}

/** Reproduces: each value (arrays joined with ';') then x64hash128(list.join('~~~'), 31). */
export function hashComponents(components: readonly FpComponent[]): string {
  const parts = components.map((c) => (Array.isArray(c.value) ? joinLike(c.value, ';') : c.value));
  return x64hash128(joinLike(parts, '~~~'), 31);
}

export class FingerprintProfileError extends Error {}

const isPrimitive = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** A component value as JSON gave it; anything else becomes the string the hash would have joined anyway. */
function componentValue(v: unknown): ComponentValue {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map((e) => (e === undefined ? null : isPrimitive(e) ? e : String(e)));
  return isPrimitive(v) ? v : String(v);
}

/** The well-typed fields of a profile file or upload (the rest dropped). */
function partialProfile(raw: unknown): Partial<FingerprintProfile> {
  const r = obj(raw);
  const p: Partial<FingerprintProfile> = {};
  if (r.version === 1) p.version = 1;
  if (typeof r.capturedAt === 'string') p.capturedAt = r.capturedAt;
  if (typeof r.userAgent === 'string') p.userAgent = r.userAgent;
  if (Array.isArray(r.languages)) p.languages = r.languages.map(String);
  if (typeof r.webdriver === 'boolean' || r.webdriver === null) p.webdriver = r.webdriver;
  if (typeof r.fp === 'string') p.fp = r.fp;
  if (Array.isArray(r.components)) p.components = objs(r.components).map((c) => ({ key: String(c.key), value: componentValue(c.value) }));
  return p;
}

export function validateProfile(raw: unknown): FingerprintProfile {
  const r = partialProfile(raw);
  if (r.version !== 1) throw new FingerprintProfileError(`unsupported profile version ${String(obj(raw).version)}`);
  const fp = r.fp ?? '';
  if (!/^[0-9a-f]{32}$/.test(fp)) throw new FingerprintProfileError('fp must be 32 lowercase hex chars');
  if (!r.userAgent) {
    throw new FingerprintProfileError(
      'userAgent missing: run `tw fp ua "<value of navigator.userAgent from the same browser>"`',
    );
  }
  const p: FingerprintProfile = {
    version: 1, capturedAt: r.capturedAt ?? '', userAgent: r.userAgent, languages: r.languages ?? [], webdriver: r.webdriver ?? null, fp,
    components: r.components ?? [],
  };
  if (p.components.length === 0) return p; // hash-only profile

  const keys = p.components.map((c) => c.key);
  let cursor = 0;
  for (const k of keys) {
    const idx = COMPONENT_ORDER.indexOf(k as (typeof COMPONENT_ORDER)[number], cursor);
    if (idx < 0) {
      throw new FingerprintProfileError(
        `component "${k}" is unknown or out of order; was the profile captured with the game's options?`,
      );
    }
    cursor = idx + 1;
  }
  for (const k of REQUIRED) {
    if (!keys.includes(k)) throw new FingerprintProfileError(`required component "${k}" missing`);
  }

  const recomputed = hashComponents(p.components);
  if (recomputed !== p.fp) {
    throw new FingerprintProfileError(
      `recomputed hash ${recomputed} != captured ${p.fp}; the profile was edited or captured incorrectly`,
    );
  }
  return p;
}

export function loadProfile(path: string): FingerprintProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new FingerprintProfileError(
      `cannot read fingerprint profile ${path}: ${(e as Error).message}\n` +
        'Capture one with tools/capture-fingerprint.js in your browser, then run: tw fp import <file>',
    );
  }
  return validateProfile(raw);
}

export function readProfileRaw(path: string): Partial<FingerprintProfile> | null {
  try {
    return partialProfile(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Creates or updates a profile file with fields given by hand (hash-only: no components). */
export function writeProfileFields(path: string, fields: Partial<Pick<FingerprintProfile, 'fp' | 'userAgent' | 'languages' | 'webdriver'>>): Partial<FingerprintProfile> {
  if (fields.fp !== undefined && !/^[0-9a-f]{32}$/.test(fields.fp)) {
    throw new FingerprintProfileError('fp must be 32 lowercase hex chars');
  }
  const current = readProfileRaw(path) ?? {};
  const next: Partial<FingerprintProfile> = {
    version: 1,
    languages: ['en-US', 'en'],
    webdriver: false,
    userAgent: '',
    ...current,
    ...fields,
    capturedAt: new Date().toISOString(),
  };
  // A new hash invalidates components captured for a different one.
  if (fields.fp !== undefined && current.fp !== fields.fp) next.components = [];
  next.components ??= [];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}
