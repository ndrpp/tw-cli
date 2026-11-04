// Town hall: the city hall window and town construction jobs.
//   building_cityhall action '' {town_id} (CityhallWindow.Build @1240352) → {townName, townNoLeave,
//     buildings:[{key, name, maxStage, stage, infinite, nextStagePoints, buildPoints}]}
//   cityhall_build/build (mode) {x, y, building} (BuildWindow.initData4Town @1087174) → {build_key, build_name,
//     build_skills:{skills:[{skill, coefficient}], malus}, jobPoints, build_point, build_point_limit, deposit,
//     motivation, jobDurationData:{<seconds>:{calcduration, formatted, expCalc:{min, max}}}, defaultData, singleDuration}
//   TaskBuild (tw2game @689326): task/add post {x, y, building_key, duration, deposit ('town' | 'player'), taskType:'build'}.
import type { GameClient } from '../http/game-client.ts';
import type { FormValue } from '../http/form.ts';
import { plainText } from './quests.ts';
import { obj, objs, vals, type JsonObject } from '../util/json.ts';

export interface TownBuilding {
  key: string;
  name: string;
  stage: number;
  maxStage: number;
  /** Church stages never end (the browser shows an infinity symbol). */
  infinite: boolean;
  buildPoints: number;
  nextStagePoints: number;
}

export interface TownHall {
  townId: number;
  townName: string;
  noLeave: boolean;
  buildings: TownBuilding[];
}

export interface BuildDuration {
  seconds: number;
  /** The game's text, e.g. "1 hour (240$)". */
  formatted: string;
  xpMin: number;
  xpMax: number;
}

export interface BuildSkill { skill: string; coefficient: number }

export interface Construction {
  townId: number;
  x: number;
  y: number;
  key: string;
  name: string;
  description: string;
  jobPoints: number;
  motivation: number;
  /** The game formats this with thousands separators ("35.064"); keep the text for display. */
  deposit: string;
  buildPoints: number;
  buildPointLimit: number;
  skills: BuildSkill[];
  malus: number;
  durations: BuildDuration[];
  defaultDuration: number | null;
  singleDuration: boolean;
}

const errText = (json: JsonObject, what: string) => plainText(json.msg ?? (typeof json.error === 'string' ? json.error : '')) || `${what} failed`;

export async function fetchTownHall(client: GameClient, townId: number): Promise<TownHall> {
  const json = await client.remoteCall('building_cityhall', '', { town_id: townId });
  if (json.error) throw new Error(errText(json, 'Town hall'));
  return {
    townId,
    townName: plainText(json.townName) || `town ${townId}`,
    noLeave: !!json.townNoLeave,
    buildings: objs(json.buildings).map((r) => ({
      key: String(r.key),
      name: String(r.name ?? r.key),
      stage: Number(r.stage) || 0,
      maxStage: Number(r.maxStage) || 0,
      infinite: !!r.infinite,
      buildPoints: Number(r.buildPoints) || 0,
      nextStagePoints: Number(r.nextStagePoints) || 0,
    })),
  };
}

export function parseConstruction(json: JsonObject): Construction {
  const durations: BuildDuration[] = vals(json.jobDurationData)
    .map(obj)
    .map((d) => ({
      seconds: Number(d.calcduration) || 0,
      formatted: String(d.formatted ?? ''),
      xpMin: Number(obj(d.expCalc).min) || 0,
      xpMax: Number(obj(d.expCalc).max) || 0,
    }))
    .filter((d) => d.seconds > 0)
    .sort((a, b) => a.seconds - b.seconds);
  const def = Number(obj(json.defaultData).calcduration) || 0;
  const skills = obj(json.build_skills);
  return {
    townId: Number(json.id) || 0,
    x: Number(json.x) || 0,
    y: Number(json.y) || 0,
    key: String(json.build_key ?? ''),
    name: String(json.build_name ?? json.build_key ?? 'Building'),
    description: plainText(String(json.description ?? '')),
    jobPoints: Number(json.jobPoints) || 0,
    motivation: Number(json.motivation) || 0,
    deposit: String(json.deposit ?? '0'),
    buildPoints: Number(json.build_point) || 0,
    buildPointLimit: Number(json.build_point_limit) || 0,
    skills: objs(skills.skills).map((s) => ({
      skill: String(s.skill ?? ''),
      coefficient: Number(s.coefficient) || 0,
    })),
    malus: Number(skills.malus) || 0,
    durations,
    defaultDuration: durations.some((d) => d.seconds === def) ? def : durations[0]?.seconds ?? null,
    singleDuration: !!json.singleDuration,
  };
}

export async function fetchConstruction(client: GameClient, x: number, y: number, building: string): Promise<Construction> {
  const json = await client.remoteCallMode('cityhall_build', 'build', { x, y, building });
  if (json.error) throw new Error(errText(json, 'Construction'));
  return parseConstruction(json);
}

/** TaskBuild's post (key order as the browser's object). */
export function buildPost(at: { x: number; y: number }, building: string, duration: number, pay: 'town' | 'player'): Record<string, FormValue> {
  return { x: at.x, y: at.y, building_key: building, duration, deposit: pay, taskType: 'build' };
}
