import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelStartXp } from '../src/game/character.ts';
import { projectTimeline, regenSeconds, type TimelineStart, type TimelineStep } from '../src/game/timeline.ts';

const way = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
// 100 max energy, 10 %/h regen: 1 energy per 360 s.
const start = (o: Partial<TimelineStart> = {}): TimelineStart => ({
  now: 1_000_000, at: { x: 0, y: 0 }, energy: 50, maxEnergy: 100, health: 400, maxHealth: 500,
  energyRegen: 0.1, healthRegen: 0.1, level: 10, experience: levelStartXp(10), cash: 0, ...o,
});
const job = (o: Partial<Extract<TimelineStep, { kind: 'job' }>> = {}): TimelineStep => ({
  kind: 'job', title: 'job', jobId: 1, at: { x: 0, y: 0 }, duration: 3600, energy: 12, xp: 50, money: 100, ...o,
});

test('regenSeconds: time to regenerate, capped at max, Infinity without regen', () => {
  assert.equal(regenSeconds(50, 60, 100, 0.1), 3600);
  assert.equal(regenSeconds(90, 200, 100, 0.1), 3600, 'capped at max');
  assert.equal(regenSeconds(60, 50, 100, 0.1), 0);
  assert.equal(regenSeconds(0, 1, 100, 0), Infinity);
});

test('timeline: travel, energy paid at start, regen during the job, rewards at the end', () => {
  const tl = projectTimeline(start(), [job({ at: { x: 600, y: 0 } })], { wayTime: way });
  const s = tl.steps[0]!;
  assert.equal(s.travel, 600);
  assert.equal(s.start, 1_000_600);
  assert.equal(s.end, 1_004_200);
  assert.ok(Math.abs(s.energyBefore - (50 + 600 / 360)) < 1e-9, 'regen while walking');
  assert.ok(Math.abs(s.energy - (50 + 4200 / 360 - 12)) < 1e-9, 'cost paid, regen during the job');
  assert.equal(s.cash, 100);
  assert.equal(tl.gained.xp, 50);
  assert.deepEqual(tl.final.at, { x: 600, y: 0 });
});

test('timeline: a planned job waits for energy; a server-queued job costs none', () => {
  const short = projectTimeline(start({ energy: 2 }), [job({ energy: 12 })], { wayTime: way });
  assert.ok(Math.abs(short.steps[0]!.waited - 3600) < 1e-6, '10 energy at 1 per 360 s');
  const fixed = projectTimeline(start({ energy: 2 }), [job({ fixed: { start: 999_000, end: 1_001_800 } })], { wayTime: way });
  const f = fixed.steps[0]!;
  assert.equal(f.waited, 0);
  assert.equal(f.start, 1_000_000, 'already running: from now');
  assert.equal(f.end, 1_001_800);
  assert.ok(Math.abs(f.energy - (2 + 5)) < 1e-9, 'no cost, 1800 s of regen');
});

test('timeline: level-up refills energy and health', () => {
  const need = levelStartXp(11) - levelStartXp(10);
  const tl = projectTimeline(start({ energy: 30, health: 100 }), [
    job({ xp: need - 10, energy: 12, duration: 15 }),
    job({ xp: 20, energy: 12, duration: 15 }),
    job({ xp: 5, energy: 12, duration: 15 }),
  ], { wayTime: way });
  const [a, b, c] = tl.steps;
  assert.equal(a!.levelUp, false);
  assert.equal(b!.levelUp, true);
  assert.equal(b!.level, 11);
  assert.equal(b!.energy, 100);
  assert.equal(b!.health, 500);
  assert.ok(c!.energy < 100 && c!.energy > 87, 'the next job pays from the refilled energy');
  assert.equal(tl.gained.levels, 1);
});

