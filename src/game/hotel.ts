// Hotel (HotelWindow @1516149): building_hotel mode get_data {town_id} →
//   {hotel_level, town_name, own_hotel, waytime, attackable, rooms:{<room key>:{name,level,available,free,costs,energy,health}}}
// Sleeping is a task: TaskSleep(town_id, room) → task/add post {town_id, room, taskType:'sleep'}.
// Room keys: cubby, bedroom, hotel_room, apartment, luxurious_apartment (TaskSleep.getIcon @686067).
import type { GameClient } from '../http/game-client.ts';
import { entries, type JsonObject, obj } from '../util/json.ts';

export interface HotelRoom {
  key: string;
  name: string;
  level: number;
  available: boolean;
  free: boolean;
  costs: number;
  energy: number;
  health: number;
}
export interface Hotel {
  townId: number;
  townName: string;
  level: number;
  own: boolean;
  waytime: string;
  attackable: string | null;
  rooms: HotelRoom[];
}

/** A room's energy / health number as a fraction of max per hour (read as % per hour; checked by calibration.ts). */
export const roomRate = (value: number) => Math.max(0, value) / 100;

export function parseHotel(townId: number, json: JsonObject): Hotel {
  const rooms = entries(json.rooms).map(([key, value]) => {
    const jsonValue = obj(value);
    return {
      key,
      name: String(jsonValue.name ?? key),
      level: Number(jsonValue.level) || 0,
      available: !!jsonValue.available,
      free: !!jsonValue.free,
      costs: Number(jsonValue.costs) || 0,
      energy: Number(jsonValue.energy) || 0,
      health: Number(jsonValue.health) || 0,
    };
  });
  rooms.sort((first, second) => first.level - second.level);
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
export function defaultRoom(hotel: Hotel): HotelRoom | undefined {
  const usable = hotel.rooms.filter((room) => room.available);
  if (hotel.own) return usable.find((room) => room.level === hotel.level) ?? usable.at(-1);
  return usable.filter((room) => room.free && room.level <= hotel.level).at(-1) ?? usable[0];
}

export async function fetchHotel(client: GameClient, townId: number): Promise<Hotel> {
  const json = await client.remoteCallMode('building_hotel', 'get_data', { town_id: townId });
  if (json.error) throw new Error(String(json.msg ?? 'Hotel failed'));
  return parseHotel(townId, json);
}
