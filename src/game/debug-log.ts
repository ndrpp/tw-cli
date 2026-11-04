// Debug log: everything the client and the autopilot do, with the data behind it, for the Debug screen (B)
// files in `<config dir>/debug/` (one JSON object per line, one file per UTC hour, `YYYY-MM-DDTHH.jsonl`;
// files older than 24 h are deleted, so the folder keeps one day).
// Categories: log (the log pane), state (character / queue / quest / bag diffs), request (calls and
// errors), autopilot (runner decisions), sim (planner input + output), quest (quest-module decisions).
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type DebugCategory = 'log' | 'state' | 'request' | 'autopilot' | 'sim' | 'quest';
export const DEBUG_CATEGORIES: DebugCategory[] = ['log', 'state', 'request', 'autopilot', 'sim', 'quest'];

export interface DebugEntry { id: number; at: number; cat: DebugCategory; title: string; data?: unknown }

const MAX_ENTRIES = 3000;
/** Planner snapshots are large: only the newest keep their data in memory (the files keep all). */
const SIM_WITH_DATA = 50;
/** How long debug files are kept. */
export const DEBUG_RETENTION_MS = 24 * 3600_000;

/** JSON that survives Maps, Sets, cycles and Infinity. */
export function debugJson(v: unknown, indent?: number): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(v, (_k, x) => {
    if (x instanceof Map) return Object.fromEntries(x);
    if (x instanceof Set) return [...x];
    if (typeof x === 'number' && !Number.isFinite(x)) return String(x);
    if (typeof x === 'bigint') return String(x);
    if (x && typeof x === 'object') {
      if (seen.has(x)) return '[cycle]';
      seen.add(x);
    }
    return x;
  }, indent) ?? 'undefined';
}

export class DebugLog {
  entries: DebugEntry[] = [];
  /** Folder for the hourly files; set by the TUI (tests and CLI commands keep it off). */
  dir: string | null = null;
  private hour = '';
  private nextId = 1;
  /** Last message per dedupe key, so repeated identical decisions (every tick) are logged once. */
  private last = new Map<string, string>();
  private onAdd: () => void;

  constructor(onAdd: () => void = () => {}) {
    this.onAdd = onAdd;
  }

  add(cat: DebugCategory, title: string, data?: unknown): void {
    const e: DebugEntry = { id: this.nextId++, at: Date.now(), cat, title, data };
    this.entries.push(e);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (this.dir) this.write(e);
    if (cat === 'sim') {
      let n = 0;
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const x = this.entries[i]!;
        if (x.cat !== 'sim' || x.data === undefined || typeof x.data === 'string') continue;
        if (++n > SIM_WITH_DATA) x.data = this.dir ? '(dropped from memory; full data in the debug file of that hour)' : '(dropped from memory)';
      }
    }
    this.onAdd();
  }

  /** Logs only when the title differs from the last one under `key` (data, e.g. live energy, is not compared). */
  once(key: string, cat: DebugCategory, title: string, data?: unknown): void {
    if (this.last.get(key) === title) return;
    this.last.set(key, title);
    this.add(cat, title, data);
  }

  clear(): void {
    this.entries = [];
    this.last.clear();
    this.onAdd();
  }

  /** The file the entries of this hour go to (null when the sink is off). */
  get file(): string | null {
    return this.dir ? join(this.dir, `${new Date().toISOString().slice(0, 13)}.jsonl`) : null;
  }

  private write(e: DebugEntry): void {
    const dir = this.dir!;
    try {
      const hour = new Date(e.at).toISOString().slice(0, 13);
      if (hour !== this.hour) {
        this.hour = hour;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        pruneDebugDir(dir, e.at);
      }
      appendFileSync(join(dir, `${hour}.jsonl`), `${debugJson({ ...e, at: new Date(e.at).toISOString() })}\n`, { mode: 0o600 });
    } catch {
      this.dir = null; // a broken sink must not break the game
    }
  }
}

/** Deletes hourly files whose hour ended more than the retention ago. */
export function pruneDebugDir(dir: string, now = Date.now()): string[] {
  const gone: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/);
    if (!m) continue;
    const hourEnd = Date.parse(`${m[1]}:00:00Z`) + 3600_000;
    if (now - hourEnd > DEBUG_RETENTION_MS) {
      unlinkSync(join(dir, f));
      gone.push(f);
    }
  }
  return gone;
}

/** Field-by-field differences between two flat snapshots: [from, to], or { added, removed } for lists. */
export function diffSnapshots(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k];
    const y = b[k];
    if (debugJson(x) === debugJson(y)) continue;
    if (Array.isArray(x) && Array.isArray(y)) {
      const xs = x.map((v) => debugJson(v));
      const ys = y.map((v) => debugJson(v));
      out[k] = { added: y.filter((_, i) => !xs.includes(ys[i]!)), removed: x.filter((_, i) => !ys.includes(xs[i]!)) };
    } else out[k] = [x, y];
  }
  return out;
}
