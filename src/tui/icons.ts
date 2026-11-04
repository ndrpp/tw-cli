// One-cell symbols used across the TUI. Only text-presentation characters (no emoji): emoji are two cells
// wide in most terminals and Ink would misalign columns.
import type { TimelineStep } from '../game/timeline.ts';

export const ICON = {
  job: '⚒',
  walk: '→',
  sleep: '☾',
  bank: '$',
  item: '✚',
  wait: '◷',
  level: '★',
  duel: '⚔',
  quest: '!',
  mail: '✉',
  done: '✓',
  fail: '✘',
  action: '•',
} as const;

/** Icon for a queue task type from the server (job, walk, sleep, duel, …). */
export function taskIcon(type: string): string {
  return type === 'job'
    ? ICON.job
    : type === 'walk'
      ? ICON.walk
      : type === 'sleep'
        ? ICON.sleep
        : /duel/.test(type)
          ? ICON.duel
          : ICON.action;
}

/** Icon for a planned or projected step; `action` tells deposits from item uses. */
export function stepIcon(step: TimelineStep, action?: { type: string }): string {
  if (step.kind !== 'action') return taskIcon(step.kind);
  if (action?.type === 'deposit' || /^Deposit/.test(step.title)) return ICON.bank;
  if (action?.type === 'use' || /^Use /.test(step.title)) return ICON.item;
  return ICON.action;
}
