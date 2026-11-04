// Points of interest for the map: the game's interactive map objects (GameMap.Data.interactiveImages:
// town, job, quest, fort, fair, adventures) plus markets, friends and your own places.
import type { Position } from './character.ts';
import { distance } from './jobs.ts';
import type { GameState } from './state.ts';

export type PoiKind =
  | 'home'
  | 'me'
  | 'queue'
  | 'town'
  | 'fort'
  | 'quest'
  | 'gold'
  | 'silver'
  | 'market'
  | 'fair'
  | 'friend'
  | 'crowd';

export interface Poi extends Position {
  kind: PoiKind;
  label: string;
  townId?: number;
}

export const POI_STYLE: Record<PoiKind, { ch: string; color: string; name: string }> = {
  me: { ch: '@', color: 'green', name: 'you' },
  queue: { ch: '#', color: 'cyan', name: 'queued task' },
  home: { ch: 'H', color: 'cyan', name: 'home town' },
  town: { ch: 'T', color: 'white', name: 'town' },
  fort: { ch: 'F', color: 'red', name: 'fort' },
  quest: { ch: '?', color: 'magenta', name: 'quest giver' },
  gold: { ch: '*', color: 'yellowBright', name: 'gold job' },
  silver: { ch: '*', color: 'whiteBright', name: 'silver job' },
  market: { ch: '$', color: 'green', name: 'market' },
  fair: { ch: '&', color: 'magentaBright', name: 'travelling fair' },
  friend: { ch: 'f', color: 'blue', name: 'friend' },
  crowd: { ch: 'p', color: 'blueBright', name: 'players' },
};

export function collectPois(state: GameState): Poi[] {
  const out: Poi[] = [];
  const w = state.world;
  const homeId = state.character.homeTown?.id;
  out.push({ kind: 'me', label: state.character.name, ...state.character.position });
  state.queue.forEach((t, i) => {
    out.push({ kind: 'queue', label: `${i + 1}. ${t.title}`, ...t.coords });
  });
  for (const t of w.towns) {
    if (t.id === homeId) out.push({ kind: 'home', label: t.name ?? 'Home town', x: t.x, y: t.y, townId: t.id });
    else if (t.name)
      out.push({ kind: 'town', label: `${t.name} (${t.members} members)`, x: t.x, y: t.y, townId: t.id });
  }
  for (const f of w.forts) out.push({ kind: 'fort', label: f.name, x: f.x, y: f.y });
  // Named quest givers from loaded tiles; the rest from the minimap without names.
  const named = new Set<string>();
  for (const q of state.tiles.questGivers.values()) {
    named.add(`${q.x},${q.y}`);
    out.push({ kind: 'quest', label: q.names.join(', ') || 'Quest giver', x: q.x, y: q.y });
  }
  for (const q of w.quests)
    if (!named.has(`${q.x},${q.y}`)) out.push({ kind: 'quest', label: 'Quest giver', x: q.x, y: q.y });
  for (const s of state.tiles.specialJobs.values()) {
    const name = state.catalog.get(s.jobId)?.name ?? `job ${s.jobId}`;
    out.push({ kind: s.gold ? 'gold' : 'silver', label: `${s.gold ? 'Gold' : 'Silver'} job: ${name}`, x: s.x, y: s.y });
  }
  for (const m of w.markets) out.push({ kind: 'market', label: 'Market', x: m.x, y: m.y });
  if (w.fair) out.push({ kind: 'fair', label: 'Travelling fair', ...w.fair });
  for (const f of w.friends) out.push({ kind: 'friend', label: `Friends (${f.amount})`, x: f.x, y: f.y });
  for (const c of state.tiles.crowds.values()) out.push({ kind: 'crowd', label: `${c.count} players`, x: c.x, y: c.y });
  return out;
}

/** POIs sorted by distance from `from`, optionally filtered by text or kind. */
export function poisNear(state: GameState, from: Position, filter = ''): (Poi & { dist: number })[] {
  const f = filter.trim().toLowerCase();
  return collectPois(state)
    .filter((p) => !f || p.label.toLowerCase().includes(f) || POI_STYLE[p.kind].name.includes(f))
    .map((p) => ({ ...p, dist: distance(p, from) }))
    .sort((a, b) => a.dist - b.dist);
}
