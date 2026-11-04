// Autopilot runner: the 1 s ticker calls step(). It replans when the inputs' fingerprint changes (checked every
// 2 s, so bursts of updates cause one replan) and, while running, carries the plan out: sends the planned tasks
// as queue space allows, deposits on arrival, cancels a sleep at its wake target, and cancels queued tasks when
// a fresh plan is clearly better. Failures back off 1 → 5 → 15 min; after 3 the step is left out of plans.
import type { FormValue } from '../http/form.ts';
import {
  type Consumable,
  chooseCancel,
  type HotelOption,
  type Plan,
  type PlanInput,
  parseConsumable,
  planAutopilot,
} from './autopilot.ts';
import type { AutopilotFile, PlannedTask } from './autopilot-config.ts';
import { duelOutlook, fingerprint } from './autopilot-config.ts';
import { QuestModule } from './autopilot-quests.ts';
import { DuelApi } from './duels.ts';
import { fetchHotel, roomRate } from './hotel.ts';
import { baseId } from './items.ts';
import { wayTime } from './jobs.ts';
import { MARKET_TTL_MS, SHOP_TTL_MS, where } from './quest-buy.ts';
import type { GameState } from './state.ts';
import { deposit, fetchMobileTrader, fetchShop, MarketApi, SHOPS, type Shop, useItem } from './trade.ts';

const BACKOFF_S = [60, 300, 900] as const;
const backoffSeconds = (attempt: number): number => BACKOFF_S[Math.min(attempt, BACKOFF_S.length) - 1] ?? BACKOFF_S[0];
const HOTEL_TTL_MS = 10 * 60_000;
const CHECK_MS = 2_000;
const CANCEL_CHECK_MS = 30_000;
/** work/index re-read: motivation (calibration and job values) changes as jobs are done. */
const JOBS_REFRESH_MS = 30 * 60_000;
/** Quest shopping: at most this many towns' shops are read (nearest first), one request at a time this far apart. */
const SHOP_TOWNS = 10;
const BUY_SCAN_GAP_MS = 3_000;

export class AutopilotRunner {
  plan: Plan | null = null;
  /** Shown before the first replan: the saved plan of the last run. */
  stale = true;
  private state: GameState;
  private lastPrint = '';
  private lastCheck = 0;
  private hotels = new Map<number, { at: number; option: HotelOption | null }>();
  private failures = new Map<string, { count: number; until: number }>();
  private wakes = new Map<number, { energy: number; health: number }>();
  private lastCancel = 0;
  /** Last cancel check (it plans twice): at most every CANCEL_CHECK_MS, or right after a replan. */
  private lastCancelCheck = 0;
  private jobsAt = Date.now();
  /** Sleeps the autopilot queued: energy and time when queued, to measure the room's real rate on wake-up. */
  private sleeps = new Map<number, { energy: number; at: number; rate: number }>();
  private resumed = false;
  private duelsAt = 0;
  private acting = false;
  /** Why the next fingerprint-driven replan happens, when it is not just "inputs changed". */
  private replanReason: string | null = null;
  private scanning = false;
  private scanAt = 0;

  private quests: QuestModule;

  constructor(state: GameState) {
    this.state = state;
    this.quests = new QuestModule({
      state,
      get config() {
        return state.autopilot.config;
      },
      budget: () => this.budget(),
      spend: (n) => this.spend(n),
      skipped: () => this.skipped(),
      fail: (k, m) => this.fail(k, m),
    });
  }

  private get cfg() {
    return this.state.autopilot.config;
  }

  /** Step keys left out of plans: 3 failures, or still backing off. */
  private skipped(): Set<string> {
    const now = Date.now();
    return new Set([...this.failures].filter(([, f]) => f.count >= 3 || f.until > now).map(([k]) => k));
  }

  private fail(key: string, msg: string): void {
    const f = this.failures.get(key) ?? { count: 0, until: 0 };
    f.count++;
    f.until = Date.now() + backoffSeconds(f.count) * 1000;
    this.failures.set(key, f);
    this.state.debug.add('autopilot', `Failure ${f.count}/3: ${key}`, {
      key,
      msg,
      count: f.count,
      retryAt: new Date(f.until).toISOString(),
    });
    this.state.error(
      `Autopilot: ${msg}${f.count >= 3 ? ' (skipped from now on; plan redone without it)' : ` (retry in ${backoffSeconds(f.count) / 60} min)`}`,
    );
    if (/session|logged out|log in|login/i.test(msg)) this.pause('the session expired; reconnect with r or A');
  }

  pause(why: string): void {
    if (!this.cfg.running) return;
    this.state.updateAutopilot((f) => (f.config.running = false));
    this.state.error(`Autopilot paused: ${why}.`);
  }

  private today(): string {
    return new Date(this.state.clock.nowMs()).toISOString().slice(0, 10);
  }

  private budget(): number {
    const s = this.state.autopilot.spent;
    return Math.max(0, this.cfg.spend.daily - (s.day === this.today() ? s.amount : 0));
  }

  private spend(amount: number): void {
    if (amount <= 0) return;
    const day = this.today();
    this.state.updateAutopilot((f) => (f.spent = { day, amount: (f.spent.day === day ? f.spent.amount : 0) + amount }));
  }

