// Autopilot planner: from a snapshot (character, server queue, jobs, quests, hotels, settings) it plans the
// next tasks greedily along the timeline, safety first: HP sleep → bank → jobs by priority, with energy
// sleeps when sleeping gets the energy sooner than waiting. Pure: no requests; the runner in state.ts sends.
// Job value: each goal's gain per cost, normalised by the best candidate for that goal, weighted by the
// ranking (autopilot-config.ts). Cost: energy (+ walking at the energy it would regenerate meanwhile) or time.
import { levelStartXp, type Position } from './character.ts';
import { DURATION_KEYS, type DurationKey, type JobInfo } from './jobs.ts';
import { runGains, type RouteNeed } from './route.ts';
import { jobPost, sleepPost, walkPost } from './tasks.ts';
import { projectTimeline, regenSeconds, type Timeline, type TimelineStart, type TimelineStep } from './timeline.ts';
import { goalWeights, type AutopilotConfig, type AutopilotRules, type Goal, type PlannedTask } from './autopilot-config.ts';

export interface HotelOption {
  townId: number;
  name: string;
  at: Position;
  rooms: { key: string; name: string; cost: number; energyRate: number; healthRate: number }[];
}

/** A single-use item's effect, from its usebonus text ("Energy increase: 15%", "Health point bonus: 20%"). */
export interface ConsumableEffect { energy: number; health: number; motivation: number }

export function parseConsumable(usebonus: string[], usetype: string): ConsumableEffect | null {
  if (usetype !== 'single') return null;
  const pct = (re: RegExp) => usebonus.reduce((a, t) => a + Number(t.match(re)?.[1] ?? 0), 0) / 100;
  const e = { energy: pct(/^Energy increase: (\d+)%/i), health: pct(/^Health point bonus: (\d+)%/i), motivation: pct(/^Work motivation increase: (\d+)%/i) };
  return e.energy || e.health || e.motivation ? e : null;
}

/** An item in the bag the autopilot may use: `count` is what is left above the reserve; `value` its shop price. */
export interface Consumable { itemId: number; name: string; count: number; value: number; effect: ConsumableEffect }

export interface PlanInput {
  start: TimelineStart;
  /** The server queue as fixed timeline steps. */
  fixed: TimelineStep[];
  jobs: JobInfo[];
  locations: (groupId: number) => Position[] | undefined;
  wayTime: (from: Position, to: Position) => number;
  config: AutopilotConfig;
  rules: AutopilotRules;
  /** What open quests still need (the Quests goal). */
  needs: RouteNeed[];
  /** Sell value of an item (the Products goal). */
  itemValue: (itemId: number) => number;
  hotels: HotelOption[];
  /** Usable consumables (already filtered by the reserve). */
  consumables?: Consumable[];
  homeTownId?: number;
  /** Named towns, for banking. */
  towns: { id: number; name: string; at: Position }[];
  /** Money the autopilot may still spend today. */
  budget: number;
  /** Step keys that keep failing: not planned. */
  skip?: Set<string>;
  /** Cap on planned jobs (default MAX_JOBS; tests use fewer). The plan otherwise runs to the horizon. */
  maxJobs?: number;
  /** Exchange rates per goal (best gain per cost); a cancel check passes the current plan's so values compare. */
  rates?: Record<Goal, number>;
  /** Calibrated motivation model (calibration.ts): lost per run, recovered per hour (fractions). */
  motivation?: { perRun: number; perHour: number };
  /** Calibrated multiplier for the danger → HP heuristic. */
  hpScale?: number;
}

/** Safety cap on jobs in one plan; normally the horizon ends it first. */
export const MAX_JOBS = 200;

export interface Plan {
  tasks: PlannedTask[];
  timeline: Timeline;
  /** Why the first task (or nothing). */
  why: string;
  /** Weighted value of the planned tasks inside the horizon (in units of the exchange rates). */
  value: number;
  /** The exchange rates the values are in: best gain per cost per goal at the plan's start. */
  rates: Record<Goal, number>;
}

/** Expected HP lost on a run: a heuristic until danger damage is known (danger % of 10 % max HP per hour). */
export function expectedHpLoss(danger: number | null, seconds: number, maxHealth: number): number {
  if (!danger) return 0;
  return (danger / 100) * 0.1 * maxHealth * Math.min(1, seconds / 3600);
}

