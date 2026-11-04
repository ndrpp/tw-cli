// Detects that the process was frozen (machine slept / laptop lid closed): a timer that should fire
// every `intervalMs` sees a much larger wall-clock gap. After that the session, server clock offset,
// live long-poll and task queue are all stale, so the caller rebuilds everything.

export interface WakeOptions {
  /** How often to check (ms). */
  intervalMs?: number;
  /** A gap above this counts as a sleep (ms). */
  gapMs?: number;
  now?: () => number;
}

export class WakeDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: number;
  private readonly intervalMs: number;
  private readonly gapMs: number;
  private readonly now: () => number;
  private readonly onWake: (sleptMs: number) => void;

  constructor(onWake: (sleptMs: number) => void, opts: WakeOptions = {}) {
    this.onWake = onWake;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.gapMs = opts.gapMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.last = this.now();
  }

  /** One check; returns the gap when it counted as a wake (exposed for tests). */
  check(): number | null {
    const time = this.now();
    const gap = time - this.last;
    this.last = time;
    if (gap > this.gapMs) {
      this.onWake(gap);
      return gap;
    }
    return null;
  }

  start(): this {
    this.last = this.now();
    this.timer ??= setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
