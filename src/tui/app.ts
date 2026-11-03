// Full-screen TUI (ink, without JSX so Node can run the TypeScript directly).
// Layout: status header · screen nav bar · jobs list + job details | task queue · chat strip · log · key help.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { JOB_SORTS, type GameState, type JobOption, type JobSort, type StartupStep } from '../game/state.ts';
import { DURATION_KEYS, type DurationKey } from '../game/jobs.ts';
import { bar, formatDuration, money, scrollWindow, truncate } from './format.ts';
import { clampView, entriesAt, findNearest, LayersOverlay, MAP_LAYERS, mapGridSize, MapScreen, ZOOMS, type MapView } from './map.ts';
import { HelpOverlay, HotelOverlay, PoiOverlay, SCREEN_MODES, type Mode } from './overlays.ts';
import { CharacterScreen } from './character.ts';
import { QuestsScreen } from './quests.ts';
import { MailScreen } from './mail.ts';
import { TradeScreen } from './trade.ts';
import { DuelsScreen } from './duels.ts';
import { AutopilotScreen } from './autopilot.ts';
import { ChatPanel, ChatScreen, chatRoomIds } from './chat.ts';
import { defaultRoom } from '../game/hotel.ts';
import { poisNear } from '../game/poi.ts';

const h = React.createElement;
const QUEUE_POLL_MS = 60_000;
/** danger is only in job/job and motivation changes as jobs repeat; refresh the selected job. */
const JOB_DETAIL_POLL_MS = 60_000;
/** Full character re-read: other players' duels change health/money with no live push. */
const SYNC_MS = 3 * 60_000;

type Focus = 'jobs' | 'queue' | 'chat';
const FOCUS_ORDER: Focus[] = ['jobs', 'queue', 'chat'];
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
        state.unread.reports ? h(Text, { color: 'yellow' }, ' · new report (M)') : '',
        state.unread.messages ? h(Text, { color: 'yellow' }, ' · new telegram (M)') : '',
        state.live?.unreadRooms.size ? h(Text, { color: 'cyan' }, ` · chat ${state.live.unreadRooms.size} (C)`) : '',
        state.quests.some((q) => q.finishable) ? h(Text, { color: 'green' }, ` · ${state.quests.filter((q) => q.finishable).length} quest(s) to finish`) : '',
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

function sortCell(o: JobOption, sort: JobSort): string {
  const v = o.job.values.long ?? o.job.values.middle ?? o.job.values.short;
  if (!v) return '';
  if (sort === 'xp') return `${v.experience}xp`;
  if (sort === 'money') return money(v.money);
  if (sort === 'luck') return money(o.job.luckValue[1]);
  return '';
}

function JobsPane(props: { options: JobOption[]; selected: number; focused: boolean; height: number; width: number; filter: string; filtering: boolean; sort: JobSort; showAll: boolean }) {
  const { options, selected, focused, height, width, filter, filtering, sort, showAll } = props;
  const listHeight = Math.max(3, height - 4);
  const [start, end] = scrollWindow(selected, options.length, listHeight);
  const metric = sort === 'xp' || sort === 'money' || sort === 'luck';
  const nameW = Math.max(10, width - 24 - (metric ? 8 : 0));
  const title = filtering ? `Jobs  /${filter}▏` : filter ? `Jobs  (filter: ${filter})` : 'Jobs';
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'cyan' : 'gray', width, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, `${title}  ${options.length ? `${selected + 1}/${options.length}` : ''}`),
    h(Text, { dimColor: true, wrap: 'truncate' }, `sort: ${SORT_LABEL[sort]}${metric ? ' (1 h)' : ''} (S) · ${showAll ? 'all jobs' : 'enough LP only'} (a)`),
    ...options.slice(start, end).map((o, i) => {
      const idx = start + i;
      const sel = idx === selected;
      const doable = o.job.jobPoints >= o.job.workPoints;
      const pts = String(o.job.laborPoints);
      const way = o.way === null ? '  —  ' : formatDuration(o.way).padStart(7);
      return h(Text, { key: o.job.id, inverse: sel && focused, color: doable ? undefined : 'gray', wrap: 'truncate' },
        `${truncate(o.job.name, nameW)}${metric ? ` ${sortCell(o, sort).padStart(7)}` : ''} ${pts.padStart(5)} ${way}`);
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
      `${formatDuration(v.duration).padStart(7)} ${String(v.energy).padStart(3)}en ${money(v.money).padStart(6)} ${String(v.experience).padStart(4)}xp`);
  });
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, `${job.name}  (lvl ${job.level})`),
    h(Text, { wrap: 'truncate' }, `${job.laborPoints} LP · motiv ${Math.round((job.motivation ?? 0) * 100)}% · danger ${danger}`),
    h(Text, { wrap: 'truncate' }, h(Text, { color: 'yellow' }, 'Luck '), job.luckValue[1] > 0 ? money(job.luckValue[1]) : '—'),
    h(Text, { dimColor: true, wrap: 'truncate' }, at ? `at ${at.x},${at.y} · travel ${formatDuration(way ?? 0)}` : 'No location known'),
    ...durRows,
    h(Text, { color: 'magenta', wrap: 'truncate' }, `Drops: ${state.jobProducts(job).map((p) => `${p.name}${p.percent !== null ? ` ${p.percent}%` : ''}`).join(' · ') || '—'}`),
    state.queue.length >= state.taskLimit ? h(Text, { color: 'red', wrap: 'truncate' }, `Queue full (${state.queue.length}/${state.taskLimit})`) : null,
  );
}

