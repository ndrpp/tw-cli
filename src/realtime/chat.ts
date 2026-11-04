// Live updates: the browser's chat service is an HTTP long-poll, not socket.io (socket.io is only
// loaded for the MPI translation helper). Chat.Router (tw2game @1059388):
//   POST <world>/gameservice/chat/   body = encodeURIComponent(JSON.stringify({messageid, clid, stamp,
//        actioned, batch:[{op:'nop', to:null, stamp}]}))   (jQuery default form content type)
//   ← {timenow, batch:[{id, t, payload}], error?}
// The server holds the request until there are events; the client immediately sends the next nop
// (at most one request per second, 30 s pause after a network error).
// The browser also pushes `var_dec`/`style_dec` requests, but only when new window globals or style
// sheets appear after the page loaded (userscripts). A plain client never sends them, so neither do we.
// `actioned` is the time of the user's last click/keypress (we pass the last TUI keypress).
// Events used here (Response.* @1045596-1054463):
//   Status {self, clients, rooms, sessionHash}  first reply; self = our own client
//   UserUpdate {id, x, y, level, experience, money, deposit, energy, energy_date, energy_regen,
//               health, health_date, health_regen, ...}  for our id → Character.set*
//   QuestDataChanged → reload quest log; ReportChanged / ReadState → unread markers;
//   NuggetsChanged {nuggets}; TellReceived {from:{name}, message}; CharDeathStateChanged.
//   error "invalid sid" / "sid invalidated by login" → session gone.
// Chat rooms (Chat.Resource.* @1027002, Response.* @1045596): Status.rooms[{roomdescription:{id, room
//   (town|general|maneuver|fortbattle), title, topic, townid, general_id}, members:[client id]}], Status.clients
//   [{id, westid, name, level, ...}]; ClientJoined {rid, client}; ClientLeft {rid, cid}; Text {cid, to, message};
//   TellReceived {from:client, message}; TellConfirmed {to:client, message}; TellFailed.
// Sending (Chat.Request.Send / Tell @1040177): the same POST with batch [{op:'send', to:<room id | player name>,
//   stamp, message[, tell:true]}]; the browser allows a second request while the long-poll is open.
import { EventEmitter } from 'node:events';
import { send, type GameClient } from '../http/game-client.ts';
import type { HostPolicy } from '../http/throttle.ts';
import { arr, isObj, obj, objs, type JsonObject } from '../util/json.ts';

export interface SelfUpdate {
  x?: number | undefined; y?: number | undefined; level?: number | undefined; experience?: number | undefined;
  money?: number | undefined; deposit?: number | undefined;
  /** energyAt / healthAt: seconds relative to now when the value was measured (energy_date, usually ≤ 0). */
  energy?: number | undefined; energyAt?: number | undefined; health?: number | undefined; healthAt?: number | undefined;
  townId?: number | undefined;
}

export interface ChatEvent { id: string; t: number; payload: JsonObject }

/** A chat client, with what the town roster shows (Client.update @1029207). */
export interface ChatClient {
  id: string;
  playerId: number;
  name: string;
  level: number;
  townId: number;
  /** 0 none · 1 citizen · 2 councillor · 3 town founder (mayor). */
  townRights: number;
  /** Epoch ms of the player's last action (5 min idle threshold, Chat.Resource.Client.updateStatus). */
  actioned: number;
}

export interface ChatRoom { id: string; kind: string; title: string; topic: string; members: Set<string>; townId?: number }
export interface ChatLine { at: number; from: string; text: string; own: boolean }

/** Town role names as the browser's RoomTown.getPlayerInfo shows them (3 is the founder/mayor). */
export const TOWN_ROLES = ['Guest', 'Citizen', 'Councillor', 'Mayor'];

/** Online within 5 minutes of the last action, as Chat.Resource.Client.updateStatus. */
export function chatPresence(actioned: number | undefined, now = Date.now()): 'online' | 'idle' | 'unknown' {
  if (!actioned) return 'unknown';
  return now - actioned > 300_000 ? 'idle' : 'online';
}

const ROOM_KIND_TITLE: Record<string, string> = { town: 'Town', general: 'Saloon', maneuver: 'Maneuver', fortbattle: 'Fort battle' };
export const HISTORY_LIMIT = 200;

function stripTags(s: unknown): string {
  return String(s ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
}

export const CHAT_POLICY: HostPolicy = {
  lane: 'chat',
  concurrency: 1,
  minIntervalMs: 1000, // Chat.Router requestDelay
  jitterMs: 0,
  maxRetries: 0,
  baseBackoffMs: 0,
  maxBackoffMs: 0,
  breakerThreshold: 1_000_000, // handled here: 30 s pause per error like the browser
  breakerCooldownMs: 0,
  timeoutMs: 120_000,
};

/** Chat.Router clientConnectionId: shuffled a-z + time, 18 chars, + last 4 digits of the time. */
export function makeClientId(now = Date.now(), rand = Math.random): string {
  const chars = ('abcdefghijklmnopqrstuvwxyz' + now).split('');
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('').substr(5, 18) + String(now).substr(-4);
}

export function encodeChatRequest(data: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(data).replace(/\n/g, '\\n'));
}