test('timeline: sleep until full at room rates, or a partial sleep; cost and actions', () => {
  // Room: 50 %/h energy, 20 %/h health. Energy 20 → 100 takes 1.6 h; health 400 → 500 takes 1 h.
  const sleep: TimelineStep = { kind: 'sleep', title: 'Hotel', at: { x: 0, y: 0 }, energyRate: 0.5, healthRate: 0.2, cost: 25 };
  const full = projectTimeline(start({ energy: 20, cash: 100 }), [sleep], { wayTime: way }).steps[0]!;
  assert.ok(Math.abs(full.end - full.start - 5760) < 1e-6);
  assert.equal(full.energy, 100);
  assert.equal(full.health, 500);
  assert.equal(full.cash, 75);
  const part = projectTimeline(start({ energy: 20 }), [{ ...sleep, seconds: 1800 }], { wayTime: way }).steps[0]!;
  assert.ok(Math.abs(part.energy - 45) < 1e-9, 'wake early: 30 min at 50 %/h');
  const used = projectTimeline(start({ energy: 95 }), [{ kind: 'action', title: 'Coffee', energy: 20, cash: -10 }], { wayTime: way });
  assert.equal(used.steps[0]!.energy, 100, 'capped at max');
  assert.equal(used.final.cash, -10);
  assert.equal(used.end, 1_000_000, 'no time passes');
});

