// Autopilot settings, rules and the last plan, saved in the config dir (autopilot.json) so they survive
// restarts. The plan itself is always recomputed from live inputs; the saved copy is only shown (stale) until
// the first replan, and its fingerprint tells whether the inputs changed since.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';
import type { FormValue } from '../http/form.ts';
import type { TimelineStep } from './timeline.ts';

export type Goal = 'quests' | 'xp' | 'money' | 'products';
export const GOALS: Goal[] = ['quests', 'xp', 'money', 'products'];
/** Weights by rank: the top goal decides, the rest break ties. */
export const RANK_WEIGHTS = [1, 0.25, 0.06, 0.015];

export type ModuleKey = 'jobs' | 'energySleep' | 'hpSleep' | 'consumables' | 'bank' | 'quests' | 'npcDuels' | 'dryRun';

export interface AutopilotConfig {
  running: boolean;
  priority: Goal[];
  per: 'energy' | 'time';
  /** Replaces RANK_WEIGHTS when set (advanced). */
  customWeights: Partial<Record<Goal, number>> | null;
  modules: Record<ModuleKey, boolean>;
  wake: { levelUp: boolean; stretch: boolean; hpSafe: boolean; full: boolean };
  hp: { sleepBelow: number; wakeAbove: number };
  /** Hotel and bank: own town when it is this close (s of walking). */
  ownTownWithin: number;
  bank: { above: number; maxDetour: number };
  consumables: { energy: boolean; health: boolean; motivation: boolean; reserve: number };
  /** unfinishable: also work on quests with a requirement the autopilot cannot get (off: skip those quests). */
  quests: { repeatable: boolean; unfinishable: boolean; excludedChains: string[] };
  duels: { forXp: boolean; levelMargin: number };
  cancel: { horizon: number; margin: number; cooldown: number };
  /**
   * Seconds each queued run costs for its queue slot: the TUI is not always open, and while it is closed only
   * the queued tasks keep you busy, so short runs that fill slots leave you idle.
   */
  slotCost: number;
  spend: { daily: number };
}

export const DEFAULT_CONFIG: AutopilotConfig = {
  running: false,
  priority: ['quests', 'xp', 'money', 'products'],
  per: 'energy',
  customWeights: null,
  modules: { jobs: true, energySleep: true, hpSleep: true, consumables: false, bank: true, quests: false, npcDuels: false, dryRun: false },
  wake: { levelUp: true, stretch: false, hpSafe: true, full: false },
  hp: { sleepBelow: 0.5, wakeAbove: 0.7 },
  ownTownWithin: 3600,
  bank: { above: 4500, maxDetour: 1800 },
  consumables: { energy: true, health: true, motivation: false, reserve: 2 },
  quests: { repeatable: false, unfinishable: false, excludedChains: [] },
  duels: { forXp: true, levelMargin: 0 },
  cancel: { horizon: 6 * 3600, margin: 0.1, cooldown: 900 },
  slotCost: 600,
  spend: { daily: 1000 },
};

/** One task the autopilot intends to do; `post` is the task/add body when it is a server task. */
export interface PlannedTask {
  module: ModuleKey;
  step: TimelineStep;
  post?: Record<string, FormValue>;
  why?: string;
  /** Identifies the step across replans (retry/backoff, skip after failures). */
  key: string;
  /** Sleep: cancel it once energy and health reach these. */
  wake?: { energy: number; health: number };
  /** Done on the spot when the queue before it has finished (no task). */
  action?: { type: 'deposit'; townId: number } | { type: 'use'; itemId: number };
  /** Weighted value by the priority (plans are compared by the sum). */
  value?: number;
}

/**
 * Your edits to the plan, kept as rules so a replan cannot wipe them. Inserts are anchored to a server time
 * (placed before the first planned step starting at or after it), which stays meaningful as tasks finish.
 */
export interface AutopilotRules {
  excludedJobs: number[];
  excludedQuests: number[];
  /** Only these quests count for the Quests goal (empty: all open quests); set by the quest screen's route. */
  onlyQuests: number[];
  inserts: { at: number; kind: 'sleep' | 'bank' }[];
}

export const EMPTY_RULES: AutopilotRules = { excludedJobs: [], excludedQuests: [], onlyQuests: [], inserts: [] };