function QueuePane({ state, selected, focused, width, confirm, maxRows }: { state: GameState; selected: number; focused: boolean; width: number; confirm: boolean; maxRows: number }) {
  const now = state.clock.now();
  const rowsForTasks = Math.max(1, maxRows - (confirm ? 1 : 0));
  const overflow = state.queue.length > rowsForTasks;
  const [start, end] = scrollWindow(selected, state.queue.length, overflow ? rowsForTasks - 1 : rowsForTasks);
  const hidden = state.queue.length - (end - start);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'cyan' : 'gray', width, paddingX: 1, flexGrow: 1, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, `Task queue ${state.queue.length}/${state.taskLimit}`),
    state.queue.length === 0 ? h(Text, { dimColor: true }, 'Idle') : null,
    ...state.queue.slice(start, end).map((t, j) => {
      const i = start + j;
      const sel = i === selected && focused;
      const walking = t.way && t.way.end > now;
      const left = i === 0 ? (walking ? `walk ${formatDuration(t.way!.end - now)}` : formatDuration(t.end - now)) : formatDuration(t.end - t.start);
      const label = `${i + 1}. ${t.type === 'job' ? '' : `[${t.type}] `}${t.title}`;
      return h(Text, { key: t.queueId || i, inverse: sel, color: i === 0 ? 'green' : undefined, wrap: 'truncate' },
        `${truncate(label, Math.max(8, width - 17))} ${left.padStart(9)}`);
    }),
    overflow ? h(Text, { dimColor: true }, `  +${hidden} more`) : null,
    confirm ? h(Text, { color: 'red' }, 'Cancel this task? y / n') : null,
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
  const [mode, setMode] = useState<Mode>('main');
  const [overlay, setOverlay] = useState<null | 'help' | 'poi' | 'hotel' | 'layers'>(null);
  const [layerSel, setLayerSel] = useState(0);
  const [hotelSel, setHotelSel] = useState(0);
  const [questsOnGivers, setQuestsOnGivers] = useState(false);
  const capture = useRef(false);
  const [focus, setFocus] = useState<Focus>('jobs');
  const [chatRoom, setChatRoom] = useState(0);
  const [chatDraft, setChatDraft] = useState<string | null>(null);
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
  const logLines = height >= 32 ? 5 : 3;
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

  const jumpTo = (at: { x: number; y: number }) => {
    setView((v) => clampView({ ...v, x: at.x, y: at.y, zoom: Math.min(v.zoom, 128) }));
    setMode('map');
    setMapPanel(false);
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
  const openScreen = (m: Mode) => {
    capture.current = false;
    setMapPanel(false);
    setMode((cur) => (cur === m ? 'main' : m));
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
    if (chatDraft !== null && mode === 'main') {
      if (key.escape) return setChatDraft(null);
      if (key.return) {
        const room = chatRoomIds(state)[chatRoom];
        setChatDraft(null);
        if (room && chatDraft.trim()) void state.chatSay(room, chatDraft);
        return;
      }
      if (key.backspace || key.delete) return setChatDraft(chatDraft.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setChatDraft(chatDraft + input);
      return;
    }
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

    // Global shortcuts.
    if (input === '?') return setOverlay('help');
    if (input === 'q') return exit();
    if (input === 'm') {
      setMapPanel(false);
      return setMode((m) => (m === 'map' ? 'main' : 'map'));
    }
    if (input === 'p') {
      setPoiFilter('');
      setPoiSel(0);
      return setOverlay('poi');
    }
    if (input === 'r') return void state.reload();
    if (input === 'u') {
      if (mode === 'char') return void state.refreshInventory().then(() => state.refreshSkills());
      if (mode === 'quests') return void state.loadQuests();
      if (mode === 'mail') return void state.loadReports(state.reports?.page ?? 1).then(() => state.loadTelegrams(state.telegrams?.page ?? 1));
      if (mode === 'duels') return void state.loadDuels();
      if (mode === 'trade') return void state.loadMarketMine();
      return void state.refreshQueue();
    }
    if (input === 'A' && onAccount) return onAccount();
    if (input === 'i') return openScreen('char');
    if (input === 'o' && !(mode === 'map' && mapPanel)) {
      setQuestsOnGivers(false);
      return openScreen('quests');
    }
    if (input === 'L') return state.live?.active ? state.stopLive() : state.startLive();
    if (input === 'W') {
      capture.current = false;
      setMapPanel(false);
      return setMode('main');
    }
    if (input === 'M') return openScreen('mail');
    if (input === '$') return openScreen('trade');
    if (input === 'D') return openScreen('duels');
    if (input === 'C') return openScreen('chat');
    if (input === 'G') return openScreen('autopilot');
    if (input === 's' && !(mode === 'map' && mapPanel)) return openHotel(state.character.homeTown?.id);
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
            setMapPanel(false);
            setMode('quests');
          });
        }
        return;
      }
      const big = key.shift || key.pageUp || key.pageDown ? 10 : 1;
      const pan = (dc: number, dr: number) => setView((v) => clampView({ ...v, x: v.x + dc * big * v.zoom, y: v.y + dr * big * v.zoom * 2 }));
      if (key.leftArrow || input === 'h' || input === 'H') return pan(-1, 0);
      if (key.rightArrow || input === 'l' || input === 'L') return pan(1, 0);
      if (key.upArrow || key.pageUp || input === 'k' || input === 'K') return pan(0, -1);
      if (key.downArrow || key.pageDown || input === 'j' || input === 'J') return pan(0, 1);
      if (input === '+' || input === '=') return setView((v) => ({ ...v, zoom: ZOOMS[Math.max(0, ZOOMS.indexOf(v.zoom) - 1)]! }));
      if (input === '-' || input === '_') return setView((v) => ({ ...v, zoom: ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(v.zoom) + 1)]! }));
      if (input === '.' || input === 'c') return setView((v) => ({ ...v, ...state.character.position }));
      if (input === 'g') return setView((v) => ({ ...v, ...state.queueEndPosition }));
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
      if (key.escape) return setMode('main');
      return;
    }

    if (key.tab) {
      const order = chatH ? FOCUS_ORDER : FOCUS_ORDER.filter((f) => f !== 'chat');
      return setFocus((f) => order[(order.indexOf(f) + (key.shift ? order.length - 1 : 1)) % order.length]!);
    }
    if (focus === 'chat') {
      const n = chatRoomIds(state).length;
      if (key.leftArrow || input === 'h') return setChatRoom((i) => (n ? (Math.min(i, n - 1) + n - 1) % n : 0));
      if (key.rightArrow || input === 'l') return setChatRoom((i) => (n ? (Math.min(i, n - 1) + 1) % n : 0));
      if (key.return) {
        if (!state.live?.active) return state.error('Live updates are off: press L to connect to chat.');
        if (!n) return state.error('No chat room yet (still connecting).');
        return setChatDraft('');
      }
      return;
    }
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
  // JobDetail: 2 border + 4 info lines + 3 durations (+1 when the queue is full).
  const detailH = 10 + (state.queue.length >= state.taskLimit ? 1 : 0);
  // Jobs/detail/queue keep what the detail and a few queue rows need; the rest goes to chat.
  const topMin = detailH + 6;
  const chatSpace = bodyH - Math.max(topMin, Math.ceil(bodyH * 0.55));
  const chatH = chatSpace >= 5 ? chatSpace : 0;
  const topH = bodyH - chatH;
  const help = filtering
    ? 'type to filter · Enter keep · Esc clear'
    : searching
      ? 'type a job or town name · Enter jump to nearest · Esc cancel'
      : mode === 'map'
        ? mapPanel
          ? '↑↓ select · 1/2/3 start job · w walk · o quests · s hotel · Esc back · ? help'
          : `arrows pan · +/- zoom · . me · / find · v layers · Enter select${state.mapHighlight ? ' · x clear !' : ''}`
        : mode === 'char'
          ? '← → tab · Tab pane · Enter wear/take off · +/- skills · i/Esc back · ? help'
          : mode === 'quests'
            ? 'Tab log/givers · Enter finish/accept · x cancel · w walk · o/Esc back · ? help'
            : onScreen
              ? `${{ mail: 'M', trade: '$', duels: 'D', chat: 'C' }[mode as 'mail']}/Esc back · ? help`
              : chatDraft !== null
                ? 'type a message · Enter send · Esc cancel'
                : focus === 'chat'
                  ? 'Enter write · ←/→ room · Tab pane · C full chat · ? help'
                  : 'Tab pane · / filter · S sort · a all · 1/2/3 start · c cancel';

  let body;
  if (overlay === 'help') body = h(HelpOverlay, { mode, width, height: bodyH });
  else if (overlay === 'layers') body = h(Box, { height: bodyH }, h(MapScreen, { state, view, width: width - Math.min(52, width), height: bodyH, entries: [], selected: 0, panelFocused: false, search: '', searching: false }), h(LayersOverlay, { state, selected: layerSel, width, height: bodyH }));
  else if (overlay === 'poi') body = h(PoiOverlay, { state, pois, selected: poiIdx, filter: poiFilter, width, height: bodyH });
  else if (overlay === 'hotel') body = h(HotelOverlay, { state, hotel: state.hotel, selected: hotelSel, width, height: bodyH });
  else if (SCREEN_MODES.includes(mode)) body = null;
  else if (mode === 'map') {
    body = h(MapScreen, { state, view, width, height: bodyH, entries, selected: mapIdx, panelFocused: mapPanel, search, searching });
  } else {
    body = h(Box, { flexDirection: 'column', height: bodyH },
      h(Box, { height: topH },
        h(JobsPane, { options, selected: jobIdx, focused: focus === 'jobs', height: topH, width: leftW, filter, filtering, sort: jobSort, showAll: showAllJobs }),
        h(Box, { flexDirection: 'column', width: rightW },
          h(JobDetail, { option: options[jobIdx], state }),
          h(QueuePane, { state, selected: queueIdx, focused: focus === 'queue', width: rightW, confirm: confirmCancel, maxRows: Math.max(1, topH - detailH - 3) }),
        ),
      ),
      chatH ? h(ChatPanel, { state, width, height: chatH, focused: focus === 'chat', roomIdx: chatRoom, draft: chatDraft }) : null,
    );
  }

  // Character/quest screens stay mounted under overlays so planned points or selections survive '?'.
  let screen = null;
  if (SCREEN_MODES.includes(mode)) {
    const props = { state, width, height: bodyH, active: !overlay, onCapture: (c: boolean) => (capture.current = c), onExit: () => setMode('main') };
    const el = mode === 'char' ? h(CharacterScreen, props)
      : mode === 'quests' ? h(QuestsScreen, { ...props, startOnGivers: questsOnGivers, onShowOnMap: jumpTo })
        : mode === 'mail' ? h(MailScreen, props)
          : mode === 'trade' ? h(TradeScreen, props)
            : mode === 'duels' ? h(DuelsScreen, props)
              : mode === 'autopilot' ? h(AutopilotScreen, props)
              : h(ChatScreen, props);
    screen = h(Box, { display: overlay ? 'none' : 'flex' }, el);
  }

  if (state.startup && !state.startup.done) return h(LoadingScreen, { state, width, height });

  return h(Box, { flexDirection: 'column', width, height },
    h(Header, { state }),
    h(NavBar, { mode, overlay, width }),
    body,
    screen,
    h(LogPane, { state, lines: logLines }),
    h(Text, { dimColor: true, wrap: 'truncate' }, ` ${help}`),
  );
}

