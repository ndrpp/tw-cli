// Terminal world map. The cursor is the centre cell; the view pans around it.
// One column covers `zoom` px of world x; one row covers 2×zoom px of y (terminal cells are ~2:1).
import React from 'react';
import { Box, Text } from 'ink';
import type { GameState, JobOption } from '../game/state.ts';
import type { Position } from '../game/character.ts';
import { WORLD_H, WORLD_W, type Fort, type Town } from '../game/world.ts';
import { distance } from '../game/jobs.ts';
import { formatDuration, money, truncate } from './format.ts';
import { defined } from '../util/defined.ts';

const h = React.createElement;

export const ZOOMS = [32, 64, 128, 256, 512, 1024];

export interface MapView { x: number; y: number; zoom: number }

export interface Seg { text: string; color?: string | undefined; dim?: boolean | undefined; bold?: boolean | undefined; inverse?: boolean | undefined }

interface Cell { ch: string; prio: number; color?: string; dim?: boolean; bold?: boolean }

export type MapLayer = 'jobs' | 'lockedJobs' | 'special' | 'questJobs' | 'questGivers' | 'towns' | 'emptyTowns' | 'forts' | 'markets' | 'players' | 'queue' | 'counties';
/** Toggleable map layers (v on the map), in display order. */
export const MAP_LAYERS: { key: MapLayer; symbol: string; color: string; label: string }[] = [
  { key: 'jobs', symbol: 'j', color: 'yellow', label: 'jobs you can do' },
  { key: 'lockedJobs', symbol: 'j', color: 'gray', label: 'jobs without enough labor points' },
  { key: 'special', symbol: '*', color: 'yellowBright', label: 'gold / silver jobs' },
  { key: 'questJobs', symbol: '!', color: 'magentaBright', label: 'quest / route jobs' },
  { key: 'questGivers', symbol: '?', color: 'magenta', label: 'quest givers & fair' },
  { key: 'towns', symbol: 'T', color: 'white', label: 'towns' },
  { key: 'emptyTowns', symbol: 't', color: 'gray', label: 'empty town sites' },
  { key: 'forts', symbol: 'F', color: 'red', label: 'forts' },
  { key: 'markets', symbol: '$', color: 'green', label: 'markets' },
  { key: 'players', symbol: 'p', color: 'blueBright', label: 'players & friends' },
  { key: 'queue', symbol: '1', color: 'cyan', label: 'queued tasks' },
  { key: 'counties', symbol: '┊', color: 'gray', label: 'county borders' },
];
export const DEFAULT_LAYERS: Record<MapLayer, boolean> = Object.fromEntries(MAP_LAYERS.map((l) => [l.key, true])) as Record<MapLayer, boolean>;

export function clampView(v: MapView): MapView {
  return { ...v, x: Math.min(WORLD_W - 1, Math.max(0, v.x)), y: Math.min(WORLD_H - 1, Math.max(0, v.y)) };
}

function origin(view: MapView, cols: number, rows: number) {
  const cw = view.zoom;
  const chh = view.zoom * 2;
  const cc = Math.floor(cols / 2);
  const cr = Math.floor(rows / 2);
  // Cursor cell (cc, cr) contains view.x/view.y.
  const x0 = Math.floor(view.x / cw) * cw - cc * cw;
  const y0 = Math.floor(view.y / chh) * chh - cr * chh;
  return { cw, chh, cc, cr, x0, y0 };
}

/** World rectangle covered by the cursor cell. */
export function cursorRect(view: MapView, cols: number, rows: number) {
  const { cw, chh, cc, cr, x0, y0 } = origin(view, cols, rows);
  const x1 = x0 + cc * cw;
  const y1 = y0 + cr * chh;
  return { x1, y1, x2: x1 + cw, y2: y1 + chh };
}

