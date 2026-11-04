import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { x64hash128 } from '../src/fingerprint/murmur.ts';
import {
  type FingerprintProfile,
  FingerprintProfileError,
  hashComponents,
  validateProfile,
} from '../src/fingerprint/profile.ts';
import { recordFpPayload } from '../src/fingerprint/record.ts';
import { jqueryParam } from '../src/http/form.ts';

const GAME_PHP = fileURLToPath(new URL('../../en32.the_west.net/en32.the-west.net/game.php', import.meta.url));

// Load the ORIGINAL Fingerprint2 library from the downloaded game.php into an isolated vm context,
// so the port is checked against the real code rather than our reading of it.
function loadOriginal(): any | null {
  if (!existsSync(GAME_PHP)) return null;
  const html = readFileSync(GAME_PHP, 'utf8');
  const start = html.indexOf('!function(e,t,n){"use strict";"function"==typeof window.define');
  const endMarker = 't.VERSION="1.8.0",t});';
  const end = html.indexOf(endMarker, start);
  if (start < 0 || end < 0) return null;
  const lib = html.slice(start, end + endMarker.length);
  const ctx: any = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(`(function(){ ${lib} }).call(this);`, ctx, { timeout: 2000 });
  return new ctx.Fingerprint2({});
}

const original = loadOriginal();

function randomString(len: number, maxCode: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(Math.floor(Math.random() * maxCode));
  return s;
}

test("x64hash128 port matches the game's original implementation", { skip: !original && 'game.php not found' }, () => {
  const cases = ['', 'a', 'The West', '~~~', 'x'.repeat(16), 'x'.repeat(31), 'ü€😀 non-latin tail'];
  for (let len = 0; len < 80; len++) {
    cases.push(randomString(len, 128), randomString(len, 0x10000));
  }
  for (const s of cases) {
    for (const seed of [0, 31]) {
      assert.equal(x64hash128(s, seed), original.x64hash128(s, seed), `mismatch for ${JSON.stringify(s)} seed ${seed}`);
    }
  }
});

const components = [
  { key: 'language', value: 'en-US' },
  { key: 'color_depth', value: 24 },
  { key: 'device_memory', value: 8 },
  { key: 'hardware_concurrency', value: 8 },
  { key: 'resolution', value: [1920, 1080] },
  { key: 'available_resolution', value: [1920, 1040] },
  { key: 'timezone_offset', value: -60 },
  { key: 'session_storage', value: 1 },
  { key: 'local_storage', value: 1 },
  { key: 'indexed_db', value: 1 },
  { key: 'cpu_class', value: 'unknown' },
  { key: 'navigator_platform', value: 'Win32' },
  { key: 'canvas', value: ['canvas winding:yes', 'canvas fp:data:image/png;base64,AAAA'] },
  { key: 'webgl', value: ['data:image/png;base64,BBBB', 'extensions:ANGLE_instanced_arrays'] },
  { key: 'webgl_vendor', value: null },
  { key: 'adblock', value: false },
  { key: 'has_lied_languages', value: false },
  { key: 'has_lied_resolution', value: false },
  { key: 'has_lied_browser', value: false },
  { key: 'touch_support', value: [0, false, false] },
  { key: 'js_fonts', value: ['Arial', 'Calibri', 'Courier New'] },
  { key: 'audio_fp', value: '124.04347527516074' },
];

test('component hashing matches the original get() reduction', { skip: !original && 'game.php not found' }, () => {
  // Same reduction as the library's get() callback, executed with the original hash function.
  const n = components.map((c) => (Array.isArray(c.value) ? (c.value as unknown[]).join(';') : c.value));
  assert.equal(hashComponents(components), original.x64hash128(n.join('~~~'), 31));
});

function profile(overrides: Partial<FingerprintProfile> = {}): FingerprintProfile {
  return {
    version: 1,
    capturedAt: '2026-11-03T00:00:00Z',
    userAgent: 'Mozilla/5.0 (test)',
    languages: ['en-US'],
    webdriver: false,
    fp: hashComponents(components),
    components,
    ...overrides,
  };
}

test('validateProfile accepts a consistent profile', () => {
  assert.doesNotThrow(() => validateProfile(profile()));
});

test('validateProfile rejects hash mismatch, wrong order and missing components', () => {
  assert.throws(() => validateProfile(profile({ fp: '0'.repeat(32) })), FingerprintProfileError);
  const swapped = [components[1]!, components[0]!, ...components.slice(2)];
  assert.throws(() => validateProfile(profile({ components: swapped, fp: hashComponents(swapped) })), /out of order/);
  const missing = components.filter((c) => c.key !== 'audio_fp');
  assert.throws(() => validateProfile(profile({ components: missing, fp: hashComponents(missing) })), /audio_fp/);
});

test('record_fp body matches jQuery serialisation of the browser call', () => {
  const p = profile();
  assert.equal(jqueryParam(recordFpPayload(p)), `fp=${p.fp}&gv=&wd=false`);
});

test('jqueryParam mirrors $.param for nested task payloads', () => {
  assert.equal(
    jqueryParam({ tasks: { 0: { taskType: 'job', jobId: 12, x: 1, y: 2 } }, a: [1, 2], s: 'a b&c' }),
    'tasks%5B0%5D%5BtaskType%5D=job&tasks%5B0%5D%5BjobId%5D=12&tasks%5B0%5D%5Bx%5D=1&tasks%5B0%5D%5By%5D=2&a%5B%5D=1&a%5B%5D=2&s=a+b%26c',
  );
});