export interface AutopilotFile {
  config: AutopilotConfig;
  rules: AutopilotRules;
  plan: { fingerprint: string; savedAt: number; tasks: PlannedTask[] } | null;
  /** Money the autopilot spent on `day` (server date, YYYY-MM-DD), for the daily cap. */
  spent: { day: string; amount: number };
  /** NPC duel results (yours and the autopilot's), newest last: what levels you beat and what they pay. */
  duels: DuelRecord[];
}

export interface DuelRecord { at: number; level: number; won: boolean; xp: number; energy: number }

export const AUTOPILOT_FILE = () => join(CONFIG_DIR, 'autopilot.json');

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Saved values over the defaults, one level deep, keeping only known keys of the default's type. */
function merge<T extends Record<string, any>>(def: T, saved: unknown): T {
  if (!isObj(saved)) return structuredClone(def);
  const out: Record<string, any> = structuredClone(def);
  for (const [k, d] of Object.entries(def)) {
    const v = saved[k];
    if (v === undefined) continue;
    if (isObj(d) && isObj(v)) out[k] = merge(d, v);
    else if (d === null || typeof v === typeof d) out[k] = v;
  }
  return out as T;
}

export function parseAutopilotFile(json: unknown): AutopilotFile {
  const raw = isObj(json) ? json : {};
  const config = merge(DEFAULT_CONFIG, raw.config);
  // The ranking must hold every goal once; drop unknowns, append missing ones.
  const ranked = Array.isArray(raw.config?.priority) ? raw.config.priority.filter((g: unknown): g is Goal => GOALS.includes(g as Goal)) : [];
  config.priority = [...new Set([...ranked, ...GOALS])];
  const rules = merge(EMPTY_RULES, raw.rules);
  const plan = isObj(raw.plan) && typeof raw.plan.fingerprint === 'string' && Array.isArray(raw.plan.tasks)
    ? { fingerprint: raw.plan.fingerprint, savedAt: Number(raw.plan.savedAt) || 0, tasks: raw.plan.tasks as PlannedTask[] }
    : null;
  const spent = isObj(raw.spent) && typeof raw.spent.day === 'string' ? { day: raw.spent.day, amount: Number(raw.spent.amount) || 0 } : { day: '', amount: 0 };
  const duels = Array.isArray(raw.duels) ? raw.duels.filter((d: any) => isObj(d) && Number.isFinite(d.level)).slice(-200) as DuelRecord[] : [];
  return { config, rules, plan, spent, duels };
}

export function loadAutopilot(file = AUTOPILOT_FILE()): AutopilotFile {
  try {
    return parseAutopilotFile(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return parseAutopilotFile(null);
  }
}

export function saveAutopilot(data: AutopilotFile, file = AUTOPILOT_FILE()): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    /* preference only */
  }
}

/** Goal weights: custom when set, else by rank. */
/**
 * Expected XP and energy of an NPC duel at `level`, from wins within ±3 levels (needs 2+ results), or null.
 * A loss in the last 24 h at this level or below stops NPC duels (one loss stops them for the day).
 */
export function duelOutlook(record: DuelRecord[], level: number, now: number): { xp: number; energy: number } | null {
  if (record.some((d) => !d.won && d.at > now - 86400)) return null;
  const near = record.filter((d) => Math.abs(d.level - level) <= 3);
  const wins = near.filter((d) => d.won);
  if (near.length < 2 || wins.length < near.length * 0.9) return null;
  const avg = (f: (d: DuelRecord) => number) => wins.reduce((a, d) => a + f(d), 0) / wins.length;
  return { xp: avg((d) => d.xp), energy: Math.max(1, avg((d) => d.energy)) };
}

export function goalWeights(config: AutopilotConfig): Record<Goal, number> {
  if (config.customWeights) return Object.fromEntries(GOALS.map((g) => [g, Math.max(0, config.customWeights![g] ?? 0)])) as Record<Goal, number>;
  return Object.fromEntries(config.priority.map((g, i) => [g, RANK_WEIGHTS[i] ?? 0])) as Record<Goal, number>;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}

/** Hash of the planner's inputs (key order does not matter); equal hashes mean no replan is needed. */
export function fingerprint(inputs: unknown): string {
  return createHash('sha1').update(JSON.stringify(stable(inputs))).digest('hex').slice(0, 16);
}
