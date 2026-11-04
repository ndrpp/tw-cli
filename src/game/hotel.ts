// Hotel (HotelWindow @1516149): building_hotel mode get_data {town_id} →
//   {hotel_level, town_name, own_hotel, waytime, attackable, rooms:{<room key>:{name,level,available,free,costs,energy,health}}}
// Sleeping is a task: TaskSleep(town_id, room) → task/add post {town_id, room, taskType:'sleep'}.
// Room keys: cubby, bedroom, hotel_room, apartment, luxurious_apartment (TaskSleep.getIcon @686067).
import type { GameClient } from '../http/game-client.ts';

export interface HotelRoom { key: string; name: string; level: number; available: boolean; free: boolean; costs: number; energy: number; health: number }
export interface Hotel { townId: number; townName: string; level: number; own: boolean; waytime: string; attackable: string | null; rooms: HotelRoom[] }

/** A room's energy / health number as a fraction of max per hour (read as % per hour; checked by calibration.ts). */
export const roomRate = (v: number) => Math.max(0, v) / 100;

export function parseHotel(townId: number, json: Record<string, any>): Hotel {
  const rooms = Object.entries<any>(json.rooms ?? {}).map(([key, r]) => ({
    key,
    name: String(r?.name ?? key),
    level: Number(r?.level) || 0,
    available: !!r?.available,
    free: !!r?.free,
    costs: Number(r?.costs) || 0,
    energy: Number(r?.energy) || 0,
    health: Number(r?.health) || 0,
  }));
  rooms.sort((a, b) => a.level - b.level);
  return {
    townId,
    townName: String(json.town_name ?? `town ${townId}`),
    level: Number(json.hotel_level) || 0,
    own: !!json.own_hotel,
    waytime: String(json.waytime ?? ''),
    attackable: json.attackable ? String(json.attackable) : null,
    rooms,
  };
}

/** The room the browser pre-selects: own hotel → its level; else the best free one. */
export function defaultRoom(h: Hotel): HotelRoom | undefined {
  const usable = h.rooms.filter((r) => r.available);
  if (h.own) return usable.find((r) => r.level === h.level) ?? usable.at(-1);
  return usable.filter((r) => r.free && r.level <= h.level).at(-1) ?? usable[0];
}

export async function fetchHotel(client: GameClient, townId: number): Promise<Hotel> {
  const json = await client.remoteCallMode('building_hotel', 'get_data', { town_id: townId });
  if (json.error) throw new Error(json.msg ?? 'Hotel failed');
  return parseHotel(townId, json);
}
