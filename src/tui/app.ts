// Full-screen TUI (ink, without JSX so Node can run the TypeScript directly).
// Layout: status header · screen nav bar · screen (home by default; jobs: list + details | task queue) · log · key help.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { JOB_SORTS, type GameState, type JobOption, type JobSort, type StartupStep } from '../game/state.ts';
import { DURATION_KEYS, type DurationKey } from '../game/jobs.ts';
import { bar, formatDuration, money, scrollWindow, truncate } from './format.ts';
import { ICON } from './icons.ts';
import { clampView, entriesAt, findNearest, LayersOverlay, MAP_LAYERS, mapGridSize, MapScreen, ZOOMS, type MapView } from './map.ts';
import { GOTO, HelpOverlay, HotelOverlay, PoiOverlay, SCREEN_MODES, type Mode } from './overlays.ts';
import { CharacterScreen } from './character.ts';
import { QuestsScreen } from './quests.ts';
import { MailScreen } from './mail.ts';
import { TradeScreen } from './trade.ts';
import { DuelsScreen } from './duels.ts';
import { AutopilotScreen } from './autopilot.ts';
import { DebugScreen } from './debug.ts';
import { QueuePane } from './queue.ts';
import { ChatScreen } from './chat.ts';
import { TownScreen } from './town.ts';
import { HomeScreen } from './home.ts';
import { defaultRoom } from '../game/hotel.ts';
import { poisNear } from '../game/poi.ts';

const h = React.createElement;
const QUEUE_POLL_MS = 60_000;
/** danger is only in job/job and motivation changes as jobs repeat; refresh the selected job. */
const JOB_DETAIL_POLL_MS = 60_000;
/** Full character re-read: other players' duels change health/money with no live push. */
const SYNC_MS = 3 * 60_000;

type Focus = 'jobs' | 'queue';
const LIVE_COLOR = { off: 'gray', connecting: 'yellow', on: 'green', error: 'red' } as const;

function useGameState(state: GameState): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onChange = () => setVersion((v) => v + 1);
    state.on('change', onChange);
    return () => {
      state.off('change', onChange);
    };
  }, [state]);
  return version;
}

function Header({ state }: { state: GameState }) {
  const c = state.character;
  const now = state.clock.now();
  const automation = state.hasAutomation ? `automation ${formatDuration(state.automationUntil - now)}` : 'no automation';
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
    h(Box, { justifyContent: 'space-between' },
      h(Text, { bold: true, color: 'yellow', wrap: 'truncate' }, `${c.name}  lvl ${c.level} ${c.charClass}`),
      h(Text, { dimColor: true, wrap: 'truncate' },
        `${state.worldName} · ${automation} · `,
        h(Text, { color: LIVE_COLOR[state.liveStatus], dimColor: false }, `● live ${state.liveStatus}`),
        state.unread.reports ? h(Text, { color: 'yellow' }, ` · ${ICON.mail} new report (g r)`) : '',
        state.unread.messages ? h(Text, { color: 'yellow' }, ` · ${ICON.mail} new telegram (g r)`) : '',
        state.live?.unreadRooms.size ? h(Text, { color: 'cyan' }, ` · chat ${state.live.unreadRooms.size} (g c)`) : '',
        state.quests.some((q) => q.finishable) ? h(Text, { color: 'green' }, ` · ${ICON.quest} ${state.quests.filter((q) => q.finishable).length} quest(s) to finish`) : '',
        state.autoRoute ? h(Text, { color: 'magenta' }, ` · auto-route ${state.autoRoute.runs.length} left`) : '',
        state.autopilot.config.running ? h(Text, { color: 'green' }, ' · autopilot ●') : '',
        state.busy ? ' · working…' : ''),
    ),
    h(Text, { wrap: 'truncate' },
      h(Text, { color: 'red' }, 'HP '), `${bar(c.health, c.maxHealth, 10)} ${c.health}/${c.maxHealth}   `,
      h(Text, { color: 'cyan' }, 'EN '), `${bar(c.energy, c.maxEnergy, 10)} ${c.energy}/${c.maxEnergy}   `,
      h(Text, { color: 'green' }, 'XP '), xpText(c),
      h(Text, { color: 'green' }, money(c.cash)), ` bank ${money(c.deposit)}   `,
      h(Text, { dimColor: true }, `pos ${c.position.x},${c.position.y}`),
      state.lastSync ? h(Text, { dimColor: true }, ` · synced ${formatDuration(Math.floor((Date.now() - state.lastSync) / 1000))} ago`) : '',
    ),
  );
}