  /** Home town's hotel and the one nearest to where the queue ends (travelTo), fetched at most every 10 min. */
  private hotelOptions(): HotelOption[] {
    const s = this.state;
    const named = s.world.towns.filter((t) => t.name);
    const near = named.length ? named.reduce((a, b) => (s.travelTo(b) < s.travelTo(a) ? b : a)) : undefined;
    const ids = [...new Set([s.character.homeTown?.id, near?.id].filter((x): x is number => !!x))];
    const out: HotelOption[] = [];
    for (const id of ids) {
      const c = this.hotels.get(id);
      if (!c || Date.now() - c.at > HOTEL_TTL_MS) {
        this.hotels.set(id, { at: Date.now(), option: c?.option ?? null });
        void fetchHotel(s.client, id)
          .then((h) => {
            const town = s.world.towns.find((t) => t.id === id);
            if (!town) return;
            this.hotels.set(id, {
              at: Date.now(),
              option: {
                townId: id,
                name: h.townName,
                at: { x: town.x, y: town.y },
                rooms: h.rooms
                  .filter((r) => r.available)
                  .map((r) => ({
                    key: r.key,
                    name: r.name,
                    cost: r.free ? 0 : r.costs,
                    energyRate: roomRate(r.energy) * s.calibration.roomScale,
                    healthRate: roomRate(r.health),
                  })),
              },
            });
            this.lastPrint = ''; // new hotel data: replan
            this.replanReason = 'hotel data';
          })
          .catch(() => {});
      }
      const o = this.hotels.get(id)?.option;
      if (o) out.push(o);
    }
    return out;
  }

  /** Bag items with an energy / health / motivation effect, minus the reserve. */
  private consumables(): Consumable[] {
    const s = this.state;
    if (!s.items) return [];
    const out: Consumable[] = [];
    for (const it of s.inventory.bag.values()) {
      const d = s.items.get(it.itemId);
      const effect = d ? parseConsumable(d.usebonus, d.usetype) : null;
      const count = it.count - this.cfg.consumables.reserve;
      if (d && effect && count > 0) out.push({ itemId: it.itemId, name: d.name, count, value: d.price, effect });
    }
    return out;
  }

  /** Everything the plan depends on, hashed. Server values only (not the regen estimate), so it is stable. */
  private inputs(hotels: HotelOption[]): unknown {
    const s = this.state;
    const c = s.character;
    return {
      // Rounded: queue times come back with sub-ms jitter from the clock offset on every poll.
      queue: s.queue.map((q) => [q.queueId, Math.round(q.end)]),
      c: [c.position, c.level, c.experience, c.cash, c.deposit, Object.values(c.serverValues).map(Math.round)],
      quests: s.quests.map((q) => [q.id, q.requirements.map((r) => r.solved)]),
      needs: s.autopilotNeeds().map((n) => [n.key, n.amount]),
      jobs: s.jobs.map((j) => [j.id, j.motivation, j.jobPoints, j.values.long?.experience]),
      config: { ...this.cfg, running: undefined },
      rules: s.autopilot.rules,
      hotels: hotels.map((h) => [h.townId, h.rooms.length]),
      items: this.consumables().map((c) => [c.itemId, c.count]),
      skip: [...this.skipped()],
      budget: this.budget(),
      buy: [s.buyCatalog.version, s.autopilot.pickups.length],
    };
  }

  /** A plan from these inputs; `rates` keeps a cancel check's alternatives in the current plan's units. */
  private snapshot(
    fixedQueue = this.state.queue,
    energyBonus = 0,
    hotels = this.hotelOptions(),
    rates = this.plan?.rates,
  ): Plan {
    return planAutopilot({ ...this.planInput(fixedQueue, energyBonus, hotels), rates });
  }

  /** Jobs with drop rates blended with what job reports showed (calibration.ts). */
  private calibratedJobs(): GameState['jobs'] {
    const cal = this.state.calibration;
    if (!Object.keys(cal.data.drops).length) return this.state.jobs;
    return this.state.jobs.map((j) => ({
      ...j,
      values: Object.fromEntries(
        Object.entries(j.values).map(([k, v]) => [
          k,
          v && {
            ...v,
            items: v.items?.map((i) => ({ ...i, expected: cal.dropRate(j.id, k, i.itemId, i.expected) })),
          },
        ]),
      ),
    }));
  }

