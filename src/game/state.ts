// Game state the TUI renders: character, task queue, jobs. Owns the GameClient and keeps state in
// sync the way the browser does (responses update energy/money; queue reloaded via task/get_tasks;
// full state from a fresh game.php load on reload()).
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';
import type { OpenGame } from '../auth/login.ts';
import type { GameClient } from '../http/game-client.ts';
import { CharacterState, type Position } from './character.ts';
import { ServerClock } from './clock.ts';
import {
  DURATION_KEYS, fetchJobDetail, fetchJobInfos, JobCatalog, nearestLocation, parseJobDetail, wayTime,
  type DurationKey, type JobDurationValues, type JobInfo, type JobLocations,
} from './jobs.ts';
import { jobPost, parseQueue, sleepPost, TaskApi, walkPost, type QueuedTask } from './tasks.ts';
import { WorldMap, type Fort, type Town } from './world.ts';
import { TileCache } from './tiles.ts';
import { ItemCatalog, ItemSetCatalog, loadItemCatalog, loadItemSets, statsOf } from './items.ts';
import { setBonusLines, type ItemStats, type StatContext } from './itemstats.ts';
import { Inventory, InventoryApi, type EquipSets } from './inventory.ts';
import { SkillApi, Skills, type SkillPlan } from './skills.ts';
import { QuestApi, questEnds, type Quest, type QuestEmployer, type QuestRequirement } from './quests.ts';
import { fetchHotel, roomRate, type Hotel, type HotelRoom } from './hotel.ts';
import { ChatPoller, type SelfUpdate } from '../realtime/chat.ts';
import { cachedJson } from '../util/disk-cache.ts';
import { planRoute, questNeeds, type RouteNeed, type RouteObjective, type RoutePlan } from './route.ts';
import { MailApi, type Report, type ReportFolder, type ReportList, type ReportRow, type Telegram, type TelegramList } from './mail.ts';
import {
  buyMobileTrader, buyOrderProblem, DEFAULT_FILTER, deposit, fetchBank, fetchMobileTrader, fetchShop, MarketApi, shopBuy, shopSell, useItem,
  type Bank, type MarketFilter, type MarketOffer, type MobileTrader, type MobileTraderItem, type Shop, type ShopKey,
} from './trade.ts';
import { buildPost, fetchConstruction, fetchTownHall, type Construction, type TownBuilding, type TownHall } from './townhall.ts';
import { DuelApi, duelPost, type DuelData, type DuelOpponent, type NpcDuelResult } from './duels.ts';
import { loadAutopilot, saveAutopilot, type AutopilotFile } from './autopilot-config.ts';
import { projectTimeline, type Timeline, type TimelineStep } from './timeline.ts';
import { AutopilotRunner } from './autopilot-runner.ts';
import { DebugLog, diffSnapshots } from './debug-log.ts';
import { Calibration } from './calibration.ts';
import { expectedHpLoss } from './autopilot.ts';
import { RateTracker } from './rates.ts';

export interface LogEntry { at: Date; level: 'info' | 'error'; msg: string }

export interface JobOption {
  job: JobInfo;
  at: Position | null;
  /** Travel time in seconds from where the queue ends. */
  way: number | null;
}

const LAYERS_FILE = () => join(CONFIG_DIR, 'map-layers.json');
function loadMapLayers(): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(LAYERS_FILE(), 'utf8'));
  } catch {
    return {};
  }
}
function saveMapLayers(layers: Record<string, boolean>): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(LAYERS_FILE(), JSON.stringify(layers), { mode: 0o600 });
  } catch {
    /* preference only */
  }
}

/** One planned route job: the task/add post, its energy cost and name. */
type RouteRun = { post: ReturnType<typeof jobPost>; energy: number; title: string };

export type JobSort = 'name' | 'xp' | 'money' | 'luck' | 'distance';
export const JOB_SORTS: JobSort[] = ['name', 'xp', 'money', 'luck', 'distance'];

/** Value a job is sorted by: the 1 h (else longest known) duration's XP / money; luck = max $ find (maxLuck). */
export function jobSortValue(job: JobInfo, sort: JobSort): number {
  if (sort === 'luck') return job.luckValue[1];
  const v = job.values.long ?? job.values.middle ?? job.values.short;
  if (!v) return -Infinity;
  return sort === 'xp' ? v.experience : sort === 'money' ? v.money : 0;
}

export interface StartupStep { label: string; status: 'running' | 'done' | 'error'; startedAt: number; endedAt?: number }

export class GameState extends EventEmitter {
  client!: GameClient;
  clock!: ServerClock;
  character!: CharacterState;
  catalog!: JobCatalog;
  tasks!: TaskApi;
  travelSpeed = 1;
  automationUntil = 0;
  worldName = '';
  queue: QueuedTask[] = [];
  jobs: JobInfo[] = [];
  private jobDetailLoading = new Set<number>();
  world = new WorldMap();
  tiles = new TileCache();
  log: LogEntry[] = [];
  /** Everything that happens, with data (Debug screen, B); the TUI also writes it to debug.jsonl. */
  debug = new DebugLog();
  private debugSnap: Record<string, unknown> | null = null;
  private debugStarted = new Set<number>();
  /** What the autopilot learns from reports, health and motivation (memory only unless the TUI sets a file). */
  calibration = new Calibration(null);
  /** Rates of sleeps on the queue (the queue entry has none): queueId → fraction of max per hour. */
  sleepRates = new Map<number, { energyRate: number; healthRate: number }>();
  /** Dangerous jobs finished whose HP loss has not been seen yet (next server health value). */
  private hpPending: { title: string; predicted: number } | null = null;
  /** Job motivation at the last work/index read, and runs finished since. */
  private motivationSeen = new Map<number, { m: number; at: number; runs: number }>();
  /** Job reports already counted (ids). */
  private reportsSeen = new Set<number>();
  busy = false;
  items: ItemCatalog | null = null;
  itemSets: ItemSetCatalog | null = null;
  inventory = new Inventory();
  /** Saved equipment sets (loaded by the character screen's Sets tab). */
  equipSets: EquipSets | null = null;
  skills = new Skills();
  quests: Quest[] = [];
  questCapacity = 0;
  saloon: { key: string; name: string }[] = [];
  employer: QuestEmployer | null = null;
  hotel: Hotel | null = null;
  /** Live updates (chat long-poll). */
  live: ChatPoller | null = null;
  liveStatus: 'off' | 'connecting' | 'on' | 'error' = 'off';
  unread = { reports: false, messages: false };
  /** Jobs marked on the map for a quest (`g` in the quest screen). */
  mapHighlight: { label: string; jobIds: Set<number> } | null = null;
  /** Map layers switched off by the user (v on the map); saved in the config dir. */
  mapLayers: Record<string, boolean> = loadMapLayers();
  /** Mail screen: last loaded report / telegram lists. */
  reports: ReportList | null = null;
  /** Newest reports (page 1, all folders) for the home screen; refreshed when the game says there is a new one. */
  recentReports: ReportRow[] | null = null;
  /** Measured XP/h and $/h, jobs done this session. */
  rates = new RateTracker();
  reportFolder: ReportFolder = 'all';
  telegrams: TelegramList | null = null;
  /** Trade screen: bank, shop and market of the town you are in (or your home town). */
  bank: Bank | null = null;
  shop: Shop | null = null;
  /** Rotating offers of the mobile trader (the trade screen's "Mobile trader" tab). */
  mobileTrader: MobileTrader | null = null;
  /** Town hall of the home town and the construction detail of its selected building. */
  townHall: TownHall | null = null;
  construction: Construction | null = null;
  market: { query: string; page: number; next: boolean; offers: MarketOffer[]; filter: MarketFilter; searched: boolean } =
    { query: '', page: 1, next: false, offers: [], filter: { ...DEFAULT_FILTER }, searched: false };
  /** My market: bids, sell offers and (for the trade town's market) buy orders. */
  marketMine: { bids: MarketOffer[]; offers: MarketOffer[]; buyOrders: MarketOffer[] } | null = null;
  /** Duels screen. */
  duels: DuelData | null = null;
  duelOpponents: DuelOpponent[] = [];
  lastNpcDuel: NpcDuelResult | null = null;
  private itemsFile: string | undefined;
  private itemSetsFile: string | undefined;
  private bagInit: Record<string, any> | null = null;
  private reopen: () => Promise<OpenGame>;

  constructor(game: OpenGame, reopen: () => Promise<OpenGame>) {
    super();
    this.reopen = reopen;
    this.apply(game);
  }

  private apply({ client, bootstrap }: OpenGame): void {
    this.client = client;
    this.clock = new ServerClock(bootstrap.game?.sincepoch);
    this.character = CharacterState.fromInit(bootstrap.character ?? {}, this.clock);
    if (Number(bootstrap.game?.maxLevel) > 0) this.character.maxLevel = Number(bootstrap.game!.maxLevel);
    this.catalog = new JobCatalog(bootstrap.game);
    this.tasks = new TaskApi(client);
    this.travelSpeed = bootstrap.game?.travelSpeed ?? 1;
    this.worldName = bootstrap.game?.currentWorldName ?? '';
    this.automationUntil = bootstrap.premium?.premiumBoni?.automation?.expiration ?? 0;
    this.queue = parseQueue(bootstrap.character?.taskQueue);
    this.itemsFile = bootstrap.game?.itemsFile;
    this.itemSetsFile = bootstrap.game?.itemSetsFile;
    this.bagInit = bootstrap.bag ?? bootstrap.character?.inventory ?? null;
    this.inventory = Inventory.fromInit(this.bagInit, this.items ?? undefined);
    this.equipSets = null;
    this.mobileTrader = null;
    this.townHall = null;
    this.construction = null;
    this.skills = Skills.fromInit(bootstrap.character?.skillData);
    const wasLive = !!this.live?.active;
    this.live?.stop();
    this.live = null;
    if (wasLive) this.startLive();
  }