interface Candidate {
  job: JobInfo;
  duration: DurationKey;
  at: Position;
  travel: number;
  energy: number;
  hpLoss: number;
  /** The job's own XP for this run (motivation applied), without quest rewards. */
  xp: number;
  gains: Record<string, number>;
  raw: Record<Goal, number>;
  cost: number;
  score: number;
  /** Each goal's share of the score. */
  by: Record<Goal, number>;
}

const doable = (j: JobInfo) => j.jobPoints >= j.workPoints;
const GOAL_KEYS: Goal[] = ['quests', 'xp', 'money', 'products'];

/** Best gain per cost of each goal in a candidate list. */
function bestRates(list: { raw: Record<Goal, number>; cost: number }[]): Record<Goal, number> {
  const best: Record<Goal, number> = { quests: 0, xp: 0, money: 0, products: 0 };
  for (const c of list) for (const g of GOAL_KEYS) best[g] = Math.max(best[g], c.raw[g] / c.cost);
  return best;
}

/** The duration key whose run time is closest to `seconds` (queued jobs carry no key). */
function closestDuration(job: JobInfo, seconds: number): DurationKey | undefined {
  let found: DurationKey | undefined;
  let gap = Infinity;
  for (const k of DURATION_KEYS) {
    const d = job.values[k];
    if (d && Math.abs(d.duration - seconds) < gap) [found, gap] = [k, Math.abs(d.duration - seconds)];
  }
  return found;
}

const GOAL_WORD: Record<Goal, string> = { quests: 'quest progress', xp: 'XP', money: 'money', products: 'products to sell' };

