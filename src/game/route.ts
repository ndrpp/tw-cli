// Quest route planner: which jobs to do, where, how long and in what order to collect what open quests
// still need (items that jobs drop, and "do job X" requirements). Greedy: from the current position,
// repeatedly take the job run that covers the most outstanding need per cost, then move there.
// Drop amounts use the job window's numbers: (prop + probBonus)% per run from work/index, i.e. 767% ≈ 7.67
// items expected per run. These are expectations, not guarantees; the plan is redone after each refresh.
import type { Position } from './character.ts';
import type { DurationKey, JobInfo } from './jobs.ts';
import { DURATION_KEYS } from './jobs.ts';
import type { Quest, QuestRequirement } from './quests.ts';

export type RouteObjective = 'energy' | 'time';

export interface RouteNeed {
  key: string; // "item:<base>" | "job:<id>"
  label: string;
  /** Items: how many; job requirements: runs or seconds (see unit). */
  amount: number;
  unit: 'items' | 'runs' | 'seconds';
  itemId?: number;
  jobId?: number;
  quests: string[];
}

export interface RouteStop {
  job: JobInfo;
  at: Position;
  duration: DurationKey;
  runs: number;
  /** Travel to this stop from the previous one (seconds). */
  travel: number;
  /** Expected progress per need key over all runs. */
  gains: Record<string, number>;
  energy: number;
  seconds: number;
  xp: number;
  money: number;
}

export interface RoutePlan {
  needs: RouteNeed[];
  stops: RouteStop[];
  /** Needs no doable job covers (bought, quest items, not enough labor points, …), with the reason. */
  unmet: { need: RouteNeed; why: string }[];
  /** Needs left after the run limit (rare). */
  leftover: Record<string, number>;
  totals: { energy: number; seconds: number; travel: number; xp: number; money: number; runs: number };
  /** Runs (in order) whose energy fits in `energyAvailable`; all runs when no budget was given. */
  fitRuns: number;
  /** Energy missing for the whole route (0 when it fits or no budget was given). */
  energyShort: number;
}

const baseOf = (id: number) => Math.floor(id / 1000);

/** "(0/4)" → 4 runs left; "Trading (30 minutes)" → 1800 s; else the jsInfo count. */
function jobRequirementAmount(r: QuestRequirement): { amount: number; unit: 'runs' | 'seconds' } {
  const frac = r.info.match(/\((\d+)\s*\/\s*(\d+)\)/);
  if (frac) return { amount: Math.max(0, Number(frac[2]) - Number(frac[1])), unit: 'runs' };
  const time = r.info.match(/(\d+)\s*(second|minute|hour)/i);
  if (time) return { amount: Number(time[1]) * ({ second: 1, minute: 60, hour: 3600 } as Record<string, number>)[time[2]!.toLowerCase()]!, unit: 'seconds' };
  const n = r.count ?? 1;
  return n >= 15 ? { amount: n, unit: 'seconds' } : { amount: n, unit: 'runs' };
}

/** Outstanding needs of these quests, summed per item / job; items already in the bag are subtracted. */
export function questNeeds(quests: Quest[], have: (itemId: number) => number, itemName: (id: number) => string, jobName: (id: number) => string): RouteNeed[] {
  const needs = new Map<string, RouteNeed>();
  const add = (n: Omit<RouteNeed, 'quests'>, quest: string) => {
    const cur = needs.get(n.key);
    if (cur) {
      cur.amount += n.amount;
      if (!cur.quests.includes(quest)) cur.quests.push(quest);
    } else needs.set(n.key, { ...n, quests: [quest] });
  };
  for (const q of quests) {
    for (const r of q.requirements) {
      if (r.solved) continue;
      if (r.itemId !== undefined) add({ key: `item:${baseOf(r.itemId)}`, label: itemName(r.itemId), amount: r.count ?? 1, unit: 'items', itemId: r.itemId }, q.soloTitle || q.title);
      else if (r.jobId !== undefined) {
        const { amount, unit } = jobRequirementAmount(r);
        if (amount > 0) add({ key: `job:${r.jobId}:${unit}`, label: jobName(r.jobId), amount, unit, jobId: r.jobId }, q.soloTitle || q.title);
      }
    }
  }
  for (const n of needs.values()) if (n.unit === 'items' && n.itemId !== undefined) n.amount = Math.max(0, n.amount - have(n.itemId));
  return [...needs.values()].filter((n) => n.amount > 0);
}

export interface PlanInput {
  needs: RouteNeed[];
  jobs: JobInfo[];
  /** Map locations of a job group. */
  locations: (groupId: number) => Position[] | undefined;
  from: Position;
  wayTime: (from: Position, to: Position) => number;
  objective?: RouteObjective;
  maxRuns?: number;
  /**
   * Energy-mode weight of walking: energy per second of walking. Walking costs time, not energy; time is
   * worth the energy that regenerates meanwhile (maxEnergy · energyRegenFactor / 3600). Default 1/600.
   */
  walkEnergyPerSecond?: number;
  /** Energy available now: the plan reports how many runs fit (`fitRuns`) and the shortfall. */
  energyAvailable?: number;
}

const doable = (j: JobInfo) => j.jobPoints >= j.workPoints;

/** Expected progress of one run of `job` for `duration` towards each need. */
function runGains(job: JobInfo, duration: DurationKey, needs: RouteNeed[]): Record<string, number> {
  const v = job.values[duration];
  const out: Record<string, number> = {};
  if (!v) return out;
  for (const n of needs) {
    if (n.unit === 'items' && n.itemId !== undefined) {
      const y = v.items?.find((i) => baseOf(i.itemId) === baseOf(n.itemId!));
      if (y && y.expected > 0) out[n.key] = y.expected;
    } else if (n.jobId === job.id) out[n.key] = n.unit === 'runs' ? 1 : v.duration;
  }
  return out;
}

