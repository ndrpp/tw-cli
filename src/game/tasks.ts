// Task queue, mirroring TaskQueue (tw2game @694568) and Task/TaskFactory (@681020–@686063).
//  add:    task/add     {tasks: {<queuePos>: task.post}}   post = ctor fields + taskType
//          job:  {jobId, x, y, duration, taskType:'job'}
//          walk: {unitId, type, x, y, taskType:'walk'}
//          sleep:{town_id, room, taskType:'sleep'}
//          build:{x, y, building_key, duration, deposit:'town'|'player', taskType:'build'} (town construction)
//          reply: {tasks: {<queuePos>: {task?, error?, msg?}}, energy?, buffs?, protection?}
//  cancel: task/cancel  {tasks: {<queuePos>: {queueId, type}}}
//          reply: {tasks: {<queuePos>: {extra?, error?, msg?}}, queue: [...]}
//  list:   task/get_tasks (mode) → {queue: [...]}
// Queue entries: {queue_id, date_start, date_done (epoch s), type, data|data_obj:{coords, wayData?, ...}}
import type { GameClient } from '../http/game-client.ts';
import type { FormValue } from '../http/form.ts';
import type { Position } from './character.ts';

export interface TaskWay {
  queueId: number;
  start: number; // epoch s
  end: number;
  to: Position;
}

export interface QueuedTask {
  queueId: number;
  type: string;
  start: number; // epoch s
  end: number;
  coords: Position;
  title: string;
  jobId?: number;
  way?: TaskWay;
  raw: Record<string, any>;
}

export function parseQueueEntry(t: Record<string, any>): QueuedTask {
  const data = t.data_obj ?? t.data ?? {};
  let way: TaskWay | undefined;
  if (data.wayData) {
    const w = data.wayData;
    const wd = w.data_obj ?? w.data ?? {};
    way = { queueId: w.queue_id, start: w.date_start, end: w.date_done, to: { x: wd.coords?.x ?? 0, y: wd.coords?.y ?? 0 } };
  }
  return {
    queueId: t.queue_id,
    type: t.type,
    start: t.date_start,
    end: t.date_done,
    coords: { x: data.coords?.x ?? 0, y: data.coords?.y ?? 0 },
    title: data.title ?? data.town_name ?? data.name ?? t.type,
    jobId: data.job_id,
    way,
    raw: t,
  };
}

export function parseQueue(list: unknown): QueuedTask[] {
  return Array.isArray(list) ? list.map(parseQueueEntry) : [];
}

export type TaskPost =
  | { taskType: 'job'; jobId: number; x: number; y: number; duration: number }
  | { taskType: 'walk'; unitId: number; type: string; x?: number; y?: number }
  | { taskType: 'sleep'; town_id: number; room: string }
  | { taskType: 'build'; x: number; y: number; building_key: string; duration: number; deposit: 'town' | 'player' };

/** Same key order as the browser's post objects (ctor fields first, taskType appended). */
export function jobPost(jobId: number, at: Position, duration: number): Record<string, FormValue> {
  return { jobId, x: at.x, y: at.y, duration, taskType: 'job' };
}

export function walkPost(unitId: number | string | null, type: string, at?: Position): Record<string, FormValue> {
  return { unitId, type, x: at?.x, y: at?.y, taskType: 'walk' };
}

export function sleepPost(townId: number, room: string): Record<string, FormValue> {
  return { town_id: townId, room, taskType: 'sleep' };
}

export interface AddResult {
  added: QueuedTask[];
  errors: string[];
  energy?: number;
}

export class TaskLimitError extends Error {}

export class TaskApi {
  private client: GameClient;

  constructor(client: GameClient) {
    this.client = client;
  }

  async list(): Promise<QueuedTask[]> {
    const json = await this.client.remoteCallMode('task', 'get_tasks');
    if (json.error) throw new Error(json.msg ?? 'task/get_tasks failed');
    return parseQueue(json.queue);
  }

  /**
   * Adds tasks behind the current queue. Positions continue from queueLength, exactly as the
   * browser keys them (post.tasks[queuePos]).
   */
  async add(queueLength: number, posts: Record<string, FormValue>[], limit: number): Promise<AddResult> {
    const room = limit - queueLength;
    if (room <= 0) throw new TaskLimitError(`Task queue is full (${queueLength}/${limit})`);
    const batch = posts.slice(0, room);
    const tasks: Record<string, FormValue> = {};
    batch.forEach((p, i) => (tasks[String(queueLength + i)] = p));
    const json = await this.client.remoteCall('task', 'add', { tasks });
    const result: AddResult = { added: [], errors: [] };
    for (const [, q] of Object.entries<any>(json.tasks ?? {})) {
      if (q?.task) result.added.push(parseQueueEntry(q.task));
      if (q?.error) result.errors.push(q.msg ?? String(q.error));
    }
    if (json.error && json.msg) result.errors.push(json.msg);
    if (json.energy !== undefined) result.energy = json.energy;
    return result;
  }

  /** Cancels tasks by queue position. Returns the server's new queue. */
  async cancel(queue: QueuedTask[], positions: number[]): Promise<{ queue: QueuedTask[]; errors: string[]; energy?: number; money?: number }> {
    const tasks: Record<string, FormValue> = {};
    for (const pos of positions) {
      const t = queue[pos];
      if (t?.queueId) tasks[String(pos)] = { queueId: t.queueId, type: t.type };
    }
    const json = await this.client.remoteCall('task', 'cancel', { tasks });
    const errors: string[] = [];
    let energy: number | undefined;
    let money: number | undefined;
    for (const [, q] of Object.entries<any>(json.tasks ?? {})) {
      if (q?.error) errors.push(q.msg ?? String(q.error));
      if (q?.extra?.energy !== undefined) energy = q.extra.energy;
      if (q?.extra?.money !== undefined) money = q.extra.money;
    }
    return { queue: parseQueue(json.queue), errors, energy, money };
  }
}

/** Seconds of walking still ahead for a task (its wayData leg), from `now`. */
export function walkLeft(t: QueuedTask, now: number): number {
  if (!t.way) return 0;
  return Math.max(0, t.way.end - Math.max(now, t.way.start));
}

/** Seconds of the task itself (excluding its walk) still ahead, from `now`. */
export function workLeft(t: QueuedTask, now: number): number {
  return Math.max(0, t.end - Math.max(now, t.start));
}

export interface QueueSummary {
  /** Epoch s when the last task is done. */
  doneAt: number;
  /** Seconds until then. */
  left: number;
  /** Seconds of that which is walking (wayData legs plus walk tasks). */
  walk: number;
}

export function queueSummary(queue: QueuedTask[], now: number): QueueSummary | null {
  if (!queue.length) return null;
  const doneAt = Math.max(...queue.map((t) => t.end));
  const walk = queue.reduce((s, t) => s + walkLeft(t, now) + (t.type === 'walk' ? workLeft(t, now) : 0), 0);
  return { doneAt, left: Math.max(0, doneAt - now), walk };
}