function selfFrom(p: JsonObject): SelfUpdate {
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : undefined);
  return {
    x: n(p.x), y: n(p.y), level: n(p.level), experience: n(p.experience), money: n(p.money), deposit: n(p.deposit),
    energy: n(p.energy), energyAt: n(p.energy_date), health: n(p.health), healthAt: n(p.health_date), townId: n(p.townId),
  };
}

/** What ChatPoller emits; 'event' fires for every event, before the specific one. */
export interface ChatPollerEvents {
  self: [SelfUpdate];
  quests: [];
  reports: [JsonObject];
  read: [JsonObject];
  nuggets: [number];
  tell: [{ from: string; message: string }];
  text: [{ room: string; cid: string; message: string }];
  chat: [string, ChatLine];
  rooms: [];
  tellFailed: [];
  revived: [JsonObject];
  event: [ChatEvent];
  invalid: [string];
  error: [Error];
}

export class ChatPoller extends EventEmitter<ChatPollerEvents> {
  client: GameClient;
  myId: string | null = null;
  actioned: number | null = null;
  private running = false;
  private abort: AbortController | null = null;
  private messageId = 0;
  private clid = makeClientId();
  private policy: HostPolicy;
  private errorPauseMs: number;
  /** Chat rooms we are in, client data, and per-room history ("tell:<name>" for whispers). */
  rooms = new Map<string, ChatRoom>();
  clients = new Map<string, ChatClient>();
  history = new Map<string, ChatLine[]>();
  unreadRooms = new Set<string>();

