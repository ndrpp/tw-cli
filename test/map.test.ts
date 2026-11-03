import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { parseBootstrap, type Bootstrap } from '../src/auth/bootstrap.ts';
import { CookieJar } from '../src/http/cookie-jar.ts';
import { GameClient } from '../src/http/game-client.ts';
import { resetThrottle, type HostPolicy } from '../src/http/throttle.ts';
import { GameState } from '../src/game/state.ts';
import { WorldMap } from '../src/game/world.ts';
import { TileCache } from '../src/game/tiles.ts';
import { collectPois, poisNear } from '../src/game/poi.ts';
import { buildGrid, cursorRect, entriesAt, findNearest } from '../src/tui/map.ts';
import { App } from '../src/tui/app.ts';

const GAME_PHP = fileURLToPath(new URL('../../en32.the_west.net/en32.the-west.net/game.php', import.meta.url));
const HAVE_GAME = existsSync(GAME_PHP);
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(`${FIXTURES}${name}.live.json`, 'utf8');
const WORLD = 'https://en32.the-west.net';
const FAST: HostPolicy = {
  concurrency: 1, minIntervalMs: 0, jitterMs: 0, maxRetries: 0, baseBackoffMs: 0, maxBackoffMs: 0,
  breakerThreshold: 100, breakerCooldownMs: 0, timeoutMs: 5_000,
};

