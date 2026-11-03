// Tile detail via map/get_complete_data {tiles: JSON [[tx,ty],...]} (GameMap.Data.Loader @420667),
// cached 60 s like the browser (GameMap.Data dataTTL). We only use the parts that name points of interest:
//   dynamic: [{tx:{ty:[[{x,y,left,top}, data], ...]}}, ...] where data is one of
//     town  {town_id,x,y,name,member,points,rank,...}
//     fort  {fort_id,name,fort_battle_count,battlestartdelta,...}
//     job   {job_id,group_id,x,y,gold,silver}          ← gold / silver jobs
//     crowd {count,x,y}                                 ← players standing there
//   quests: {tx:{ty:[[{...}, {x,y,employer:[{key,name,visible,...}]}]]}} | null
// Response shapes checked against a live reply (dynamic) and the saved sample game-38d090cd2e3a4.php (quests).
import type { GameClient } from '../http/game-client.ts';
import type { Position } from './character.ts';
import { TILE, WORLD_H, WORLD_W } from './world.ts';

export interface SpecialJob extends Position { jobId: number; groupId: number; gold: boolean; silver: boolean }
export interface QuestGiver extends Position { names: string[]; employers: { key: string; name: string }[] }
export interface Crowd extends Position { count: number }

const TTL_MS = 60_000;
const MAX_TILES_PER_REQUEST = 25;

export class TileCache {
  private loadedAt = new Map<string, number>();
  specialJobs = new Map<string, SpecialJob>();
  questGivers = new Map<string, QuestGiver>();
  crowds = new Map<string, Crowd>();
  private inflight = false;

  private fresh(tx: number, ty: number): boolean {
    const t = this.loadedAt.get(`${tx},${ty}`);
    return t !== undefined && Date.now() - t < TTL_MS;
  }

  /** Loads stale tiles in a square around `at` (radius in tiles). Returns true if a request was made. */
  async loadAround(client: GameClient, at: Position, radius = 2): Promise<boolean> {
    if (this.inflight) return false;
    const cx = Math.floor(at.x / TILE);
    const cy = Math.floor(at.y / TILE);
    const tiles: [number, number][] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx * TILE >= WORLD_W || ty * TILE >= WORLD_H) continue;
        if (!this.fresh(tx, ty)) tiles.push([tx, ty]);
      }
    }
    if (!tiles.length) return false;
    this.inflight = true;
    try {
      const json = await client.get('map', 'get_complete_data', { tiles: JSON.stringify(tiles.slice(0, MAX_TILES_PER_REQUEST)) });
      this.ingest(json, tiles.slice(0, MAX_TILES_PER_REQUEST));
      return true;
    } finally {
      this.inflight = false;
    }
  }

  ingest(json: Record<string, any>, requested: [number, number][]): void {
    const now = Date.now();
    // Forget old entries of the requested tiles before re-adding.
    const inTiles = new Set(requested.map(([x, y]) => `${x},${y}`));
    const tileOf = (p: Position) => `${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)}`;
    for (const m of [this.specialJobs, this.questGivers, this.crowds] as Map<string, Position>[]) {
      for (const [k, v] of m) if (inTiles.has(tileOf(v))) m.delete(k);
    }
    for (const t of inTiles) this.loadedAt.set(t, now);

    const layers = Array.isArray(json.dynamic) ? json.dynamic : json.dynamic ? [json.dynamic] : [];
    for (const layer of layers) {
      for (const ys of Object.values<any>(layer ?? {})) {
        for (const entries of Object.values<any>(ys ?? {})) {
          for (const e of entries as any[]) {
            const d = e?.[1];
            if (!d || typeof d !== 'object') continue;
            const key = `${d.x},${d.y}`;
            if (d.job_id !== undefined && (d.gold || d.silver)) {
              this.specialJobs.set(`${key}#${d.job_id}`, { x: d.x, y: d.y, jobId: d.job_id, groupId: d.group_id, gold: !!d.gold, silver: !!d.silver });
            } else if (d.count !== undefined && d.town_id === undefined) {
              this.crowds.set(key, { x: d.x, y: d.y, count: d.count });
            }
          }
        }
      }
    }
    for (const ys of Object.values<any>(json.quests ?? {})) {
      for (const entries of Object.values<any>(ys ?? {})) {
        for (const e of entries as any[]) {
          const d = e?.[1];
          if (!d) continue;
          const employers = (d.employer ?? [])
            .filter((em: any) => em.visible !== false)
            .map((em: any) => ({ key: String(em.key), name: String(em.name).replace(/&#039;/g, "'").replace(/&amp;/g, '&') }));
          this.questGivers.set(`${d.x},${d.y}`, { x: d.x, y: d.y, names: employers.map((e: { name: string }) => e.name), employers });
        }
      }
    }
  }
}
