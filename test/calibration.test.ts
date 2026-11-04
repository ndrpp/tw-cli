import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calibration } from '../src/game/calibration.ts';
import { parseJobReport } from '../src/game/mail.ts';
import { questEnds } from '../src/game/quests.ts';

test('calibration: drops blend reports with the game\'s number; HP, rooms and motivation from samples', () => {
  const c = new Calibration(null);
  assert.equal(c.dropRate(4, 'long', 704000, 0.4), 0.4, 'no reports: the game\'s number');
  for (let i = 0; i < 5; i++) c.addJobRun(4, 'long', i < 1 ? [[704000, 2]] : []);
  assert.ok(Math.abs(c.dropRate(4, 'long', 704000, 0.4) - (2 + 0.4 * 5) / 10) < 1e-9, 'half prior, half observed');
  assert.equal(c.hpScale, 1);
  c.addHp(10, 30);
  assert.ok(c.hpScale > 1 && c.hpScale < 3, 'pulled toward 3× by one run');
  assert.equal(c.roomScale, 1);
  c.addRoom(0.2);
  assert.ok(Math.abs(c.roomScale - 0.6) < 1e-9);
  // Motivation: −3 % per run, +1 % per hour.
  assert.deepEqual(c.motivation, { perRun: 0.02, perHour: 0, samples: 0 });
  for (const [runs, hours] of [[2, 1], [0, 3], [4, 0.5], [1, 2]]) c.addMotivation(runs, hours, -0.03 * runs + 0.01 * hours);
  assert.ok(Math.abs(c.motivation.perRun - 0.03) < 1e-9 && Math.abs(c.motivation.perHour - 0.01) < 1e-9);
  c.addLevelUp(true);
  assert.deepEqual(c.data.levelUps, { seen: 1, refilled: 1 });
});

test('job report: job, items and run length for calibration; quest end date', () => {
  const r = parseJobReport({ reportType: 'job', reportInfo: { job_id: 18, items: [[708000, true, 5, 'yield']] }, page: '<div><span>Duration</span><span>1 hour</span></div>' });
  assert.deepEqual(r, { jobId: 18, items: [[708000, 5]], seconds: 3600 });
  assert.equal(parseJobReport({ reportType: 'duel', reportInfo: {} }), null);
  assert.equal(questEnds('This quest is only available from 28.10.2026 at 00:00 until the 16.11.2026 at 12:00.'), Date.UTC(2026, 10, 16, 12, 0) / 1000);
  assert.equal(questEnds(''), null);
});
