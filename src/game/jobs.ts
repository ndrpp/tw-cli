// Jobs, as the browser handles them:
//  - static definitions: Game.init.jobs / jobDurations (JobList.init @607935)
//  - per-character values: work/index (mode)  → json.jobs[id] (JobsModel.initJobs / mergeJobObject @2209657)
//    live shape: {workpoints, jobSkillPoints, motivation, durations:[{cost,money,xp,luck,items,duration}×3],
//                 minMaxItemVal, limit_reached, stage:{stage,progress,malus}}
//  - locations: map/get_minimap (ajax)        → json.job_groups[groupid] = [[x,y], ...] (createPoints4Job)
//  - one location's details: job/job (mode) {jobId,x,y} (JobWindow.initData @1520049)
//  - travel time: GameMap.calcWayTime = distance * Game.travelSpeed * Character.speed (seconds)
import type { GameClient } from '../http/game-client.ts';
import type { Position } from './character.ts';
import { arr, entries, obj, objs, type JsonObject } from '../util/json.ts';

export type DurationKey = 'short' | 'middle' | 'long';
export const DURATION_KEYS: DurationKey[] = ['short', 'middle', 'long'];

export interface JobDef {
  id: number;
  groupid: number;
  name: string;
  shortname: string;
  level: number;
  malus: number;
  skills: Record<string, number>;
  durations: Record<DurationKey, number>;
  /** Product drops: item id → chance (Game.init.jobs[].yields[id].prop). */
  yields: Record<number, number>;
}

export interface JobDurationValues {
  duration: number;
  energy: number;
  money: number;
  experience: number;
  luck: number;
  /** Product drops for this duration: expected items per run = (prop + probBonus) / 100 (job window shows the %). */
  items?: { itemId: number; expected: number; percent: number }[];
}

export interface JobInfo extends JobDef {
  /** jobSkillPoints: weighted skill points for this job. */
  jobPoints: number;
  /** Requirement, as the client computes it: malus + 1 (west.job.Model). Doable when jobPoints >= workPoints. */
  workPoints: number;
  /** Labor points as shown in game: jobSkillPoints − malus (live work/index sends it as `workpoints`). */
  laborPoints: number;
  motivation: number;
  /** Danger 0–100; null until the selected job's job/job detail is loaded (work/index omits it). */
  danger: number | null;
  /** minMaxItemVal: $ value range of a lucky item find (job window "$min-$max"; list sorts by max = maxLuck). */
  luckValue: [number, number];
  values: Partial<Record<DurationKey, JobDurationValues>>;
}

export class JobCatalog {
  readonly byId = new Map<number, JobDef>();

  constructor(gameInit: JsonObject | null) {
    for (const j of objs(gameInit?.jobs)) {
      const d = obj(j.durations);
      const id = Number(j.id);
      this.byId.set(id, {
        id,
        groupid: Number(j.groupid),
        name: String(j.name ?? ''),
        shortname: String(j.shortname ?? ''),
        level: Number(j.level) || 0,
        malus: Number(j.malus) || 0,
        skills: Object.fromEntries(entries(j.skills).map(([k, v]) => [k, Number(v) || 0])),
        durations: { short: Number(d.short ?? 15), middle: Number(d.middle ?? 600), long: Number(d.long ?? 3600) },
        yields: Object.fromEntries(entries(j.yields).map(([id, y]) => [Number(id), Number(obj(y).prop) || 0])),
      });
    }
  }

  get(id: number): JobDef | undefined {
    return this.byId.get(id);
  }

  /** Jobs whose product drops include this item (any upgrade level), best chance first. */
  yielding(itemId: number): { job: JobDef; chance: number }[] {
    const base = Math.floor(itemId / 1000);
    const out: { job: JobDef; chance: number }[] = [];
    for (const job of this.byId.values()) {
      for (const [id, chance] of Object.entries(job.yields ?? {})) {
        if (Math.floor(Number(id) / 1000) === base) out.push({ job, chance });
      }
    }
    return out.sort((a, b) => b.chance - a.chance);
  }
}

