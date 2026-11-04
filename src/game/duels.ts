// Duels (DuelsWindow @1379265–@1407500, TaskDuel @688583):
//   duel/get_data {} → {npcs:{npcs:[{duelnpc_id, npc_name, npc_level, weapon_id, arrival_delta, ...}],
//     arrival_delay, difficulty}, motivation, motivation_npc, weaponId, ...}
//   duel/duel_npc {duelnpc_id} → {data:{rounds, summary_round, duelResult (HTML)}, npcs, money, energy, health,
//     experience, level, motivation, motivation_npc, attacker_died} | {error, msg}
//   duel/search_op {distance (s, default 7200), order_by:'ASC', page, sort:'range', next} → {oplist:{pclist:[
//     {player_id, player_name, duellevel, town_name, character_x, character_y, alliance_id, ...}], page, next}}
//   Player duels are tasks: task/add {player_id, taskType:'duel'} (Task('duel', {player_id})).
import type { FormValue } from '../http/form.ts';
import type { GameClient } from '../http/game-client.ts';
import { plainText } from './quests.ts';
import { obj, objs, type JsonObject } from '../util/json.ts';

export interface DuelNpc { id: number; name: string; level: number; weaponId: number; readyIn: number }
export interface DuelData { npcs: DuelNpc[]; difficulty: string; motivation: number; npcMotivation: number }
export interface DuelOpponent { playerId: number; name: string; duelLevel: number; town: string; x: number; y: number; allianceId: number }
export interface NpcDuelResult {
  result: string;
  rounds: { own: number | null; other: number | null }[];
  energy?: number | undefined; health?: number | undefined; money?: number | undefined; experience?: number | undefined; level?: number | undefined; died: boolean;
  data: DuelData;
}

const errText = (json: JsonObject, what: string) => plainText(json.msg ?? '') || `${what} failed`;

export function parseDuelData(json: JsonObject): DuelData {
  const npcs = obj(json.npcs);
  const delay = Number(npcs.arrival_delay) || 0;
  return {
    npcs: objs(npcs.npcs).map((n) => ({
      id: Number(n.duelnpc_id), name: plainText(n.npc_name), level: Number(n.npc_level) || 0, weaponId: Number(n.weapon_id) || 0,
      readyIn: Math.max(0, delay - (Number(n.arrival_delta) || 0)),
    })),
    difficulty: String(npcs.difficulty ?? ''),
    motivation: Number(json.motivation) || 0,
    npcMotivation: Number(json.motivation_npc) || 0,
  };
}

const num = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? undefined : Number(v));

export class DuelApi {
  private client: GameClient;

  constructor(client: GameClient) {
    this.client = client;
  }

  async data(): Promise<DuelData> {
    const json = await this.client.remoteCall('duel', 'get_data', {});
    if (json.error) throw new Error(errText(json, 'Duels'));
    return parseDuelData(json);
  }

  async fightNpc(npcId: number): Promise<NpcDuelResult> {
    const json = await this.client.remoteCall('duel', 'duel_npc', { duelnpc_id: npcId });
    if (json.error) throw new Error(errText(json, 'NPC duel'));
    const d = obj(json.data);
    const hit = (p: unknown) => (obj(p).damage ? Number(obj(p).damage) : null);
    return {
      result: plainText(d.duelResult ?? ''),
      rounds: objs(d.rounds).map((r) => ({ own: hit(r.own), other: hit(r.other) })),
      energy: num(json.energy), health: num(json.health), money: num(json.money), experience: num(json.experience), level: num(json.level),
      died: !!json.attacker_died,
      data: parseDuelData(json),
    };
  }

  /** Players in duel range within `distance` seconds of walking. */
  async opponents(page = 0, distance = 7200): Promise<{ opponents: DuelOpponent[]; next: boolean }> {
    const json = await this.client.remoteCall('duel', 'search_op', { distance, order_by: 'ASC', page, sort: 'range', next: false });
    if (json.error) throw new Error(errText(json, 'Duel opponents'));
    const ol = obj(json.oplist);
    return {
      opponents: objs(ol.pclist).map((p) => ({
        playerId: Number(p.player_id), name: plainText(p.player_name), duelLevel: Number(p.duellevel) || 0, town: plainText(p.town_name ?? ''),
        x: Number(p.character_x) || 0, y: Number(p.character_y) || 0, allianceId: Number(p.alliance_id) || 0,
      })),
      next: !!ol.next,
    };
  }
}

/** TaskDuel(playerId).post */
export function duelPost(playerId: number): Record<string, FormValue> {
  return { player_id: playerId, taskType: 'duel' };
}