test('autopilot file: defaults, merge of saved values, ranking repaired, bad input ignored', async () => {
  const { parseAutopilotFile, DEFAULT_CONFIG, goalWeights, fingerprint, loadAutopilot, saveAutopilot } = await import('../src/game/autopilot-config.ts');
  const empty = parseAutopilotFile(null);
  assert.deepEqual(empty.config, DEFAULT_CONFIG);
  assert.equal(empty.plan, null);
  const f = parseAutopilotFile({
    config: { running: true, priority: ['xp', 'bogus', 'money'], hp: { sleepBelow: 0.4, wakeAbove: 'x' }, modules: { quests: true }, unknown: 1 },
    rules: { excludedJobs: [5] },
    plan: { fingerprint: 'abc', savedAt: 7, tasks: [] },
  });
  assert.equal(f.config.running, true);
  assert.deepEqual(f.config.priority, ['xp', 'money', 'quests', 'products']);
  assert.deepEqual(f.config.hp, { sleepBelow: 0.4, wakeAbove: 0.7 }, 'wrong types keep the default');
  assert.equal(f.config.modules.quests, true);
  assert.equal(f.config.modules.jobs, true, 'unsaved keys keep the default');
  assert.equal('unknown' in f.config, false);
  assert.deepEqual(f.rules.excludedJobs, [5]);
  assert.equal(f.plan?.fingerprint, 'abc');
  assert.deepEqual(goalWeights(f.config), { xp: 1, money: 0.25, quests: 0.06, products: 0.015 });
  assert.deepEqual(goalWeights({ ...f.config, customWeights: { xp: 60, money: -1 } }), { quests: 0, xp: 60, money: 0, products: 0 });
  assert.equal(fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] }), fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }), 'key order does not matter');
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tw-ap-'));
  try {
    const file = join(dir, 'sub', 'autopilot.json');
    saveAutopilot(f, file);
    assert.deepEqual(loadAutopilot(file), f, 'round trip');
    assert.deepEqual(loadAutopilot(join(dir, 'missing.json')).config, DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autopilot screen: toggles, values and ranking change the saved config; queue projection shown', async () => {
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { AutopilotScreen } = await import('../src/tui/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const { CharacterState } = await import('../src/game/character.ts');
  const { ServerClock } = await import('../src/game/clock.ts');
  const clock = new ServerClock();
  const character = CharacterState.fromInit({ level: 10, experience: levelStartXp(10), energy: 50, maxEnergy: 100, health: 100, cash: 1234, energyRegenFactor: 0.1, pos: { x: 0, y: 0 } }, clock);
  const now = clock.now();
  const saved: unknown[] = [];
  const state: any = {
    autopilot: parseAutopilotFile(null), clock, character, travelSpeed: 1, logs: [] as string[], runner: { plan: null },
    info(m: string) { this.logs.push(m); },
    updateAutopilot(fn: (f: any) => void) { fn(this.autopilot); saved.push(structuredClone(this.autopilot.config)); },
    timeline() {
      return projectTimeline({ now, at: { x: 0, y: 0 }, energy: 50, maxEnergy: 100, health: 100, maxHealth: 100, energyRegen: 0.1, healthRegen: 0, level: 10, experience: levelStartXp(10), cash: 0 },
        [job({ title: 'Cutting tobacco', xp: 45, fixed: { start: now, end: now + 900 } })], { wayTime: way });
    },
  };
  const stdout = new PassThrough() as any;
  Object.assign(stdout, { columns: 120, rows: 40, isTTY: true });
  const stdin = new PassThrough() as any;
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const keys = async (...ks: string[]) => { for (const k of ks) { stdin.write(k); await settle(); } };
  // GameState emits 'change' and the App re-renders; the stub re-renders by hand.
  const el = () => React.createElement(AutopilotScreen, { state, width: 120, height: 38, onCapture: () => {}, onExit: () => {} });
  const app = render(el(), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  try {
    await settle();
    assert.match(plain(), /‖ paused/);
    assert.match(plain(), /1 Quests completed/);
    assert.match(plain(), /Cutting tobacco/);
    assert.match(plain(), /\+45 XP/);
    assert.match(plain(), /In the queue/);
    assert.match(plain(), /Goals  Quests › XP › Money › Products/);
    await keys('J'); // quests down one rank
    assert.deepEqual(state.autopilot.config.priority, ['xp', 'quests', 'money', 'products']);
    await keys('j', 'j', 'j', 'j', ' '); // the "Queue jobs" toggle
    assert.equal(state.autopilot.config.modules.jobs, false);
    await keys('R');
    assert.equal(state.autopilot.config.running, true);
    app.rerender(el());
    await settle();
    assert.match(plain(), /● running/);
    // Down to "below" (HP sleep threshold) and raise it by 5 %.
    for (let i = 0; i < 8; i++) await keys('j');
    await keys('+');
    assert.equal(state.autopilot.config.hp.sleepBelow, 0.55);
    await keys('X');
    assert.equal(state.autopilot.config.running, false);
    assert.match(state.logs.at(-1), /stopped/);
    assert.ok(saved.length >= 5, 'every change is saved');
  } finally {
    app.unmount();
  }
});

// ---- planner ----------------------------------------------------------------------------------

const planJob = (id: number, groupid: number, o: { xp: number; money: number; energy?: number; danger?: number; items?: any[] }): any => ({
  id, groupid, name: `job${id}`, jobPoints: 10, workPoints: 1, laborPoints: 9, motivation: 1, danger: o.danger ?? null, durations: {},
  values: { long: { duration: 3600, energy: o.energy ?? 12, money: o.money, experience: o.xp, luck: 0, items: o.items ?? [] } },
});

async function planWith(o: { start?: Partial<TimelineStart>; config?: (c: any) => void; jobs?: any[]; hotels?: any[]; needs?: any[]; towns?: any[]; consumables?: any[] } = {}) {
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const f = parseAutopilotFile(null);
  o.config?.(f.config);
  const jobs = o.jobs ?? [planJob(1, 1, { xp: 100, money: 10 }), planJob(2, 2, { xp: 10, money: 200 })];
  const locs: Record<number, any[]> = { 1: [{ x: 100, y: 0 }], 2: [{ x: 200, y: 0 }], 3: [{ x: 50, y: 0 }] };
  return planAutopilot({
    start: start(o.start), fixed: [], jobs, locations: (g) => locs[g], wayTime: way, config: f.config, rules: f.rules,
    needs: o.needs ?? [], itemValue: () => 5, hotels: o.hotels ?? [], consumables: o.consumables ?? [], homeTownId: 9, towns: o.towns ?? [], budget: 1000, maxJobs: 6,
  });
}

test('planner: the top goal decides the job; per hour vs per energy', async () => {
  const xp = await planWith({ config: (c) => (c.priority = ['xp', 'money', 'quests', 'products']) });
  assert.equal((xp.tasks[0]!.step as any).jobId, 1);
  assert.match(xp.why, /best XP per energy/);
  const money = await planWith({ config: (c) => (c.priority = ['money', 'xp', 'quests', 'products']) });
  assert.equal((money.tasks[0]!.step as any).jobId, 2);
  assert.ok(money.value > 0);
  const off = await planWith({ config: (c) => (c.modules.jobs = false) });
  assert.equal(off.tasks.length, 0);
  assert.match(off.why, /Queue jobs is off/);
});

test('planner: per hour counts the time to regenerate a run\'s energy (no 15 s runs when energy is short)', async () => {
  const durations = (pct: [number, number, number]) => ({
    short: { duration: 15, energy: 1, money: 25, experience: 5, luck: 0, items: [{ itemId: 700000, expected: pct[0] / 100, percent: pct[0] }] },
    middle: { duration: 600, energy: 5, money: 116, experience: 23, luck: 0, items: [{ itemId: 700000, expected: pct[1] / 100, percent: pct[1] }] },
    long: { duration: 3600, energy: 12, money: 246, experience: 48, luck: 0, items: [{ itemId: 700000, expected: pct[2] / 100, percent: pct[2] }] },
  });
  const jobs = [{ ...planJob(3, 3, { xp: 0, money: 0 }), values: durations([6, 128, 767]) }];
  const needs = [{ key: 'item:700', label: 'Tobacco', amount: 40, unit: 'items', itemId: 700000, quests: ['Q'] }];
  const perHour = (c: any) => (c.per = 'time');
  // 3 energy an hour (the log that found this): energy is the limit, the long run wins.
  const slow = await planWith({ jobs, needs, config: perHour, start: { energyRegen: 0.03 } });
  assert.equal(slow.tasks[0]!.key, 'job:3:long');
  // A fast hotel room makes energy cheap again: still long (12 energy back in ~11 min of sleep).
  const hotels = [{ townId: 9, name: 'Home', at: { x: 0, y: 0 }, rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.64, healthRate: 0.2 }] }];
  assert.equal((await planWith({ jobs, needs, hotels, config: perHour, start: { energyRegen: 0.03 } })).tasks[0]!.key, 'job:3:long');
  // Energy regenerates faster than short runs spend it: per hour, the short run is best (standing at the job).
  const fast = await planWith({ jobs, needs, config: (c) => { perHour(c); c.slotCost = 0; }, start: { energyRegen: 40, at: { x: 50, y: 0 } } });
  assert.equal(fast.tasks[0]!.key, 'job:3:short');
});