/** XP within the level: bar, have/need and percent (the web's XP bar, Character.getExperience4Level). */
function xpText(c: GameState['character']): string {
  const p = c.progress;
  if (p.maxed) return `${c.experience} (max level)   `;
  return `${bar(p.have, p.need, 10)} ${p.have}/${p.need} ${Math.floor(p.ratio * 100)}%   `;
}

const SORT_LABEL: Record<JobSort, string> = { name: 'name', xp: 'XP', money: '$', luck: 'luck', distance: 'distance' };

/** Columns after the name: XP and $ of the longest duration (when wide enough), luck when sorted by it, LP, travel. */
function jobCells(o: JobOption, wide: boolean, luck: boolean): string {
  const v = o.job.values.long ?? o.job.values.middle ?? o.job.values.short;
  const way = o.way === null ? '—' : formatDuration(o.way);
  return [
    wide ? (v ? `${v.experience}xp` : '').padStart(6) : null,
    wide ? (v ? money(v.money) : '').padStart(7) : null,
    luck ? money(o.job.luckValue[1]).padStart(7) : null,
    String(o.job.laborPoints).padStart(5),
    way.padStart(7),
  ].filter((c) => c !== null).join(' ');
}

function JobsPane(props: { state: GameState; options: JobOption[]; selected: number; focused: boolean; height: number; width: number; filter: string; filtering: boolean; sort: JobSort; showAll: boolean }) {
  const { state, options, selected, focused, height, width, filter, filtering, sort, showAll } = props;
  const listHeight = Math.max(3, height - 5);
  const [start, end] = scrollWindow(selected, options.length, listHeight);
  const luck = sort === 'luck';
  // Inner width − marker − LP and travel (with spaces) − luck − xp and $.
  const fixed = 4 + 2 + 14 + (luck ? 8 : 0);
  const wide = width - fixed - 15 >= 14;
  const nameW = Math.max(8, width - fixed - (wide ? 15 : 0));
  const quest = state.mapHighlight?.jobIds;
  const title = filtering ? `Jobs  /${filter}▏` : filter ? `Jobs  (filter: ${filter})` : 'Jobs';
  const head = `  ${'job'.padEnd(nameW)} ${[wide ? 'xp'.padStart(6) : null, wide ? '$'.padStart(7) : null, luck ? 'luck'.padStart(7) : null, 'LP'.padStart(5), 'travel'.padStart(7)].filter(Boolean).join(' ')}`;
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'cyan' : 'gray', width, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, `${title}  ${options.length ? `${selected + 1}/${options.length}` : ''}`),
    h(Text, { dimColor: true, wrap: 'truncate' }, `sort: ${SORT_LABEL[sort]} (S) · ${showAll ? 'all jobs' : 'enough LP only'} (a) · xp/$ for the longest run${quest?.size ? ` · ! ${state.mapHighlight!.label}` : ''}`),
    h(Text, { dimColor: true, wrap: 'truncate' }, head),
    ...options.slice(start, end).map((o, i) => {
      const idx = start + i;
      const sel = idx === selected;
      const doable = o.job.jobPoints >= o.job.workPoints;
      const mark = quest?.has(o.job.id) ? h(Text, { color: 'magentaBright', bold: true }, '! ') : '  ';
      return h(Text, { key: o.job.id, inverse: sel && focused, color: doable ? undefined : 'gray', wrap: 'truncate' },
        mark, `${truncate(o.job.name, nameW).padEnd(nameW)} ${jobCells(o, wide, luck)}`);
    }),
    options.length === 0 ? h(Text, { dimColor: true }, state0(filter, showAll)) : null,
  );
}

function state0(filter: string, showAll: boolean): string {
  return filter ? `No job matches the filter${showAll ? '' : ' (a shows jobs without enough LP)'}.` : 'Loading jobs…';
}