  private get questApi(): QuestApi {
    return new QuestApi(this.client, (id) => this.itemName(id));
  }

  itemName(id: number): string {
    return this.items ? this.items.name(id) : `item ${id}`;
  }

  /** Title of a quest in the log or at the open employer, if we have it. */
  questTitle(id: number): string | undefined {
    return (this.quests.find((q) => q.id === id) ?? this.employer?.open.find((q) => q.id === id))?.title;
  }

  info(msg: string): void {
    this.push('info', msg);
  }

  error(msg: string): void {
    this.push('error', msg);
  }

  private push(level: LogEntry['level'], msg: string): void {
    this.log.push({ at: new Date(), level, msg });
    if (this.log.length > 200) this.log.shift();
    this.debug.add('log', msg, { level });
    this.changed();
  }

  changed(): void {
    this.emit('change');
  }

  /** Job group id → map locations (from the minimap). */
  get locations(): JobLocations {
    return this.world.jobGroups;
  }

  /** Doable jobs of one map location's job group, with travel from where the queue ends. */
  jobsAtLocation(groupId: number, at: { x: number; y: number }): JobOption[] {
    const from = this.queueEndPosition;
    const way = wayTime(from, at, this.travelSpeed, this.character.speed);
    return this.jobs
      .filter((j) => j.groupid === groupId)
      .map((job) => ({ job, at, way }));
  }

  travelTo(at: { x: number; y: number }): number {
    return wayTime(this.queueEndPosition, at, this.travelSpeed, this.character.speed);
  }

  get hasAutomation(): boolean {
    return this.automationUntil > this.clock.now();
  }

  get taskLimit(): number {
    return this.hasAutomation ? this.character.taskLimit.premium : this.character.taskLimit.normal;
  }

  /** Where the character will be once the current queue is done (jobs are queued sequentially). */
  get queueEndPosition(): Position {
    const last = this.queue[this.queue.length - 1];
    return last ? last.coords : this.character.position;
  }

  /** Drops finished tasks locally (TaskQueueUi.tick) and moves the character to their coords. */
  tick(): boolean {
    const now = this.clock.now();
    let changed = false;
    while (this.queue.length && this.queue[0]!.end <= now) {
      const done = this.queue.shift()!;
      this.character.position = done.coords;
      this.info(`Finished: ${done.title}`);
      if (done.type === 'job') {
        this.rates.jobsDone++;
        this.jobFinished(done);
      }
      this.rates.lastTask = { title: done.title, type: done.type, end: done.end };
      changed = true;
    }
    const c = this.character;
    this.rates.record(now, c.experience, c.cash + c.deposit);
    this.watchDebug();
    return changed;
  }

  /** A queued job ended: count the run for motivation and expect its HP loss in the next health value. */
  private jobFinished(t: QueuedTask): void {
    const q = this.queuedJob(t);
    if (!q) return;
    const seen = this.motivationSeen.get(q.job.id);
    if (seen) seen.runs++;
    if (q.job.danger) {
      const predicted = expectedHpLoss(q.job.danger, q.values.duration, this.character.maxHealth);
      this.hpPending = { title: t.title, predicted: (this.hpPending?.predicted ?? 0) + predicted };
    }
  }

  /**
   * A fresh server health value after a dangerous job: the drop below the regen estimate is the job's HP loss.
   * More than 30 % of max HP at once is taken for an attack and not counted.
   */
  private observeHealth(before: number, after: number): void {
    const p = this.hpPending;
    if (!p) return;
    this.hpPending = null;
    const lost = Math.max(0, before - after);
    if (lost > 0.3 * this.character.maxHealth) return void this.debug.add('state', `HP drop ${lost} after ${p.title} looks like an attack: not calibrated`, { before, after, predicted: p.predicted });
    this.calibration.addHp(p.predicted, lost);
    this.debug.add('state', `Calibration: ${p.title} cost ${lost} HP (predicted ${Math.round(p.predicted)})`, { lost, predicted: p.predicted, hpScale: this.calibration.hpScale });
  }

  /** A level-up seen: did it refill energy (the planner assumes so)? */
  private observeLevelUp(): void {
    const c = this.character;
    const refilled = c.energy >= c.maxEnergy - 1;
    this.calibration.addLevelUp(refilled);
    this.debug.add('state', `Calibration: level-up ${refilled ? 'refilled' : 'did NOT refill'} energy (${c.energy}/${c.maxEnergy})`, this.calibration.data.levelUps);
  }

  /** work/index read: each job's motivation change since the last read, with the runs done between. */
  private observeMotivation(): void {
    const now = this.clock.now();
    for (const j of this.jobs) {
      const prev = this.motivationSeen.get(j.id);
      if (prev) {
        const hours = (now - prev.at) / 3600;
        // At 100 % recovery is invisible (capped): only uncapped pairs teach anything.
        if ((prev.runs > 0 || hours > 0.25) && prev.m < 0.999 && j.motivation < 0.999) this.calibration.addMotivation(prev.runs, hours, j.motivation - prev.m);
      }
      this.motivationSeen.set(j.id, { m: j.motivation, at: now, runs: 0 });
    }
    this.debug.add('state', 'Calibration: job motivation read', this.calibration.motivation);
  }