test('planner: quest needs come first with Quests on top; dangerous jobs are skipped near the HP threshold', async () => {
  const jobs = [planJob(1, 1, { xp: 100, money: 10 }), planJob(3, 3, { xp: 1, money: 1, items: [{ itemId: 700000, expected: 1, percent: 100 }] })];
  const needs = [{ key: 'item:700', label: 'Ham', amount: 2, unit: 'items', itemId: 700000, quests: ['Q'] }];
  const p = await planWith({ jobs, needs });
  assert.deepEqual(p.tasks.slice(0, 2).map((t) => (t.step as any).jobId), [3, 3], 'two runs cover the 2 ham');
  assert.equal((p.tasks[2]!.step as any).jobId, 1, 'then the next goal (XP)');
  const risky = [planJob(1, 1, { xp: 1000, money: 0, danger: 100 }), planJob(2, 2, { xp: 10, money: 10 })];
  const safe = await planWith({ jobs: risky, start: { health: 270 }, config: (c) => (c.priority = ['xp', 'money', 'quests', 'products']) });
  assert.equal((safe.tasks[0]!.step as any).jobId, 2, '1000 XP job could take HP (270/500) under 50 %');
});

test('planner: out of energy → sleeps until enough to level up when that beats waiting; HP sleep first', async () => {
  const hotels = [{ townId: 9, name: 'Home', at: { x: 0, y: 0 }, rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.5, healthRate: 0.2 }] }];
  const gap = levelStartXp(11) - levelStartXp(10);
  const jobs = [planJob(1, 1, { xp: Math.ceil(gap / 3), money: 0, energy: 10 })];
  const p = await planWith({ jobs, hotels, start: { energy: 0 } });
  const sl = p.tasks[0]!;
  assert.equal(sl.step.kind, 'sleep');
  assert.equal(sl.module, 'energySleep');
  assert.equal(sl.wake!.energy, 30, '3 runs of 10 energy reach the next level');
  assert.match(sl.why!, /enough to level up/);
  assert.deepEqual(sl.post, { town_id: 9, room: 'cubby', taskType: 'sleep' });
  assert.ok(p.timeline.steps.some((s) => s.levelUp), 'the level-up is in the projection');
  const hp = await planWith({ jobs, hotels, start: { health: 100 } });
  assert.equal(hp.tasks[0]!.module, 'hpSleep');
  assert.equal(hp.tasks[0]!.wake!.health, 350, 'up at 70 %');
  const noSleep = await planWith({ jobs, hotels, start: { energy: 0 }, config: (c) => (c.modules.energySleep = false) });
  assert.equal(noSleep.tasks[0]!.step.kind, 'job', 'waits for regen instead');
});

