import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateTracker } from '../src/game/rates.ts';

test('rates: null until 5 min of data, then per hour over the session', () => {
  const result = new RateTracker();
  result.record(0, 1000, 500);
  assert.equal(result.rates(120, 1100, 500), null);
  const xCoord = result.rates(600, 1100, 560)!;
  assert.equal(xCoord.span, 600);
  assert.equal(xCoord.xpH, 600);
  assert.equal(xCoord.moneyH, 360);
});

test('rates: rolling window starts at the newest sample before it; samples thinned to one a minute', () => {
  const result = new RateTracker();
  for (let time = 0; time <= 7200; time += 10) result.record(time, time, -time); // 1 xp/s, −$1/s
  assert.ok(result.samples.length <= 122);
  const xCoord = result.rates(7200, 7200, -7200)!;
  assert.equal(xCoord.span, 3600);
  assert.equal(xCoord.xpH, 3600);
  assert.equal(xCoord.moneyH, -3600);
});