export function buildGrid(state: GameState, view: MapView, cols: number, rows: number): Seg[][] {
  const { cw, chh, cc, cr, x0, y0 } = origin(view, cols, rows);
  const grid: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    const wy = y0 + r * chh;
    for (let c = 0; c < cols; c++) {
      const wx = x0 + c * cw;
      const outside = wx + cw <= 0 || wy + chh <= 0 || wx >= WORLD_W || wy >= WORLD_H;
      row.push(outside ? { ch: '░', prio: 0, dim: true } : { ch: ' ', prio: 0 });
    }
    grid.push(row);
  }
  const on = (l: MapLayer) => state.mapLayers[l] !== false;
  // County borders.
  for (const county of on('counties') ? state.world.counties : []) {
    for (const bx of [county.x1]) {
      if (bx <= 0) continue;
      const c = Math.floor((bx - x0) / cw);
      if (c < 0 || c >= cols) continue;
      for (let r = 0; r < rows; r++) {
        const wy = y0 + r * chh;
        if (wy + chh > county.y1 && wy <= county.y2 && grid[r]![c]!.prio === 0 && grid[r]![c]!.ch === ' ') grid[r]![c] = { ch: '┊', prio: 0, dim: true };
      }
    }
    if (county.y1 > 0) {
      const r = Math.floor((county.y1 - y0) / chh);
      if (r >= 0 && r < rows) {
        for (let c = 0; c < cols; c++) {
          const wx = x0 + c * cw;
          if (wx + cw > county.x1 && wx <= county.x2 && grid[r]![c]!.ch === ' ') grid[r]![c] = { ch: '┄', prio: 0, dim: true };
        }
      }
    }
  }
  const put = (p: Position, cell: Cell) => {
    const c = Math.floor((p.x - x0) / cw);
    const r = Math.floor((p.y - y0) / chh);
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    if (grid[r]![c]!.prio < cell.prio) grid[r]![c] = cell;
  };
  const doableGroups = new Set(state.jobs.filter((j) => j.jobPoints >= j.workPoints).map((j) => j.groupid));
  if (on('players')) {
    for (const f of state.world.friends) put(f, { ch: 'f', prio: 1, color: 'blue' });
    for (const c of state.tiles.crowds.values()) put(c, { ch: 'p', prio: 1, color: 'blueBright' });
  }
  for (const [groupId, locs] of state.world.jobGroups) {
    const doable = doableGroups.has(groupId);
    if (!on(doable ? 'jobs' : 'lockedJobs')) continue;
    for (const at of locs) put(at, { ch: 'j', prio: doable ? 3 : 2, color: doable ? 'yellow' : 'gray', dim: !doable });
  }
  if (on('markets')) for (const m of state.world.markets) put(m, { ch: '$', prio: 4, color: 'green' });
  if (on('questGivers')) {
    for (const q of state.world.quests) put(q, { ch: '?', prio: 5, color: 'magenta', bold: true });
    if (state.world.fair) put(state.world.fair, { ch: '&', prio: 5, color: 'magentaBright', bold: true });
  }
  if (on('forts')) for (const f of state.world.forts) put(f, { ch: 'F', prio: 6, color: 'red' });
  if (on('special')) for (const s of state.tiles.specialJobs.values()) put(s, { ch: '*', prio: 7, color: s.gold ? 'yellowBright' : 'whiteBright', bold: true });
  const home = state.character.homeTown?.id;
  for (const t of state.world.towns) {
    if (t.id === home) put(t, { ch: 'H', prio: 9, color: 'cyan', bold: true }); // home always shows
    else if (t.name) on('towns') && put(t, { ch: 'T', prio: 8, color: 'white', bold: true });
    else on('emptyTowns') && put(t, { ch: 't', prio: 6, dim: true });
  }
  if (on('queue')) state.queue.forEach((task, i) => put(task.coords, { ch: String((i + 1) % 10), prio: 10, color: 'cyan', bold: true }));
  // Quest targets (jobs that drop a required item) stand out over ordinary jobs and towns.
  for (const id of on('questJobs') ? state.mapHighlight?.jobIds ?? [] : []) {
    const job = state.catalog.get(id);
    for (const at of job ? state.world.jobGroups.get(job.groupid) ?? [] : []) put(at, { ch: '!', prio: 9.5, color: 'magentaBright', bold: true });
  }
  put(state.character.position, { ch: '@', prio: 11, color: 'green', bold: true });

  // Collapse runs of equal style into segments; cursor cell is inverse.
  return grid.map((row, r) => {
    const segs: Seg[] = [];
    row.forEach((cell, c) => {
      const inverse = r === cr && c === cc;
      const ch = inverse && cell.ch === ' ' ? '+' : cell.ch;
      const last = segs[segs.length - 1];
      if (last && !inverse && !last.inverse && last.color === cell.color && last.dim === cell.dim && last.bold === cell.bold) last.text += ch;
      else segs.push({ text: ch, color: cell.color, dim: cell.dim, bold: cell.bold, inverse });
    });
    return segs;
  });
}

