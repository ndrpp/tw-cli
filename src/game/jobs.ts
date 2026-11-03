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

  constructor(gameInit: Record<string, any> | null) {
    for (const j of (gameInit?.jobs ?? []) as any[]) {
      this.byId.set(j.id, {
        id: j.id,
        groupid: j.groupid,
        name: j.name,
        shortname: j.shortname,
        level: j.level,
        malus: j.malus,
        skills: j.skills ?? {},
        durations: j.durations ?? { short: 15, middle: 600, long: 3600 },
        yields: Object.fromEntries(Object.entries<any>(j.yields ?? {}).map(([id, y]) => [Number(id), Number(y?.prop) || 0])),
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
export function parseJobDetail(raw: Record<string, any>): JobDetail {
  const motivation = raw.motivation === null || raw.motivation === undefined ? NaN : Number(raw.motivation);
  return {
    danger: parseDanger(raw.danger),
    motivation: Number.isFinite(motivation) ? motivation : null,
  };
}

/** work/index → per-character job values merged onto the static definitions. */
export async function fetchJobInfos(client: GameClient, catalog: JobCatalog): Promise<JobInfo[]> {
  const json = await client.remoteCallMode('work', 'index');
  if (json.error) throw new Error(json.msg ?? 'work/index failed');
  const out: JobInfo[] = [];
  for (const [key, be] of Object.entries<any>(json.jobs ?? {})) {
    const def = catalog.get(Number(key));
    if (!def) continue;
    const values: JobInfo['values'] = {};
    DURATION_KEYS.forEach((k, i) => {
      const d = be.durations?.[i];
      if (!d) return;
      values[k] = {
        duration: d.duration,
        energy: d.cost,
        money: d.money + (d.featured_money || 0),
        experience: d.xp + (d.featured_xp || 0),
        luck: d.luck,
        items: (Array.isArray(d.items) ? d.items : []).filter((y: any) => y && !y.random && y.itemid).map((y: any) => {
          const percent = (Number(y.prop) || 0) + (Number(y.probBonus) || 0);
          return { itemId: Number(y.itemid), expected: percent / 100, percent };
        }),
      };
    });
    out.push({
      ...def,
      jobPoints: be.jobSkillPoints,
      workPoints: def.malus + 1,
      laborPoints: typeof be.workpoints === 'number' ? be.workpoints : be.jobSkillPoints - def.malus,
      motivation: be.motivation,
      danger: parseDanger(be.danger),
      luckValue: Array.isArray(be.minMaxItemVal) ? [Number(be.minMaxItemVal[0]) || 0, Number(be.minMaxItemVal[1]) || 0] : [0, 0],
      values,
    });
  }
  return out;
}

export type JobLocations = Map<number, Position[]>;

/** map/get_minimap → job group id → list of map coordinates. */
export async function fetchJobLocations(client: GameClient): Promise<JobLocations> {
  const json = await client.get('map', 'get_minimap');
  if (json.error) throw new Error(json.msg ?? 'map/get_minimap failed');
  const map: JobLocations = new Map();
  for (const [group, coords] of Object.entries<any>(json.job_groups ?? {})) {
    map.set(Number(group), (coords as any[]).map((c) => ({ x: Number(c[0]), y: Number(c[1]) })));
  }
  return map;
}

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
export async function fetchJobDetail(client: GameClient, jobId: number, at: Position): Promise<Record<string, any>> {
  const json = await client.remoteCallMode('job', 'job', { jobId, x: at.x, y: at.y });
  if (json.error) throw new Error(json.msg ?? 'job/job failed');
  return json;
}
