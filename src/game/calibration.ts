// Calibration: what the autopilot learns from your own game instead of guessing (calibration.json in the
// config dir). Job reports give item drops per job and duration; the health the server reports after a
// dangerous job gives the real HP loss; job motivation read over time gives the drop per run and the
// recovery per hour; a cancelled sleep gives the hotel room's real energy rate; level-ups show whether they
// refill energy. The planner blends each with its prior (the game's numbers or the old heuristic) by how
// many samples there are.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';
import { entries, isObj, mergeDefaults, obj } from '../util/json.ts';

export const CALIBRATION_FILE = () => join(CONFIG_DIR, 'calibration.json');

/** Prior strength: how many observed runs / samples it takes to count as much as the game's own number. */
export const PRIOR_RUNS = 5;

export interface CalibrationData {
  /** `${jobId}:${duration key}` → runs seen in reports and items found per base item id. */
  drops: Record<string, { runs: number; found: Record<string, number> }>;
  /** Dangerous runs: summed predicted (heuristic) and observed HP loss. */
  hp: { runs: number; predicted: number; observed: number };
  /** Normal-equation sums for Δmotivation = −perRun · runs + perHour · hours (least squares). */
  motivation: { n: number; rr: number; rh: number; hh: number; rd: number; hd: number };
  /** Sleeps cancelled by the autopilot: observed energy rate ÷ the rate read from the hotel (energy / 100). */
  rooms: { n: number; ratio: number };
  levelUps: { seen: number; refilled: number };
}

const EMPTY: CalibrationData = {
  drops: {},
  hp: { runs: 0, predicted: 0, observed: 0 },
  motivation: { n: 0, rr: 0, rh: 0, hh: 0, rd: 0, hd: 0 },
  rooms: { n: 0, ratio: 0 },
  levelUps: { seen: 0, refilled: 0 },
};

export class Calibration {
  data: CalibrationData;
  private file: string | null;

  constructor(file: string | null = CALIBRATION_FILE(), data?: CalibrationData) {
    this.file = file;
    this.data = data ?? (file ? Calibration.load(file) : structuredClone(EMPTY));
  }

  static load(file: string): CalibrationData {
    try {
      const raw = obj(JSON.parse(readFileSync(file, 'utf8')));
      const drops = entries(raw.drops)
        .filter(([, d]) => isObj(d))
        .map(([key, d]) => {
          const found = entries(obj(d).found).map(([id, n]): [string, number] => [id, Number(n) || 0]);
          return [key, { runs: Number(obj(d).runs) || 0, found: Object.fromEntries(found) }] as const;
        });
      return { ...mergeDefaults(EMPTY, raw), drops: Object.fromEntries(drops) };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch {
      /* learning only */
    }
  }

  // ---- recording -------------------------------------------------------------------------------

  /** One job report: the job, its duration key and the items found ([itemId, count]). */
  addJobRun(jobId: number, duration: string, items: [number, number][]): void {
    const k = `${jobId}:${duration}`;
    const existing = this.data.drops[k];
    const d = existing ?? { runs: 0, found: {} };
    if (!existing) this.data.drops[k] = d;
    d.runs++;
    for (const [id, n] of items) {
      const base = String(Math.floor(id / 1000));
      d.found[base] = (d.found[base] ?? 0) + n;
    }
    this.save();
  }

  addHp(predicted: number, observed: number): void {
    this.data.hp.runs++;
    this.data.hp.predicted += predicted;
    this.data.hp.observed += Math.max(0, observed);
    this.save();
  }

  /** A job's motivation moved by `delta` (fraction) over `hours` with `runs` runs done meanwhile (not capped at 100 %). */
  addMotivation(runs: number, hours: number, delta: number): void {
    const m = this.data.motivation;
    m.n++;
    m.rr += runs * runs;
    m.rh += runs * hours;
    m.hh += hours * hours;
    m.rd += runs * -delta;
    m.hd += hours * -delta;
    this.save();
  }

  addRoom(ratio: number): void {
    const r = this.data.rooms;
    r.ratio = (r.ratio * r.n + ratio) / (r.n + 1);
    r.n++;
    this.save();
  }

  addLevelUp(refilled: boolean): void {
    this.data.levelUps.seen++;
    if (refilled) this.data.levelUps.refilled++;
    this.save();
  }

  // ---- estimates -------------------------------------------------------------------------------

  /** Expected items per run, the game's number blended with what reports showed. */
  dropRate(jobId: number, duration: string, itemId: number, prior: number): number {
    const d = this.data.drops[`${jobId}:${duration}`];
    if (!d?.runs) return prior;
    const found = d.found[String(Math.floor(itemId / 1000))] ?? 0;
    return (found + prior * PRIOR_RUNS) / (d.runs + PRIOR_RUNS);
  }

  /** Multiplier for the danger → HP heuristic (1 until dangerous runs were seen). */
  get hpScale(): number {
    const h = this.data.hp;
    if (!h.runs || h.predicted <= 0) return 1;
    const prior = (h.predicted / h.runs) * PRIOR_RUNS; // PRIOR_RUNS runs exactly as predicted
    return (h.observed + prior) / (h.predicted + prior);
  }

  /**
   * Motivation lost per run and recovered per hour (fractions). The default (2 % per run, no recovery) holds
   * until 3 samples; solved by least squares, clamped to sane ranges.
   */
  get motivation(): { perRun: number; perHour: number; samples: number } {
    const m = this.data.motivation;
    const det = m.rr * m.hh - m.rh * m.rh;
    if (m.n < 3 || Math.abs(det) < 1e-9) return { perRun: 0.02, perHour: 0, samples: m.n };
    // drop = perRun · runs − perHour · hours; normal equations [rr −rh; −rh hh]·[a b] = [rd −hd].
    const perRun = (m.rd * m.hh - m.rh * m.hd) / det;
    const perHour = (m.rh * m.rd - m.rr * m.hd) / det;
    return { perRun: Math.min(0.2, Math.max(0, perRun)), perHour: Math.min(0.5, Math.max(0, perHour)), samples: m.n };
  }

  /** Hotel energy rate multiplier: measured sleeps blended with 1 (the hotel's number read as % per hour). */
  get roomScale(): number {
    const r = this.data.rooms;
    return (r.ratio * r.n + 1) / (r.n + 1);
  }

  /** Summary for the debug log and screen. */
  summary(): Record<string, unknown> {
    const runs = Object.values(this.data.drops).reduce((a, d) => a + d.runs, 0);
    return {
      jobReports: runs,
      jobKinds: Object.keys(this.data.drops).length,
      hpScale: this.hpScale,
      hpRuns: this.data.hp.runs,
      motivation: this.motivation,
      roomScale: this.roomScale,
      roomSamples: this.data.rooms.n,
      levelUps: this.data.levelUps,
    };
  }
}
