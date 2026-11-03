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
  fetchJobInfos, JobCatalog, nearestLocation, wayTime,
  type DurationKey, type JobInfo, type JobLocations,
} from './jobs.ts';
import { jobPost, parseQueue, sleepPost, TaskApi, walkPost, type QueuedTask } from './tasks.ts';
import { WorldMap, type Fort, type Town } from './world.ts';
import { TileCache } from './tiles.ts';
import { ItemCatalog, ItemSetCatalog, loadItemCatalog, loadItemSets, statsOf } from './items.ts';
import { setBonusLines, type ItemStats, type StatContext } from './itemstats.ts';
import { Inventory, InventoryApi } from './inventory.ts';
import { SkillApi, Skills, type SkillPlan } from './skills.ts';
import { QuestApi, type Quest, type QuestEmployer, type QuestRequirement } from './quests.ts';
import { fetchHotel, type Hotel, type HotelRoom } from './hotel.ts';
import { ChatPoller, type SelfUpdate } from '../realtime/chat.ts';
import { cachedJson } from '../util/disk-cache.ts';
import { planRoute, questNeeds, type RouteObjective, type RoutePlan } from './route.ts';
import { MailApi, type Report, type ReportFolder, type ReportList, type ReportRow, type Telegram, type TelegramList } from './mail.ts';
import {
  buyOrderProblem, DEFAULT_FILTER, deposit, fetchBank, fetchShop, MarketApi, shopBuy, shopSell, useItem,
  type Bank, type MarketFilter, type MarketOffer, type Shop, type ShopKey,
} from './trade.ts';
import { DuelApi, duelPost, type DuelData, type DuelOpponent, type NpcDuelResult } from './duels.ts';

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

export type JobSort = 'name' | 'xp' | 'money' | 'luck' | 'distance';
export const JOB_SORTS: JobSort[] = ['name', 'xp', 'money', 'luck', 'distance'];

/** Value a job is sorted by: the 1 h (else longest known) duration's XP / money / luck. */
export function jobSortValue(job: JobInfo, sort: JobSort): number {
  const v = job.values.long ?? job.values.middle ?? job.values.short;
  if (!v) return -Infinity;
  return sort === 'xp' ? v.experience : sort === 'money' ? v.money : sort === 'luck' ? v.luck : 0;
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
  world = new WorldMap();
  tiles = new TileCache();
  log: LogEntry[] = [];
  busy = false;
  items: ItemCatalog | null = null;
  itemSets: ItemSetCatalog | null = null;
  inventory = new Inventory();
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
  reportFolder: ReportFolder = 'all';
  telegrams: TelegramList | null = null;
  /** Trade screen: bank, shop and market of the town you are in (or your home town). */
  bank: Bank | null = null;
  shop: Shop | null = null;
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

  info(msg: string): void {
    this.push('info', msg);
  }

  error(msg: string): void {
    this.push('error', msg);
  }

  private push(level: LogEntry['level'], msg: string): void {
    this.log.push({ at: new Date(), level, msg });
    if (this.log.length > 200) this.log.shift();
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
      changed = true;
    }
    return changed;
  }

  private async guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) {
      this.error('Busy, wait for the previous action to finish');
      return undefined;
    }
    this.busy = true;
    this.changed();
    try {
      return await fn();
    } catch (err) {
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

  async start(opts: { live?: boolean } = {}): Promise<void> {
    this.startup = { steps: [], done: false };
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
      this.info('New report.');
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
    if (u.level !== undefined && u.level > c.level) {
      this.info(`Level up: ${u.level}!`);
      c.level = u.level;
    }
    if (u.experience !== undefined && u.experience > c.experience) c.experience = u.experience;
    if (u.money !== undefined) c.cash = u.money;
    if (u.deposit !== undefined) c.deposit = u.deposit;
    if (u.energy !== undefined) c.setEnergy(u.energy, u.energyAt);
    if (u.health !== undefined) c.setHealth(u.health, u.healthAt);
    this.changed();
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
  sleep(hotel: Hotel, room: HotelRoom): Promise<boolean> {
    return this.addTask('Sleep', sleepPost(hotel.townId, room.key), `Sleeping in ${hotel.townName}: ${room.name}`);
  }

  async reload(): Promise<void> {
    await this.guard('Reload', async () => {
      this.apply(await this.reopen());
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
      this.world = WorldMap.fromMinimap(minimap);
      if (!quiet) this.info(`Loaded ${jobs.length} jobs.`);
    });
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

  /** Queues the route's runs in order, as many as fit in the task queue (one task/add call). */
  async queueRoute(plan: RoutePlan): Promise<number> {
    const free = this.taskLimit - this.queue.length;
    if (free <= 0) {
      this.queueFull();
      return 0;
    }
    // Only what the current energy pays for: the server would refuse the rest.
    const posts = plan.stops.flatMap((s) => Array.from({ length: s.runs }, () => jobPost(s.job.id, s.at, s.job.values[s.duration]?.duration ?? s.job.durations[s.duration]))).slice(0, Math.min(free, plan.fitRuns));
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
    return new MailApi(this.client);
  }

  async loadReports(page = 1, folder: ReportFolder = this.reportFolder): Promise<void> {
    await this.guard('Reports', async () => {
      this.reports = await this.mail.reports(page, folder);
      this.reportFolder = folder;
      this.unread.reports = false;
    });
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
    await this.guard('NPC duel', async () => {
      const r = await this.duelApi.fightNpc(npcId);
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