test('planner: banks cash over the limit at home when close, not beyond the detour', async () => {
  const towns = [{ id: 9, name: 'Home', at: { x: 300, y: 0 } }, { id: 8, name: 'Far', at: { x: 9000, y: 0 } }];
  const p = await planWith({ towns, start: { cash: 5000 } });
  assert.deepEqual(p.tasks.slice(0, 2).map((t) => t.step.kind), ['walk', 'action']);
  assert.deepEqual(p.tasks[1]!.action, { type: 'deposit', townId: 9 });
  assert.equal(p.timeline.steps[1]!.cash, 0);
  const far = await planWith({ towns: [towns[1]], start: { cash: 5000 } });
  assert.equal(far.tasks[0]!.step.kind, 'job', 'Far is past the 30 min detour: bank later');
});

test('planner: a queued bank walk gets its deposit first even when the cash projection dips under the limit', async () => {
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const f = parseAutopilotFile(null);
  const towns = [{ id: 9, name: 'Home', at: { x: 300, y: 0 } }];
  const fixed: TimelineStep[] = [{ kind: 'walk', title: 'Home', at: { x: 300, y: 0 }, fixed: { start: 1000, end: 1000 + way({ x: 0, y: 0 }, { x: 300, y: 0 }) } }];
  const plan = (bankTownId?: number) => planAutopilot({
    start: start({ cash: 4000 }), fixed, jobs: [planJob(1, 1, { xp: 100, money: 10 })], locations: () => [{ x: 100, y: 0 }], wayTime: way,
    config: f.config, rules: f.rules, needs: [], itemValue: () => 0, hotels: [], homeTownId: 9, towns, budget: 1000, maxJobs: 3, bankTownId,
  });
  // The live bug: $4,000 < $4,500, so a job went in behind the bank walk and a second walk to town followed it.
  assert.equal(plan().tasks[0]!.step.kind, 'job');
  const p = plan(9);
  assert.deepEqual(p.tasks[0]!.action, { type: 'deposit', townId: 9 });
  assert.match(p.tasks[0]!.why!, /queued bank walk/);
  assert.equal(p.tasks.filter((t) => t.module === 'bank').length, 1, 'no second walk to town');
});