/** Danger is only part of the job/job detail reply; work/index may leave it out. */
export function parseDanger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface JobDetail {
  danger: number | null;
  motivation: number | null;
}

/** job/job → the live values the browser's job window shows for one job at one location. */
export function parseJobDetail(raw: JsonObject): JobDetail {
  const motivation = raw.motivation === null || raw.motivation === undefined ? NaN : Number(raw.motivation);
  return {
    danger: parseDanger(raw.danger),
    motivation: Number.isFinite(motivation) ? motivation : null,
  };
}

/** work/index → per-character job values merged onto the static definitions. */
export async function fetchJobInfos(client: GameClient, catalog: JobCatalog): Promise<JobInfo[]> {
  const json = await client.remoteCallMode('work', 'index');
  if (json.error) throw new Error(String(json.msg ?? 'work/index failed'));
  const out: JobInfo[] = [];
  for (const [key, v] of entries(json.jobs)) {
    const be = obj(v);
    const def = catalog.get(Number(key));
    if (!def) continue;
    const values: JobInfo['values'] = {};
    DURATION_KEYS.forEach((k, i) => {
      const raw = arr(be.durations)[i];
      if (!raw) return;
      const d = obj(raw);
      values[k] = {
        duration: Number(d.duration),
        energy: Number(d.cost),
        money: Number(d.money) + (Number(d.featured_money) || 0),
        experience: Number(d.xp) + (Number(d.featured_xp) || 0),
        luck: Number(d.luck),
        items: objs(d.items).filter((y) => !y.random && y.itemid).map((y) => {
          const percent = (Number(y.prop) || 0) + (Number(y.probBonus) || 0);
          return { itemId: Number(y.itemid), expected: percent / 100, percent };
        }),
      };
    });
    out.push({
      ...def,
      jobPoints: Number(be.jobSkillPoints),
      workPoints: def.malus + 1,
      laborPoints: typeof be.workpoints === 'number' ? be.workpoints : Number(be.jobSkillPoints) - def.malus,
      motivation: Number(be.motivation),
      danger: parseDanger(be.danger),
      luckValue: [Number(arr(be.minMaxItemVal)[0]) || 0, Number(arr(be.minMaxItemVal)[1]) || 0],
      values,
    });
  }
  return out;
}

export type JobLocations = Map<number, Position[]>;

/** map/get_minimap → job group id → list of map coordinates. */
export async function fetchJobLocations(client: GameClient): Promise<JobLocations> {
  const json = await client.get('map', 'get_minimap');
  if (json.error) throw new Error(String(json.msg ?? 'map/get_minimap failed'));
  const map: JobLocations = new Map();
  for (const [group, coords] of entries(json.job_groups)) map.set(Number(group), toPositions(coords));
  return map;
}

/** [[x, y], ...] → positions. */
export const toPositions = (coords: unknown): Position[] => arr(coords).map((c) => ({ x: Number(arr(c)[0]), y: Number(arr(c)[1]) }));

export function distance(a: Position, b: Position): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** GameMap.calcWayTime, seconds. */
export function wayTime(from: Position, to: Position, travelSpeed: number, charSpeed: number): number {
  return distance(from, to) * travelSpeed * charSpeed;
}

export function nearestLocation(locations: Position[] | undefined, from: Position): Position | null {
  if (!locations?.length) return null;
  let best = locations[0]!;
  let bestD = distance(best, from);
  for (const p of locations) {
    const d = distance(p, from);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** job/job {jobId,x,y}: details for one job at one place (raw server object). */
export async function fetchJobDetail(client: GameClient, jobId: number, at: Position): Promise<JsonObject> {
  const json = await client.remoteCallMode('job', 'job', { jobId, x: at.x, y: at.y });
  if (json.error) throw new Error(String(json.msg ?? 'job/job failed'));
  return json;
}
