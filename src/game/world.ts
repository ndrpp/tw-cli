// World map model from map/get_minimap (verified against a live response 2026-11-03):
//   towns{id:{town_id,x,y,name|null,member_count,npctown,town_points,alliance_id}}
//   forts{x:{y: <number> | {fort:{fort_id,x,y,name,type,town_id,...}}}}
//   job_groups{groupid:[[x,y],...]}, quest_locations{id:[[x,y]]},
//   market_locations/friend_locations/town_members [{amount,x,y}],
//   counties[{county_id,name,start_x,start_y,end_x,end_y}], current_county
// World size: GameMap.max {x:181,y:79} tiles of 256 px (tw2game @401628).
import type { Position } from './character.ts';

export const TILE = 256;
export const WORLD_W = 182 * TILE; // 46592
export const WORLD_H = 80 * TILE; // 20480

export interface Town { id: number; x: number; y: number; name: string | null; members: number; npc: boolean; points: number }
export interface Fort { id: number; x: number; y: number; name: string; townId: number }
export interface County { id: number; name: string; x1: number; y1: number; x2: number; y2: number }
export interface Point extends Position { amount: number }

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

  static fromMinimap(json: Record<string, any>): WorldMap {
    const w = new WorldMap();
    for (const t of Object.values<any>(json.towns ?? {})) {
      w.towns.push({ id: t.town_id, x: t.x, y: t.y, name: t.name ?? null, members: t.member_count ?? 0, npc: !!t.npctown, points: t.town_points ?? 0 });
    }
    for (const [x, ys] of Object.entries<any>(json.forts ?? {})) {
      for (const [y, v] of Object.entries<any>(ys ?? {})) {
        const f = v && typeof v === 'object' ? v.fort : null;
        w.forts.push({ id: f?.fort_id ?? 0, x: Number(x), y: Number(y), name: f?.name ?? 'Fort site', townId: f?.town_id ?? 0 });
      }
    }
    for (const [group, coords] of Object.entries<any>(json.job_groups ?? {})) {
      w.jobGroups.set(Number(group), (coords as any[]).map((c) => ({ x: Number(c[0]), y: Number(c[1]) })));
    }
    for (const coords of Object.values<any>(json.quest_locations ?? {})) {
      for (const c of coords as any[]) w.quests.push({ x: Number(c[0]), y: Number(c[1]) });
    }
    const points = (list: any) => (Array.isArray(list) ? list.map((p) => ({ x: p.x, y: p.y, amount: p.amount ?? 1 })) : []);
    w.markets = points(json.market_locations);
    w.friends = points(json.friend_locations);
    w.townMembers = points(json.town_members);
    w.counties = (json.counties ?? []).map((c: any) => ({ id: c.county_id, name: c.name, x1: c.start_x, y1: c.start_y, x2: c.end_x, y2: c.end_y }));
    w.currentCounty = json.current_county ?? 0;
    const fair = json.fair;
    if (fair && typeof fair === 'object' && Number.isFinite(Number(fair.x))) w.fair = { x: Number(fair.x), y: Number(fair.y) };
    return w;
  }

  countyAt(p: Position): County | undefined {
    return this.counties.find((c) => p.x >= c.x1 && p.x <= c.x2 && p.y >= c.y1 && p.y <= c.y2);
  }

  /** Everything inside the rectangle [x1,x2) × [y1,y2). */
  within(x1: number, y1: number, x2: number, y2: number) {
    const inside = (p: Position) => p.x >= x1 && p.x < x2 && p.y >= y1 && p.y < y2;
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
