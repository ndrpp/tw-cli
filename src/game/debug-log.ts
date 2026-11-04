// Debug log: everything the client and the autopilot do, with the data behind it, for the Debug screen (g x)
// files in `<config dir>/debug/` (one JSON object per line, one file per UTC hour, `YYYY-MM-DDTHH.jsonl`;
// files older than 24 h are deleted, so the folder keeps one day).
// Categories: log (the log pane), state (character / queue / quest / bag diffs), request (calls and
// errors), autopilot (runner decisions), sim (planner input + output), quest (quest-module decisions).
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type DebugCategory = 'log' | 'state' | 'request' | 'autopilot' | 'sim' | 'quest';
export const DEBUG_CATEGORIES: DebugCategory[] = ['log', 'state', 'request', 'autopilot', 'sim', 'quest'];

export interface DebugEntry {
  id: number;
  at: number;
  cat: DebugCategory;
  title: string;
  data?: unknown;
}

const MAX_ENTRIES = 3000;
/** Planner snapshots are large: only the newest keep their data in memory (the files keep all). */
const SIM_WITH_DATA = 50;
/** How long debug files are kept. */
export const DEBUG_RETENTION_MS = 24 * 3600_000;

/** Plain data for JSON: Maps → objects, Sets → arrays, Infinity / bigint → strings; only true cycles are cut. */
function plain(xCoord: unknown, ancestors: Set<object>): unknown {
  if (typeof xCoord === 'number') {
    return Number.isFinite(xCoord) ? xCoord : String(xCoord);
  }
  if (typeof xCoord === 'bigint') {
    return String(xCoord);
  }
  if (!xCoord || typeof xCoord !== 'object') {
    return xCoord;
  }
  if (ancestors.has(xCoord)) {
    return '[cycle]';
  }
  ancestors.add(xCoord);
  try {
    if (typeof (xCoord as { toJSON?: unknown }).toJSON === 'function') {
      return (xCoord as { toJSON(): unknown }).toJSON();
    }
    if (xCoord instanceof Map) {
      return Object.fromEntries(
        [...xCoord].map(([entryKey, currentValue]) => [String(entryKey), plain(currentValue, ancestors)]),
      );
    }
    if (xCoord instanceof Set || Array.isArray(xCoord)) {
      return [...xCoord].map((currentValue) => plain(currentValue, ancestors));
    }
    return Object.fromEntries(
      Object.entries(xCoord).map(([entryKey, currentValue]) => [entryKey, plain(currentValue, ancestors)]),
    );
  } finally {
    ancestors.delete(xCoord);
  }
}

/** JSON that survives Maps, Sets, cycles and Infinity; an object seen twice (not a cycle) is written twice. */
export function debugJson(currentValue: unknown, indent?: number): string {
  return JSON.stringify(plain(currentValue, new Set()), null, indent) ?? 'undefined';
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
    const currentTime: DebugEntry = { id: this.nextId++, at: Date.now(), cat, title, data };
    this.entries.push(currentTime);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    if (this.dir) {
      this.write(currentTime);
    }
    if (cat === 'sim') {
      let count = 0;
      for (let index = this.entries.length - 1; index >= 0; index--) {
        const entry = this.entries[index];
        if (!entry) {
          continue;
        }
        if (entry.cat !== 'sim' || entry.data === undefined || typeof entry.data === 'string') {
          continue;
        }
        if (++count > SIM_WITH_DATA) {
          entry.data = this.dir
            ? '(dropped from memory; full data in the debug file of that hour)'
            : '(dropped from memory)';
        }
      }
    }
    this.onAdd();
  }

  /** Logs only when the title differs from the last one under `key` (data, e.g. live energy, is not compared). */
  once(key: string, cat: DebugCategory, title: string, data?: unknown): void {
    if (this.last.get(key) === title) {
      return;
    }
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

  private write(entry: DebugEntry): void {
    const dir = this.dir;
    if (!dir) {
      return;
    }
    try {
      const hour = new Date(entry.at).toISOString().slice(0, 13);
      if (hour !== this.hour) {
        this.hour = hour;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        pruneDebugDir(dir, entry.at);
      }
      appendFileSync(join(dir, `${hour}.jsonl`), `${debugJson({ ...entry, at: new Date(entry.at).toISOString() })}\n`, {
        mode: 0o600,
      });
    } catch {
      this.dir = null; // a broken sink must not break the game
    }
  }
}

/** Deletes hourly files whose hour ended more than the retention ago. */
export function pruneDebugDir(dir: string, now = Date.now()): string[] {
  const gone: string[] = [];
  for (const text of readdirSync(dir)) {
    const match = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/);
    if (!match) {
      continue;
    }
    const hourEnd = Date.parse(`${match[1]}:00:00Z`) + 3600_000;
    if (now - hourEnd > DEBUG_RETENTION_MS) {
      unlinkSync(join(dir, text));
      gone.push(text);
    }
  }
  return gone;
}

/** Field-by-field differences between two flat snapshots: [from, to], or { added, removed } for lists. */
export function diffSnapshots(from: Record<string, unknown>, to: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const fromValue = from[key];
    const toValue = to[key];
    if (debugJson(fromValue) === debugJson(toValue)) {
      continue;
    }
    if (Array.isArray(fromValue) && Array.isArray(toValue)) {
      const fromItems = fromValue.map((currentValue) => debugJson(currentValue));
      const toItems = toValue.map((currentValue) => debugJson(currentValue));
      out[key] = {
        added: toValue.filter((_, index) => {
          const value = toItems[index];
          return value === undefined || !fromItems.includes(value);
        }),
        removed: fromValue.filter((_, index) => {
          const value = fromItems[index];
          return value === undefined || !toItems.includes(value);
        }),
      };
    } else {
      out[key] = [fromValue, toValue];
    }
  }
  return out;
}
