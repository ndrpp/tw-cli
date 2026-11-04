// World map model from map/get_minimap (verified against a live response 2026-11-03):
//   towns{id:{town_id,x,y,name|null,member_count,npctown,town_points,alliance_id}}
//   forts{x:{y: <number> | {fort:{fort_id,x,y,name,type,town_id,...}}}}
//   job_groups{groupid:[[x,y],...]}, quest_locations{id:[[x,y]]},
//   market_locations/friend_locations/town_members [{amount,x,y}],
//   counties[{county_id,name,start_x,start_y,end_x,end_y}], current_county
// World size: GameMap.max {x:181,y:79} tiles of 256 px (tw2game @401628).

import { entries, isObj, type JsonObject, obj, objs, vals } from '../util/json.ts';
import type { Position } from './character.ts';
import { toPositions } from './jobs.ts';

export const TILE = 256;
export const WORLD_W = 182 * TILE; // 46592
export const WORLD_H = 80 * TILE; // 20480

export interface Town {
  id: number;
  x: number;
  y: number;
  name: string | null;
  members: number;
  npc: boolean;
  points: number;
}
export interface Fort {
  id: number;
  x: number;
  y: number;
  name: string;
  townId: number;
}
export interface County {
  id: number;
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface Point extends Position {
  amount: number;
}

export class WorldMap {
  towns: Town[] = [];
  forts: Fort[] = [];
  jobGroups = new Map<number, Position[]>();
  quests: Position[] = [];
  markets: Point[] = [];
  friends: Point[] = [];
  townMembers: Point[] = [];
  counties: County[] = [];
  currentCounty = 0;
  /** Travelling fair location when one is active (minimap.fair is false otherwise). */
  fair: Position | null = null;

  static fromMinimap(json: JsonObject): WorldMap {
    const width = new WorldMap();
    for (const jsonValue of vals(json.towns).map(obj)) {
      width.towns.push({
        id: Number(jsonValue.town_id),
        x: Number(jsonValue.x),
        y: Number(jsonValue.y),
        name: jsonValue.name == null ? null : String(jsonValue.name),
        members: Number(jsonValue.member_count ?? 0),
        npc: !!jsonValue.npctown,
        points: Number(jsonValue.town_points ?? 0),
      });
    }
    for (const [text, ys] of entries(json.forts)) {
      for (const [textValue, value] of entries(ys)) {
        const fortJson = isObj(value) && isObj(value.fort) ? value.fort : null;
        width.forts.push({
          id: Number(fortJson?.fort_id ?? 0),
          x: Number(text),
          y: Number(textValue),
          name: String(fortJson?.name ?? 'Fort site'),
          townId: Number(fortJson?.town_id ?? 0),
        });
      }
    }
    for (const [group, coords] of entries(json.job_groups)) width.jobGroups.set(Number(group), toPositions(coords));
    for (const coords of vals(json.quest_locations)) width.quests.push(...toPositions(coords));
    const points = (list: unknown) =>
      objs(list).map((jsonValue) => ({
        x: Number(jsonValue.x),
        y: Number(jsonValue.y),
        amount: Number(jsonValue.amount ?? 1),
      }));
    width.markets = points(json.market_locations);
    width.friends = points(json.friend_locations);
    width.townMembers = points(json.town_members);
    width.counties = objs(json.counties).map((jsonValue) => ({
      id: Number(jsonValue.county_id),
      name: String(jsonValue.name ?? ''),
      x1: Number(jsonValue.start_x),
      y1: Number(jsonValue.start_y),
      x2: Number(jsonValue.end_x),
      y2: Number(jsonValue.end_y),
    }));
    width.currentCounty = Number(json.current_county ?? 0);
    const fair = json.fair;
    if (isObj(fair) && Number.isFinite(Number(fair.x))) width.fair = { x: Number(fair.x), y: Number(fair.y) };
    return width;
  }

  countyAt(position: Position): County | undefined {
    return this.counties.find(
      (candidate) =>
        position.x >= candidate.x1 &&
        position.x <= candidate.x2 &&
        position.y >= candidate.y1 &&
        position.y <= candidate.y2,
    );
  }

  /** Everything inside the rectangle [x1,x2) × [y1,y2). */
  within(x1: number, y1: number, x2: number, y2: number) {
    const inside = (position: Position) => position.x >= x1 && position.x < x2 && position.y >= y1 && position.y < y2;
    const jobs: { groupId: number; at: Position }[] = [];
    for (const [groupId, locs] of this.jobGroups) for (const at of locs) if (inside(at)) jobs.push({ groupId, at });
    return {
      towns: this.towns.filter(inside),
      forts: this.forts.filter(inside),
      jobs,
      quests: this.quests.filter(inside),
      markets: this.markets.filter(inside),
      friends: this.friends.filter(inside),
    };
  }
}
