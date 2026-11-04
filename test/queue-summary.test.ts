import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueue, queueSummary, walkLeft, workLeft } from '../src/game/tasks.ts';
import { formatClock, shortDuration } from '../src/tui/format.ts';

test('queue summary: done time is the last task end; walk counts wayData legs and walk tasks still ahead', () => {
  const now = 1000;
  const queue = parseQueue([
    // running job, its walk already over
    { queue_id: 1, type: 'job', date_start: 900, date_done: 1600, data: { coords: { x: 1, y: 1 }, wayData: { queue_id: 11, date_start: 800, date_done: 900, data: { coords: { x: 1, y: 1 } } } } },
    // next job with a 300 s walk before it
    { queue_id: 2, type: 'job', date_start: 1900, date_done: 2500, data: { coords: { x: 2, y: 2 }, wayData: { queue_id: 12, date_start: 1600, date_done: 1900, data: { coords: { x: 2, y: 2 } } } } },
    // a plain walk task
    { queue_id: 3, type: 'walk', date_start: 2500, date_done: 2620, data: { coords: { x: 3, y: 3 } } },
  ]);
  assert.equal(walkLeft(queue[0]!, now), 0);
  assert.equal(workLeft(queue[0]!, now), 600);
  assert.equal(walkLeft(queue[1]!, now), 300);
  assert.deepEqual(queueSummary(queue, now), { doneAt: 2620, left: 1620, walk: 420 });
  assert.equal(queueSummary([], now), null);
});

test('formatClock: HH:MM today, weekday prefix otherwise', () => {
  const noon = new Date(2026, 10, 3, 12, 0).getTime() / 1000;
  assert.equal(formatClock(noon + 3600 + 300, noon), '13:05');
  assert.match(formatClock(noon + 86400, noon), /^[A-Z][a-z]{2} 12:00$/);
});

test('shortDuration: seconds under a minute (15 s runs are not "1m")', () => {
  assert.equal(shortDuration(15), '15s');
  assert.equal(shortDuration(600), '10m');
  assert.equal(shortDuration(3600), '1h');
  assert.equal(shortDuration(7800), '2h10');
});
