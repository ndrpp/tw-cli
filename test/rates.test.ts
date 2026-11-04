import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateTracker } from '../src/game/rates.ts';

test('rates: null until 5 min of data, then per hour over the session', () => {
  const r = new RateTracker();
  r.record(0, 1000, 500);
  assert.equal(r.rates(120, 1100, 500), null);
  const x = r.rates(600, 1100, 560)!;
  assert.equal(x.span, 600);
  assert.equal(x.xpH, 600);
  assert.equal(x.moneyH, 360);
});

test('rates: rolling window starts at the newest sample before it; samples thinned to one a minute', () => {
  const r = new RateTracker();
  for (let t = 0; t <= 7200; t += 10) r.record(t, t, -t); // 1 xp/s, −$1/s
  assert.ok(r.samples.length <= 122);
  const x = r.rates(7200, 7200, -7200)!;
  assert.equal(x.span, 3600);
  assert.equal(x.xpH, 3600);
  assert.equal(x.moneyH, -3600);
});