test('consumables: effects parsed from usebonus; energy item when it saves 30+ min, health item instead of a sleep', async () => {
  const { parseConsumable } = await import('../src/game/autopilot.ts');
  assert.deepEqual(parseConsumable(['Energy increase: 15%'], 'single'), { energy: 0.15, health: 0, motivation: 0 });
  assert.deepEqual(parseConsumable(['Health point bonus: 10%', 'Energy increase: 10%'], 'single'), { energy: 0.1, health: 0.1, motivation: 0 });
  assert.deepEqual(parseConsumable(['Work motivation increase: 15%'], 'single'), { energy: 0, health: 0, motivation: 0.15 });
  assert.equal(parseConsumable(['+15 Vigor', 'Uses: 5'], 'buff'), null, 'buffs are not consumables here');
  assert.equal(parseConsumable(['Active waytime shortening: 25%'], 'single'), null);

  const coffee = { itemId: 1, name: 'Gingerbread', count: 1, value: 31, effect: { energy: 0.15, health: 0, motivation: 0 } };
  const cookie = { itemId: 2, name: 'Chocolate cookie', count: 3, value: 29, effect: { energy: 0, health: 0.2, motivation: 0 } };
  const on = (c: any) => (c.modules.consumables = true);
  const p = await planWith({ start: { energy: 0 }, consumables: [coffee], config: on });
  assert.equal(p.tasks[0]!.module, 'consumables');
  assert.deepEqual(p.tasks[0]!.action, { type: 'use', itemId: 1 });
  assert.equal(p.tasks[1]!.step.kind, 'job', 'the 15 energy pays the next run');
  assert.equal(p.tasks.filter((t) => t.module === 'consumables').length, 1, 'only what is above the reserve');
  const off = await planWith({ start: { energy: 0 }, consumables: [coffee] });
  assert.equal(off.tasks[0]!.step.kind, 'job', 'module off: waits for regen');
  const close = await planWith({ start: { energy: 9 }, consumables: [coffee], config: on });
  assert.equal(close.tasks[0]!.step.kind, 'job', '3 energy short regenerates in 18 min: not worth an item');
  const hotels = [{ townId: 9, name: 'Home', at: { x: 0, y: 0 }, rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.5, healthRate: 0.2 }] }];
  const hp = await planWith({ start: { health: 200 }, consumables: [cookie], hotels, config: on });
  assert.deepEqual(hp.tasks[0]!.action, { type: 'use', itemId: 2 }, '200 + 100 lifts HP over 50 % of 500');
  const low = await planWith({ start: { health: 100 }, consumables: [cookie], hotels, config: on });
  assert.equal(low.tasks[0]!.step.kind, 'sleep', '100 + 100 is still under 50 %: sleep');
  const near = await planWith({ start: { energy: 0 }, consumables: [coffee], hotels, config: on });
  assert.equal(near.tasks[0]!.step.kind, 'sleep', 'a hotel within the own-town distance beats an energy item');
  const farHotels = [{ ...hotels[0], at: { x: 1e6, y: 0 } }];
  const far = await planWith({ start: { energy: 0 }, consumables: [coffee], hotels: farHotels, config: on });
  assert.deepEqual(far.tasks[0]!.action, { type: 'use', itemId: 1 }, 'hotel past the own-town distance: the item');
});

test('planner: plans to the 6 h horizon (jobs of any length cover the same time); inserted sleep goes in at its time', async () => {
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const f = parseAutopilotFile(null);
  const hotels = [{ townId: 9, name: 'Home', at: { x: 0, y: 0 }, rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.5, healthRate: 0.2 }] }];
  const input = (rules = f.rules) => ({
    start: start({ energy: 100 }), fixed: [], jobs: [planJob(1, 1, { xp: 100, money: 10, energy: 5 })], locations: () => [{ x: 10, y: 0 }], wayTime: way,
    config: f.config, rules, needs: [], itemValue: () => 0, hotels, towns: [], budget: 1000,
  });
  const p = planAutopilot(input());
  assert.equal(p.tasks.filter((t) => t.step.kind === 'job').length, 6, 'six one-hour jobs reach the horizon');
  assert.ok(p.timeline.end - start().now >= 6 * 3600);
  assert.ok(p.rates.xp > 0, 'the plan carries its exchange rates');
  const at = start().now + 2 * 3600;
  const ins = planAutopilot(input({ ...f.rules, inserts: [{ at, kind: 'sleep' }] }));
  const i = ins.tasks.findIndex((t) => t.key === `insert:sleep:${at}`);
  assert.equal(i, 2, 'after the two jobs that end by then');
  assert.equal(ins.tasks[i]!.step.kind, 'sleep');
});