  /** New job reports (from a report list): drops per job and duration. One show_report request each. */
  async calibrateFromReports(rows: ReportRow[]): Promise<void> {
    for (const r of rows) {
      if (this.reportsSeen.has(r.id) || !/^job report/i.test(r.title)) continue;
      this.reportsSeen.add(r.id);
      try {
        const rep = await this.mail.jobReport(r.id, r.hash);
        const job = rep && this.jobs.find((j) => j.id === rep.jobId);
        if (!rep || !job || rep.seconds === null) continue;
        let dur: DurationKey | undefined;
        for (const k of DURATION_KEYS) if (job.values[k]?.duration === rep.seconds) dur = k;
        if (!dur) continue;
        this.calibration.addJobRun(job.id, dur, rep.items);
        this.debug.add('state', `Calibration: ${job.name} (${dur}) report: ${rep.items.map(([id, n]) => `${this.itemName(id)} ×${n}`).join(', ') || 'no items'}`, { report: r.id, ...rep });
      } catch (err) {
        this.debug.add('request', `Job report ${r.id} for calibration failed`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Server-side values the client tracks, for the debug diff (no regen estimates: they change every tick). */
  private debugSnapshot(): Record<string, unknown> {
    const c = this.character;
    const sv = c.serverValues;
    return {
      position: `${c.position.x},${c.position.y}`, town: this.townHere?.name ?? null,
      level: c.level, experience: c.experience, cash: c.cash, deposit: c.deposit, nuggets: c.nuggets,
      energy: sv.energy, health: sv.health, maxEnergy: c.maxEnergy, maxHealth: c.maxHealth,
      queue: this.queue.map((q) => `#${q.queueId} ${q.type} ${q.title}`),
      quests: this.quests.map((q) => `${q.title}${q.finishable ? ' (finishable)' : ''}: ${q.requirements.map((r) => `${r.solved ? '✓' : '·'} ${r.info}`).join(' | ')}`),
      bag: [...this.inventory.bag.values()].map((b) => `${this.itemName(b.itemId)} ×${b.count}`),
      wear: [...this.inventory.wear].map(([slot, id]) => `${slot}: ${this.itemName(id)}`),
      jobs: this.jobs.length, live: this.liveStatus,
      autopilot: this.autopilot.config.running ? (this.autopilot.config.modules.dryRun ? 'running (dry run)' : 'running') : 'paused',
    };
  }

  /** Logs what changed since the last tick, and queue tasks as they are added, start and leave. */
  private watchDebug(): void {
    const snap = this.debugSnapshot();
    if (this.debugSnap) {
      const d = diffSnapshots(this.debugSnap, snap);
      const keys = Object.keys(d);
      if (keys.length) this.debug.add('state', `Changed: ${keys.join(', ')}`, d);
    }
    this.debugSnap = snap;
    const now = this.clock.now();
    const head = this.queue[0];
    if (head && head.start <= now && !this.debugStarted.has(head.queueId)) {
      this.debugStarted.add(head.queueId);
      const q = this.queuedJob(head);
      this.debug.add('state', `Started: ${head.title}`, {
        task: { queueId: head.queueId, type: head.type, start: head.start, end: head.end, coords: head.coords, way: head.way },
        job: q ? { id: q.job.id, duration: q.duration, values: q.values, motivation: q.job.motivation, danger: q.job.danger } : undefined,
        energy: this.character.energy, health: this.character.health,
      });
    }
  }

  private async guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) {
      this.error('Busy, wait for the previous action to finish');
      return undefined;
    }
    this.busy = true;
    this.changed();
    const t0 = Date.now();
    try {
      const r = await fn();
      this.debug.add('request', `${label}: ok (${Date.now() - t0} ms)`);
      return r;
    } catch (err) {
      this.debug.add('request', `${label}: failed (${Date.now() - t0} ms)`, { error: err instanceof Error ? err.stack ?? err.message : String(err) });
      this.error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  setMapLayer(key: string, shown: boolean): void {
    this.mapLayers = { ...this.mapLayers, [key]: shown };
    saveMapLayers(this.mapLayers);
    this.changed();
  }

  /** First-start progress for the loading screen; null when start() was never called. */
  startup: { steps: StartupStep[]; done: boolean } | null = null;

  /** Runs one startup step; it failed when it logged an error (guard() reports errors to the log). */
  private async step(label: string, fn: () => Promise<unknown>): Promise<void> {
    const s: StartupStep = { label, status: 'running', startedAt: Date.now() };
    this.startup?.steps.push(s);
    this.changed();
    const errors = this.log.filter((l) => l.level === 'error').length;
    await fn();
    s.status = this.log.filter((l) => l.level === 'error').length > errors ? 'error' : 'done';
    s.endedAt = Date.now();
    this.changed();
  }

  /** `connect`: how long connecting took (shown as the loading screen's first, finished step). */
  async start(opts: { live?: boolean; connect?: { label: string; startedAt: number; endedAt: number } } = {}): Promise<void> {
    this.startup = { steps: opts.connect ? [{ ...opts.connect, status: 'done' }] : [], done: false };
    await this.step('Server clock', () => this.guard('Clock sync', () => this.clock.sync(this.client)));
    await this.step('Jobs and map', () => this.loadJobs(true));
    await this.step('Item data', () => this.loadItems());
    await this.step('Quest log', () => this.loadQuests(true));
    if (opts.live !== false) await this.step('Live updates', async () => this.startLive());
    this.startup.done = true;
    this.info(`Ready: ${this.jobs.length} jobs, ${this.items?.size ?? 0} items, ${this.quests.length} quests.`);
  }

  /** Leaves the loading screen early (requests keep running in the background). */
  skipStartup(): void {
    if (this.startup) this.startup.done = true;
    this.changed();
  }

  // ---- live updates -------------------------------------------------------------------------

  /** After a rebuild (wake from sleep): keep the log and a running auto-route. */
  carryOver(prev: GameState): void {
    this.log.unshift(...prev.log.slice(-100));
    for (const e of this.debug.entries) prev.debug.add(e.cat, e.title, e.data);
    this.debug = prev.debug;
    this.sleepRates = prev.sleepRates;
    this.motivationSeen = prev.motivationSeen;
    this.reportsSeen = prev.reportsSeen;
    this.hpPending = prev.hpPending;
    if (prev.autoRoute) this.autoRoute = { ...prev.autoRoute, retryAt: 0 };
    this.autopilot = prev.autopilot;
    this.mapLayers = prev.mapLayers;
    this.rates = prev.rates;
    this.recentReports = prev.recentReports;
  }

  /** Starts the chat long-poll the browser keeps open; pushes XP/money/energy/position. */
  startLive(): void {
    if (this.live?.active) return;
    const poller = new ChatPoller(this.client);
    this.live = poller;
    this.liveStatus = 'connecting';
    poller.on('self', (u: SelfUpdate) => {
      this.liveStatus = 'on';
      this.applySelf(u);
    });
    poller.on('quests', () => void this.loadQuests(true));
    poller.on('reports', () => {
      this.unread.reports = true;
      void this.announceNewReport();
      void this.syncCharacter('report');
    });
    poller.on('read', (p: Record<string, any>) => {
      this.unread.reports = !p.reports;
      this.unread.messages = !p.messages;
      this.changed();
    });
    poller.on('nuggets', (n: number) => {
      this.character.nuggets = n;
      this.changed();
    });
    poller.on('tell', ({ from, message }: { from: string; message: string }) => this.info(`✉ ${from}: ${message}`));
    poller.on('chat', () => this.changed());
    poller.on('rooms', () => this.changed());
    poller.on('tellFailed', () => this.error('You can only whisper to players that you can see in a chat window.'));
    poller.on('invalid', (why: string) => {
      this.liveStatus = 'off';
      this.error(`Live updates stopped: ${why}. Press r to reload or A to log in.`);
    });
    poller.on('error', (e: Error) => {
      this.liveStatus = 'error';
      this.error(`Live updates: ${e.message} (retrying in 30 s)`);
    });
    poller.start();
    this.changed();
  }

  stopLive(): void {
    this.live?.stop();
    this.live = null;
    this.liveStatus = 'off';
    this.changed();
  }

  /** Last user input time; sent as `actioned` like the browser's click/keypress tracking. */
  touch(): void {
    if (this.live) this.live.actioned = Date.now();
  }

  applySelf(u: SelfUpdate): void {
    const c = this.character;
    if (u.x !== undefined && u.y !== undefined && (u.x !== c.position.x || u.y !== c.position.y)) c.position = { x: u.x, y: u.y };
    const leveled = u.level !== undefined && u.level > c.level;
    if (leveled) {
      this.info(`Level up: ${u.level}!`);
      c.level = u.level!;
    }
    const hpBefore = c.health;
    if (u.experience !== undefined && u.experience > c.experience) c.experience = u.experience;
    if (u.money !== undefined) c.cash = u.money;
    if (u.deposit !== undefined) c.deposit = u.deposit;
    // energy_date / health_date are offsets from now in seconds (Character.setEnergy @tw2game: getServerTime() + date).
    const now = this.clock.now();
    if (u.energy !== undefined) c.setEnergy(u.energy, u.energyAt === undefined ? undefined : now + u.energyAt);
    if (u.health !== undefined) {
      c.setHealth(u.health, u.healthAt === undefined ? undefined : now + u.healthAt);
      this.observeHealth(hpBefore, c.health);
    }
    if (leveled) this.observeLevelUp();
    this.changed();
  }

  /** Server time (ms) of the last successful syncCharacter(); 0 before the first. */
  lastSync = 0;
  private syncing = false;

  /**
   * Re-reads the character from a fresh game.php (the only place the browser gets the full set:
   * Character.init). Duels by other players change health/money server-side without a UserUpdate
   * push, so the header would otherwise keep showing regenerated, pre-attack values.
   * Runs in the background: no busy lock, errors only logged.
   */
  async syncCharacter(why = ''): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const { bootstrap } = await this.reopen();
      const data = bootstrap.character;
      if (!data) return;
      const fresh = CharacterState.fromInit(data, this.clock);
      const c = this.character;
      const hpBefore = c.health;
      const cashBefore = c.cash;
      const leveled = fresh.level > c.level;
      if (leveled) this.info(`Level up: ${fresh.level}!`);
      c.level = fresh.level;
      c.experience = fresh.experience;
      c.cash = fresh.cash;
      c.deposit = fresh.deposit;
      c.nuggets = fresh.nuggets;
      c.position = fresh.position;
      c.homeTown = fresh.homeTown;
      c.duelLevel = fresh.duelLevel;
      c.maxEnergy = fresh.maxEnergy;
      c.maxHealth = fresh.maxHealth;
      c.healthRegen = fresh.healthRegen;
      c.energyRegen = fresh.energyRegen;
      c.setEnergy(data.energy);
      c.setHealth(data.health);
      c.lpPerPoint = fresh.lpPerPoint;
      this.observeHealth(hpBefore, c.health);
      if (leveled) this.observeLevelUp();
      if (data.taskQueue) this.queue = parseQueue(data.taskQueue);
      this.lastSync = Date.now();
      // Regen estimate vs. the server: a real drop means something happened to us.
      const lost = hpBefore - c.health;
      if (lost > Math.max(2, c.maxHealth * 0.01)) {
        const cash = cashBefore > c.cash ? `, cash $${cashBefore} → $${c.cash}` : '';
        this.error(`⚔ Health ${hpBefore} → ${c.health}${cash}. Attacked? See reports (M).`);
      }
      this.changed();
    } catch (err) {
      this.error(`Sync${why ? ` (${why})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.syncing = false;
    }
  }

  /** Newest unread report title (duels show up here: "Duel: X vs Y"). */
  private async announceNewReport(): Promise<void> {
    try {
      const list = await this.mail.reports(1, 'all');
      this.recentReports = list.reports;
      void this.calibrateFromReports(list.reports);
      const r = list.reports.find((x) => !x.read);
      if (r) this.info(`New report: ${r.title}`);
      else this.info('New report.');
    } catch {
      this.info('New report.');
    }
  }

  // ---- inventory & skills -------------------------------------------------------------------

  /** Item data (cached per game version). Inventory names need it. */
  async loadItems(): Promise<void> {
    if (this.items) return;
    await this.guard('Items', async () => {
      this.items = await loadItemCatalog(this.client, this.itemsFile, (m) => this.info(m));
      this.inventory.retype(this.items);
      this.info(`Item data: ${this.items.size} items.`);
    });
    if (!this.itemSets) {
      await this.guard('Item sets', async () => {
        this.itemSets = await loadItemSets(this.client, this.itemSetsFile, (m) => this.info(m));
      });
    }
  }

  /** What the web popup computes for this character: upgrade level, per-level bonuses, job names. */
  get statContext(): StatContext {
    return { charLevel: this.character.level, jobName: (id) => this.catalog.get(id)?.name };
  }

  itemStats(itemId: number): ItemStats | null {
    const d = this.items?.get(itemId);
    return d ? statsOf(d, itemId, this.statContext) : null;
  }

  /** Item level requirement after Character.itemLevelRequirementDecrease (ItemPopup "- Level %1 (%2)"). */
  requiredLevel(itemId: number): { level: number; base: number } | null {
    const d = this.items?.get(itemId);
    if (!d?.level) return null;
    const dec = this.character.itemLevelDecrease;
    const decrease = (dec.all ?? 0) + (dec[d.type] ?? 0);
    return { level: Math.max(1, d.level - decrease), base: d.level };
  }

  /** Set of an item: name, members (worn or not) and the bonus for the currently worn count. */
  itemSet(itemId: number): { name: string; worn: number; items: { id: number; name: string; worn: boolean }[]; bonus: string[] } | null {
    const d = this.items?.get(itemId);
    const set = this.itemSets?.get(d?.set);
    if (!set) return null;
    const wornBase = new Set([...this.inventory.wear.values()].map((id) => Math.floor(id / 1000)));
    const items = set.items.map((id) => ({ id, name: this.items?.get(id * 1000)?.name ?? `item ${id}`, worn: wornBase.has(id) }));
    const worn = items.filter((i) => i.worn).length;
    return { name: set.name, worn, items, bonus: setBonusLines(set, worn, this.statContext) };
  }

  async refreshInventory(): Promise<void> {
    await this.guard('Inventory', async () => {
      const r = await new InventoryApi(this.client).changedSince(this.inventory.lastInvId);
      this.inventory.applyChanges(r.changes);
      this.inventory.applyWear(r.wear);
    });
  }

  async loadEquipSets(): Promise<void> {
    await this.guard('Equipment sets', async () => {
      this.equipSets = await new InventoryApi(this.client).equipSets();
    });
  }

  /** Switches to a saved set; gear changes skill bonuses, so skills and jobs are refreshed too. */
  async switchEquipSet(id: number): Promise<void> {
    const set = this.equipSets?.sets.find((s) => s.id === id);
    if (!set) return this.error('That equipment set is no longer available.');
    const ok = await this.guard('Switch equipment', async () => {
      const r = await new InventoryApi(this.client).switchEquip(id, this.inventory.lastInvId);
      this.inventory.applyChanges(r.changes);
      this.inventory.setWearIds(r.wear, this.items ?? undefined);
      if (r.speed !== undefined) this.character.speed = r.speed;
      this.info(`Equipped set: ${set.name}`);
      return true;
    });
    if (ok) await this.afterGearChange();
  }

  async wear(itemId: number): Promise<void> {
    const type = this.items?.get(itemId)?.type;
    await this.guard('Wear', async () => {
      const r = await new InventoryApi(this.client).carry(itemId, this.inventory.lastInvId);
      if (r.error) throw new Error(r.error);
      this.inventory.applyChanges(r.changes);
      if (type) this.inventory.wear.set(type, itemId);
      if (r.speed !== undefined) this.character.speed = r.speed;
      this.info(`Equipped ${this.itemName(itemId)}`);
    });
    await this.afterGearChange();
  }

  async unwear(slot: string): Promise<void> {
    const id = this.inventory.wear.get(slot);
    if (id === undefined) return;
    await this.guard('Take off', async () => {
      const r = await new InventoryApi(this.client).uncarry(slot, this.inventory.lastInvId);
      if (r.error) throw new Error(r.error);
      this.inventory.applyChanges(r.changes);
      this.inventory.wear.delete(slot);
      if (r.speed !== undefined) this.character.speed = r.speed;
      this.info(`Took off ${this.itemName(id)}`);
    });
    await this.afterGearChange();
  }

  /** Gear changes skill bonuses → labor points; refresh both like the browser windows do. */
  private async afterGearChange(): Promise<void> {
    await this.refreshSkills();
    await this.loadJobs(true);
  }

  async refreshSkills(): Promise<void> {
    await this.guard('Skills', async () => {
      this.skills = await new SkillApi(this.client).overview();
      this.character.skills = this.skills.skills;
      this.character.skillBonus = this.skills.skillBonus;
    });
  }

  async saveSkills(plan: SkillPlan): Promise<boolean> {
    const ok = await this.guard('Save skills', async () => {
      const msg = await new SkillApi(this.client).save(plan);
      this.info(msg);
      return true;
    });
    await this.refreshSkills();
    if (ok) await this.loadJobs(true);
    return !!ok;
  }

  // ---- quests -------------------------------------------------------------------------------

  async loadQuests(quiet = false): Promise<void> {
    await this.guard('Quest log', async () => {
      const r = await this.questApi.openQuests();
      const before = new Set(this.quests.filter((q) => q.finishable).map((q) => q.id));
      this.quests = r.quests;
      this.questCapacity = r.capacity;
      for (const q of r.quests) if (q.finishable && !before.has(q.id) && quiet) this.info(`Quest ready to finish: ${q.title}`);
      if (!quiet) this.info(`Quest log: ${r.quests.length}/${r.capacity || '?'}`);
    });
  }

  async loadSaloon(): Promise<void> {
    await this.guard('Saloon', async () => {
      this.saloon = await this.questApi.saloon();
    });
  }

  async openEmployer(key: string, at?: { x: number; y: number } | null): Promise<boolean> {
    const r = await this.guard('Quest giver', async () => {
      this.employer = await this.questApi.employer(key, at);
      return true;
    });
    return !!r;
  }

  async acceptQuest(q: Quest): Promise<void> {
    await this.guard('Accept quest', async () => {
      await this.questApi.accept(q.id);
      this.info(`Accepted: ${q.title}`);
    });
    await this.loadQuests(true);
    if (this.employer) await this.openEmployer(this.employer.key, this.employer.x !== null ? { x: this.employer.x, y: this.employer.y! } : null);
  }

  async finishQuest(q: Quest, rewardOption?: number): Promise<void> {
    await this.guard('Finish quest', async () => {
      const r = await this.questApi.finish(q.id, rewardOption);
      if (r.health !== undefined) this.character.setHealth(r.health);
      this.info(`Finished: ${q.title}${r.rewards.length ? ` → ${r.rewards.join(', ')}` : ''}`);
    });
    await this.loadQuests(true);
    if (this.items) await this.refreshInventory();
  }

  async cancelQuest(q: Quest): Promise<void> {
    await this.guard('Cancel quest', async () => {
      await this.questApi.cancel(q.id);
      this.info(`Cancelled quest: ${q.title}`);
    });
    await this.loadQuests(true);
  }

  /**
   * Where to get what an unsolved requirement needs: jobs that drop the item (Game.init.jobs yields), or the
   * job itself for "do job X" requirements. Each with the nearest location from the queue end.
   */
  requirementSources(req: QuestRequirement): (JobOption & { chance: number | null })[] {
    const found: { id: number; chance: number | null }[] = [];
    if (req.itemId !== undefined) for (const y of this.catalog.yielding(req.itemId)) found.push({ id: y.job.id, chance: y.chance });
    if (req.jobId !== undefined) found.push({ id: req.jobId, chance: null });
    const from = this.queueEndPosition;
    return found.flatMap(({ id, chance }) => {
      const job = this.jobs.find((j) => j.id === id);
      if (!job) return [];
      const at = nearestLocation(this.locations.get(job.groupid), from);
      return [{ job, at, way: at ? wayTime(from, at, this.travelSpeed, this.character.speed) : null, chance }];
    });
  }

  /** Marks all source jobs of a quest's open requirements on the map; returns the nearest location. */
  highlightQuest(q: Quest): { x: number; y: number } | null {
    const sources = q.requirements.filter((r) => !r.solved).flatMap((r) => this.requirementSources(r));
    if (!sources.length) {
      this.mapHighlight = null;
      return null;
    }
    this.mapHighlight = { label: q.title, jobIds: new Set(sources.map((s) => s.job.id)) };
    const near = sources.filter((s) => s.at).sort((a, b) => (a.way ?? Infinity) - (b.way ?? Infinity))[0];
    this.changed();
    return near?.at ?? null;
  }

  // ---- walking & sleeping -------------------------------------------------------------------

  private queueFull(): boolean {
    if (this.queue.length < this.taskLimit) return false;
    this.error(`Task queue is full (${this.queue.length}/${this.taskLimit})${this.hasAutomation ? '' : '; automation premium raises the limit'}`);
    return true;
  }

  private async addTask(label: string, post: Parameters<TaskApi['add']>[1][number], done: string): Promise<boolean> {
    if (this.queueFull()) return false;
    const r = await this.guard(label, async () => {
      const res = await this.tasks.add(this.queue.length, [post], this.taskLimit);
      if (res.energy !== undefined) this.character.setEnergy(res.energy);
      for (const e of res.errors) this.error(e);
      if (!res.added.length) return false;
      this.queue.push(...res.added);
      this.info(done);
      return true;
    });
    return !!r;
  }

  /** Map quest giver: TaskWalk(employer.key, 'questgiver', x, y) (QuestEmployerView @2225490). */
  walkToQuestGiver(key: string, name: string, at: { x: number; y: number }): Promise<boolean> {
    return this.addTask('Walk', walkPost(key, 'questgiver', at), `Walking to ${name}`);
  }

  /** Guidepost.start_walk(fortId, 'fort'). */
  walkToFort(fort: Fort): Promise<boolean> {
    return this.addTask('Walk', walkPost(fort.id, 'fort'), `Walking to ${fort.name}`);
  }

  async openHotel(townId: number): Promise<Hotel | null> {
    const r = await this.guard('Hotel', async () => {
      this.hotel = await fetchHotel(this.client, townId);
      return this.hotel;
    });
    return r ?? null;
  }

  /** TaskSleep(town_id, room); the server walks there first if needed. */
  async sleep(hotel: Hotel, room: HotelRoom): Promise<boolean> {
    const ok = await this.addTask('Sleep', sleepPost(hotel.townId, room.key), `Sleeping in ${hotel.townName}: ${room.name}`);
    const t = this.queue[this.queue.length - 1];
    if (ok && t?.type === 'sleep') this.sleepRates.set(t.queueId, { energyRate: roomRate(room.energy) * this.calibration.roomScale, healthRate: roomRate(room.health) });
    return ok;
  }

  async reload(): Promise<void> {
    await this.guard('Reload', async () => {
      this.apply(await this.reopen());
      this.lastSync = Date.now();
      this.info('Reloaded game state.');
    });
    await this.loadJobs(false, true);
    await this.loadQuests(true);
  }

  async refreshQueue(): Promise<void> {
    await this.guard('Task queue', async () => {
      this.queue = await this.tasks.list();
    });
  }

  /** Job infos (depend on gear, always fetched) and the minimap (cached 12 h on disk; `freshMap` refetches). */
  async loadJobs(quiet = false, freshMap = false): Promise<void> {
    await this.guard('Jobs', async () => {
      const jobs = await fetchJobInfos(this.client, this.catalog);
      const minimap = await cachedJson(`minimap-${new URL(this.client.worldUrl).host}`, async () => {
        const m = await this.client.get('map', 'get_minimap');
        if (m.error) throw new Error(m.msg ?? 'map/get_minimap failed');
        return m;
      }, { fresh: freshMap });
      this.jobs = jobs.sort((a, b) => a.name.localeCompare(b.name));
      this.observeMotivation();
      this.world = WorldMap.fromMinimap(minimap);
      if (!quiet) this.info(`Loaded ${jobs.length} jobs.`);
    });
  }

  /**
   * job/job is the only endpoint that returns danger, and it also carries the live motivation.
   * Refreshes the selected job only: the browser does the same when its job window opens.
   */
  async loadJobDetail(job: JobInfo, at: Position): Promise<void> {
    if (this.jobDetailLoading.has(job.id)) return;
    this.jobDetailLoading.add(job.id);
    try {
      const detail = parseJobDetail(await fetchJobDetail(this.client, job.id, at));
      const current = this.jobs.find((j) => j.id === job.id);
      if (!current) return;
      let changed = false;
      if (detail.danger !== null && detail.danger !== current.danger) {
        current.danger = detail.danger;
        changed = true;
      }
      if (detail.motivation !== null && detail.motivation !== current.motivation) {
        current.motivation = detail.motivation;
        changed = true;
      }
      if (changed) this.changed();
    } catch (err) {
      this.error(`Job detail: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.jobDetailLoading.delete(job.id);
    }
  }

  /** Product names a job drops (static yields + per-duration drops), for search and display. */
  jobProducts(job: JobInfo): { itemId: number; name: string; percent: number | null }[] {
    const out = new Map<number, { itemId: number; name: string; percent: number | null }>();
    for (const y of job.values.long?.items ?? job.values.middle?.items ?? []) out.set(Math.floor(y.itemId / 1000), { itemId: y.itemId, name: this.itemName(y.itemId), percent: y.percent });
    for (const id of Object.keys(job.yields ?? {}).map(Number)) {
      if (!out.has(Math.floor(id / 1000))) out.set(Math.floor(id / 1000), { itemId: id, name: this.itemName(id), percent: null });
    }
    return [...out.values()];
  }

  /**
   * Jobs with the nearest location from where the queue ends. `filter` matches the job name or a product
   * it drops. By default only jobs with enough labor points; `showAll` adds the rest (as the web lists
   * them: jobs you could reach by level). `sort` orders by the 1 h values, best first.
   */
  jobOptions(filter = '', opts: { sort?: JobSort; showAll?: boolean } = {}): JobOption[] {
    const from = this.queueEndPosition;
    const f = filter.trim().toLowerCase();
    const sort = opts.sort ?? 'name';
    const list = this.jobs
      .filter((j) => (opts.showAll ? j.jobPoints >= j.workPoints || this.character.level >= j.level : j.jobPoints >= j.workPoints))
      .filter((j) => !f || j.name.toLowerCase().includes(f) || this.jobProducts(j).some((p) => p.name.toLowerCase().includes(f)))
      .map((job) => {
        const at = nearestLocation(this.locations.get(job.groupid), from);
        return { job, at, way: at ? wayTime(from, at, this.travelSpeed, this.character.speed) : null };
      });
    if (sort === 'name') return list;
    if (sort === 'distance') return list.sort((a, b) => (a.way ?? Infinity) - (b.way ?? Infinity));
    return list.sort((a, b) => jobSortValue(b.job, sort) - jobSortValue(a.job, sort) || a.job.name.localeCompare(b.job.name));
  }

  async startJob(option: JobOption, duration: DurationKey): Promise<void> {
    const { job, at } = option;
    if (this.queue.length >= this.taskLimit) {
      this.error(`Task queue is full (${this.queue.length}/${this.taskLimit})${this.hasAutomation ? '' : '; automation premium raises the limit'}`);
      return;
    }
    if (!at) {
      this.error(`No known location for ${job.name}`);
      return;
    }
    const seconds = job.values[duration]?.duration ?? job.durations[duration];
    await this.guard('Start job', async () => {
      const res = await this.tasks.add(this.queue.length, [jobPost(job.id, at, seconds)], this.taskLimit);
      if (res.energy !== undefined) this.character.setEnergy(res.energy);
      for (const e of res.errors) this.error(e);
      if (res.added.length) {
        this.queue.push(...res.added);
        this.info(`Queued ${job.name} (${duration}) at ${at.x},${at.y}`);
      }
    });
  }

  // ---- quest route ---------------------------------------------------------------------------

  /** Quests a route covers: one quest, its chain (accepted quests of the same chain) or the whole log. */
  routeQuests(scope: 'quest' | 'chain' | 'all', quest?: Quest): Quest[] {
    const open = this.quests.filter((q) => !q.finishable);
    if (scope === 'all' || !quest) return open;
    if (scope === 'chain') return open.filter((q) => (quest.groupId ? q.groupId === quest.groupId : q.group === quest.group));
    return open.filter((q) => q.id === quest.id);
  }

  /** Best job route (from where the queue ends) for what these quests still need. */
  planQuestRoute(quests: Quest[], objective: RouteObjective = 'energy'): RoutePlan {
    const needs = questNeeds(quests, (id) => this.inventory.countBase(id), (id) => this.itemName(id), (id) => this.catalog.get(id)?.name ?? `job ${id}`);
    return planRoute({
      needs,
      jobs: this.jobs,
      locations: (g) => this.locations.get(g),
      from: this.queueEndPosition,
      wayTime: (a, b) => wayTime(a, b, this.travelSpeed, this.character.speed),
      objective,
      walkEnergyPerSecond: (this.character.maxEnergy * this.character.energyRegen) / 3600,
      energyAvailable: this.character.energy,
    });
  }

  /**
   * Auto-route: the planned runs not queued yet. The 1 s ticker calls autoRouteStep(), which adds
   * the next ones (in route order) whenever the queue has room and there is energy for them.
   */
  autoRoute: { label: string; runs: RouteRun[]; total: number; retryAt: number } | null = null;

  private routeRuns(plan: RoutePlan): RouteRun[] {
    return plan.stops.flatMap((s) => {
      const v = s.job.values[s.duration];
      const run = { post: jobPost(s.job.id, s.at, v?.duration ?? s.job.durations[s.duration]), energy: v?.energy ?? Math.ceil(s.energy / Math.max(1, s.runs)), title: s.job.name };
      return Array.from({ length: s.runs }, () => run);
    });
  }

  /** Queues the route's runs in order, as many as fit (one task/add call); `auto` keeps queueing the rest later. */
  async queueRoute(plan: RoutePlan, opts: { auto?: boolean; label?: string } = {}): Promise<number> {
    const runs = this.routeRuns(plan);
    const free = this.taskLimit - this.queue.length;
    if (opts.auto) {
      this.autoRoute = { label: opts.label ?? 'route', runs, total: runs.length, retryAt: 0 };
      const added = await this.autoRouteStep();
      if (this.autoRoute) this.info(`Auto-route on: ${this.autoRoute.runs.length} more job(s) get queued as queue space and energy allow (R, then x stops).`);
      return added;
    }
    if (free <= 0) {
      this.queueFull();
      return 0;
    }
    // Only what the current energy pays for: the server would refuse the rest.
    const posts = runs.map((r) => r.post).slice(0, Math.min(free, plan.fitRuns));
    if (!posts.length) {
      this.error(`Not enough energy for the first route job (${this.character.energy} energy). Sleep or wait, then press R again.`);
      return 0;
    }
    const r = await this.guard('Queue route', async () => {
      const res = await this.tasks.add(this.queue.length, posts, this.taskLimit);
      if (res.energy !== undefined) this.character.setEnergy(res.energy);
      for (const e of res.errors) this.error(e);
      this.queue.push(...res.added);
      const left = plan.totals.runs - res.added.length;
      const why = plan.fitRuns < plan.totals.runs && plan.fitRuns <= free ? 'you have the energy' : 'the queue has room';
      this.info(`Queued ${res.added.length} route job(s)${left > 0 ? `; ${left} more once ${why} (R again)` : ''}.`);
      return res.added.length;
    });
    return r ?? 0;
  }

  /** Adds the next auto-route runs that fit in the queue and the current energy; no request otherwise. */
  async autoRouteStep(): Promise<number> {
    const auto = this.autoRoute;
    if (!auto || this.busy || Date.now() < auto.retryAt) return 0;
    if (!auto.runs.length) {
      this.autoRoute = null;
      this.info(`Auto-route done: all ${auto.total} job(s) queued.`);
      return 0;
    }
    const free = this.taskLimit - this.queue.length;
    let energy = this.character.energy;
    const batch: RouteRun[] = [];
    for (const run of auto.runs) {
      if (batch.length >= free || run.energy > energy) break;
      batch.push(run);
      energy -= run.energy;
    }
    if (!batch.length) return 0;
    const added = await this.guard('Auto-route', async () => {
      const res = await this.tasks.add(this.queue.length, batch.map((b) => b.post), this.taskLimit);
      // Jobs cost their energy when queued; without a server value, subtract what was accepted.
      if (res.energy !== undefined) this.character.setEnergy(res.energy);
      else if (res.added.length) this.character.setEnergy(this.character.energy - batch.slice(0, res.added.length).reduce((a, b) => a + b.energy, 0));
      this.queue.push(...res.added);
      return res;
    });
    if (this.autoRoute !== auto) return added?.added.length ?? 0; // stopped meanwhile
    if (!added || !added.added.length) {
      // Refused (energy/queue out of sync, job gone, …): retry in a minute instead of hammering.
      for (const e of added?.errors ?? []) this.error(`Auto-route: ${e}`);
      auto.retryAt = Date.now() + 60_000;
      void this.refreshQueue();
      return 0;
    }
    for (const e of added.errors) this.error(`Auto-route: ${e}`);
    auto.runs = auto.runs.slice(added.added.length);
    this.info(`Auto-route: queued ${added.added.map((t) => t.title).join(', ')} (${auto.runs.length} left).`);
    if (!auto.runs.length) {
      this.autoRoute = null;
      this.info(`Auto-route done: all ${auto.total} job(s) queued.`);
    }
    this.changed();
    return added.added.length;
  }

  stopAutoRoute(): void {
    if (!this.autoRoute) return;
    this.info(`Auto-route stopped (${this.autoRoute.runs.length} job(s) not queued).`);
    this.autoRoute = null;
    this.changed();
  }

  // ---- autopilot -----------------------------------------------------------------------------

  /** Settings, rules and the last plan (autopilot.json). */
  autopilot: AutopilotFile = loadAutopilot();
  /** Plans and carries out; the TUI ticker calls runner.step() every second. */
  runner = new AutopilotRunner(this);

  /** The quest screen's route shortcut: autopilot on, quests first, limited to these quests. */
  startAutopilotForQuests(ids: number[], label: string): void {
    this.stopAutoRoute();
    this.updateAutopilot((f) => {
      f.rules.onlyQuests = ids;
      f.config.running = true;
      f.config.modules.jobs = true;
      f.config.priority = ['quests', ...f.config.priority.filter((g) => g !== 'quests')];
    });
    this.info(`Autopilot on for ${label}: quests first (G to change, R to pause).`);
  }

  /** Runs one autopilot request under the busy lock; errors are thrown to the caller (it retries / pauses). */
  async autopilotCall<T>(fn: () => Promise<T>, label = 'autopilot request'): Promise<T> {
    if (this.busy) {
      this.debug.add('request', `${label}: refused (busy)`);
      throw new Error('busy');
    }
    this.busy = true;
    this.changed();
    const t0 = Date.now();
    try {
      const r = await fn();
      this.debug.add('request', `${label}: ok (${Date.now() - t0} ms)`, { result: r });
      return r;
    } catch (err) {
      this.debug.add('request', `${label}: failed (${Date.now() - t0} ms)`, { error: err instanceof Error ? err.stack ?? err.message : String(err) });
      throw err;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  /**
   * The first open requirement of a quest the autopilot cannot get, or null when it can finish the quest:
   * items need a doable job that drops them (or enough in the bag); job requirements a doable job; anything
   * else ("Go to …", "Resolve …", duels, shop-only items) it cannot do yet.
   */
  questBlocker(q: Quest): string | null {
    for (const r of q.requirements) {
      if (r.solved) continue;
      if (r.itemId !== undefined) {
        if (this.inventory.countBase(r.itemId) >= (r.count ?? 1)) continue;
        if (this.requirementSources(r).some((x) => x.job.jobPoints >= x.job.workPoints && x.at)) continue;
        return `${r.info}: no doable job drops it`;
      }
      if (r.jobId !== undefined) {
        const job = this.jobs.find((j) => j.id === r.jobId);
        if (job && job.jobPoints >= job.workPoints) continue;
        return `${r.info}: job not doable`;
      }
      return `${r.info}: the autopilot cannot do this`;
    }
    return null;
  }

  /** Quests the Quests goal works on: open quests (or the route's), minus excluded ones, chains and (unless allowed) ones it cannot finish. */
  autopilotQuests(): Quest[] {
    const { rules, config } = this.autopilot;
    return this.routeQuests('all').filter((q) =>
      (!rules.onlyQuests.length || rules.onlyQuests.includes(q.id)) &&
      !rules.excludedQuests.includes(q.id) &&
      !config.quests.excludedChains.includes(q.group) &&
      (config.quests.repeatable || !/repeatable/i.test(q.group)) &&
      (config.quests.unfinishable || !this.questBlocker(q)));
  }

  /**
   * What the Quests goal works on, with the autopilot's extras per need: urgency `weight` (up to 2× for a quest
   * ending within 3 days) and the quests' XP / $ rewards spread over the units each quest still needs.
   */
  autopilotNeeds(): RouteNeed[] {
    const quests = this.autopilotQuests();
    const needs = questNeeds(quests, (id) => this.inventory.countBase(id), (id) => this.itemName(id), (id) => this.catalog.get(id)?.name ?? `job ${id}`);
    const now = this.clock.now();
    for (const q of quests) {
      const mine = needs.filter((n) => n.quests.includes(q.soloTitle || q.title));
      const units = mine.reduce((a, n) => a + (n.unit === 'seconds' ? n.amount / 3600 : n.amount), 0);
      if (!mine.length || units <= 0) continue;
      const xp = q.rewards.reduce((a, r) => a + (r.item === null && /experience/i.test(r.text) ? Number(r.text.match(/[\d.,]+/)?.[0]?.replace(/[.,]/g, '') ?? 0) : 0), 0);
      const money = q.rewards.reduce((a, r) => a + (r.item === null && /dollar/i.test(r.text) ? Number(r.text.match(/[\d.,]+/)?.[0]?.replace(/[.,]/g, '') ?? 0) : 0), 0);
      const ends = questEnds(q.limited);
      const left = ends === null ? Infinity : (ends - now) / 3600;
      const weight = 1 + Math.max(0, Math.min(1, 1 - left / 72));
      for (const n of mine) {
        const per = n.unit === 'seconds' ? 1 / 3600 : 1;
        n.xpPerUnit = (n.xpPerUnit ?? 0) + (xp / units) * per;
        n.moneyPerUnit = (n.moneyPerUnit ?? 0) + (money / units) * per;
        n.weight = Math.max(n.weight ?? 1, weight);
      }
    }
    return needs;
  }

  /** Changes the autopilot file and saves it. */
  updateAutopilot(fn: (f: AutopilotFile) => void): void {
    fn(this.autopilot);
    saveAutopilot(this.autopilot);
    this.changed();
  }

  /**
   * A queued job's definition and the duration it runs for. The queue entry has no duration key (not seen in
   * task/get_tasks), so it is the duration closest to the work time (end − walk end).
   */
  queuedJob(t: QueuedTask): { job: JobInfo; duration: DurationKey; values: JobDurationValues } | null {
    const job = t.jobId === undefined ? undefined : this.jobs.find((j) => j.id === t.jobId);
    if (!job) return null;
    const secs = t.end - (t.way?.end ?? t.start);
    let found: { job: JobInfo; duration: DurationKey; values: JobDurationValues } | null = null;
    let best = Infinity;
    for (const k of DURATION_KEYS) {
      const d = job.values[k];
      if (d && Math.abs(d.duration - secs) < best) [found, best] = [{ job, duration: k, values: d }, Math.abs(d.duration - secs)];
    }
    return found;
  }

  /** A server queue entry as a fixed timeline step; job rewards from the job's values for its duration. */
  queuedStep(t: QueuedTask): TimelineStep {
    const fixed = { start: t.start, end: t.end };
    if (t.type === 'job' && t.jobId !== undefined) {
      const q = this.queuedJob(t);
      const secs = t.end - (t.way?.end ?? t.start);
      return { kind: 'job', title: t.title, jobId: t.jobId, at: t.coords, duration: secs, energy: 0, xp: q?.values.experience ?? 0, money: q?.values.money ?? 0, fixed };
    }
    // Sleep rates are not in the queue entry; base regen until the room's units are known (docs/autopilot.md).
    if (t.type === 'sleep') {
      const r = this.sleepRates.get(t.queueId);
      return { kind: 'sleep', title: t.title, at: t.coords, energyRate: r?.energyRate ?? this.character.energyRegen, healthRate: r?.healthRate ?? this.character.healthRegen, fixed };
    }
    return { kind: 'walk', title: t.title, at: t.coords, fixed };
  }

  /** Projection of the server queue followed by `planned` steps, from now. */
  timeline(planned: TimelineStep[] = []): Timeline {
    const c = this.character;
    return projectTimeline({
      now: this.clock.now(), at: c.position, energy: c.energy, maxEnergy: c.maxEnergy, health: c.health, maxHealth: c.maxHealth,
      energyRegen: c.energyRegen, healthRegen: c.healthRegen, level: c.level, experience: c.experience, maxLevel: c.maxLevel, cash: c.cash,
    }, [...this.queue.map((t) => this.queuedStep(t)), ...planned], { wayTime: (a, b) => wayTime(a, b, this.travelSpeed, c.speed) });
  }

  /** Marks the route's jobs on the map. */
  highlightRoute(plan: RoutePlan, label: string): { x: number; y: number } | null {
    if (!plan.stops.length) return null;
    this.mapHighlight = { label, jobIds: new Set(plan.stops.map((s) => s.job.id)) };
    this.changed();
    return plan.stops[0]!.at;
  }

  /** Loads tile details (quest giver names, gold/silver jobs, crowds) around a map position. */
  async loadTilesAround(at: { x: number; y: number }): Promise<void> {
    try {
      if (await this.tiles.loadAround(this.client, at)) this.changed();
    } catch (err) {
      this.error(`Map tiles: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Guidepost.start_walk(townId, 'town') → TaskWalk(unitId, type) with no x/y. */
  walkToTown(town: Town): Promise<boolean> {
    return this.addTask('Walk', walkPost(town.id, 'town'), `Walking to ${town.name ?? `town ${town.id}`}`);
  }

  async cancel(position: number): Promise<void> {
    const task = this.queue[position];
    if (!task) return;
    await this.guard('Cancel', async () => {
      const res = await this.tasks.cancel(this.queue, [position]);
      if (res.energy !== undefined) this.character.setEnergy(res.energy);
      if (res.money !== undefined) this.character.cash = res.money;
      for (const e of res.errors) this.error(e);
      this.queue = res.queue;
      this.info(`Cancelled: ${task.title}`);
    });
  }

  // ---- chat ---------------------------------------------------------------------------------

  /** Says something in a chat room, or whispers when `room` is "tell:<name>". */
  async chatSay(room: string, text: string): Promise<boolean> {
    const live = this.live;
    if (!live?.active) {
      this.error('Chat needs live updates (press L).');
      return false;
    }
    try {
      if (room.startsWith('tell:')) await live.say(room.slice(5), text, true);
      else await live.say(room, text);
      return true;
    } catch (err) {
      this.error(`Chat: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ---- mail ---------------------------------------------------------------------------------

  private get mail(): MailApi {
    return new MailApi(this.client, (id) => this.itemName(id));
  }

  async loadReports(page = 1, folder: ReportFolder = this.reportFolder): Promise<void> {
    await this.guard('Reports', async () => {
      this.reports = await this.mail.reports(page, folder);
      this.reportFolder = folder;
      this.unread.reports = false;
    });
  }

  /** Home screen's report list: one page-1 read in the background (no busy lock, errors only logged). */
  async loadRecentReports(): Promise<void> {
    try {
      this.recentReports = (await this.mail.reports(1, 'all')).reports;
      this.changed();
    } catch (err) {
      this.error(`Reports: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async openReport(row: ReportRow): Promise<Report | null> {
    const r = await this.guard('Report', async () => {
      const rep = await this.mail.report(row.id, row.hash);
      row.read = true;
      return rep;
    });
    return r ?? null;
  }

  async deleteReport(row: ReportRow): Promise<void> {
    const ok = await this.guard('Delete report', async () => {
      await this.mail.deleteReport(row.id, this.reportFolder);
      this.info(`Deleted report: ${row.title}`);
      return true;
    });
    if (ok) await this.loadReports(this.reports?.page ?? 1);
  }

  async loadTelegrams(page = 1): Promise<void> {
    await this.guard('Telegrams', async () => {
      this.telegrams = await this.mail.telegrams(page);
      this.unread.messages = false;
    });
  }

  async openTelegram(id: number, page = 0): Promise<Telegram | null> {
    const r = await this.guard('Telegram', async () => {
      const t = await this.mail.telegram(id, page);
      const row = this.telegrams?.telegrams.find((x) => x.id === id);
      if (row) row.unread = false;
      return t;
    });
    return r ?? null;
  }

  async replyTelegram(id: number, text: string): Promise<boolean> {
    const ok = await this.guard('Reply', async () => {
      await this.mail.reply(id, text);
      this.info('Reply sent.');
      return true;
    });
    return !!ok;
  }

  async sendTelegram(to: string, subject: string, text: string): Promise<boolean> {
    const ok = await this.guard('Telegram', async () => {
      await this.mail.send(to, subject, text);
      this.info(`Your telegram to ${to} was sent!`);
      return true;
    });
    if (ok) await this.loadTelegrams(1);
    return !!ok;
  }

  async deleteTelegram(id: number): Promise<void> {
    const ok = await this.guard('Delete telegram', async () => {
      await this.mail.deleteTelegram(id);
      return true;
    });
    if (ok) await this.loadTelegrams(this.telegrams?.page ?? 1);
  }

  // ---- town: bank, shops, market, item use ---------------------------------------------------

  /** Town at the character's position (you are in it), else null. */
  get townHere(): Town | null {
    const p = this.character.position;
    return this.world.towns.find((t) => t.x === p.x && t.y === p.y && t.name) ?? null;
  }

  /** Where the trade screen shops: the town you stand in, else your home town. */
  get tradeTown(): { id: number; name: string; here: boolean } | null {
    const here = this.townHere;
    if (here) return { id: here.id, name: here.name ?? `town ${here.id}`, here: true };
    const home = this.character.homeTown;
    if (!home) return null;
    const t = this.world.towns.find((x) => x.id === home.id);
    return { id: home.id, name: t?.name ?? `town ${home.id}`, here: false };
  }

  townAt(at: { x: number; y: number }): Town | undefined {
    return this.world.towns.find((t) => t.x === at.x && t.y === at.y);
  }

  async openBank(townId: number): Promise<void> {
    await this.guard('Bank', async () => {
      this.bank = await fetchBank(this.client, townId);
    });
  }

  /** City hall of the home town (construction rights live there). */
  async loadTownHall(): Promise<void> {
    const home = this.character.homeTown;
    if (!home) return this.error('You are not a member of a town.');
    await this.guard('Town hall', async () => {
      this.townHall = await fetchTownHall(this.client, home.id);
    });
  }

  async openConstruction(building: TownBuilding): Promise<Construction | null> {
    const home = this.character.homeTown;
    if (!home) {
      this.error('You are not a member of a town.');
      return null;
    }
    const r = await this.guard('Construction', async () => {
      this.construction = await fetchConstruction(this.client, home.x, home.y, building.key);
      return this.construction;
    });
    return r ?? null;
  }

  /** Queues TaskBuild; the server walks to the town first when needed. */
  async queueConstruction(duration: number, pay: 'town' | 'player'): Promise<boolean> {
    const c = this.construction;
    if (!c) return false;
    if (!c.durations.some((d) => d.seconds === duration)) {
      this.error('That construction duration is not available.');
      return false;
    }
    return this.addTask('Construction', buildPost({ x: c.x, y: c.y }, c.key, duration, pay), `Queued construction: ${c.name}`);
  }

  async depositMoney(amount: number): Promise<void> {
    const bank = this.bank;
    if (!bank) return;
    if (!(amount > 0)) return this.error('Enter an amount to deposit.');
    if (amount > this.character.cash) return this.error(`You only have ${this.character.cash} in cash.`);
    await this.guard('Deposit', async () => {
      const r = await deposit(this.client, bank.townId, amount);
      this.character.cash = r.cash;
      this.character.deposit = r.deposit;
      this.bank = { ...bank, cash: r.cash, deposit: r.deposit };
      this.info(`You deposited $ ${amount} and paid a fee of $ ${r.fee}`);
    });
  }

  async openShop(key: ShopKey, townId: number): Promise<void> {
    await this.guard('Shop', async () => {
      this.shop = await fetchShop(this.client, key, townId);
    });
  }

  /** Rotating offers of the mobile trader; no town needed. */
  async openMobileTrader(): Promise<void> {
    await this.guard('Mobile trader', async () => {
      this.mobileTrader = await fetchMobileTrader(this.client);
    });
  }

  async buyMobileTrader(item: MobileTraderItem): Promise<void> {
    const ok = await this.guard('Buy from mobile trader', async () => {
      const r = await buyMobileTrader(this.client, item);
      this.applyMoney(r);
      const name = this.itemName(item.itemId);
      this.info(`Bought ${name}${r.message && !r.message.includes(name) ? `: ${r.message}` : ''}`);
      return true;
    });
    if (!ok) return;
    await this.refreshInventory();
    await this.openMobileTrader();
  }

  /** Shop price: item price × the shop's charge (Trader.addItemToInv). */
  shopPrice(itemId: number): number {
    return Math.round((this.items?.get(itemId)?.price ?? 0) * (this.shop?.charge || 1));
  }

  private applyMoney(r: { cash?: number; deposit?: number }): void {
    if (typeof r.cash === 'number') this.character.cash = r.cash;
    if (typeof r.deposit === 'number') this.character.deposit = r.deposit;
  }

  async buyFromShop(itemId: number): Promise<void> {
    const shop = this.shop;
    if (!shop) return;
    await this.guard('Buy', async () => {
      const r = await shopBuy(this.client, shop.key, shop.townId, itemId, this.inventory.lastInvId);
      this.inventory.applyChanges(r.changes);
      this.applyMoney(r);
      this.info(`Bought ${this.itemName(itemId)}`);
    });
  }

  async sellToShop(itemId: number, count = 1): Promise<void> {
    const shop = this.shop;
    const item = this.inventory.bag.get(itemId);
    if (!shop || !item) return;
    if (this.items?.get(itemId)?.sellable === false) return this.error(`${this.itemName(itemId)} cannot be sold.`);
    await this.guard('Sell', async () => {
      const r = await shopSell(this.client, shop.key, shop.townId, item, Math.min(count, item.count), this.inventory.lastInvId);
      this.inventory.applyChanges(r.changes);
      this.applyMoney(r);
      this.info(`Sold ${count > 1 ? `${count}× ` : ''}${this.itemName(itemId)}`);
    });
  }

  async useItem(itemId: number, count = 1): Promise<void> {
    const d = this.items?.get(itemId);
    if (d && d.usetype === 'none') return this.error(`${d.name} cannot be used.`);
    await this.guard('Use item', async () => {
      const r = await useItem(this.client, itemId, count, this.inventory.lastInvId, (id) => this.itemName(id));
      this.inventory.applyChanges(r.changes);
      if (r.energy !== undefined) this.character.setEnergy(r.energy);
      if (r.health !== undefined) this.character.setHealth(r.health);
      this.info(`Used ${this.itemName(itemId)}${r.effects.length ? `: ${r.effects.join(' ')}` : ''}`);
    });
    if (d?.usetype === 'buff' || d?.usebonus?.length) await this.refreshSkills();
  }

  private get marketApi(): MarketApi {
    return new MarketApi(this.client);
  }

  /** Searches goods for sale (or buy orders, with filter.buyOrders). Keeps the last filter when none is given. */
  async searchMarket(query: string, page = 1, filter: MarketFilter = this.market.filter): Promise<void> {
    const nav = page > this.market.page ? 'next' : page < this.market.page ? 'prev' : page > 1 ? 'next' : 'first';
    await this.guard('Market', async () => {
      const r = await this.marketApi.search(query, page, filter, nav);
      this.market = { query, page, next: r.next, offers: r.offers, filter: { ...filter }, searched: true };
      if (!r.offers.length) this.info(`No ${filter.buyOrders ? 'buy orders' : 'market offers'}${query ? ` for "${query}"` : ''}.`);
    });
  }

  async loadMarketMine(): Promise<void> {
    const town = this.tradeTown;
    await this.guard('Market', async () => {
      const [bids, offers, buyOrders] = await Promise.all([
        this.marketApi.myBids(), this.marketApi.myOffers(), town ? this.marketApi.myBuyOrders(town.id) : Promise.resolve([]),
      ]);
      this.marketMine = { bids, offers, buyOrders };
    });
  }

  /**
   * Bids on a market offer, or on a buy order (you sell the item; at or below its instant price it sells at once).
   * Goods for sale: ≥ the buy-now price buys at once; cash first unless fromBank.
   */
  async bidMarket(offer: MarketOffer, amount: number, fromBank = false): Promise<void> {
    if (offer.sellerId && offer.sellerId === this.character.playerId) return this.error('That is your own offer.');
    if (!(amount > 0)) return this.error('Enter an amount.');
    const selling = offer.direction === 'BUY';
    if (selling && this.inventory.count(offer.itemId) < offer.count) {
      return this.error(`You need ${offer.count}× ${this.itemName(offer.itemId)} in your bag to sell into this buy order.`);
    }
    // Like the web's bid dialog: going past the instant price only ever gets the instant price.
    if (offer.buyNow !== null && (selling ? amount < offer.buyNow : amount > offer.buyNow)) amount = offer.buyNow;
    await this.guard('Bid', async () => {
      const r = await this.marketApi.bid(offer, amount, fromBank);
      this.applyMoney(r);
      if (r.changes.length) this.inventory.applyChanges(r.changes);
      const name = this.itemName(offer.itemId);
      this.info(r.instant
        ? selling ? `You sold ${name} for $ ${amount} (collect the money at ${offer.town.name}).` : `You have won ${name} (pick it up at ${offer.town.name}).`
        : `You have posted your bid of $ ${amount}.`);
    });
    if (selling && this.items) await this.refreshInventory();
    await this.searchMarket(this.market.query, this.market.page);
  }

  private atTown(at: { x: number; y: number }): boolean {
    const p = this.character.position;
    return p.x === at.x && p.y === at.y;
  }

  /** Picks up a finished offer's goods/money; you must stand in the market town. */
  async pickUpMarket(offer: MarketOffer): Promise<void> {
    if (!this.atTown(offer.town)) return this.error(`Go to ${offer.town.name} to pick this up (w walks there).`);
    await this.guard('Pick up', async () => {
      const r = await this.marketApi.fetch(offer.id);
      this.applyMoney(r);
      this.info('You have accepted the market delivery.');
    });
    await this.loadMarketMine();
    if (this.items) await this.refreshInventory();
  }

  /** Picks up everything finished at the market of the town you stand in. */
  async pickUpAllMarket(): Promise<void> {
    const town = this.townHere;
    if (!town) return this.error('Stand in a town to pick up its market deliveries.');
    await this.guard('Pick up', async () => {
      const r = await this.marketApi.fetchAll(town.id);
      this.applyMoney(r);
      this.info(`You have accepted the market deliveries at ${town.name ?? 'this town'}.`);
    });
    await this.loadMarketMine();
    if (this.items) await this.refreshInventory();
  }

  /** Withdraws one of your running sell offers or buy orders (in the market town, as the web asks for). */
  async withdrawMarket(offer: MarketOffer): Promise<void> {
    if (!this.atTown(offer.town)) return this.error(`Go to ${offer.town.name} to withdraw this (w walks there).`);
    await this.guard('Withdraw', async () => {
      const r = await this.marketApi.withdraw(offer);
      if (r.refund) this.character.cash += r.refund;
      this.info(r.refund ? `The offer was withdrawn; $ ${r.refund} of fees were refunded to you.` : 'The offer was withdrawn; no fees were refunded to you.');
    });
    await this.loadMarketMine();
    if (this.items) await this.refreshInventory();
  }

  /** Auctionable items whose name matches `query` (exact name first), for placing a buy order. */
  findAuctionable(query: string): { id: number; name: string }[] {
    const q = query.trim().toLowerCase();
    if (!q || !this.items) return [];
    const all = this.items.all().filter((d) => d.auctionable && d.name.toLowerCase().includes(q));
    const exact = all.filter((d) => d.name.toLowerCase() === q);
    return (exact.length ? exact : all).map((d) => ({ id: d.id * 1000, name: d.name }));
  }

  /** Places a buy order at the trade town's market for an item by name. */
  async placeBuyOrder(o: { query: string; count: number; days: number; maxBid?: number; instant?: number; fromBank: boolean }): Promise<boolean> {
    const town = this.tradeTown;
    if (!town) {
      this.error('You need to be in a town (or have a home town) to place a buy order.');
      return false;
    }
    const found = this.findAuctionable(o.query);
    if (found.length !== 1) {
      this.error(found.length ? `"${o.query}" matches ${found.length} items (${found.slice(0, 4).map((f) => f.name).join(', ')}${found.length > 4 ? ', …' : ''}); be more exact.` : `No market item is called "${o.query}".`);
      return false;
    }
    const item = found[0]!;
    const problem = buyOrderProblem(o, this.items?.get(item.id)?.sell ?? 0);
    if (problem) {
      this.error(problem);
      return false;
    }
    const ok = await this.guard('Buy order', async () => {
      const r = await this.marketApi.buyOrder({ ...o, townId: town.id, itemId: item.id });
      this.applyMoney(r);
      this.info(`Buy order for ${o.count > 1 ? `${o.count}× ` : ''}${item.name} placed at ${town.name}; the fee is $ ${r.fee}`);
      return true;
    });
    if (ok) await this.loadMarketMine();
    return !!ok;
  }

  async sellOnMarket(o: { itemId: number; count: number; days: number; startPrice?: number; buyNow?: number }): Promise<boolean> {
    const town = this.tradeTown;
    if (!town) {
      this.error('You need to be in a town (or have a home town) to sell on the market.');
      return false;
    }
    const ok = await this.guard('Market offer', async () => {
      const r = await this.marketApi.sell({ ...o, townId: town.id });
      this.applyMoney(r);
      this.info(`The goods are offered for sale; the fee is $ ${r.fee}`);
      return true;
    });
    if (ok && this.items) await this.refreshInventory();
    return !!ok;
  }

  /** Walks to a town given by coordinates (market towns are only known by position). */
  walkToTownAt(at: { x: number; y: number }, name: string): Promise<boolean> {
    const t = this.townAt(at);
    if (!t) {
      this.error(`No known town at ${at.x},${at.y}`);
      return Promise.resolve(false);
    }
    return this.addTask('Walk', walkPost(t.id, 'town'), `Walking to ${name || t.name}`);
  }

  // ---- duels --------------------------------------------------------------------------------

  private get duelApi(): DuelApi {
    return new DuelApi(this.client);
  }

  async loadDuels(): Promise<void> {
    await this.guard('Duels', async () => {
      this.duels = await this.duelApi.data();
      this.duelOpponents = (await this.duelApi.opponents()).opponents;
    });
  }

  async fightNpc(npcId: number): Promise<void> {
    const npc = this.duels?.npcs.find((n) => n.id === npcId);
    const before = { xp: this.character.experience, energy: this.character.energy };
    await this.guard('NPC duel', async () => {
      const r = await this.duelApi.fightNpc(npcId);
      // Kept for the autopilot: which NPC levels you beat and what a duel pays / costs.
      if (npc) {
        const rec = { at: this.clock.now(), level: npc.level, won: !r.died && !/lost|defeat/i.test(r.result), xp: Math.max(0, (r.experience ?? before.xp) - before.xp), energy: Math.max(0, before.energy - (r.energy ?? before.energy)) };
        this.updateAutopilot((f) => (f.duels = [...f.duels, rec].slice(-200)));
      }
      this.lastNpcDuel = r;
      this.duels = r.data;
      const c = this.character;
      if (r.energy !== undefined) c.setEnergy(Math.floor(r.energy));
      if (r.health !== undefined) c.setHealth(Math.floor(r.health));
      if (r.money !== undefined) c.cash = r.money;
      if (r.experience !== undefined) c.experience = r.experience;
      if (r.level !== undefined) c.level = r.level;
      this.info(`NPC duel: ${r.result || 'done'}${r.died ? ' (you passed out and wake up in your home town)' : ''}`);
    });
    if (this.lastNpcDuel?.died) await this.reload();
  }

  /** Queues a duel against a player (TaskDuel). */
  duelPlayer(o: DuelOpponent): Promise<boolean> {
    return this.addTask('Duel', duelPost(o.playerId), `Duel against ${o.name} queued`);
  }
}
