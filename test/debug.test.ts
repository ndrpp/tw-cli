import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DebugLog, debugJson, diffSnapshots, pruneDebugDir } from '../src/game/debug-log.ts';
import { compactLines, jsonLines } from '../src/tui/debug.ts';

test('debug log: diff of snapshots (lists as added / removed), once() dedupes by title', () => {
  const data = diffSnapshots({ cash: 1, queue: ['a', 'b'], same: 3 }, { cash: 2, queue: ['b', 'c'], same: 3 });
  assert.deepEqual(data, { cash: [1, 2], queue: { added: ['c'], removed: ['a'] } });
  const log = new DebugLog();
  log.once('k', 'autopilot', 'waiting', { energy: 1 });
  log.once('k', 'autopilot', 'waiting', { energy: 2 });
  log.once('k', 'autopilot', 'go');
  assert.deepEqual(
    log.entries.map((entry) => entry.title),
    ['waiting', 'go'],
  );
  assert.equal(
    debugJson({ m: new Map([[1, 2]]), s: new Set([3]), i: Infinity }),
    '{"m":{"1":2},"s":[3],"i":"Infinity"}',
  );
  const at = { x: 1, y: 2 };
  assert.equal(
    debugJson({ a: at, b: [at] }),
    '{"a":{"x":1,"y":2},"b":[{"x":1,"y":2}]}',
    'a shared object is not a cycle',
  );
  const loop: any = { name: 'loop' };
  loop.self = loop;
  assert.equal(debugJson(loop), '{"name":"loop","self":"[cycle]"}');
});

test('debug log: hourly JSONL files, older than 24 h pruned; old sim data dropped from memory only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-debug-'));
  const old = new Date(Date.now() - 26 * 3600_000).toISOString().slice(0, 13);
  const recent = new Date(Date.now() - 20 * 3600_000).toISOString().slice(0, 13);
  writeFileSync(join(dir, `${old}.jsonl`), '{}\n');
  writeFileSync(join(dir, `${recent}.jsonl`), '{}\n');
  writeFileSync(join(dir, 'notes.txt'), 'kept');
  const log = new DebugLog();
  log.dir = dir;
  for (let index = 0; index < 60; index++) {
    log.add('sim', `plan ${index}`, { i: index });
  }
  const files = readdirSync(dir).sort();
  assert.ok(!files.includes(`${old}.jsonl`), 'older than a day: deleted');
  assert.ok(files.includes(`${recent}.jsonl`) && files.includes('notes.txt'));
  const lines = readFileSync(log.file!, 'utf8')
    .trim()
    .split('\n')
    .map((text): any => JSON.parse(text));
  assert.equal(lines.length, 60);
  assert.deepEqual(lines[0].data, { i: 0 }, 'the file keeps everything');
  assert.equal(typeof log.entries[0]!.data, 'string', 'memory keeps the newest 50 snapshots');
  assert.deepEqual(log.entries[59]!.data, { i: 59 });
  assert.deepEqual(pruneDebugDir(dir, Date.now() + 30 * 3600_000).length, 2);
});

test('debug screen: JSON lines are hard-wrapped to the width', () => {
  const lines = jsonLines({ long: 'x'.repeat(50) }, 20);
  assert.ok(lines.every((text) => text.length <= 20));
  assert.equal(lines.join('').replace(/\s/g, '').includes('x'.repeat(10)), true);
  assert.deepEqual(jsonLines(undefined, 20), ['(no data)']);
  assert.deepEqual(compactLines({ energy: '7/100', quests: [{ t: 'a'.repeat(30) }, { t: 'b' }] }, 30).slice(0, 3), [
    'energy: "7/100"',
    'quests: (2)',
    `  • {"t":"${'a'.repeat(20)}`,
  ]);
});