function JobDetail({ option, state }: { option: JobOption | undefined; state: GameState }) {
  if (!option) return h(Box, { borderStyle: 'round', borderColor: 'gray', paddingX: 1 }, h(Text, { dimColor: true }, 'No job selected'));
  const { job, at, way } = option;
  const danger = job.danger === null ? '—' : `${job.danger}%`;
  const durRows = DURATION_KEYS.map((k, i) => {
    const v = job.values[k];
    if (!v) return null;
    return h(Text, { key: k, wrap: 'truncate' },
      h(Text, { color: 'yellow' }, `[${i + 1}] `),
      `${formatDuration(v.duration).padStart(7)} ${String(v.energy).padStart(3)}en ${money(v.money).padStart(6)} ${String(v.experience).padStart(4)}xp`,
      v.energy ? h(Text, { dimColor: true }, `  ${(v.experience / v.energy).toFixed(1)} xp/en`) : '');
  });
  const quest = state.mapHighlight?.jobIds.has(job.id) ? state.mapHighlight.label : '';
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, `${job.name}  (lvl ${job.level})`),
    h(Text, { wrap: 'truncate' }, `${job.laborPoints} LP · motiv ${Math.round((job.motivation ?? 0) * 100)}% · danger ${danger}`),
    h(Text, { wrap: 'truncate' }, h(Text, { color: 'yellow' }, 'Luck '), job.luckValue[1] > 0 ? money(job.luckValue[1]) : '—'),
    h(Text, { dimColor: true, wrap: 'truncate' }, at ? `at ${at.x},${at.y} · travel ${formatDuration(way ?? 0)}` : 'No location known'),
    ...durRows,
    h(Text, { color: 'magenta', wrap: 'truncate' }, `Drops: ${state.jobProducts(job).map((p) => `${p.name}${p.percent !== null ? ` ${p.percent}%` : ''}`).join(' · ') || '—'}`),
    quest ? h(Text, { color: 'magentaBright', wrap: 'truncate' }, `! needed for ${quest}`) : null,
    state.queue.length >= state.taskLimit ? h(Text, { color: 'red', wrap: 'truncate' }, `Queue full (${state.queue.length}/${state.taskLimit})`) : null,
  );
}

function LogPane({ state, lines }: { state: GameState; lines: number }) {
  const entries = state.log.slice(-lines);
  return h(Box, { flexDirection: 'column', paddingX: 1 },
    ...entries.map((e, i) =>
      h(Text, { key: i, color: e.level === 'error' ? 'red' : undefined, dimColor: e.level === 'info', wrap: 'truncate' },
        `${e.at.toLocaleTimeString()}  ${e.msg}`)),
  );
}