/** Screens and their jump keys; the key is highlighted, the open screen shown inverted. */
const NAV: { key: string; label: string; mode?: Mode; overlay?: string }[] = [
  { key: 'W', label: 'jobs', mode: 'main' },
  { key: 'm', label: 'map', mode: 'map' },
  { key: 'i', label: 'character', mode: 'char' },
  { key: 'o', label: 'quests', mode: 'quests' },
  { key: 'M', label: 'mail', mode: 'mail' },
  { key: '$', label: 'trade', mode: 'trade' },
  { key: 'D', label: 'duels', mode: 'duels' },
  { key: 'C', label: 'chat', mode: 'chat' },
  { key: 'G', label: 'autopilot', mode: 'autopilot' },
  { key: 's', label: 'sleep', overlay: 'hotel' },
  { key: 'p', label: 'places', overlay: 'poi' },
  { key: '?', label: 'help', overlay: 'help' },
];

function NavBar({ mode, overlay, width }: { mode: Mode; overlay: string | null; width: number }) {
  const items = NAV.map((n) => {
    const active = overlay ? n.overlay === overlay : n.mode === mode;
    return { ...n, active };
  });
  return h(Box, { width, paddingX: 1 },
    h(Text, { wrap: 'truncate' },
      ...items.flatMap((n, i) => [
        i ? h(Text, { key: `s${i}` }, '  ') : null,
        h(Text, { key: n.label, inverse: n.active, color: n.active ? 'cyan' : undefined },
          h(Text, { bold: true, color: n.active ? undefined : 'yellow' }, `${n.key} `),
          h(Text, { dimColor: !n.active }, n.label)),
      ]),
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