  constructor(client: GameClient, opts: { policy?: HostPolicy; errorPauseMs?: number } = {}) {
    super();
    this.client = client;
    this.policy = opts.policy ?? CHAT_POLICY;
    this.errorPauseMs = opts.errorPauseMs ?? 30_000;
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  /** One request → events handled. Returns false when the session is gone. */
  async pollOnce(): Promise<boolean> {
    this.abort = new AbortController();
    return this.exchange([{ op: 'nop', to: null, stamp: Date.now() }], this.abort.signal, this.policy);
  }

  /** Says something in a room (Chat.Request.Send) or whispers to a player (Chat.Request.Tell). */
  async say(to: string, message: string, tell = false): Promise<void> {
    if (!message.trim()) return;
    const req: Record<string, unknown> = { op: 'send', to, stamp: Date.now(), message };
    if (tell) req.tell = true;
    // A second request beside the pending long-poll, like Chat.Router (openCnt ≤ 2); not on the poll lane.
    const ok = await this.exchange([req], undefined, { ...this.policy, lane: 'chat-send', timeoutMs: 30_000 });
    if (!ok) throw new Error('chat session is gone');
  }

  private async exchange(batchOut: Record<string, unknown>[], signal: AbortSignal | undefined, policy: HostPolicy): Promise<boolean> {
    const data = {
      messageid: ++this.messageId,
      clid: this.clid,
      stamp: Date.now(),
      actioned: this.actioned,
      batch: batchOut,
    };
    const c = this.client;
    const res = await send(c.jar, c.identity, `${c.worldUrl}/gameservice/chat/`, {
      method: 'POST', body: encodeChatRequest(data), ajax: true, referer: `${c.worldUrl}/game.php`, origin: c.worldUrl, signal,
    }, policy);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`chat: non-JSON reply (${res.status})`);
    }
    const json = obj(parsed);
    if (json.error) {
      const err = String(json.error);
      if (/invalid sid|sid invalidated by login/.test(err)) {
        this.emit('invalid', err);
        return false;
      }
      if (/admin login/.test(err)) {
        this.emit('invalid', 'Administrator login - chat deactivated');
        return false;
      }
      throw new Error(`chat: ${err}`);
    }
    const batch: ChatEvent[] = objs(json.batch).map((e) => ({ id: String(e.id), t: Number(e.t), payload: obj(e.payload) }));
    batch.sort((a, b) => a.t - b.t);
    for (const e of batch) this.handle(e);
    return true;
  }

  roomTitle(id: string): string {
    if (id.startsWith('tell:')) return `✉ ${id.slice(5)}`;
    const r = this.rooms.get(id);
    return r ? r.title : id;
  }

  private addLine(room: string, line: ChatLine): void {
    const list = this.history.get(room) ?? [];
    list.push(line);
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
    this.history.set(room, list);
    if (!line.own) this.unreadRooms.add(room);
    this.emit('chat', room, line);
  }

  private acquireRoom(d: JsonObject): ChatRoom {
    const id = String(d.id);
    const kind = String(d.room ?? '');
    const title = stripTags(d.title) || (kind === 'general' ? `Saloon ${String(d.general_id ?? '')}`.trim() : ROOM_KIND_TITLE[kind] ?? id);
    const room = this.rooms.get(id) ?? { id, kind, title, topic: '', members: new Set<string>() };
    room.title = title;
    room.topic = stripTags(d.topic);
    if (d.townid !== undefined && d.townid !== null) room.townId = Number(d.townid);
    this.rooms.set(id, room);
    return room;
  }

  /** Creates or updates a client from Status / ClientJoined / UserUpdate data (missing fields keep old values). */
  private acquireClient(v: unknown): ChatClient | null {
    if (!isObj(v) || v.id === undefined) return null;
    const d = v;
    const id = String(d.id);
    const prev = this.clients.get(id);
    const n = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
    const client: ChatClient = {
      id,
      playerId: n(d.westid ?? d.playerId) ?? prev?.playerId ?? 0,
      name: String(d.name ?? d.pname ?? prev?.name ?? '?'),
      level: n(d.level) ?? prev?.level ?? 0,
      townId: n(d.townId ?? d.town_id) ?? prev?.townId ?? 0,
      townRights: n(d.town_rights ?? d.townRights) ?? prev?.townRights ?? 0,
      actioned: n(d.actioned) ?? prev?.actioned ?? 0,
    };
    this.clients.set(id, client);
    return client;
  }

  clientName(id: string): string {
    return this.clients.get(id)?.name ?? '?';
  }

  handle(e: ChatEvent): void {
    this.emit('event', e);
    const p = e.payload;
    switch (e.id) {
      case 'Status':
        if (isObj(p.self)) {
          this.myId = String(p.self.id);
          this.acquireClient(p.self);
          this.emit('self', selfFrom(p.self));
        }
        for (const c of arr(p.clients)) this.acquireClient(c);
        if (Array.isArray(p.rooms)) {
          const seen = new Set<string>();
          for (const r of objs(p.rooms)) {
            if (!isObj(r.roomdescription)) continue;
            const room = this.acquireRoom(r.roomdescription);
            room.members = new Set(arr(r.members).map(String));
            seen.add(room.id);
          }
          for (const id of [...this.rooms.keys()]) if (!seen.has(id)) this.rooms.delete(id);
          this.emit('rooms');
        }
        break;
      case 'ClientJoined': {
        const room = this.rooms.get(String(p.rid));
        this.acquireClient(p.client);
        const joined = obj(p.client);
        if (room && joined.id !== undefined) room.members.add(String(joined.id));
        this.emit('rooms');
        break;
      }
      case 'ClientLeft':
        this.rooms.get(String(p.rid))?.members.delete(String(p.cid));
        this.emit('rooms');
        break;
      case 'TellConfirmed': {
        const to = this.acquireClient(p.to)?.name ?? '?';
        this.addLine(`tell:${to}`, { at: e.t, from: this.clients.get(this.myId ?? '')?.name ?? 'me', text: stripTags(p.message), own: true });
        break;
      }
      case 'TellFailed':
        this.emit('tellFailed');
        break;
      case 'UserUpdate':
        this.acquireClient(p);
        if (this.myId !== null && String(p.id) === this.myId) this.emit('self', selfFrom(p));
        else if (p.id !== undefined) this.emit('rooms');
        break;
      case 'QuestDataChanged':
        this.emit('quests');
        break;
      case 'ReportChanged':
        this.emit('reports', p);
        break;
      case 'ReadState':
        this.emit('read', p);
        break;
      case 'NuggetsChanged':
        this.emit('nuggets', Number(p.nuggets));
        break;
      case 'TellReceived': {
        const from = this.acquireClient(p.from)?.name ?? '?';
        this.addLine(`tell:${from}`, { at: e.t, from, text: stripTags(p.message), own: false });
        this.emit('tell', { from: String(obj(p.from).name ?? '?'), message: String(p.message ?? '') });
        break;
      }
      case 'Text': {
        const cid = String(p.cid ?? '');
        const room = String(p.to ?? '');
        this.addLine(room, { at: e.t, from: this.clientName(cid), text: stripTags(p.message), own: cid === this.myId });
        this.emit('text', { room, cid, message: String(p.message ?? '') });
        break;
      }
      case 'CharDeathStateChanged':
        this.emit('revived', p);
        break;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.pollOnce())) {
          this.running = false;
          break;
        }
      } catch (err) {
        if (!this.running) break;
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        await new Promise((r) => setTimeout(r, this.errorPauseMs));
      }
    }
  }
}