export type MapEntry =
  | { kind: 'job'; option: JobOption; doable: boolean }
  | { kind: 'town'; town: Town }
  | { kind: 'fort'; fort: Fort }
  | { kind: 'quest'; key: string; name: string; at: Position }
  | { kind: 'text'; text: string; color?: string };

/** What is under the cursor cell, as selectable entries. */
export function entriesAt(state: GameState, view: MapView, cols: number, rows: number): MapEntry[] {
  const r = cursorRect(view, cols, rows);
  const here = state.world.within(r.x1, r.y1, r.x2, r.y2);
  const out: MapEntry[] = [];
  for (const t of here.towns) out.push({ kind: 'town', town: t });
  for (const f of here.forts) out.push({ kind: 'fort', fort: f });
  const inRect = (p: Position) => p.x >= r.x1 && p.x < r.x2 && p.y >= r.y1 && p.y < r.y2;
  const givers = [...state.tiles.questGivers.values()].filter(inRect);
  for (const g of givers) {
    if (!g.employers?.length) out.push({ kind: 'text', text: '? quest giver', color: 'magenta' });
    for (const e of g.employers ?? []) out.push({ kind: 'quest', key: e.key, name: e.name, at: { x: g.x, y: g.y } });
  }
  const unnamed = here.quests.filter((q) => !givers.some((g) => g.x === q.x && g.y === q.y));
  if (unnamed.length) out.push({ kind: 'text', text: `? quest giver${unnamed.length > 1 ? ` ×${unnamed.length}` : ''} (name loads when close)`, color: 'magenta' });
  if (state.world.fair && inRect(state.world.fair)) out.push({ kind: 'text', text: '& travelling fair', color: 'magentaBright' });
  for (const sj of [...state.tiles.specialJobs.values()].filter(inRect)) {
    out.push({ kind: 'text', text: `* ${sj.gold ? 'GOLD' : 'silver'} job: ${state.catalog.get(sj.jobId)?.name ?? sj.jobId}`, color: sj.gold ? 'yellowBright' : 'whiteBright' });
  }
  for (const c of [...state.tiles.crowds.values()].filter(inRect)) out.push({ kind: 'text', text: `p ${c.count} players here`, color: 'blueBright' });
  if (here.markets.length) out.push({ kind: 'text', text: '$ market', color: 'green' });
  if (here.friends.length) out.push({ kind: 'text', text: `f friends: ${here.friends.reduce((n, f) => n + f.amount, 0)}`, color: 'blue' });
  const seen = new Set<string>();
  for (const { groupId, at } of here.jobs) {
    for (const option of state.jobsAtLocation(groupId, at)) {
      const key = `${option.job.id}@${at.x},${at.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'job', option, doable: option.job.jobPoints >= option.job.workPoints });
    }
  }
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

function rank(e: MapEntry): number {
  if (e.kind === 'town' || e.kind === 'fort' || e.kind === 'quest') return 0;
  if (e.kind === 'text') return 1;
  return e.doable ? 2 : 3;
}

/** '/' search: nearest location (from the cursor) of a job or named town matching the query. */
export function findNearest(state: GameState, query: string, from: Position): { at: Position; label: string } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let best: { at: Position; label: string; d: number } | null = null;
  const consider = (at: Position, label: string) => {
    const d = distance(at, from);
    if (!best || d < best.d) best = { at, label, d };
  };
  for (const job of state.jobs) {
    if (!job.name.toLowerCase().includes(q)) continue;
    for (const at of state.world.jobGroups.get(job.groupid) ?? []) consider(at, job.name);
  }
  for (const t of state.world.towns) if (t.name?.toLowerCase().includes(q)) consider(t, t.name);
  const b = best as { at: Position; label: string; d: number } | null;
  return b ? { at: b.at, label: b.label } : null;
}

export interface MapScreenProps {
  state: GameState;
  view: MapView;
  width: number;
  height: number;
  entries: MapEntry[];
  selected: number;
  panelFocused: boolean;
  search: string;
  searching: boolean;
}

export const PANEL_W = 40;

export function mapGridSize(width: number, height: number) {
  return { cols: Math.max(10, width - PANEL_W - 2), rows: Math.max(4, height - 2) };
}

export function MapScreen(p: MapScreenProps) {
  const { state, view, width, height, entries, selected, panelFocused } = p;
  const { cols, rows } = mapGridSize(width, height);
  const grid = buildGrid(state, view, cols, rows);
  const rect = cursorRect(view, cols, rows);
  const centre = { x: Math.round((rect.x1 + rect.x2) / 2), y: Math.round((rect.y1 + rect.y2) / 2) };
  const county = state.world.countyAt(centre);
  const panelW = Math.max(20, width - cols - 2);
  const listRows = Math.max(1, height - 2 - 5);
  const start = Math.max(0, Math.min(selected - Math.floor(listRows / 2), entries.length - listRows));
  const shown = entries.slice(start, start + listRows);

  return h(Box, { height, width },
    h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: panelFocused ? 'gray' : 'cyan', width: cols + 2, flexShrink: 0 },
      ...grid.map((segs, r) =>
        h(Text, { key: r, wrap: 'truncate' },
          ...segs.map((s, i) => h(Text, defined({ key: i, color: s.color, dimColor: s.dim, bold: s.bold, inverse: s.inverse }), s.text)))),
    ),
    h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: panelFocused ? 'cyan' : 'gray', width: panelW, paddingX: 1, flexShrink: 0 },
      h(Text, { bold: true, wrap: 'truncate' }, p.searching ? `Find: ${p.search}▏` : `${county?.name ?? 'Map'} · zoom ${view.zoom}px`),
      h(Text, { dimColor: true, wrap: 'truncate' }, `cursor ${centre.x},${centre.y}${hiddenLayers(state) ? ` · ${hiddenLayers(state)} layer(s) off (v)` : ''}`),
      h(Text, { dimColor: true, wrap: 'truncate' }, `travel ${formatDuration(state.travelTo(centre))} from queue end`),
      entries.length === 0 ? h(Text, { dimColor: true }, 'Nothing here') : null,
      ...shown.map((e, i) => {
        const idx = start + i;
        const sel = panelFocused && idx === selected;
        const w = panelW - 4;
        if (e.kind === 'town') {
          const t = e.town;
          const label = t.name ? `${t.id === state.character.homeTown?.id ? 'H' : 'T'} ${t.name} · ${t.members}m ${t.points}pts` : `t empty town site`;
          return h(Text, { key: idx, inverse: sel, wrap: 'truncate', color: 'white' }, truncate(label, w));
        }
        if (e.kind === 'fort') return h(Text, { key: idx, inverse: sel, wrap: 'truncate', color: 'red' }, truncate(`F ${e.fort.name}`, w));
        if (e.kind === 'quest') return h(Text, { key: idx, inverse: sel, wrap: 'truncate', color: 'magenta' }, truncate(`? ${e.name}`, w));
        if (e.kind === 'text') return h(Text, defined({ key: idx, inverse: sel, wrap: 'truncate', color: e.color }), truncate(e.text, w));
        const j = e.option.job;
        const v = j.values.long ?? j.values.middle ?? j.values.short;
        const quest = state.mapHighlight?.jobIds.has(j.id);
        const label = `${quest ? '!' : 'j'} ${j.name} ${j.laborPoints}LP${v ? ` ${money(v.money)}/h` : ''}`;
        return h(Text, { key: idx, inverse: sel, wrap: 'truncate', color: quest ? 'magentaBright' : e.doable ? 'yellow' : 'gray' }, truncate(label, w));
      }),
    ),
  );
}

const hiddenLayers = (state: GameState) => MAP_LAYERS.filter((l) => state.mapLayers[l.key] === false).length;

/** v on the map: which layers are drawn. */
export function LayersOverlay({ state, selected, width, height }: { state: GameState; selected: number; width: number; height: number }) {
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, width: Math.min(52, width), height },
    h(Text, { bold: true }, 'Map layers'),
    ...MAP_LAYERS.map((l, i) => {
      const shown = state.mapLayers[l.key] !== false;
      return h(Text, { key: l.key, inverse: i === selected, wrap: 'truncate' },
        h(Text, { color: shown ? 'green' : 'gray' }, shown ? '[✔] ' : '[ ] '),
        h(Text, { color: l.color, bold: true, dimColor: !shown }, l.symbol),
        h(Text, { dimColor: !shown }, ` ${l.label}`));
    }),
    h(Box, { flexGrow: 1 }),
    h(Text, { dimColor: true, wrap: 'truncate' }, 'Space/Enter toggle · a all on · n all off · Esc close'),
  );
}