  private planInput(fixedQueue = this.state.queue, energyBonus = 0, hotels = this.hotelOptions()): PlanInput {
    const s = this.state;
    const c = s.character;
    return {
      start: {
        now: s.clock.now(),
        at: c.position,
        energy: Math.min(c.maxEnergy, c.energy + energyBonus),
        maxEnergy: c.maxEnergy,
        health: c.health,
        maxHealth: c.maxHealth,
        energyRegen: c.energyRegen,
        healthRegen: c.healthRegen,
        level: c.level,
        experience: c.experience,
        maxLevel: c.maxLevel,
        cash: c.cash,
        healthPerLevel: c.lpPerPoint,
      },
      fixed: fixedQueue.map((t) => s.queuedStep(t)),
      jobs: this.calibratedJobs(),
      locations: (g) => s.locations.get(g),
      wayTime: (a, b) => wayTime(a, b, s.travelSpeed, c.speed),
      config: this.cfg,
      rules: s.autopilot.rules,
      needs: s.autopilotNeeds(),
      itemValue: (id) => s.items?.get(id)?.sell ?? 0,
      hotels,
      consumables: this.consumables(),
      homeTownId: c.homeTown?.id,
      towns: s.world.towns.flatMap((t) => (t.name ? [{ id: t.id, name: t.name, at: { x: t.x, y: t.y } }] : [])),
      bankTownId: this.bankWalk()?.townId,
      buyTrips: s.buyTrips(),
      budget: this.budget(),
      skip: this.skipped(),
      motivation: s.calibration.motivation,
      hpScale: s.calibration.hpScale,
    };
  }

  /**
   * What the autopilot sees right now, for the debug log and screen: energy, HP, where you are and how far the
   * home / nearest town is, the bag, and every open quest with its requirements and the nearest place to get each.
   */
  context(): Record<string, unknown> {
    const s = this.state;
    const c = s.character;
    const way = (to: { x: number; y: number }) => Math.round(wayTime(c.position, to, s.travelSpeed, c.speed));
    const named = s.world.towns.filter((t) => t.name);
    const nearest = named.length ? named.reduce((a, b) => (way(b) < way(a) ? b : a)) : undefined;
    const home = c.homeTown;
    const homeTown = home ? s.world.towns.find((t) => t.id === home.id) : undefined;
    const needs = s.autopilotNeeds();
    return {
      energy: `${c.energy}/${c.maxEnergy}`,
      health: `${c.health}/${c.maxHealth}`,
      homeTown: home
        ? { name: homeTown?.name ?? `town ${home.id}`, at: { x: home.x, y: home.y }, seconds: way(home) }
        : null,
      nearestTown: nearest ? { name: nearest.name, at: { x: nearest.x, y: nearest.y }, seconds: way(nearest) } : null,
      position: c.position,
      townHere: s.townHere?.name ?? null,
      queueEnd: s.queueEndPosition,
      quests: s.quests.map((q) => ({
        id: q.id,
        title: q.title,
        chain: q.group,
        finishable: q.finishable,
        inScope: needs.some((n) => n.quests.includes(q.soloTitle || q.title)) || undefined,
        blocker: s.questBlocker(q) ?? undefined,
        buy: (() => {
          const p = s.questPurchase(q);
          return p.needs.length
            ? {
                needs: p.needs,
                picks: p.picks.map((x) => ({ item: x.name, count: x.count, cost: x.cost, from: where(x.source) })),
                problem: p.problem ?? undefined,
              }
            : undefined;
        })(),
        giver: q.employerName,
        giverSeconds: q.employerAt ? way(q.employerAt) : null,
        requirements: q.requirements.map((r) => {
          const src = r.solved ? [] : s.requirementSources(r).sort((a, b) => (a.way ?? Infinity) - (b.way ?? Infinity));
          return {
            info: r.info,
            kind: r.kind,
            solved: r.solved,
            have: r.itemId !== undefined ? s.inventory.countBase(r.itemId) : undefined,
            need: r.count,
            nearest: src[0]
              ? {
                  job: src[0].job.name,
                  at: src[0].at,
                  seconds: src[0].way === null ? null : Math.round(src[0].way),
                  chance: src[0].chance,
                  fromQueueEnd: true,
                }
              : undefined,
            sources: src.length || undefined,
          };
        }),
      })),
      inventory: [...s.inventory.bag.values()].map((b) => ({
        id: b.itemId,
        name: s.itemName(b.itemId),
        count: b.count,
      })),
      consumables: this.consumables().map((x) => ({ name: x.name, usable: x.count, effect: x.effect })),
      worn: Object.fromEntries([...s.inventory.wear].map(([slot, id]) => [slot, s.itemName(id)])),
      queue: s.queue.map((q) => ({
        title: q.title,
        type: q.type,
        start: new Date(q.start * 1000).toISOString(),
        end: new Date(q.end * 1000).toISOString(),
      })),
      taskLimit: s.taskLimit,
      now: new Date(s.clock.now() * 1000).toISOString(),
      running: this.cfg.running,
      dryRun: this.cfg.modules.dryRun,
      busy: s.busy,
      server: c.serverValues,
      regen: { energyPerHour: c.energyRegen, healthPerHour: c.healthRegen },
      level: c.level,
      experience: c.experience,
      cash: c.cash,
      deposit: c.deposit,
      budgetLeft: this.budget(),
      needs,
      buyTrips: s.buyTrips(),
      pickups: s.autopilot.pickups,
      shopsRead: [...s.buyCatalog.shops].map(([id, c]) => ({
        town: s.world.towns.find((t) => t.id === id)?.name ?? id,
        at: new Date(c.at).toISOString(),
        shops: c.shops.map((x) => `${x.key} (${x.items.length})`),
      })),
      calibration: s.calibration.summary(),
      rates: this.plan?.rates,
      failures: Object.fromEntries(
        [...this.failures].map(([k, f]) => [k, { count: f.count, until: new Date(f.until).toISOString() }]),
      ),
    };
  }