test('queue view (Q): queued + planned rows; d excludes a planned job, s inserts a sleep, c cancels a queued task', async () => {
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { AutopilotScreen } = await import('../src/tui/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const { ServerClock } = await import('../src/game/clock.ts');
  const clock = new ServerClock();
  const now = clock.now();
  const st = start({ now });
  const steps = [job({ title: 'Queued job', fixed: { start: now, end: now + 600 } }), job({ title: 'Planned job', jobId: 5 })];
  const timeline = projectTimeline(st, steps, { wayTime: way });
  const cancelled: number[] = [];
  const state: any = {
    autopilot: parseAutopilotFile(null), clock, character: { cash: 0 }, logs: [] as string[],
    runner: { plan: { tasks: [{ module: 'jobs', key: 'job:5:long', step: steps[1], why: 'best xp' }], timeline, why: 'best xp', value: 1 } },
    info(m: string) { this.logs.push(m); },
    updateAutopilot(fn: (f: any) => void) { fn(this.autopilot); },
    timeline: () => timeline,
    cancel: async (i: number) => void cancelled.push(i),
  };
  const stdout = new PassThrough() as any;
  Object.assign(stdout, { columns: 140, rows: 30, isTTY: true });
  const stdin = new PassThrough() as any;
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const keys = async (...ks: string[]) => { for (const k of ks) { stdin.write(k); await settle(); } };
  let captured = false;
  const app = render(React.createElement(AutopilotScreen, { state, width: 140, height: 28, onCapture: (c: boolean) => (captured = c), onExit: () => {} }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  try {
    await settle();
    await keys('Q');
    assert.match(plain(), /1 queued · 1 planned/);
    assert.match(plain(), /Queued job[\s\S]*Planned job/);
    assert.equal(captured, true, 'global keys are held off while open');
    await keys('j', 'd');
    assert.deepEqual(state.autopilot.rules.excludedJobs, [5]);
    await keys('s');
    assert.equal(state.autopilot.rules.inserts[0]?.kind, 'sleep');
    await keys('k', 'c', 'y');
    assert.deepEqual(cancelled, [0]);
    await keys('\x1b');
    assert.equal(captured, false);
  } finally {
    app.unmount();
  }
});

test('plan rows: back-to-back runs of a job merge, waits for energy are rows, reasons come from the tasks', async () => {
  const { planRows } = await import('../src/tui/autopilot.ts');
  const st = start({ energy: 30 });
  const steps = [
    job({ title: 'Queued', jobId: 9, fixed: { start: st.now, end: st.now + 600 } }),
    job({ title: 'Cotton', jobId: 2 }), job({ title: 'Cotton', jobId: 2 }),
    job({ title: 'Wheel', jobId: 3, energy: 40 }),
  ];
  const tl = projectTimeline(st, steps, { wayTime: way });
  const tasks = steps.slice(1).map((s, i) => ({ module: 'jobs' as const, key: `t${i}`, step: s, why: `why ${i}` }));
  const rows = planRows(tl, tasks);
  assert.deepEqual(rows.map((r) => [r.title, r.count, r.fixed]), [['Queued', 1, true], ['Cotton', 2, false], ['wait 1h14 for energy', 1, false], ['Wheel', 1, false]]);
  assert.equal(rows[1]!.why, 'why 0', 'a merged row keeps the first reason');
  assert.equal(rows[1]!.xp, 100);
});

test('planner: a job picked for quests says which item, for which quest, and how many are left', async () => {
  const p = await planWith({
    jobs: [planJob(1, 1, { xp: 100, money: 10, items: [{ itemId: 7000, expected: 1, percent: 100 }] })],
    needs: [{ key: 'item:7', label: 'Cotton', amount: 5, unit: 'items', itemId: 7000, quests: ["Farmer's woes"] }],
  });
  assert.equal(p.why, `quest: Cotton for "Farmer's woes" (5 left)`);
  assert.match(p.tasks[1]!.why!, /\(4 left\)/);
});

test('quest rewards: picked by priority; a wearable upgrade always wins', async () => {
  const { chooseReward } = await import('../src/game/autopilot-quests.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const c = parseAutopilotFile(null).config;
  const opts = [{ id: 1, text: '500 Experience points' }, { id: 2, text: '300 Dollars' }, { id: 3, text: 'Bowie knife' }];
  assert.equal(chooseReward(opts, { ...c, priority: ['xp', 'money', 'quests', 'products'] }), 1);
  assert.equal(chooseReward(opts, { ...c, priority: ['money', 'xp', 'quests', 'products'] }), 2);
  assert.equal(chooseReward(opts, c, (t) => t === 'Bowie knife'), 3);
  assert.equal(chooseReward([{ id: 9, text: 'x' }], c), 9);
});

test('duel outlook: needs 2+ results near the level, mostly wins; any loss in 24 h stops NPC duels', async () => {
  const { duelOutlook } = await import('../src/game/autopilot-config.ts');
  const now = 1_000_000;
  const win = (level: number, at = now - 90_000) => ({ at, level, won: true, xp: 40, energy: 10 });
  assert.equal(duelOutlook([win(20)], 20, now), null, 'one result is not enough');
  assert.deepEqual(duelOutlook([win(20), win(22)], 21, now), { xp: 40, energy: 10 });
  assert.equal(duelOutlook([win(20), win(22)], 30, now), null, 'nothing known near level 30');
  assert.equal(duelOutlook([win(20), win(22), { ...win(10), won: false, at: now - 3600 }], 21, now), null, 'lost today: no NPC duels');
  assert.deepEqual(duelOutlook([win(20), win(22), { ...win(40), won: false, at: now - 100_000 }], 21, now), { xp: 40, energy: 10 }, 'an old loss far away does not count');
});

test('planner: a level-up refunds energy, so XP lowers a run\'s energy cost (refill tops up to max)', async () => {
  // Level 10 → 11 takes 393 XP: 300 XP brings back ~76 energy, so the 12-energy run costs its floor of 3.
  const jobs = [planJob(1, 1, { xp: 300, money: 100 }), planJob(2, 2, { xp: 0, money: 110 })];
  const p = await planWith({ jobs, config: (c) => (c.priority = ['money', 'xp', 'quests', 'products']) });
  assert.equal((p.tasks[0]!.step as any).jobId, 1, '$100 for ~3 net energy beats $110 for 12');
});

test('planner: exchange rates are fixed per plan: once a need is nearly met, its crumbs lose to the next goal', async () => {
  const jobs = [planJob(3, 3, { xp: 1, money: 0, items: [{ itemId: 700000, expected: 1, percent: 100 }] }), planJob(1, 1, { xp: 100, money: 0 })];
  const needs = [{ key: 'item:700', label: 'Ham', amount: 1.1, unit: 'items', itemId: 700000, quests: ['Q'] }];
  const p = await planWith({ jobs, needs });
  assert.deepEqual(p.tasks.slice(0, 2).map((t) => (t.step as any).jobId), [3, 1], 'the 0.1 left is worth less than the XP job');
});

test('planner: drops of jobs already queued count toward needs', async () => {
  const jobs = [planJob(3, 3, { xp: 1, money: 0, items: [{ itemId: 700000, expected: 1, percent: 100 }] }), planJob(1, 1, { xp: 100, money: 0 })];
  const needs = [{ key: 'item:700', label: 'Ham', amount: 1, unit: 'items' as const, itemId: 700000, quests: ['Q'] }];
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const f = parseAutopilotFile(null);
  const queued: any = { kind: 'job', title: 'job3', jobId: 3, at: { x: 50, y: 0 }, duration: 3600, energy: 0, xp: 1, money: 0, fixed: { start: 1_000_000, end: 1_003_600 } };
  const p = planAutopilot({
    start: start(), fixed: [queued], jobs, locations: (g) => ({ 1: [{ x: 100, y: 0 }], 3: [{ x: 50, y: 0 }] } as any)[g], wayTime: way, config: f.config, rules: f.rules,
    needs, itemValue: () => 0, hotels: [], towns: [], budget: 1000, maxJobs: 2,
  });
  assert.equal((p.tasks[0]!.step as any).jobId, 1, 'the queued run already brings the ham');
});

test('planner: a queue slot costs time (the TUI is not always open), so runs that fill slots fast lose', async () => {
  const job = { ...planJob(1, 1, { xp: 0, money: 0 }), values: {
    short: { duration: 15, energy: 1, money: 2, experience: 0, luck: 0, items: [] },
    long: { duration: 3600, energy: 12, money: 300, experience: 0, luck: 0, items: [] },
  } };
  const money = (slot: number) => (c: any) => { c.priority = ['money', 'xp', 'quests', 'products']; c.per = 'time'; c.slotCost = slot; };
  const fast = { energyRegen: 40, at: { x: 100, y: 0 } };
  assert.equal((await planWith({ jobs: [job], config: money(0), start: fast })).tasks[0]!.key, 'job:1:short');
  assert.equal((await planWith({ jobs: [job], config: money(600), start: fast })).tasks[0]!.key, 'job:1:long');
});

test('timeline: a level-up raises max HP by lpPerPoint', () => {
  const tl = projectTimeline(start({ experience: levelStartXp(11) - 1, healthPerLevel: 15 }), [job({ xp: 10 })], { wayTime: way });
  assert.equal(tl.final.level, 11);
  assert.equal(tl.final.health, 515);
});