export function App({ state, size, onAccount }: { state: GameState; size?: { columns: number; rows: number }; onAccount?: () => void }) {
  useGameState(state);
  const { exit } = useApp();
  const win = useWindowSize();
  const { columns, rows } = size ?? win;
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>('home');
  /** Screens Esc goes back through (a screen appears at most once, so going back never loops). */
  const history = useRef<Mode[]>([]);
  /** g was pressed: the next key picks a screen or action from GOTO. */
  const [leader, setLeader] = useState(false);
  const [overlay, setOverlay] = useState<null | 'help' | 'poi' | 'hotel' | 'layers'>(null);
  const [layerSel, setLayerSel] = useState(0);
  const [hotelSel, setHotelSel] = useState(0);
  const [questsOnGivers, setQuestsOnGivers] = useState(false);
  const capture = useRef(false);
  const [focus, setFocus] = useState<Focus>('jobs');
  const [jobSel, setJobSel] = useState(0);
  const [queueSel, setQueueSel] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [jobSort, setJobSort] = useState<JobSort>('name');
  const [showAllJobs, setShowAllJobs] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [view, setView] = useState<MapView>(() => ({ ...state.character.position, zoom: 128 }));
  const [mapPanel, setMapPanel] = useState(false);
  const [mapSel, setMapSel] = useState(0);
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [poiSel, setPoiSel] = useState(0);
  const [poiFilter, setPoiFilter] = useState('');

  // 1 s ticker: countdowns, regen, local task completion (like TaskQueueUi.tick); poll queue.
  useEffect(() => {
    let lastPoll = Date.now();
    let lastSync = Date.now();
    let lastTick = Date.now();
    let pausedUntil = 0;
    const timer = setInterval(() => {
      // Back from sleep: the Root's WakeDetector rebuilds everything within ~2 s; don't act on the
      // stale session/queue meanwhile (an auto-route step could queue against an old queue).
      const now = Date.now();
      if (now - lastTick > 30_000) pausedUntil = now + 5_000;
      lastTick = now;
      if (now < pausedUntil) return;
      const finished = state.tick();
      if (Date.now() - Math.max(lastSync, state.lastSync) > SYNC_MS) {
        lastSync = lastPoll = Date.now();
        void state.syncCharacter();
      } else if (finished || Date.now() - lastPoll > QUEUE_POLL_MS) {
        lastPoll = Date.now();
        void state.refreshQueue();
      } else if (state.autoRoute && !state.autopilot.config.running) {
        void state.autoRouteStep();
      }
      void state.runner.step(); // replans on change (also while paused); acts only when running
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [state]);

  // Map: once the cursor rests for a second, load tile details around it (as the browser does
  // for the visible area) when zoomed in far enough for them to matter.
  useEffect(() => {
    if (mode !== 'map' || view.zoom > 256) return;
    const t = setTimeout(() => void state.loadTilesAround(view), 1000);
    return () => clearTimeout(t);
  }, [state, mode, view.x, view.y, view.zoom]);

  const width = columns || 100;
  const height = rows || 30;
  // Home and jobs show twice the log (finished jobs, drops, item uses, autopilot actions).
  const logLines = (height >= 32 ? 5 : 3) * ((mode === 'main' || mode === 'home') && !overlay ? 2 : 1);
  const bodyH = Math.max(10, height - 4 - 1 - logLines - 1);
  const grid = mapGridSize(width, bodyH);

  const options = useMemo(() => state.jobOptions(filter, { sort: jobSort, showAll: showAllJobs }), [state, state.jobs, state.world, state.items, state.queue.length, filter, jobSort, showAllJobs]);
  const jobIdx = Math.min(jobSel, Math.max(0, options.length - 1));
  const queueIdx = Math.min(queueSel, Math.max(0, state.queue.length - 1));

  // The job list (work/index) has no danger and stale motivation. Fetch the selected job's
  // job/job detail when the selection changes, when the queue changes, and once a minute.
  useEffect(() => {
    const selected = options[jobIdx];
    if (mode !== 'main' || !selected?.at) return;
    const { job, at } = selected;
    const timer = setTimeout(() => void state.loadJobDetail(job, at), 300);
    const poll = setInterval(() => void state.loadJobDetail(job, at), JOB_DETAIL_POLL_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [state, mode, options[jobIdx]?.job.id, options[jobIdx]?.at?.x, options[jobIdx]?.at?.y, state.jobs, state.queue.length]);

  const entries = mode === 'map' ? entriesAt(state, view, grid.cols, grid.rows) : [];
  const mapIdx = Math.min(mapSel, Math.max(0, entries.length - 1));
  const pois = overlay === 'poi' ? poisNear(state, view, poiFilter) : [];
  const poiIdx = Math.min(poiSel, Math.max(0, pois.length - 1));

  const go = (m: Mode) => {
    capture.current = false;
    setMapPanel(false);
    if (m === mode) return;
    const i = history.current.indexOf(m);
    if (i >= 0) history.current.length = i;
    else history.current.push(mode);
    setMode(m);
  };
  const back = () => {
    capture.current = false;
    setMapPanel(false);
    setMode(history.current.pop() ?? 'home');
  };
  const jumpTo = (at: { x: number; y: number }) => {
    setView((v) => clampView({ ...v, x: at.x, y: at.y, zoom: Math.min(v.zoom, 128) }));
    go('map');
    setMapSel(0);
  };

  const openHotel = (townId: number | undefined) => {
    if (!townId) return state.error('No town to sleep in (you have no home town; select a town on the map and press s).');
    state.hotel = null;
    setHotelSel(0);
    setOverlay('hotel');
    void state.openHotel(townId).then((hotel) => {
      if (!hotel) return setOverlay(null);
      const d = defaultRoom(hotel);
      setHotelSel(Math.max(0, d ? hotel.rooms.indexOf(d) : 0));
    });
  };

  const onScreen = SCREEN_MODES.includes(mode);
  useInput((input, key) => {
    state.touch();
    if (state.startup && !state.startup.done) {
      if (key.escape) state.skipStartup();
      if (input === 'q') exit();
      return;
    }
    // Text entry modes first, so typed characters are not shortcuts.
    if (overlay === 'hotel') {
      const rooms = state.hotel?.rooms ?? [];
      if (key.escape) return setOverlay(null);
      if (key.upArrow || input === 'k') return setHotelSel((i) => Math.max(0, i - 1));
      if (key.downArrow || input === 'j') return setHotelSel((i) => Math.min(rooms.length - 1, i + 1));
      if (key.return && state.hotel && rooms[hotelSel]) {
        const room = rooms[hotelSel]!;
        if (!room.available) return state.error(`${room.name} is not available in this hotel.`);
        setOverlay(null);
        return void state.sleep(state.hotel, room);
      }
      return;
    }
    if (overlay === 'layers') {
      if (key.escape || input === 'v') return setOverlay(null);
      if (key.upArrow || input === 'k') return setLayerSel((i) => Math.max(0, i - 1));
      if (key.downArrow || input === 'j') return setLayerSel((i) => Math.min(MAP_LAYERS.length - 1, i + 1));
      const l = MAP_LAYERS[layerSel]!;
      if (input === ' ' || key.return) return state.setMapLayer(l.key, state.mapLayers[l.key] === false);
      if (input === 'a' || input === 'n') for (const x of MAP_LAYERS) state.setMapLayer(x.key, input === 'a');
      return;
    }
    if (onScreen && capture.current && overlay !== 'help') return;
    if (overlay === 'poi') {
      if (key.escape) return setOverlay(null);
      if (key.return) {
        const p = pois[poiIdx];
        setOverlay(null);
        if (p) jumpTo(p);
        return;
      }
      if (key.upArrow) return setPoiSel(Math.max(0, poiIdx - 1));
      if (key.downArrow) return setPoiSel(Math.min(pois.length - 1, poiIdx + 1));
      if (key.pageUp) return setPoiSel(Math.max(0, poiIdx - 10));
      if (key.pageDown) return setPoiSel(Math.min(pois.length - 1, poiIdx + 10));
      if (key.backspace || key.delete) return setPoiFilter((f) => f.slice(0, -1));
      if (input && !key.ctrl && !key.meta) {
        setPoiFilter((f) => f + input);
        setPoiSel(0);
      }
      return;
    }
    if (overlay === 'help') return setOverlay(null);
    if (filtering) {
      if (key.return || key.escape) setFiltering(false);
      if (key.escape) setFilter('');
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.return) setFilter((f) => f + input);
      setJobSel(0);
      return;
    }
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setSearch('');
      } else if (key.return) {
        setSearching(false);
        const hit = findNearest(state, search, view);
        if (hit) {
          jumpTo(hit.at);
          state.info(`Found ${hit.label} at ${hit.at.x},${hit.at.y}`);
        } else state.error(`Nothing on the map matches "${search}"`);
      } else if (key.backspace || key.delete) setSearch((f) => f.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setSearch((f) => f + input);
      return;
    }
    if (confirmCancel) {
      if (input === 'y') void state.cancel(queueIdx);
      setConfirmCancel(false);
      return;
    }

    if (leader) {
      setLeader(false);
      const g = GOTO.find((x) => x.key === input);
      if (g?.mode === 'quests') setQuestsOnGivers(false);
      if (g?.mode) return go(g.mode);
      if (g?.key === 's') return openHotel(state.character.homeTown?.id);
      if (g?.key === 'p') {
        setPoiFilter('');
        setPoiSel(0);
        return setOverlay('poi');
      }
      if (g?.key === 'L') return state.live?.active ? state.stopLive() : state.startLive();
      if (g?.key === 'R') return void state.reload();
      if (g?.key === 'A' && onAccount) return onAccount();
      return; // Esc or an unknown key cancels
    }

    // Global shortcuts: everything else is under g, so screens keep the letters.
    if (input === '?') return setOverlay('help');
    if (input === 'q') return exit();
    if (input === 'g') return setLeader(true);
    if (input === 'm') return go('map');
    if (input === 'u') {
      if (mode === 'char') return void state.refreshInventory().then(() => state.refreshSkills()).then(() => state.loadEquipSets());
      if (mode === 'quests') return void state.loadQuests();
      if (mode === 'mail') return void state.loadReports(state.reports?.page ?? 1).then(() => state.loadTelegrams(state.telegrams?.page ?? 1));
      if (mode === 'duels') return void state.loadDuels();
      if (mode === 'trade') return void state.loadMarketMine().then(() => state.openMobileTrader());
      if (mode === 'town') return void state.loadTownHall();
      return void state.refreshQueue();
    }
    if (onScreen) return; // the screen handles the rest
    const duration = ({ '1': 'short', '2': 'middle', '3': 'long' } as Record<string, DurationKey>)[input];

    if (mode === 'map') {
      if (mapPanel) {
        if (key.escape) return setMapPanel(false);
        if (key.upArrow || input === 'k') return setMapSel(Math.max(0, mapIdx - 1));
        if (key.downArrow || input === 'j') return setMapSel(Math.min(entries.length - 1, mapIdx + 1));
        const e = entries[mapIdx];
        if (duration && e?.kind === 'job') return void state.startJob(e.option, duration);
        if (input === 'w' && e?.kind === 'town') return void state.walkToTown(e.town);
        if (input === 'w' && e?.kind === 'fort') return void state.walkToFort(e.fort);
        if (input === 'w' && e?.kind === 'quest') return void state.walkToQuestGiver(e.key, e.name, e.at);
        if (input === 's') return openHotel(e?.kind === 'town' && e.town.name ? e.town.id : state.character.homeTown?.id);
        if (input === 'o' && e?.kind === 'quest') {
          return void state.openEmployer(e.key, e.at).then((ok) => {
            if (!ok) return;
            setQuestsOnGivers(true);
            go('quests');
          });
        }
        return;
      }
      if (key.escape) return back();
      const big = key.shift || key.pageUp || key.pageDown ? 10 : 1;
      const pan = (dc: number, dr: number) => setView((v) => clampView({ ...v, x: v.x + dc * big * v.zoom, y: v.y + dr * big * v.zoom * 2 }));
      if (key.leftArrow || input === 'h' || input === 'H') return pan(-1, 0);
      if (key.rightArrow || input === 'l' || input === 'L') return pan(1, 0);
      if (key.upArrow || key.pageUp || input === 'k' || input === 'K') return pan(0, -1);
      if (key.downArrow || key.pageDown || input === 'j' || input === 'J') return pan(0, 1);
      if (input === '+' || input === '=') return setView((v) => ({ ...v, zoom: ZOOMS[Math.max(0, ZOOMS.indexOf(v.zoom) - 1)]! }));
      if (input === '-' || input === '_') return setView((v) => ({ ...v, zoom: ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(v.zoom) + 1)]! }));
      if (input === '.' || input === 'c') return setView((v) => ({ ...v, ...state.character.position }));
      if (input === 'e') return setView((v) => ({ ...v, ...state.queueEndPosition }));
      if (input === 'v') return setOverlay('layers');
      if (input === '/') {
        setSearch('');
        return setSearching(true);
      }
      if (key.return && entries.length) {
        setMapSel(0);
        return setMapPanel(true);
      }
      if (input === 'x' && state.mapHighlight) {
        state.mapHighlight = null;
        return state.changed();
      }
      return;
    }

    if (key.escape) return back();
    if (key.tab) return setFocus((f) => (f === 'jobs' ? 'queue' : 'jobs'));
    const move = (d: number) => {
      if (focus === 'jobs') setJobSel(Math.max(0, Math.min(options.length - 1, jobIdx + d)));
      else setQueueSel(Math.max(0, Math.min(state.queue.length - 1, queueIdx + d)));
    };
    if (key.upArrow || input === 'k') return move(-1);
    if (key.downArrow || input === 'j') return move(1);
    if (key.pageUp) return move(-10);
    if (key.pageDown) return move(10);
    if (focus === 'jobs') {
      if (input === '/') return setFiltering(true);
      if (input === 'S' || input === 'O') {
        setJobSel(0);
        return setJobSort((cur) => JOB_SORTS[(JOB_SORTS.indexOf(cur) + 1) % JOB_SORTS.length]!);
      }
      if (input === 'a') {
        setJobSel(0);
        return setShowAllJobs((v) => !v);
      }
      if (duration && options[jobIdx]) return void state.startJob(options[jobIdx]!, duration);
    } else if ((input === 'c' || key.delete) && state.queue[queueIdx]) {
      setConfirmCancel(true);
    }
  });

  const leftW = Math.max(30, Math.floor(width * 0.5));
  const rightW = Math.max(24, width - leftW);
  // JobDetail: 2 border + 4 info lines + 3 durations (+1 when the queue is full, +1 for a quest job).
  const detailH = 10 + (state.queue.length >= state.taskLimit ? 1 : 0) + (options[jobIdx] && state.mapHighlight?.jobIds.has(options[jobIdx]!.job.id) ? 1 : 0);
  const help = leader
    ? `go to: a letter above · ${GOTO.filter((g) => !g.mode).map((g) => `${g.key} ${g.label}`).join(' · ')} · Esc cancel`
    : filtering
    ? 'type to filter · Enter keep · Esc clear'
    : searching
      ? 'type a job or town name · Enter jump to nearest · Esc cancel'
      : mode === 'map'
        ? mapPanel
          ? '↑↓ select · 1/2/3 start job · w walk · o quests · s hotel · Esc back · ? help'
          : `arrows pan · +/- zoom · . me · / find · v layers · Enter select${state.mapHighlight ? ' · x clear !' : ''}`
        : mode === 'char'
          ? '← → tab · Tab pane · l/h detail · Enter wear/use/take off · U use · +/- skills · Esc back · ? help'
          : mode === 'quests'
            ? 'Tab log/givers · l/h detail · Enter finish/accept · x cancel · w walk · Esc back · ? help'
            : mode === 'town'
              ? '↑↓ building · Enter construction · u refresh · Esc back · ? help'
              : mode === 'home'
                ? 'Enter chat · ←/→ room · c cancel current · +/- minimap · g go to · ? help'
                : onScreen
                  ? 'g go to · Esc back · ? help'
                  : 'Tab pane · / filter · S sort · a all · 1/2/3 start · c cancel · Esc back';

  let body;
  if (overlay === 'help') body = h(HelpOverlay, { mode, width, height: bodyH });
  else if (overlay === 'layers') body = h(Box, { height: bodyH }, h(MapScreen, { state, view, width: width - Math.min(52, width), height: bodyH, entries: [], selected: 0, panelFocused: false, search: '', searching: false }), h(LayersOverlay, { state, selected: layerSel, width, height: bodyH }));
  else if (overlay === 'poi') body = h(PoiOverlay, { state, pois, selected: poiIdx, filter: poiFilter, width, height: bodyH });
  else if (overlay === 'hotel') body = h(HotelOverlay, { state, hotel: state.hotel, selected: hotelSel, width, height: bodyH });
  else if (SCREEN_MODES.includes(mode)) body = null;
  else if (mode === 'map') {
    body = h(MapScreen, { state, view, width, height: bodyH, entries, selected: mapIdx, panelFocused: mapPanel, search, searching });
  } else {
    body = h(Box, { height: bodyH },
      h(JobsPane, { state, options, selected: jobIdx, focused: focus === 'jobs', height: bodyH, width: leftW, filter, filtering, sort: jobSort, showAll: showAllJobs }),
      h(Box, { flexDirection: 'column', width: rightW },
        h(JobDetail, { option: options[jobIdx], state }),
        h(QueuePane, { state, selected: queueIdx, focused: focus === 'queue', width: rightW, confirm: confirmCancel, maxRows: Math.max(1, bodyH - detailH - 3) }),
      ),
    );
  }

  // Character/quest screens stay mounted under overlays so planned points or selections survive '?'.
  let screen = null;
  if (SCREEN_MODES.includes(mode)) {
    const props = { state, width, height: bodyH, active: !overlay, onCapture: (c: boolean) => (capture.current = c), onExit: back };
    const el = mode === 'home' ? h(HomeScreen, props)
      : mode === 'char' ? h(CharacterScreen, props)
      : mode === 'quests' ? h(QuestsScreen, { ...props, startOnGivers: questsOnGivers, onShowOnMap: jumpTo })
        : mode === 'mail' ? h(MailScreen, props)
          : mode === 'trade' ? h(TradeScreen, props)
            : mode === 'duels' ? h(DuelsScreen, props)
              : mode === 'autopilot' ? h(AutopilotScreen, props)
              : mode === 'debug' ? h(DebugScreen, props)
              : mode === 'town' ? h(TownScreen, props)
              : h(ChatScreen, props);
    screen = h(Box, { display: overlay ? 'none' : 'flex' }, el);
  }

  if (state.startup && !state.startup.done) return h(LoadingScreen, { state, width, height });

  return h(Box, { flexDirection: 'column', width, height },
    h(Header, { state }),
    h(NavBar, { mode, overlay, leader, width }),
    body,
    screen,
    h(LogPane, { state, lines: logLines }),
    h(Text, { dimColor: true, wrap: 'truncate' }, ` ${help}`),
  );
}

/** The g menu's screens (and sleep / places), each with its second key; the open screen is inverted. */
function NavBar({ mode, overlay, leader, width }: { mode: Mode; overlay: string | null; leader: boolean; width: number }) {
  const items = GOTO.filter((g) => g.mode || g.overlay).map((g) => ({ ...g, active: overlay ? g.overlay === overlay : g.mode === mode }));
  return h(Box, { width, paddingX: 1 },
    h(Text, { wrap: 'truncate' },
      h(Text, { bold: true, inverse: leader, color: 'yellow' }, leader ? ' go to › ' : 'g›'),
      ...items.flatMap((n, i) => [
        h(Text, { key: `s${i}` }, '  '),
        h(Text, { key: n.label, inverse: n.active, color: n.active ? 'cyan' : undefined },
          h(Text, { bold: true, color: n.active ? undefined : 'yellow' }, `${n.key} `),
          h(Text, { dimColor: !n.active && !leader }, n.label)),
      ]),
      h(Text, { dimColor: true }, '   '),
      h(Text, { bold: true, color: 'yellow', inverse: overlay === 'help' }, '?'),
      h(Text, { dimColor: true }, ' help'),
    ),
  );
}

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** First start: what is being loaded, until the major requests are done (Esc skips, q quits). */
function LoadingScreen({ state, width, height }: { state: GameState; width: number; height: number }) {
  const c = state.character;
  return h(LoadingFrame, {
    width, height,
    subtitle: `${c.name ?? ''}${state.worldName ? ` · ${state.worldName}` : ''}${c.level ? ` · level ${c.level}` : ''}`,
    steps: state.startup?.steps ?? [],
    latest: state.log.filter((l) => l.level === 'info').slice(-1)[0]?.msg,
    errors: state.log.filter((l) => l.level === 'error').slice(-3).map((e) => e.msg),
    keys: 'Esc skip · q quit',
  });
}

/** The loading screen's box: title, startup steps with spinner and timings, last message, errors. Root uses it while connecting. */
export function LoadingFrame({ width, height, subtitle, steps, latest, errors = [], keys }: {
  width: number; height: number; subtitle?: string; steps: StartupStep[]; latest?: string; errors?: string[]; keys: string;
}) {
  const frame = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length];
  return h(Box, { width, height, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
    h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 2, paddingY: 1, width: Math.min(60, width - 2) },
      h(Text, { bold: true, color: 'yellow' }, 'The West'),
      h(Text, { dimColor: true, wrap: 'truncate' }, subtitle ?? ''),
      h(Text, null, ' '),
      ...steps.map((s, i) => h(Text, { key: i, wrap: 'truncate', color: s.status === 'error' ? 'red' : s.status === 'done' ? 'green' : 'cyan' },
        `${s.status === 'running' ? frame : s.status === 'done' ? '✔' : '✘'} ${s.label}`,
        h(Text, { dimColor: true }, s.endedAt ? `  ${((s.endedAt - s.startedAt) / 1000).toFixed(1)} s` : s.status === 'running' ? `  ${Math.floor((Date.now() - s.startedAt) / 1000)} s` : ''))),
      h(Text, null, ' '),
      latest ? h(Text, { dimColor: true, wrap: 'truncate' }, latest) : null,
      ...errors.map((e, i) => h(Text, { key: `e${i}`, color: 'red', wrap: 'truncate' }, e)),
      h(Text, { dimColor: true }, keys),
    ));
}

export async function runTui(state: GameState): Promise<void> {
  const app = render(h(App, { state }), { alternateScreen: true, exitOnCtrlC: true });
  void state.start();
  await app.waitUntilExit();
}