  /** The planner's input without functions, compact enough for the log (jobs: values per duration). */
  private debugInput(input: PlanInput): Record<string, unknown> {
    const { jobs, locations, wayTime: _w, itemValue: _v, skip, ...rest } = input;
    return {
      ...rest,
      skip: [...(skip ?? [])],
      jobs: jobs.map((j) => ({
        id: j.id,
        groupid: j.groupid,
        name: j.name,
        motivation: j.motivation,
        danger: j.danger,
        doable: j.jobPoints >= j.workPoints,
        excluded: input.rules.excludedJobs.includes(j.id) || undefined,
        locations: locations(j.groupid)?.length ?? 0,
        values: Object.fromEntries(
          Object.entries(j.values).map(([k, v]) => [
            k,
            v && {
              s: v.duration,
              e: v.energy,
              xp: v.experience,
              $: v.money,
              items: v.items?.map((i) => [i.itemId, i.percent]),
            },
          ]),
        ),
      })),
    };
  }

  /** The plan as logged: tasks with why / value / wake, and the timeline's per-step states. */
  private debugOutput(plan: Plan): Record<string, unknown> {
    return {
      why: plan.why,
      value: plan.value,
      tasks: plan.tasks.map((t) => ({
        key: t.key,
        module: t.module,
        step: t.step,
        why: t.why,
        value: t.value,
        wake: t.wake,
        action: t.action,
      })),
      timeline: plan.timeline.steps.map(({ step, ...st }) => ({ step: step.title, ...st })),
      final: plan.timeline.final,
      end: plan.timeline.end,
    };
  }

  /** Replans now (debounced by the caller); logs what changed. */
  replan(reason = 'inputs changed'): Plan {
    const old = this.state.clock.now() - 6 * 3600;
    if (this.state.autopilot.rules.inserts.some((x) => x.at < old))
      this.state.updateAutopilot((f) => (f.rules.inserts = f.rules.inserts.filter((x) => x.at >= old)));
    const hotels = this.hotelOptions();
    const print = fingerprint(this.inputs(hotels));
    const prev = this.plan;
    const input = this.planInput(undefined, 0, hotels);
    const plan = planAutopilot(input);
    this.plan = plan;
    this.state.debug.add(
      'sim',
      `Replan (${reason}): ${plan.tasks.length} task(s), next ${plan.tasks[0]?.step.title ?? 'nothing'}`,
      {
        reason,
        context: this.context(),
        input: this.debugInput(input),
        output: this.debugOutput(plan),
      },
    );
    this.stale = false;
    this.lastPrint = print;
    this.state.updateAutopilot((f) => (f.plan = { fingerprint: print, savedAt: Date.now(), tasks: plan.tasks }));
    const next = plan.tasks[0]?.step.title ?? 'nothing';
    if (!prev || prev.tasks[0]?.key !== plan.tasks[0]?.key || prev.tasks.length !== plan.tasks.length) {
      this.state.info(`Autopilot replanned (${reason}): ${plan.tasks.length} task(s), next ${next}. ${plan.why}`);
    }
    return plan;
  }

  /** Called every second by the TUI ticker. */
  async step(): Promise<void> {
    const s = this.state;
    if (s.startup && !s.startup.done) return;
    if (this.acting || s.busy) return;
    const now = Date.now();
    if (now - this.lastCheck >= CHECK_MS) {
      this.lastCheck = now;
      const print = fingerprint(this.inputs(this.hotelOptions()));
      if (print !== this.lastPrint) {
        this.replan(this.replanReason ?? (this.plan ? 'inputs changed' : 'start'));
        this.replanReason = null;
      }
      this.scanBuySources();
      if (now - this.jobsAt >= JOBS_REFRESH_MS) {
        this.jobsAt = now;
        void s.loadJobs(true);
      }
      if (this.cfg.running && !this.resumed) {
        this.resumed = true;
        s.info('Autopilot resumed.');
      }
    }
    const d = s.debug;
    if (!this.cfg.running || this.cfg.modules.dryRun || !this.plan) {
      d.once(
        'gate',
        'autopilot',
        !this.plan
          ? 'Idle: no plan yet'
          : !this.cfg.running
            ? 'Idle: paused (plans only)'
            : 'Idle: dry run (plans only, sends nothing)',
      );
      return;
    }
    d.once('gate', 'autopilot', 'Acting: running');
    this.acting = true;
    try {
      if (await this.wakeUp()) return;
      if (await this.maybeCancelForBetter()) return;
      if (this.cfg.modules.quests && (await this.quests.step())) return;
      if (this.cfg.modules.npcDuels && this.cfg.duels.forXp && (await this.duelForXp())) return;
      await this.carryOut();
    } finally {
      this.acting = false;
    }
  }