interface Call { url: string; body: string }
let calls: Call[];
let realFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  resetThrottle();
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body });
    if (url.endsWith('window=work&mode=index')) return new Response(fixture('work_index'));
    if (url.endsWith('ajax=get_minimap')) return new Response(fixture('minimap'));
    if (url.endsWith('ajax=get_complete_data')) return new Response(fixture('complete_data'));
    if (url.includes('window=task&action=add')) {
      const pos = /tasks%5B(\d+)%5D/.exec(body)?.[1] ?? '0';
      return Response.json({ tasks: { [pos]: { task: { queue_id: 500 + Number(pos), type: 'job', date_start: 1, date_done: 2, data: { coords: { x: 1, y: 1 }, title: 'added' } } } } });
    }
    if (url.endsWith('mode=get_tasks')) return Response.json({ queue: [] });
    return new Response('unexpected ' + url, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function bootstrap(): Bootstrap {
  const b = parseBootstrap(readFileSync(GAME_PHP, 'utf8'));
  const shift = Math.floor(Date.now() / 1000) - b.game!.sincepoch;
  b.game!.sincepoch += shift;
  for (const t of b.character!.taskQueue) {
    t.date_start += shift;
    t.date_done += shift;
  }
  b.premium = { premiumBoni: { automation: { expiration: Math.floor(Date.now() / 1000) + 3600 } } };
  return b;
}

async function makeState(): Promise<GameState> {
  const b = bootstrap();
  const client = new GameClient({ worldUrl: WORLD, h: b.h, jar: new CookieJar(), identity: { userAgent: 'UA', acceptLanguage: 'en' }, policy: FAST });
  const st = new GameState({ client, bootstrap: b }, async () => ({ client, bootstrap: b }));
  await st.loadJobs();
  return st;
}

test('minimap (live shape) parses towns, forts, job groups, counties', () => {
  const w = WorldMap.fromMinimap(JSON.parse(fixture('minimap')));
  assert.equal(w.towns.length, 3);
  assert.ok(w.towns.some((t) => t.name === 'Slobozia' && t.id === 1421));
  assert.ok(w.towns.some((t) => t.name === null)); // empty town site
  assert.equal(w.forts.length >= 1, true);
  assert.ok(w.forts.some((f) => f.name && f.name !== 'Fort site'));
  assert.ok(w.jobGroups.get(12)!.length > 10);
  assert.equal(w.counties.length, 15);
  assert.equal(w.countyAt({ x: 29888, y: 15564 })?.id, 12);
  assert.equal(w.fair, null);
});

test('tile data (live shape) yields the silver job and crowds', () => {
  const t = new TileCache();
  t.ingest(JSON.parse(fixture('complete_data')), [[116, 60]]);
  const silver = [...t.specialJobs.values()];
  assert.deepEqual(silver, [{ x: 30380, y: 16308, jobId: 5, groupId: 7, gold: false, silver: true }]);
  assert.ok([...t.crowds.values()].some((c) => c.x === 29888 && c.y === 15564 && c.count === 2));
});

const TILE_SAMPLE = fileURLToPath(new URL('../../en32.the_west.net/en32.the-west.net/game-38d090cd2e3a4.php', import.meta.url));
test('quest giver names come from tile quests (saved sample)', { skip: !existsSync(TILE_SAMPLE) && 'saved tile sample missing' }, () => {
  const sample = JSON.parse(readFileSync(TILE_SAMPLE, 'utf8'));
  const t = new TileCache();
  t.ingest(sample, [[109, 65]]);
  const q = t.questGivers.get('28002,16658');
  assert.ok(q);
  assert.ok(q.names.includes("Waupee's Indian village"), q.names.join('|'));
  assert.ok(!q.names.includes('Chief Mistawasis')); // visible:false employers are hidden, as in the client
}, );

test('map grid places you, home, queue and county border', { skip: !HAVE_GAME && 'game.php missing' }, async () => {
  const st = await makeState();
  const view = { ...st.character.position, zoom: 128 };
  const grid = buildGrid(st, view, 61, 21).map((row) => row.map((s) => s.text).join(''));
  assert.equal(grid[10]![30], '@'); // cursor cell is the centre and holds you
  assert.ok(grid.some((r) => r.includes('H')), 'home town visible');
  assert.ok(grid.some((r) => r.includes('┊') || r.includes('┄')), 'county border visible');
  assert.ok(grid.some((r) => r.includes('j')), 'job locations visible');
  const rect = cursorRect(view, 61, 21);
  assert.ok(rect.x1 <= 29888 && 29888 < rect.x2 && rect.y1 <= 15564 && 15564 < rect.y2);
});

test('entries under the cursor list jobs there; find jumps to nearest job/town', { skip: !HAVE_GAME && 'game.php missing' }, async () => {
  const st = await makeState();
  const pigs = st.world.jobGroups.get(12)![0]!;
  const entries = entriesAt(st, { ...pigs, zoom: 32 }, 41, 11);
  assert.ok(entries.some((e) => e.kind === 'job' && e.option.job.name === 'Tending pigs' && e.option.at === pigs));
  const hit = findNearest(st, 'wroc', st.character.position)!;
  assert.equal(hit.label, 'Wrocław');
});

test('points of interest include towns, fort, quest givers, silver job, markets; sorted by distance', { skip: !HAVE_GAME && 'game.php missing' }, async () => {
  const st = await makeState();
  st.tiles.ingest(JSON.parse(fixture('complete_data')), [[116, 60]]);
  const kinds = new Set(collectPois(st).map((p) => p.kind));
  for (const k of ['me', 'queue', 'home', 'town', 'fort', 'quest', 'silver', 'market', 'friend', 'crowd'] as const) assert.ok(kinds.has(k), k);
  const near = poisNear(st, st.character.position);
  assert.ok(near.every((p, i) => i === 0 || near[i - 1]!.dist <= p.dist));
  assert.equal(poisNear(st, st.character.position, 'silver')[0]!.label, 'Silver job: ' + st.catalog.get(5)!.name);
});

test('walk to town sends TaskWalk(unitId, "town") like Guidepost.start_walk', { skip: !HAVE_GAME && 'game.php missing' }, async () => {
  const st = await makeState();
  const n = st.queue.length;
  await st.walkToTown(st.world.towns.find((t) => t.name === 'Wrocław')!);
  const add = calls.find((c) => c.url.includes('action=add'))!;
  assert.equal(decodeURIComponent(add.body), `tasks[${n}][unitId]=1458&tasks[${n}][type]=town&tasks[${n}][x]=&tasks[${n}][y]=&tasks[${n}][taskType]=walk`);
});

test('TUI: ? help, m map, p points of interest, map select + start job', { skip: !HAVE_GAME && 'game.php missing' }, async () => {
  const st = await makeState();
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { columns: 120, rows: 36, isTTY: true });
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void; ref: () => void; unref: () => void };
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (d) => (out += d.toString()));
  const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const settle = () => new Promise((r) => setTimeout(r, 120));
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      out = '';
      stdin.write(k);
      await settle();
    }
  };
  const app = render(React.createElement(App, { state: st }), { stdout: stdout as any, stdin: stdin as any, exitOnCtrlC: false, patchConsole: false });
  try {
    await settle();
    await press('?');
    assert.match(plain(), /Keyboard shortcuts/);
    await press('x'); // any key closes
    assert.doesNotMatch(plain(), /Keyboard shortcuts/);

    await press('m');
    assert.match(plain(), /County 12/);
    await press('?');
    assert.match(plain(), /Map legend/);
    await press('x');

    // Points of interest: filter "wroc", Enter jumps the map there.
    await press('p');
    assert.match(plain(), /Points of interest/);
    await press('w', 'r', 'o', 'c', '\r');
    const wroclaw = st.world.towns.find((t) => t.name === 'Wrocław')!;
    assert.match(plain(), new RegExp(`cursor ${wroclaw.x - (wroclaw.x % 128)}|Wrocław`));

    // Find Tending pigs with /, select it under the cursor and start the long version.
    await press('/', 'p', 'i', 'g', 's', '\r', '+', '+');
    await press('\r');
    assert.match(plain(), /Tending pigs/);
    const before = calls.filter((c) => c.url.includes('action=add')).length;
    // Move selection to the Tending pigs entry, then start.
    for (let i = 0; i < 10 && !/\x1b\[7m[^\x1b]*Tending pigs/.test(out); i++) await press('j');
    await press('3');
    const adds = calls.filter((c) => c.url.includes('action=add'));
    assert.equal(adds.length, before + 1);
    assert.match(decodeURIComponent(adds.at(-1)!.body), /\[jobId\]=1&.*\[duration\]=3600/);
  } finally {
    app.unmount();
  }
});