function nearest(locs: Position[] | undefined, from: Position, way: (a: Position, b: Position) => number): { at: Position; travel: number } | null {
  let best: { at: Position; travel: number } | null = null;
  for (const at of locs ?? []) {
    const t = way(from, at);
    if (!best || t < best.travel) best = { at, travel: t };
  }
  return best;
}

export function planRoute(input: PlanInput): RoutePlan {
  const { needs, jobs, from, wayTime } = input;
  const objective = input.objective ?? 'energy';
  const maxRuns = input.maxRuns ?? 300;
  const walkWeight = input.walkEnergyPerSecond && input.walkEnergyPerSecond > 0 ? input.walkEnergyPerSecond : 1 / 600;
  const remaining: Record<string, number> = Object.fromEntries(needs.map((n) => [n.key, n.amount]));
  const unmet: RoutePlan['unmet'] = [];

  // Candidates: doable jobs × durations that make progress on some need.
  type Cand = { job: JobInfo; duration: DurationKey; gains: Record<string, number> };
  const cands: Cand[] = [];
  for (const job of jobs) {
    if (!doable(job) || !input.locations(job.groupid)?.length) continue;
    for (const duration of DURATION_KEYS) {
      const gains = runGains(job, duration, needs);
      if (Object.keys(gains).length) cands.push({ job, duration, gains });
    }
  }
  for (const n of needs) {
    if (cands.some((c) => c.gains[n.key])) continue;
    let why = 'no job drops it (buy it, or it comes from another quest)';
    if (n.jobId !== undefined) {
      const j = jobs.find((x) => x.id === n.jobId);
      why = !j ? 'job unknown' : !doable(j) ? `not enough labor points (${j.laborPoints})` : 'job has no known location';
    } else if (jobs.some((j) => Object.values(j.values).some((v) => v?.items?.some((i) => baseOf(i.itemId) === baseOf(n.itemId!))))) {
      why = 'only jobs you lack labor points for drop it';
    }
    unmet.push({ need: n, why });
    delete remaining[n.key];
  }

  const stops: RouteStop[] = [];
  let pos = from;
  let runs = 0;
  const open = () => Object.values(remaining).some((r) => r > 1e-9);
  while (open() && runs < maxRuns) {
    let best: { c: Cand; at: Position; travel: number; score: number } | null = null;
    for (const c of cands) {
      let progress = 0;
      for (const [k, g] of Object.entries(c.gains)) {
        const rem = remaining[k] ?? 0;
        if (rem <= 1e-9) continue;
        const total = needs.find((n) => n.key === k)!.amount;
        progress += Math.min(rem, g) / total; // fraction of the need this run closes
      }
      if (progress <= 0) continue;
      const loc = nearest(input.locations(c.job.groupid), pos, wayTime);
      if (!loc) continue;
      const v = c.job.values[c.duration]!;
      // Energy is what limits a day of jobs; travel costs time only, weighted by the energy regenerated meanwhile.
      const cost = objective === 'energy' ? v.energy + loc.travel * walkWeight : v.duration + loc.travel;
      let score = progress / Math.max(cost, 1e-6);
      score += ((v.experience + v.money) / Math.max(cost, 1e-6)) * 1e-9; // tie-break: more XP/$
      if (!best || score > best.score) best = { c, at: loc.at, travel: loc.travel, score };
    }
    if (!best) break;
    const { c, at, travel } = best;
    const v = c.job.values[c.duration]!;
    const last = stops[stops.length - 1];
    if (last && last.job.id === c.job.id && last.duration === c.duration && last.at.x === at.x && last.at.y === at.y) {
      last.runs++;
    } else {
      stops.push({ job: c.job, at, duration: c.duration, runs: 1, travel, gains: {}, energy: 0, seconds: 0, xp: 0, money: 0 });
    }
    const s = stops[stops.length - 1]!;
    s.energy += v.energy;
    s.seconds += v.duration;
    s.xp += v.experience;
    s.money += v.money;
    for (const [k, g] of Object.entries(c.gains)) {
      if ((remaining[k] ?? 0) <= 1e-9) continue;
      const used = Math.min(remaining[k]!, g);
      remaining[k] = remaining[k]! - used;
      s.gains[k] = (s.gains[k] ?? 0) + g;
    }
    pos = at;
    runs++;
  }
  const leftover = Object.fromEntries(Object.entries(remaining).filter(([, r]) => r > 1e-9));
  const totals = stops.reduce(
    (t, s) => ({ energy: t.energy + s.energy, seconds: t.seconds + s.seconds + s.travel, travel: t.travel + s.travel, xp: t.xp + s.xp, money: t.money + s.money, runs: t.runs + s.runs }),
    { energy: 0, seconds: 0, travel: 0, xp: 0, money: 0, runs: 0 },
  );
  let fitRuns = totals.runs;
  let energyShort = 0;
  if (input.energyAvailable !== undefined) {
    fitRuns = 0;
    let left = input.energyAvailable;
    outer: for (const s of stops) {
      const per = s.energy / s.runs;
      for (let i = 0; i < s.runs; i++) {
        if (per > left) break outer;
        left -= per;
        fitRuns++;
      }
    }
    energyShort = Math.max(0, totals.energy - input.energyAvailable);
  }
  return { needs, stops, unmet, leftover, totals, fitRuns, energyShort };
}