  /**
   * NPC duel for XP, between tasks: HP ≥ 70 %, NPC level ≤ duel level + margin, ready, and the duel record says
   * that level is won and pays more XP per energy than the best planned job. Never players.
   */
  private async duelForXp(): Promise<boolean> {
    const s = this.state;
    const c = s.character;
    if (s.queue.length || c.health < 0.7 * c.maxHealth || Date.now() - this.duelsAt < 5 * 60_000) return false;
    this.duelsAt = Date.now();
    s.debug.add('autopilot', 'NPC duels: checking', {
      health: c.health,
      maxHealth: c.maxHealth,
      duelLevel: c.duelLevel,
      levelMargin: this.cfg.duels.levelMargin,
    });
    let data: Awaited<ReturnType<DuelApi['data']>>;
    try {
      data = await s.autopilotCall(() => new DuelApi(s.client).data(), 'duel data');
      s.duels = data;
    } catch {
      return false;
    }
    const job = this.plan?.tasks.find((t) => t.step.kind === 'job')?.step;
    const jobRate = job && job.kind === 'job' && job.energy > 0 ? job.xp / job.energy : 0;
    const now = s.clock.now();
    const best = data.npcs
      .filter(
        (n) =>
          n.readyIn <= 0 && n.level <= c.duelLevel + this.cfg.duels.levelMargin && !this.skipped().has(`duel:${n.id}`),
      )
      .map((n) => ({ n, o: duelOutlook(s.autopilot.duels, n.level, now) }))
      .filter(
        (x): x is { n: typeof x.n; o: { xp: number; energy: number } } =>
          !!x.o && x.o.energy <= c.energy && x.o.xp / x.o.energy > jobRate,
      )
      .sort((a, b) => b.o.xp / b.o.energy - a.o.xp / a.o.energy)[0];
    s.debug.add('autopilot', best ? `NPC duels: fight ${best.n.name}` : 'NPC duels: none worth it', {
      jobXpPerEnergy: jobRate,
      npcs: data.npcs.map((n) => ({
        id: n.id,
        name: n.name,
        level: n.level,
        readyIn: n.readyIn,
        outlook: duelOutlook(s.autopilot.duels, n.level, now),
      })),
    });
    if (!best) return false;
    s.info(
      `Autopilot: NPC duel ${best.n.name} (level ${best.n.level}): ~${Math.round(best.o.xp)} XP for ~${Math.round(best.o.energy)} energy beats the best job.`,
    );
    await s.fightNpc(best.n.id);
    if (s.lastNpcDuel?.died) this.pause('lost an NPC duel (passed out)');
    this.lastPrint = '';
    return true;
  }