export function planAutopilot(input: PlanInput): Plan {
  const { config: cfg, start, wayTime } = input;
  const mods = cfg.modules;
  const weights = goalWeights(cfg);
  // Plans to the horizon (so plans of short and long runs cover the same time and compare); MAX_JOBS caps it.
  const planJobs = Math.max(1, input.maxJobs ?? MAX_JOBS);
  const maxTasks = planJobs * 3 + 4;
  const horizonEnd = start.now + Math.max(3600, cfg.cancel.horizon);
  const motivation = input.motivation ?? { perRun: 0.02, perHour: 0 };
  const hpScale = input.hpScale ?? 1;
  const slotCost = Math.max(0, cfg.slotCost ?? 0); // a queue slot's worth: short runs leave you idle when the TUI is closed
  let jobsPlanned = 0;
  const opts = { wayTime };
  const walkWeight = (start.maxEnergy * start.energyRegen) / 3600 || 1 / 600;
  // Per hour: a run takes its duration, but its energy must be regenerated too. Base regen runs while you
  // work (max), a hotel room only while you sleep (added); whichever gets the energy back sooner counts.
  const perEnergyBase = start.energyRegen > 0 ? 3600 / (start.maxEnergy * start.energyRegen) : Infinity;
  const bestRoom = Math.max(0, ...input.hotels.flatMap((h) => h.rooms.filter((r) => r.cost <= input.budget).map((r) => r.energyRate)));
  const perEnergyRoom = bestRoom > 0 ? 3600 / (start.maxEnergy * bestRoom) : Infinity;
  const runSeconds = (duration: number, energy: number) => {
    const t = Math.min(Math.max(duration, energy * perEnergyBase), duration + energy * perEnergyRoom);
    return Number.isFinite(t) ? t : duration;
  };
  const skip = input.skip ?? new Set<string>();
  const excluded = new Set(input.rules.excludedJobs);
  const remaining: Record<string, number> = Object.fromEntries(input.needs.map((n) => [n.key, n.amount]));
  const totals: Record<string, number> = Object.fromEntries(input.needs.map((n) => [n.key, n.amount]));
  const runs = new Map<number, number>();
  // Jobs already queued drop items too: what they will bring is not needed again.
  for (const st of input.fixed) {
    if (st.kind !== 'job') continue;
    const job = input.jobs.find((j) => j.id === st.jobId);
    const dur = job && closestDuration(job, st.duration);
    if (!job || !dur) continue;
    runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
    for (const [k, g] of Object.entries(runGains(job, dur, input.needs))) if ((remaining[k] ?? 0) > 0) remaining[k] = Math.max(0, remaining[k]! - g);
  }
  const needInfo = new Map(input.needs.map((n) => [n.key, n]));
  let rates: Record<Goal, number> | null = input.rates ?? null;
  let budget = input.budget;
  let banked = false;
  const stock = new Map((input.consumables ?? []).map((c) => [c.itemId, c.count]));
  const useMod = mods.consumables;

  /** The cheapest usable item per point of `kind`, with at least `min` of it (fraction of max). */
  const pickItem = (kind: keyof ConsumableEffect, min: number) => {
    let best: Consumable | null = null;
    for (const c of input.consumables ?? []) {
      if ((stock.get(c.itemId) ?? 0) <= 0 || c.effect[kind] < min || skip.has(`use:${c.itemId}`)) continue;
      if (!best || c.value / c.effect[kind] < best.value / best.effect[kind]) best = c;
    }
    return best;
  };
  const useTask = (c: Consumable, why: string): PlannedTask => {
    stock.set(c.itemId, (stock.get(c.itemId) ?? 0) - 1);
    return {
      module: 'consumables', key: `use:${c.itemId}`, why,
      step: { kind: 'action', title: `Use ${c.name}`, energy: c.effect.energy * start.maxEnergy, health: c.effect.health * start.maxHealth },
      action: { type: 'use', itemId: c.itemId },
    };
  };

  const tasks: PlannedTask[] = [];
  let tl = projectTimeline(start, input.fixed, opts);
  const push = (...t: PlannedTask[]) => {
    tasks.push(...t);
    tl = projectTimeline(start, [...input.fixed, ...tasks.map((x) => x.step)], opts);
  };

  /**
   * All job candidates from a state, scored by the priority against the exchange rates. `level` sets the
   * level-up refund (a level-up refills energy: each XP point brings maxEnergy ÷ XP-per-level of it back);
   * `hours` from now sets the projected motivation.
   */
  const candidates = (from: Position, health: number, level = start.level, hours = 0): Candidate[] => {
    const list: Candidate[] = [];
    const xpPerLevel = levelStartXp(level + 1, start.maxLevel) - levelStartXp(level, start.maxLevel);
    const refundPerXp = xpPerLevel > 0 ? start.maxEnergy / xpPerLevel : 0;
    for (const job of input.jobs) {
      if (!doable(job) || excluded.has(job.id)) continue;
      const locs = input.locations(job.groupid);
      if (!locs?.length) continue;
      let at = locs[0]!;
      let travel = wayTime(from, at);
      for (const p of locs) {
        const t = wayTime(from, p);
        if (t < travel) [at, travel] = [p, t];
      }
      for (const duration of DURATION_KEYS) {
        const v = job.values[duration];
        if (!v) continue;
        if (skip.has(`job:${job.id}:${duration}`)) continue;
        const hpLoss = expectedHpLoss(job.danger, v.duration, start.maxHealth) * hpScale;
        // Never plan a run that could take HP under the sleep threshold (50–70 %: keep working, safely).
        if (mods.hpSleep && health - hpLoss < cfg.hp.sleepBelow * start.maxHealth) continue;
        const gains = runGains(job, duration, input.needs);
        // Quest progress (weighted by deadline), plus the share of the quests' rewards this progress earns.
        let quests = 0;
        let rewardXp = 0;
        let rewardMoney = 0;
        for (const [k, g] of Object.entries(gains)) {
          const rem = remaining[k] ?? 0;
          if (rem <= 1e-9) continue;
          const got = Math.min(rem, g);
          const n = needInfo.get(k);
          quests += (got / (totals[k] || 1)) * (n?.weight ?? 1);
          rewardXp += got * (n?.xpPerUnit ?? 0);
          rewardMoney += got * (n?.moneyPerUnit ?? 0);
        }
        // Motivation falls per run and recovers per hour; pay scales with it (heuristic until calibrated).
        const m0 = job.motivation > 0 ? job.motivation : 1;
        const m = Math.min(1, m0 - motivation.perRun * (runs.get(job.id) ?? 0) + motivation.perHour * hours);
        const fade = Math.max(0.3, m / m0);
        const xp = v.experience * fade;
        const products = (v.items ?? []).reduce((a, i) => a + i.expected * input.itemValue(i.itemId), 0);
        const hpSeconds = hpLoss > 0 ? regenSeconds(0, hpLoss, start.maxHealth, start.healthRegen) : 0;
        // Energy net of the level-up refund; at least a quarter (the refill only tops up to the max).
        const energy = Math.max(0.25 * v.energy, v.energy - (xp + rewardXp) * refundPerXp);
        const extra = (Number.isFinite(hpSeconds) ? hpSeconds : 0) + slotCost;
        const cost = cfg.per === 'energy'
          ? energy + (travel + extra) * walkWeight
          : runSeconds(v.duration, energy) + travel + extra;
        list.push({
          job, duration, at, travel, energy: v.energy, hpLoss, xp, gains, cost: Math.max(cost, 1e-6), score: 0, by: { quests: 0, xp: 0, money: 0, products: 0 },
          raw: { quests, xp: xp + rewardXp, money: v.money * fade + rewardMoney, products: products * fade },
        });
      }
    }
    // Each goal in units of its exchange rate (the best rate at the plan's start), so a crumb of quest
    // progress stays a crumb and values of different plans compare. A goal with no rate yet: this list's best.
    const best = bestRates(list);
    for (const g of GOAL_KEYS) if (rates && rates[g] > 0) best[g] = rates[g];
    for (const c of list) {
      c.score = 0;
      for (const g of Object.keys(best) as Goal[]) {
        c.by[g] = best[g] > 0 ? (weights[g] * (c.raw[g] / c.cost)) / best[g] : 0;
        c.score += c.by[g];
      }
    }
    return list.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  };

  /** What a run does for open quests, before it is counted: `Cotton for "Farmer's woes" (5 left)`. */
  const questParts = (gains: Record<string, number>): string[] =>
    input.needs.filter((n) => (gains[n.key] ?? 0) > 0 && (remaining[n.key] ?? 0) > 1e-9).map((n) => {
      const left = remaining[n.key]!;
      const amount = n.unit === 'seconds' ? `${Math.ceil(left / 60)} min` : String(Math.ceil(left));
      const quest = n.quests.length ? ` for "${n.quests[0]}"${n.quests.length > 1 ? ` +${n.quests.length - 1}` : ''}` : '';
      return `${n.label}${quest} (${amount} left)`;
    });

  /** Energy to reach the next level with the best XP-per-energy job; null when out of reach of one refill. */
  const levelUpEnergy = (from: Position, health: number, experience: number, level: number): number | null => {
    const gap = levelStartXp(level + 1, start.maxLevel) - experience;
    if (gap <= 0) return 0;
    let best: { xp: number; energy: number } | null = null;
    for (const c of candidates(from, health, level)) {
      if (c.energy <= 0 || c.xp <= 0) continue;
      if (!best || c.xp / c.energy > best.xp / best.energy) best = { xp: c.xp, energy: c.energy };
    }
    if (!best) return null;
    const need = Math.ceil(gap / best.xp) * best.energy;
    return need <= start.maxEnergy ? need : null;
  };

  /** A sleep that reaches the wake targets soonest (own town first when close), with when it is done and the walk there. */
  const sleepPlan = (reason: 'hp' | 'energy', minEnergy: number): { task: PlannedTask; ready: number; travel: number; energy: number } | null => {
    const s = tl.final;
    const wake = cfg.wake;
    let energy = s.energy;
    const reasons: string[] = [];
    const lvl = wake.levelUp ? levelUpEnergy(s.at, s.health, s.experience, s.level) : null;
    if (lvl !== null && lvl > energy) {
      energy = lvl;
      reasons.push('enough to level up');
    }
    if (wake.stretch && minEnergy * 4 > energy) {
      energy = minEnergy * 4;
      reasons.push('the next stretch');
    }
    if (wake.full || !reasons.length) {
      energy = start.maxEnergy;
      if (wake.full || reason === 'energy') reasons.push('full');
    }
    energy = Math.min(start.maxEnergy, Math.max(energy, minEnergy));
    const health = wake.hpSafe || reason === 'hp' ? Math.max(s.health, cfg.hp.wakeAbove * start.maxHealth) : s.health;
    if (reason === 'hp') reasons.push(`HP ${Math.round(cfg.hp.wakeAbove * 100)}%`);
    let best: { task: PlannedTask; ready: number; travel: number; own: boolean } | null = null;
    for (const h of input.hotels) {
      const travel = wayTime(s.at, h.at);
      const own = h.townId === input.homeTownId && travel <= cfg.ownTownWithin;
      for (const r of h.rooms) {
        if (r.cost > budget || r.energyRate <= 0) continue;
        if (skip.has(`sleep:${h.townId}:${r.key}`)) continue;
        const secs = Math.max(
          regenSeconds(s.energy, energy, start.maxEnergy, r.energyRate),
          regenSeconds(s.health, health, start.maxHealth, r.healthRate),
        );
        if (!Number.isFinite(secs)) continue;
        const ready = travel + secs;
        const better = !best || (own && !best.own) || (own === best.own && ready < best.ready);
        if (!better) continue;
        best = {
          own, ready, travel,
          task: {
            module: reason === 'hp' ? 'hpSleep' : 'energySleep',
            key: `sleep:${h.townId}:${r.key}`,
            step: { kind: 'sleep', title: `Sleep: ${h.name} ${r.name}`, at: h.at, energyRate: r.energyRate, healthRate: r.healthRate, seconds: secs, cost: r.cost },
            post: sleepPost(h.townId, r.key),
            wake: { energy, health },
            why: `${reason === 'hp' ? `HP low (${Math.round(s.health)}/${start.maxHealth})` : `energy low (${Math.floor(s.energy)})`}: sleep until ${reasons.join(' + ')}`,
          },
        };
      }
    }
    return best ? { task: best.task, ready: best.ready, travel: best.travel, energy } : null;
  };

  /** Walk to the bank town and deposit; null when no bank is within the allowed detour. */
  const bankPlan = (anyDistance = false): PlannedTask[] | null => {
    const s = tl.final;
    const named = input.towns.filter((t) => !skip.has(`bank:${t.id}`));
    if (!named.length) return null;
    const home = named.find((t) => t.id === input.homeTownId);
    let town = home && wayTime(s.at, home.at) <= cfg.ownTownWithin ? home : undefined;
    if (!town) {
      town = named.reduce((a, b) => (wayTime(s.at, b.at) < wayTime(s.at, a.at) ? b : a));
      if (!anyDistance && wayTime(s.at, town.at) > cfg.bank.maxDetour) return null; // bank when the route passes a town
    }
    const why = `cash $${Math.round(s.cash).toLocaleString('en-US')} is over $${cfg.bank.above.toLocaleString('en-US')}: banking it`;
    const deposit: PlannedTask = {
      module: 'bank', key: `bank:${town.id}`, why,
      step: { kind: 'action', title: `Deposit at ${town.name}`, cash: -s.cash },
      action: { type: 'deposit', townId: town.id },
    };
    if (s.at.x === town.at.x && s.at.y === town.at.y) return [deposit];
    return [{ module: 'bank', key: `walk:${town.id}`, why, step: { kind: 'walk', title: `Walk to ${town.name} (bank)`, at: town.at }, post: walkPost(town.id, 'town') }, deposit];
  };

  // Exchange rates: fixed for the whole plan, from where the server queue ends (unless passed in).
  if (!rates) rates = bestRates(candidates(tl.final.at, tl.final.health, tl.final.level));

  // Your inserted sleeps / bank stops, in time order: each goes in once the plan reaches its time.
  const inserts = [...input.rules.inserts].sort((a, b) => a.at - b.at);
  let value = 0;
  while (tasks.length < maxTasks && jobsPlanned < planJobs && tl.end < horizonEnd) {
    const s = tl.final;
    if (inserts.length && inserts[0]!.at <= tl.end) {
      const ins = inserts.shift()!;
      const key = `insert:${ins.kind}:${ins.at}`;
      const got = ins.kind === 'sleep' ? sleepPlan('energy', 0)?.task : bankPlan(true)?.[0];
      if (got) push({ ...got, key, why: `you inserted a ${ins.kind === 'sleep' ? 'sleep' : 'bank stop'} here` });
      if (ins.kind === 'bank' && got?.step.kind === 'walk') push(bankPlan(true)!.at(-1)!);
      continue;
    }
    if (mods.hpSleep && s.health < cfg.hp.sleepBelow * start.maxHealth) {
      // A health item that lifts HP back over the threshold beats walking to a hotel.
      const item = useMod && cfg.consumables.health ? pickItem('health', (cfg.hp.sleepBelow * start.maxHealth - s.health) / start.maxHealth) : null;
      if (item) {
        push(useTask(item, `HP ${Math.round(s.health)}/${start.maxHealth}: use ${item.name} instead of sleeping`));
        continue;
      }
      const sl = sleepPlan('hp', 0);
      if (sl) {
        budget -= (sl.task.step as { cost?: number }).cost ?? 0;
        push(sl.task);
        continue;
      }
    }
    if (mods.bank && !banked && s.cash > cfg.bank.above) {
      const b = bankPlan();
      banked = true; // once per plan; the next replan (after depositing) looks again
      if (b) {
        push(...b);
        continue;
      }
    }
    if (!mods.jobs) break;
    const c = candidates(s.at, s.health, s.level, Math.max(0, tl.end - start.now) / 3600)[0];
    if (!c) break;
    if (useMod && cfg.consumables.motivation && c.job.motivation < 0.75) {
      const item = pickItem('motivation', 0.01);
      if (item && !tasks.some((t) => t.key === `use:${item.itemId}` && t.step.title.includes(c.job.name))) {
        push({ ...useTask(item, `${c.job.name} motivation ${Math.round(c.job.motivation * 100)}%: use ${item.name}`), step: { kind: 'action', title: `Use ${item.name} (${c.job.name})` } });
        c.job = { ...c.job, motivation: Math.min(1, c.job.motivation + item.effect.motivation) };
      }
    }
    if (s.energy < c.energy) {
      const sl = mods.energySleep ? sleepPlan('energy', c.energy) : null;
      const wait = regenSeconds(s.energy, c.energy, start.maxEnergy, start.energyRegen);
      // A hotel within the own-town distance beats an item; else an item when it saves at least 30 minutes.
      const hotelNear = !!sl && sl.travel <= cfg.ownTownWithin;
      const other = Math.min(wait, sl ? sl.ready : Infinity);
      const item = useMod && cfg.consumables.energy && !hotelNear ? pickItem('energy', (c.energy - s.energy) / start.maxEnergy) : null;
      if (item && other >= 1800) {
        push(useTask(item, `energy ${Math.floor(s.energy)}: use ${item.name} (saves ${Math.round(Math.min(other, 86400) / 60)} min)`));
        continue;
      }
    }
    if (s.energy < c.energy && mods.energySleep) {
      const sl = sleepPlan('energy', c.energy);
      const wait = regenSeconds(s.energy, sl?.energy ?? c.energy, start.maxEnergy, start.energyRegen);
      if (sl && sl.ready < wait) {
        budget -= (sl.task.step as { cost?: number }).cost ?? 0;
        push(sl.task);
        continue;
      }
    }
    const v = c.job.values[c.duration]!;
    const goal = (Object.keys(c.by) as Goal[]).reduce((a, b) => (c.by[b] > c.by[a] ? b : a));
    const forQuests = questParts(c.gains);
    push({
      module: 'jobs',
      key: `job:${c.job.id}:${c.duration}`,
      step: { kind: 'job', title: c.job.name, jobId: c.job.id, at: c.at, duration: v.duration, energy: v.energy, xp: v.experience, money: v.money, hpLoss: c.hpLoss },
      post: jobPost(c.job.id, c.at, v.duration),
      value: c.score * c.cost,
      why: goal === 'quests' && forQuests.length
        ? `quest: ${forQuests.join('; ')}`
        : `best ${GOAL_WORD[goal]} per ${cfg.per === 'energy' ? 'energy' : 'hour'}${forQuests.length ? ` · also ${forQuests.join('; ')}` : ''}`,
    });
    const last = tl.steps[tl.steps.length - 1]!;
    // Value inside the horizon; a run crossing it counts for its share.
    const inside = last.end <= horizonEnd ? 1 : Math.max(0, (horizonEnd - last.start) / Math.max(1, last.end - last.start));
    value += c.score * c.cost * inside;
    runs.set(c.job.id, (runs.get(c.job.id) ?? 0) + 1);
    jobsPlanned++;
    for (const [k, g] of Object.entries(c.gains)) if ((remaining[k] ?? 0) > 1e-9) remaining[k] = Math.max(0, remaining[k]! - g);
  }
  const first = tasks[0];
  const why = first?.why ?? (!mods.jobs ? 'Queue jobs is off.' : 'Nothing worth doing (no doable job, or everything is excluded).');
  return { tasks, timeline: tl, why, value, rates };
}
