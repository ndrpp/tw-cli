// XP/h and $/h as measured, not planned: samples of total XP and money (cash + bank) over time, the way a
// player would read them off the header. Pure: the caller passes the time and values (GameState.tick).
// Money is net: purchases, fees and duel losses count against it; deposits and withdrawals do not.

export interface RateSample { t: number; xp: number; money: number }

export interface Rates {
  xpH: number;
  moneyH: number;
  /** Seconds the rate is measured over (the window, or the session when shorter). */
  span: number;
}

/** Keep one sample a minute; enough for a rolling hour without growing without bound. */
const SAMPLE_S = 60;
/** Shorter spans swing too much to show (one job report is the whole rate). */
const MIN_SPAN_S = 300;

export class RateTracker {
  readonly samples: RateSample[] = [];
  first: RateSample | null = null;
  /** Jobs finished this session (counted as the queue head ends). */
  jobsDone = 0;
  /** The last task that finished (end in server s): "idle for", the home screen's "done" line. */
  lastTask: { title: string; type: string; end: number } | null = null;

  private keepS: number;

  constructor(keepS = 2 * 3600) {
    this.keepS = keepS;
  }

  record(t: number, xp: number, money: number): void {
    const s = { t, xp, money };
    this.first ??= s;
    const last = this.samples[this.samples.length - 1];
    if (last && t - last.t < SAMPLE_S) return;
    this.samples.push(s);
    while (this.samples.length > 2 && this.samples[1]!.t <= t - this.keepS) this.samples.shift();
  }

  /** Rates over the last `windowS` up to `now` with the current values; null until MIN_SPAN_S of data. */
  rates(now: number, xp: number, money: number, windowS = 3600): Rates | null {
    // The newest sample at or before the window start, else the oldest kept.
    let base = this.samples[0];
    for (const s of this.samples) if (s.t <= now - windowS) base = s;
    if (!base) return null;
    const span = now - base.t;
    if (span < MIN_SPAN_S) return null;
    return { xpH: ((xp - base.xp) * 3600) / span, moneyH: ((money - base.money) * 3600) / span, span };
  }
}