  /** Cancels a running sleep once live energy and health confirm its wake target. */
  private async wakeUp(): Promise<boolean> {
    const s = this.state;
    const head = s.queue[0];
    if (head?.type !== 'sleep') return false;
    const wake = this.wakes.get(head.queueId);
    if (!wake) return false;
    const c = s.character;
    if (c.energy < wake.energy || c.health < wake.health) {
      s.debug.once(
        'wake',
        'autopilot',
        `Sleeping: waiting for wake target (energy ≥ ${Math.round(wake.energy)}, HP ≥ ${Math.round(wake.health)})`,
        { sleep: head.title, wake },
      );
      return false;
    }
    try {
      const before = c.energy;
      s.debug.add('autopilot', 'Wake-up: target reached, cancelling the sleep', {
        energy: c.energy,
        health: c.health,
        wake,
        sleep: head.title,
      });
      const res = await s.autopilotCall(() => s.tasks.cancel(s.queue, [0]), 'cancel sleep (wake-up)');
      s.queue = res.queue;
      if (res.energy !== undefined) c.setEnergy(res.energy);
      this.wakes.delete(head.queueId);
      this.measureRoom(head, res.energy);
      s.info(`Autopilot: woke up (energy ${before}/${wake.energy}, HP ${c.health}/${Math.round(wake.health)}).`);
      void s.syncCharacter('after wake-up'); // checks the sleep kept its energy (unverified until seen live)
    } catch (err) {
      this.fail(`wake:${head.queueId}`, `wake-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  /**
   * The room's real energy rate from a sleep the autopilot queued and cancelled: energy at the start (the value
   * when queued plus base regen until the sleep began) against the server's energy after the cancel. Counted
   * only when uncapped (below max) and after 15+ minutes of sleep.
   */
  private measureRoom(t: GameState['queue'][number], after: number | undefined): void {
    const s = this.state;
    const c = s.character;
    const q = this.sleeps.get(t.queueId);
    this.sleeps.delete(t.queueId);
    if (!q || after === undefined || q.rate <= 0) return;
    const now = s.clock.now();
    const begin = Math.max(q.at, t.start);
    const hours = (now - begin) / 3600;
    const startEnergy = Math.min(
      c.maxEnergy,
      q.energy + (c.maxEnergy * c.energyRegen * Math.max(0, begin - q.at)) / 3600,
    );
    if (hours < 0.25 || after >= c.maxEnergy - 1)
      return void s.debug.add('autopilot', 'Room rate: not measured (short or capped sleep)', {
        hours,
        startEnergy,
        after,
      });
    const rate = (after - startEnergy) / (c.maxEnergy * hours);
    s.calibration.addRoom(rate / q.rate);
    s.debug.add(
      'autopilot',
      `Room rate measured: ${(rate * 100).toFixed(1)} % / h vs ${(q.rate * 100).toFixed(1)} % read`,
      { hours, startEnergy, after, roomScale: s.calibration.roomScale },
    );
  }

  /**
   * Cancels the queue from some position on when replanning from there is better by the margin over the
   * horizon, or about as good (within `sameWithin`) with `walkSaved` less walking (a walk to town, a job outside
   * it, a walk back). Every cut point is tried; the running task is kept (its energy is not refunded). At most
   * one cancel per cooldown.
   */
  private async maybeCancelForBetter(): Promise<boolean> {
    const s = this.state;
    const cfg = this.cfg;
    if (s.queue.length === 0 || Date.now() - this.lastCancel < cfg.cancel.cooldown * 1000 || !this.plan) return false;
    // Construction is a manual town task the autopilot never plans; leave it alone.
    if (s.queue.some((t) => t.type === 'build')) return false;
    if (Date.now() - this.lastCancelCheck < CANCEL_CHECK_MS) return false;
    this.lastCancelCheck = Date.now();
    const refund = (from: number) =>
      s.queue.slice(from).reduce((a, t) => a + (t.type === 'job' ? this.jobEnergy(t) : 0), 0);
    const option = (from: number) => {
      const p = this.snapshot(s.queue.slice(0, from), refund(from));
      return {
        from,
        value: p.value + p.queuedValue,
        walk: Math.round(p.walk),
        next: p.tasks.slice(0, 5).map((t) => t.step.title),
      };
    };
    const cur = option(s.queue.length);
    const running = (s.queue[0]?.start ?? Number.POSITIVE_INFINITY) <= s.clock.now();
    const cuts = Array.from({ length: s.queue.length - (running ? 1 : 0) }, (_, i) => option(i + (running ? 1 : 0)));
    const pick = chooseCancel(cur, cuts, cfg.cancel);
    const cmp = {
      current: cur,
      cuts,
      margin: cfg.cancel.margin,
      sameWithin: cfg.cancel.sameWithin,
      walkSaved: cfg.cancel.walkSaved,
      threshold: cur.value * (1 + cfg.cancel.margin),
      queue: s.queue.map((t) => t.title),
      pick: pick ?? null,
    };
    if (!pick) {
      s.debug.once(
        'cancel',
        'autopilot',
        `Cancel check: keep the queue (${s.queue.map((t) => t.title).join(', ')})`,
        cmp,
      );
      return false;
    }
    const positions = s.queue
      .map((_, i) => i)
      .slice(pick.from)
      .reverse();
    const titles = s.queue
      .slice(pick.from)
      .map((t) => t.title)
      .join(', ');
    const reason =
      pick.why === 'better'
        ? `a fresh plan is ${Math.round((pick.value / cur.value - 1) * 100)}% better over ${Math.round(cfg.cancel.horizon / 3600)} h`
        : `about the same value (${((pick.value / cur.value - 1) * 100).toFixed(1)}%), ${Math.round((cur.walk - pick.walk) / 60)} min less walking`;
    s.debug.add(
      'autopilot',
      `Cancel check: cancelling ${titles} (${pick.why === 'better' ? 'better plan' : 'less walking'})`,
      { ...cmp, positions },
    );
    try {
      const res = await s.autopilotCall(() => s.tasks.cancel(s.queue, positions), `cancel ${titles}`);
      s.queue = res.queue;
      if (res.energy !== undefined) s.character.setEnergy(res.energy);
      this.lastCancel = Date.now();
      s.info(`Autopilot: cancelled ${titles}: ${reason}.`);
      this.replan(pick.why === 'better' ? 'cancelled for a better plan' : 'cancelled for less walking');
    } catch (err) {
      this.fail('cancel', `cancel failed: ${err instanceof Error ? err.message : String(err)}`);
      this.lastCancel = Date.now();
    }
    return true;
  }

  /** Energy a queued job cost: the value for its duration (a short job refunds 1, not the long job's 12). */
  private jobEnergy(t: GameState['queue'][number]): number {
    const j = this.state.jobs.find((x) => x.id === t.jobId);
    if (!j) return 0;
    const secs = t.end - (t.way?.end ?? t.start);
    const vs = Object.values(j.values).filter((v) => !!v);
    const first = vs[0];
    if (!first) return 0;
    return vs.reduce((a, b) => (Math.abs(b.duration - secs) < Math.abs(a.duration - secs) ? b : a), first).energy ?? 0;
  }

  /** Sends the next planned tasks the queue has room for; runs an on-the-spot action when its turn comes. */
  private async carryOut(): Promise<void> {
    const s = this.state;
    const tasks = this.plan?.tasks ?? [];
    const first = tasks[0];
    if (!first) return void s.debug.once('carry', 'autopilot', 'Carry out: nothing planned', { why: this.plan?.why });
    if (first.action) {
      if (s.queue.length)
        return void s.debug.once('carry', 'autopilot', `Carry out: ${first.step.title} waits for the queue to finish`, {
          task: first,
          queue: s.queue.length,
        });
      s.debug.add('autopilot', `Carry out: ${first.step.title}`, { task: first, why: first.why });
      await this.act(first);
      return;
    }
    const free = s.taskLimit - s.queue.length;
    if (free <= 0)
      return void s.debug.once('carry', 'autopilot', `Carry out: queue full (${s.queue.length}/${s.taskLimit})`);
    const batch: PlannedTask[] = [];
    let stop = 'end of plan';
    for (const t of tasks) {
      if (batch.length >= free) {
        stop = `queue room (${free})`;
        break;
      }
      if (t.action || !t.post) {
        stop = `${t.step.title} is an on-the-spot action`;
        break;
      }
      // Jobs pay energy when queued: only what the current energy covers.
      const left = s.character.energy - batch.reduce((a, b) => a + (b.step.kind === 'job' ? b.step.energy : 0), 0);
      if (t.step.kind === 'job' && t.step.energy > left) {
        stop = `${t.step.title} needs ${t.step.energy} energy, ${left} left`;
        break;
      }
      batch.push(t);
      if (t.step.kind === 'sleep') {
        stop = 'a sleep ends the batch';
        break;
      } // later tasks depend on its wake-up
    }
    if (!batch.length)
      return void s.debug.once('carry', 'autopilot', `Carry out: waiting (${stop.replace(/, \d+ left$/, '')})`, {
        stop,
        energy: s.character.energy,
        next: tasks[0],
      });
    s.debug.add('autopilot', `Carry out: queue ${batch.map((b) => b.step.title).join(', ')}`, {
      stop,
      energy: s.character.energy,
      free,
      batch: batch.map((b) => ({ key: b.key, why: b.why, step: b.step, post: b.post })),
    });
    try {
      const res = await s.autopilotCall(
        () =>
          s.tasks.add(
            s.queue.length,
            batch.map((b) => b.post as Record<string, FormValue>),
            s.taskLimit,
          ),
        'queue tasks',
      );
      // Jobs cost their energy when queued; without a server value, subtract what was accepted.
      if (res.energy !== undefined) s.character.setEnergy(res.energy);
      else if (res.added.length)
        s.character.setEnergy(
          s.character.energy -
            batch.slice(0, res.added.length).reduce((a, b) => a + (b.step.kind === 'job' ? b.step.energy : 0), 0),
        );
      s.queue.push(...res.added);
      res.added.forEach((q, i) => {
        const t = batch[i];
        if (!t) return;
        if (t.key.startsWith('insert:')) this.dropInsert(t.key);
        const deposit = tasks[tasks.indexOf(t) + 1]?.action;
        if (t.step.kind === 'walk' && deposit?.type === 'deposit')
          s.updateAutopilot((f) => (f.bankWalk = { queueId: q.queueId, townId: deposit.townId }));
        if (t.step.kind === 'sleep') {
          if (t.wake) this.wakes.set(q.queueId, t.wake);
          s.sleepRates.set(q.queueId, { energyRate: t.step.energyRate, healthRate: t.step.healthRate });
          this.sleeps.set(q.queueId, {
            energy: s.character.energy,
            at: s.clock.now(),
            rate: t.step.energyRate / s.calibration.roomScale,
          });
          this.spend(t.step.cost ?? 0);
        }
      });
      if (res.added.length)
        s.info(`Autopilot: queued ${res.added.map((q) => q.title).join(', ')}. ${batch[0]?.why ?? ''}`);
      const failed = batch.slice(res.added.length)[0];
      // "You need at least N more energy points": our energy estimate ran ahead of the server's. Correct it and
      // replan (towards a sleep or an item) instead of backing the job off as if it had failed.
      const short = Number(/at least (\d+) more energy/i.exec(res.errors.join(' '))?.[1]);
      if (failed?.step.kind === 'job' && short > 0) {
        s.character.setEnergy(Math.max(0, failed.step.energy - short));
        s.info(
          `Autopilot: ${failed.step.title} needs ${short} more energy than the server has; energy corrected to ${s.character.energy}.`,
        );
      } else if (failed)
        this.fail(failed.key, `${failed.step.title} refused${res.errors.length ? `: ${res.errors.join('; ')}` : ''}`);
      this.replan('queued');
    } catch (err) {
      const head = batch[0];
      if (head) this.fail(head.key, `${head.step.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Fills the buy catalog for quest items no job drops (Quests module, buying on): the mobile trader, the shops
   * of the nearest towns within the buy trip, market offers. One read at a time, in the background like hotel
   * data (also while paused or in dry run: reads only); each answer is a planner input, so it replans.
   */
  private scanBuySources(): void {
    const s = this.state;
    const cfg = this.cfg;
    if (
      !cfg.modules.quests ||
      !cfg.quests.buy ||
      this.scanning ||
      Date.now() - this.scanAt < BUY_SCAN_GAP_MS ||
      !s.items
    )
      return;
    // Items of quests that buying could unblock (a "Go to …" quest is not worth a read).
    const wanted = new Map<number, string>();
    for (const q of s.autopilotQuests(true)) {
      const p = s.questPurchase(q);
      if (!p.blocker) for (const n of p.needs) wanted.set(baseId(n.itemId), n.name);
    }
    if (!wanted.size) return;
    const cat = s.buyCatalog;
    let job: { what: string; run: () => Promise<void> } | null = null;
    if (cat.mobileStale()) {
      job = { what: 'mobile trader', run: async () => cat.setMobile(await fetchMobileTrader(s.client)) };
    }
    if (!job) {
      const from = s.queueEndPosition;
      const far = (t: { x: number; y: number }) => wayTime(from, t, s.travelSpeed, s.character.speed);
      const town = s.world.towns
        .filter((t) => t.name && far(t) <= cfg.quests.buyTrip)
        .sort((a, b) => far(a) - far(b))
        .slice(0, SHOP_TOWNS)
        .find((t) => Date.now() - (cat.shops.get(t.id)?.at ?? 0) > SHOP_TTL_MS);
      if (town)
        job = {
          what: `shops in ${town.name}`,
          run: async () => {
            const shops: Shop[] = [];
            // Read from anywhere (the trade screen does it for the home town; other towns unverified).
            for (const def of SHOPS)
              shops.push(
                ...(await fetchShop(s.client, def.key, town.id).then(
                  (x) => [x],
                  () => [],
                )),
              );
            cat.setShops(town.id, shops);
          },
        };
    }
    if (!job && cfg.quests.market) {
      const item = [...wanted].find(([id]) => Date.now() - (cat.market.get(id)?.at ?? 0) > MARKET_TTL_MS);
      if (item)
        job = {
          what: `market: ${item[1]}`,
          run: () =>
            new MarketApi(s.client).search(item[1]).then(
              (r) => cat.setMarket(item[0] * 1000, r.offers),
              (err) => {
                cat.setMarket(item[0] * 1000, []);
                throw err;
              },
            ),
        };
    }
    if (!job) return;
    const j = job;
    this.scanning = true;
    const t0 = Date.now();
    void j
      .run()
      .then(
        () =>
          s.debug.add('quest', `Buy sources: read ${j.what} (${Date.now() - t0} ms)`, { wanted: [...wanted.values()] }),
        (err) => {
          s.debug.add('quest', `Buy sources: reading ${j.what} failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
          // Do not retry at once: mark it read (empty) until the TTL passes.
          if (j.what === 'mobile trader') cat.setMobile({ items: [], changesAt: null });
        },
      )
      .finally(() => {
        this.scanning = false;
        this.scanAt = Date.now();
        this.replanReason = `buy sources (${j.what})`;
      });
  }

  /** The queued bank walk still owed a deposit: while it is queued or you stand in its town; forgotten otherwise. */
  private bankWalk(): AutopilotFile['bankWalk'] {
    const s = this.state;
    const w = s.autopilot.bankWalk;
    if (!w) return null;
    if (s.queue.some((q) => q.queueId === w.queueId) || s.townHere?.id === w.townId) return w;
    s.debug.add('autopilot', 'Bank walk gone without a deposit: forgotten', {
      bankWalk: w,
      position: s.character.position,
    });
    s.updateAutopilot((f) => (f.bankWalk = null));
    return null;
  }

  /** An inserted step was carried out: its rule is done. */
  private dropInsert(key: string): void {
    const [, kind, at] = key.split(':');
    this.state.updateAutopilot(
      (f) => (f.rules.inserts = f.rules.inserts.filter((x) => !(x.kind === kind && String(x.at) === at))),
    );
  }

  private async act(t: PlannedTask): Promise<void> {
    const s = this.state;
    if (t.action?.type === 'use') {
      const itemId = t.action.itemId;
      try {
        const r = await s.autopilotCall(
          () => useItem(s.client, itemId, 1, s.inventory.lastInvId, (id) => s.itemName(id)),
          `use ${s.itemName(itemId)}`,
        );
        s.inventory.applyChanges(r.changes);
        if (r.energy !== undefined) s.character.setEnergy(r.energy);
        if (r.health !== undefined) s.character.setHealth(r.health);
        s.info(
          `Autopilot: used ${s.itemName(itemId)}${r.effects.length ? `: ${r.effects.join(' ')}` : ''} (${t.why ?? ''}).`,
        );
        if (/motivation/i.test(t.step.title)) void s.loadJobs(true); // motivation is in the job values
        this.replan('item used');
      } catch (err) {
        this.fail(t.key, `${t.step.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (t.action?.type === 'buy') {
      if (s.townHere?.id !== t.action.townId) return this.fail(t.key, `${t.step.title}: not in that town yet`);
      // Usually done already: the quest step buys in the town you stand in before the plan gets here.
      if (!(await this.quests.buyHere()))
        s.debug.add('autopilot', `${t.step.title}: nothing left to buy here`, { task: t });
      this.replan('bought quest items');
      return;
    }
    if (t.action?.type !== 'deposit') return;
    const townId = t.action.townId;
    if (s.townHere?.id !== townId) return this.fail(t.key, `${t.step.title}: not in that town yet`);
    const cash = s.character.cash;
    if (s.autopilot.bankWalk) s.updateAutopilot((f) => (f.bankWalk = null));
    if (cash <= 0) return void this.replan('nothing to deposit');
    try {
      const r = await s.autopilotCall(() => deposit(s.client, townId, cash), `deposit $${cash}`);
      s.character.cash = r.cash;
      s.character.deposit = r.deposit;
      s.info(`Autopilot: deposited $ ${cash} (fee $ ${r.fee}).`);
      this.replan('deposited');
    } catch (err) {
      this.fail(t.key, `deposit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
