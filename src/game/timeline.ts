// Autopilot timeline: projects a task list forward in time — where the character is, when, and with what
// energy / health / XP / level / cash after each task. Pure: no requests, no clock; the caller passes `now`.
// Model (what the browser shows, plus what the planner needs):
//  - Regen runs all the time at maxEnergy · energyRegen / 3600 per second (Character.tick4Character);
//    a sleep replaces it with the room's rates.
//  - Jobs pay their energy when queued; tasks already on the server (`paid`) cost none here. A planned job
//    pays at its start; if energy is short it waits for regen first (`waited`).
//  - XP and money arrive when a task ends. Crossing levelStartXp(level + 1) refills energy and health
//    (the level-up reset the planner relies on; checked against a sync on the first live level-up).
import { levelStartXp, type Position } from './character.ts';

export interface TimelineStart {
  /** Server time (s) the projection starts at. */
  now: number;
  at: Position;
  energy: number;
  maxEnergy: number;
  health: number;
  maxHealth: number;
  /** Fraction of max regenerated per hour (Character.energyRegenFactor / healthRegenFactor). */
  energyRegen: number;
  healthRegen: number;
  level: number;
  experience: number;
  maxLevel?: number;
  cash: number;
  /** Max HP gained per level-up (lpPerPoint); default 0. */
  healthPerLevel?: number;
}

interface StepBase {
  title: string;
  /** Server queue entry: fixed times, energy already paid. */
  fixed?: { start: number; end: number };
}

export interface JobStep extends StepBase {
  kind: 'job';
  jobId: number;
  at: Position;
  duration: number;
  energy: number;
  xp: number;
  money: number;
  /** Expected health lost (danger); applied at the end. */
  hpLoss?: number;
}

export interface WalkStep extends StepBase {
  kind: 'walk';
  at: Position;
}

export interface SleepStep extends StepBase {
  kind: 'sleep';
  /** The hotel's town. */
  at: Position;
  /** Fraction of max regenerated per hour while sleeping. */
  energyRate: number;
  healthRate: number;
  /** Seconds of sleep; omitted: until energy and health are full. */
  seconds?: number;
  cost?: number;
}

/** Something done on the spot with no task: an item used, a deposit, a purchase. */
export interface ActionStep extends StepBase {
  kind: 'action';
  energy?: number;
  health?: number;
  cash?: number;
  xp?: number;
}

export type TimelineStep = JobStep | WalkStep | SleepStep | ActionStep;

export interface ProjectedStep {
  step: TimelineStep;
  /** When travel to the step begins / the step itself begins / it ends (server s). */
  depart: number;
  start: number;
  end: number;
  travel: number;
  /** Seconds spent waiting for energy before a planned job. */
  waited: number;
  at: Position;
  energyBefore: number;
  energy: number;
  health: number;
  experience: number;
  level: number;
  cash: number;
  levelUp: boolean;
}

export interface Timeline {
  steps: ProjectedStep[];
  end: number;
  /** State after the last step. */
  final: { at: Position; energy: number; health: number; experience: number; level: number; cash: number };
  gained: { xp: number; money: number; levels: number };
}

export interface TimelineOptions {
  wayTime: (from: Position, to: Position) => number;
}

/** Seconds of regen at `rate` (fraction of max per hour) to go from `have` to `want` points. */
export function regenSeconds(have: number, want: number, max: number, rate: number): number {
  if (want <= have) return 0;
  if (rate <= 0 || max <= 0) return Infinity;
  return ((Math.min(want, max) - have) * 3600) / (max * rate);
}

export function projectTimeline(start: TimelineStart, steps: TimelineStep[], opts: TimelineOptions): Timeline {
  const maxLevel = start.maxLevel ?? 250;
  let t = start.now;
  let at = start.at;
  let energy = start.energy;
  let health = start.health;
  let experience = start.experience;
  let level = start.level;
  let cash = start.cash;
  let maxHealth = start.maxHealth;

  const regen = (seconds: number, eRate = start.energyRegen, hRate = start.healthRegen) => {
    if (seconds <= 0) return;
    energy = Math.min(start.maxEnergy, energy + (start.maxEnergy * eRate * seconds) / 3600);
    health = Math.min(maxHealth, health + (maxHealth * hRate * seconds) / 3600);
  };
  const gainXp = (xp: number): boolean => {
    experience += xp;
    let up = false;
    while (level < maxLevel && experience >= levelStartXp(level + 1, maxLevel)) {
      level++;
      maxHealth += start.healthPerLevel ?? 0;
      up = true;
    }
    if (up) {
      energy = start.maxEnergy;
      health = maxHealth;
    }
    return up;
  };

  const out: ProjectedStep[] = [];
  for (const step of steps) {
    const depart = t;
    let travel = 0;
    let waited = 0;
    let begin: number;
    let end: number;
    const target = step.kind === 'action' ? at : step.at;
    if (step.fixed) {
      // Server task: its times are known; only regen and rewards are projected.
      begin = Math.max(t, step.fixed.start);
      end = Math.max(begin, step.fixed.end);
      travel = Math.max(0, begin - t);
      regen(begin - t);
    } else {
      travel = step.kind === 'action' ? 0 : opts.wayTime(at, target);
      regen(travel);
      begin = t + travel;
      if (step.kind === 'job' && energy < step.energy) {
        waited = regenSeconds(energy, step.energy, start.maxEnergy, start.energyRegen);
        regen(waited);
        begin += waited;
      }
      end = begin;
    }
    const energyBefore = energy;
    let levelUp = false;
    switch (step.kind) {
      case 'job': {
        if (!step.fixed) {
          energy -= step.energy;
          end = begin + step.duration;
        }
        regen(end - begin);
        cash += step.money;
        health = Math.max(0, health - (step.hpLoss ?? 0));
        levelUp = gainXp(step.xp);
        break;
      }
      case 'walk':
        if (step.fixed) regen(end - begin);
        break;
      case 'sleep': {
        if (!step.fixed) {
          cash -= step.cost ?? 0;
          const full = Math.max(
            regenSeconds(energy, start.maxEnergy, start.maxEnergy, step.energyRate),
            regenSeconds(health, maxHealth, maxHealth, step.healthRate),
          );
          const secs = step.seconds ?? full;
          end = begin + (Number.isFinite(secs) ? secs : 0);
        }
        regen(end - begin, step.energyRate, step.healthRate);
        break;
      }
      case 'action':
        energy = Math.min(start.maxEnergy, energy + (step.energy ?? 0));
        health = Math.min(maxHealth, health + (step.health ?? 0));
        cash += step.cash ?? 0;
        levelUp = gainXp(step.xp ?? 0);
        break;
    }
    t = end;
    at = target;
    out.push({
      step,
      depart,
      start: begin,
      end,
      travel,
      waited,
      at,
      energyBefore,
      energy,
      health,
      experience,
      level,
      cash,
      levelUp,
    });
  }
  return {
    steps: out,
    end: t,
    final: { at, energy, health, experience, level, cash },
    gained: { xp: experience - start.experience, money: cash - start.cash, levels: level - start.level },
  };
}
