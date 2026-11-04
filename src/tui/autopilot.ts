// Autopilot screen (G): priority ranking, module toggles and their settings on the left; what the
// autopilot is doing and the projected queue (timeline) on the right. Settings save on every change.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AutopilotConfig, Goal, ModuleKey } from '../game/autopilot-config.ts';
import type { GameState } from '../game/state.ts';
import type { ScreenProps } from './character.ts';
import { formatDuration, money, scrollWindow, truncate } from './format.ts';

const h = React.createElement;

/** Modules that already act; the others are shown but do nothing yet. */
export const BUILT_MODULES = new Set<ModuleKey>(['jobs', 'energySleep', 'hpSleep', 'bank', 'consumables', 'quests', 'npcDuels']);

const GOAL_LABEL: Record<Goal, string> = { quests: 'Quests completed', xp: 'Experience', money: 'Money', products: 'Products (items to sell)' };

type Row =
  | { kind: 'head'; text: string }
  | { kind: 'goal'; rank: number }
  | { kind: 'scope' }
  | { kind: 'toggle'; label: string; indent?: boolean; module?: ModuleKey; get: (c: AutopilotConfig) => boolean; set: (c: AutopilotConfig, v: boolean) => void }
  | { kind: 'num'; label: string; get: (c: AutopilotConfig) => number; set: (c: AutopilotConfig, v: number) => void; step: number; min: number; max: number; fmt: (v: number) => string };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mins = (v: number) => formatDuration(v);
const mod = (module: ModuleKey, label: string): Row => ({ kind: 'toggle', label, module, get: (c) => c.modules[module], set: (c, v) => (c.modules[module] = v) });
const sub = <K extends keyof AutopilotConfig>(key: K, field: keyof AutopilotConfig[K] & string, label: string): Row => ({
  kind: 'toggle', label, indent: true,
  get: (c) => !!(c[key] as any)[field],
  set: (c, v) => ((c[key] as any)[field] = v),
});
const num = <K extends keyof AutopilotConfig>(key: K, field: (keyof AutopilotConfig[K] & string) | null, label: string, step: number, min: number, max: number, fmt: (v: number) => string): Row => ({
  kind: 'num', label, step, min, max, fmt,
  get: (c) => Number(field ? (c[key] as any)[field] : c[key]),
  set: (c, v) => (field ? ((c[key] as any)[field] = v) : ((c as any)[key] = v)),
});

export const ROWS: Row[] = [
  { kind: 'head', text: 'Priority (J K reorder)' },
  { kind: 'goal', rank: 0 }, { kind: 'goal', rank: 1 }, { kind: 'goal', rank: 2 }, { kind: 'goal', rank: 3 },
  { kind: 'toggle', label: 'Best per hour (off: per energy)', get: (c) => c.per === 'time', set: (c, v) => (c.per = v ? 'time' : 'energy') },
  { kind: 'head', text: 'Modules (Space toggles · ← → change values)' },
  mod('jobs', 'Queue jobs'),
  mod('energySleep', 'Sleep when out of energy'),
  sub('wake', 'levelUp', 'wake: enough to level up'),
  sub('wake', 'stretch', 'wake: enough for the next stretch'),
  sub('wake', 'hpSafe', 'wake: HP safe'),
  sub('wake', 'full', 'wake: full'),
  num('ownTownWithin', null, 'own-town hotel / bank within', 900, 0, 6 * 3600, mins),
  mod('hpSleep', 'Sleep or heal when HP is low'),
  num('hp', 'sleepBelow', 'below', 0.05, 0.05, 0.95, pct),
  num('hp', 'wakeAbove', 'get up at', 0.05, 0.1, 1, pct),
  mod('consumables', 'Use consumables'),
  sub('consumables', 'energy', 'energy'),
  sub('consumables', 'health', 'health'),
  sub('consumables', 'motivation', 'motivation'),
  num('consumables', 'reserve', 'keep in reserve', 1, 0, 20, String),
  mod('bank', 'Bank cash'),
  num('bank', 'above', 'when cash over', 500, 500, 100_000, money),
  num('bank', 'maxDetour', 'max detour', 300, 0, 4 * 3600, mins),
  { kind: 'scope' },
  mod('quests', 'Do quests'),
  sub('quests', 'repeatable', 'repeatable quests'),
  sub('quests', 'unfinishable', 'also quests it cannot finish'),
  mod('npcDuels', 'NPC duels (never players)'),
  sub('duels', 'forXp', 'also for XP when worth it'),
  num('duels', 'levelMargin', 'NPC level vs duel level', 1, -20, 10, (v) => (v > 0 ? `+${v}` : String(v))),
  { kind: 'head', text: 'Replanning & limits' },
  num('slotCost', null, 'cost per queue slot (TUI not always open)', 300, 0, 4 * 3600, mins),
  num('cancel', 'margin', 'cancel tasks when plan better by', 0.05, 0, 1, pct),
  num('cancel', 'horizon', 'plan ahead / compare over', 3600, 3600, 48 * 3600, mins),
  num('cancel', 'cooldown', 'between cancels', 300, 0, 4 * 3600, mins),
  num('spend', 'daily', 'daily spend cap', 100, 0, 1_000_000, money),
  mod('dryRun', 'Dry run (plan only, send nothing)'),
];

const selectable = (r: Row | undefined) => !!r && r.kind !== 'head';

export function AutopilotScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [sel, setSel] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const cfg = state.autopilot.config;
  const idx = selectable(ROWS[sel]) ? sel : 1;
  const cur = ROWS[idx]!;
  const move = (dir: 1 | -1) => {
    for (let j = idx + dir; j >= 0 && j < ROWS.length; j += dir) if (selectable(ROWS[j])) return setSel(j);
  };
  const edit = (fn: (c: AutopilotConfig) => void) => state.updateAutopilot((f) => fn(f.config));

  useInput((input, key) => {
    if (input === 'Q') return setExpanded(true);
    if (key.escape) return onExit();
    if (key.upArrow || input === 'k') return move(-1);
    if (key.downArrow || input === 'j') return move(1);
    if (input === 'R') {
      edit((c) => (c.running = !c.running));
      return state.info(cfg.running ? 'Autopilot running.' : 'Autopilot paused.');
    }
    if (input === 'X') {
      state.updateAutopilot((f) => {
        f.config.running = false;
        f.plan = null;
      });
      state.runner.plan = null;
      return state.info('Autopilot stopped: planned tasks cleared (rules kept).');
    }
    if (cur.kind === 'goal' && (input === 'J' || input === 'K')) {
      const to = cur.rank + (input === 'J' ? 1 : -1);
      if (to < 0 || to >= cfg.priority.length) return;
      edit((c) => ([c.priority[cur.rank], c.priority[to]] = [c.priority[to]!, c.priority[cur.rank]!]));
      return setSel(idx + (to - cur.rank));
    }
    if (cur.kind === 'scope' && (input === ' ' || key.return)) return state.updateAutopilot((f) => (f.rules.onlyQuests = []));
    if (cur.kind === 'toggle' && (input === ' ' || key.return)) return edit((c) => cur.set(c, !cur.get(c)));
    if (cur.kind === 'num' && (key.leftArrow || key.rightArrow || input === '+' || input === '-')) {
      const d = key.rightArrow || input === '+' ? cur.step : -cur.step;
      return edit((c) => cur.set(c, Math.round(Math.min(cur.max, Math.max(cur.min, cur.get(c) + d)) * 1000) / 1000));
    }
  }, { isActive: active && !expanded });

  if (expanded) return h(QueueView, { state, width, height, active, onCapture, onClose: () => setExpanded(false) });

  const leftW = Math.max(34, Math.floor(width * 0.45));
  const rightW = width - leftW;
  const [start, end] = scrollWindow(idx, ROWS.length, Math.max(2, height - 3));
  const left = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, 'Autopilot ', cfg.running ? h(Text, { color: 'green' }, '● running') : h(Text, { color: 'yellow' }, '‖ paused')),
    ...ROWS.slice(start, end).map((r, i) => {
      const n = start + i;
      const inv = n === idx;
      if (r.kind === 'head') return h(Text, { key: n, bold: true, color: 'yellow', wrap: 'truncate' }, r.text);
      if (r.kind === 'scope') {
        const n = state.autopilot.rules.onlyQuests.length;
        return h(Text, { key: n, inverse: inv, wrap: 'truncate' }, `     Quests goal: ${n ? `only the route's ${n} quest(s) (Space: all)` : 'all open quests'}`);
      }
      if (r.kind === 'goal') return h(Text, { key: n, inverse: inv, wrap: 'truncate' }, ` ${r.rank + 1} ${GOAL_LABEL[cfg.priority[r.rank]!]}`);
      if (r.kind === 'num') return h(Text, { key: n, inverse: inv, wrap: 'truncate' }, `     ${r.label}: ${r.fmt(r.get(cfg))}`);
      const soon = r.module && r.module !== 'dryRun' && !BUILT_MODULES.has(r.module) ? h(Text, { dimColor: true }, ' (not built yet)') : '';
      return h(Text, { key: n, inverse: inv, wrap: 'truncate' }, `${r.indent ? '     ' : ' '}[${r.get(cfg) ? 'x' : ' '}] ${r.label}`, soon);
    }),
  );
  return h(Box, { width, height }, left, h(NowPane, { state, width: rightW, height }));
}

/** What the autopilot is doing, then the projected queue: ETA, energy after, XP, level-ups. */
function NowPane({ state, width, height }: { state: GameState; width: number; height: number }) {
  const runner = state.runner;
  const plan = runner.plan;
  const tl = plan?.timeline ?? state.timeline();
  const cfg = state.autopilot.config;
  const why = !plan ? 'Planning…' : `${cfg.running ? (cfg.modules.dryRun ? 'Dry run: ' : 'Next: ') : 'Paused, would do: '}${plan.why}`;
  const now = state.clock.now();
  const c = state.character;
  const lines: React.ReactNode[] = [
    h(Text, { key: 'now', bold: true }, 'Now'),
    h(Text, { key: 'why', color: cfg.running ? 'green' : 'yellow', wrap: 'wrap' }, why),
    h(Text, { key: 'spent', dimColor: true, wrap: 'truncate' }, `Spent today ${money(state.autopilot.spent.amount)} of ${money(cfg.spend.daily)}`),
    h(Text, { key: 'cash', wrap: 'truncate' }, `Cash ${money(c.cash)} / bank at ${money(state.autopilot.config.bank.above)}`),
    h(Text, { key: 'sp' }, ' '),
    h(Text, { key: 'q', bold: true, wrap: 'truncate' }, `Queue · ends in ${formatDuration(Math.max(0, tl.end - now))} · +${Math.round(tl.gained.xp)} XP · ${money(Math.round(tl.gained.money))}${tl.gained.levels ? ` · ★ ${tl.gained.levels} level-up` : ''}`),
  ];
  if (!tl.steps.length) lines.push(h(Text, { key: 'idle', dimColor: true }, 'Idle'));
  const nameW = Math.max(8, width - 36);
  for (const [i, s] of tl.steps.slice(0, Math.max(0, height - 9)).entries()) {
    const xp = s.step.kind === 'job' ? `+${s.step.xp}xp` : '';
    const planned = !s.step.fixed;
    lines.push(h(Text, { key: `s${i}`, color: i === 0 ? 'green' : undefined, dimColor: planned, wrap: 'truncate' },
      `${i === 0 ? '▶' : planned ? '·' : ' '} ${truncate(s.step.title, nameW).padEnd(nameW)} ${formatDuration(Math.max(0, s.end - now)).padStart(8)} ${String(Math.floor(s.energy)).padStart(3)}E ${xp.padStart(7)}`,
      s.levelUp ? h(Text, { color: 'yellow' }, ' ★') : ''));
  }
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, height, paddingX: 1 },
    ...lines, h(Box, { flexGrow: 1 }),
    h(Text, { dimColor: true, wrap: 'truncate' }, 'Space toggle · ← → value · J K rank · Q queue · R run/pause · X stop · Esc back'));
}

/**
 * Full queue (Q): server tasks then planned ones, with ETA, energy/HP after, XP, $. The plan is recomputed from
 * inputs, so edits are rules: d excludes a planned job (or removes an inserted row), s / b insert a sleep / bank
 * stop at a row's time, J K move an inserted row, c cancels a server task.
 */
function QueueView({ state, width, height, active, onCapture, onClose }: { state: GameState; width: number; height: number; active: boolean; onCapture: (c: boolean) => void; onClose: () => void }) {
  const [sel, setSel] = useState(0);
  const [confirm, setConfirm] = useState<number | null>(null);
  // Own all keys while open: global shortcuts (s sleep, u refresh, …) would take the queue view's.
  useEffect(() => {
    onCapture(true);
    return () => onCapture(false);
  }, []);
  const plan = state.runner.plan;
  const tl = plan?.timeline ?? state.timeline();
  const fixedN = tl.steps.length - (plan?.tasks.length ?? 0);
  const idx = Math.min(sel, Math.max(0, tl.steps.length - 1));
  const row = tl.steps[idx];
  const task = idx >= fixedN ? plan?.tasks[idx - fixedN] : undefined;
  const rules = state.autopilot.rules;
  const now = state.clock.now();
  const insertAt = (key?: string) => {
    const m = key?.match(/^insert:(sleep|bank):(\d+(?:\.\d+)?)$/);
    return m ? { kind: m[1] as 'sleep' | 'bank', at: Number(m[2]) } : null;
  };

  useInput((input, key) => {
    if (confirm !== null) {
      setConfirm(null);
      if (input === 'y') void state.cancel(confirm);
      return;
    }
    if (key.escape || input === 'Q') return onClose();
    if (key.upArrow || input === 'k') return setSel(Math.max(0, idx - 1));
    if (key.downArrow || input === 'j') return setSel(Math.min(tl.steps.length - 1, idx + 1));
    if (!row) return;
    if (input === 'c' && idx < fixedN) return setConfirm(idx);
    const ins = insertAt(task?.key);
    if (input === 'd' && ins) return state.updateAutopilot((f) => (f.rules.inserts = f.rules.inserts.filter((x) => !(x.kind === ins.kind && x.at === ins.at))));
    if (input === 'd' && task?.step.kind === 'job') {
      const jobId = task.step.jobId;
      state.updateAutopilot((f) => (f.rules.excludedJobs = [...new Set([...f.rules.excludedJobs, jobId])]));
      return state.info(`Autopilot: ${task.step.title} excluded from plans (u in the queue view clears exclusions).`);
    }
    if (input === 'u' && rules.excludedJobs.length) {
      state.updateAutopilot((f) => (f.rules.excludedJobs = []));
      return state.info('Autopilot: job exclusions cleared.');
    }
    if (input === 's' || input === 'b') {
      const at = Math.max(now, row.depart);
      return state.updateAutopilot((f) => f.rules.inserts.push({ at, kind: input === 's' ? 'sleep' : 'bank' }));
    }
    if ((input === 'J' || input === 'K') && ins) {
      const other = tl.steps[idx + (input === 'J' ? 1 : -1)];
      if (!other) return;
      const at = input === 'J' ? other.end : Math.max(now, other.depart - 1);
      state.updateAutopilot((f) => (f.rules.inserts = f.rules.inserts.map((x) => (x.kind === ins.kind && x.at === ins.at ? { ...x, at } : x))));
      return setSel(idx + (input === 'J' ? 1 : -1));
    }
  }, { isActive: active });

  const nameW = Math.max(10, width - 62);
  const [start, end] = scrollWindow(idx, tl.steps.length, Math.max(2, height - 5));
  const head = `${'  '}${'Task'.padEnd(nameW)} ${'ETA'.padStart(8)} ${'travel'.padStart(7)} ${'EN'.padStart(4)} ${'HP'.padStart(5)} ${'XP'.padStart(6)} ${'$'.padStart(6)}  by`;
  const lines = tl.steps.slice(start, end).map((st, j) => {
    const i = start + j;
    const t = i >= fixedN ? plan?.tasks[i - fixedN] : undefined;
    const xp = st.step.kind === 'job' ? `+${st.step.xp}` : st.levelUp ? '★' : '';
    const cash = st.step.kind === 'job' ? `+${st.step.money}` : st.step.kind === 'action' && st.step.cash ? String(Math.round(st.step.cash)) : '';
    const by = i < fixedN ? 'queued' : insertAt(t?.key) ? 'you' : t?.module ?? '';
    return h(Text, { key: i, inverse: i === idx, dimColor: i >= fixedN && i !== idx, color: st.levelUp ? 'yellow' : undefined, wrap: 'truncate' },
      `${i < fixedN ? '▪' : '·'} ${truncate(st.step.title, nameW).padEnd(nameW)} ${formatDuration(Math.max(0, st.end - now)).padStart(8)} ${(st.travel ? formatDuration(st.travel) : '').padStart(7)} ${String(Math.floor(st.energy)).padStart(4)} ${String(Math.floor(st.health)).padStart(5)} ${xp.padStart(6)} ${cash.padStart(6)}  ${by}${st.levelUp ? ' ★ level up' : ''}`);
  });
  const keys = confirm !== null
    ? h(Text, { color: 'yellow', wrap: 'truncate' }, `Cancel "${tl.steps[confirm]?.step.title}" on the server? y / n`)
    : h(Text, { dimColor: true, wrap: 'truncate' }, `c cancel (queued) · d exclude job / remove insert · s b insert sleep / bank here · J K move insert · ${rules.excludedJobs.length ? `u clear ${rules.excludedJobs.length} exclusion(s) · ` : ''}Esc back`);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, `Queue & plan · ${fixedN} queued · ${tl.steps.length - fixedN} planned · ends in ${formatDuration(Math.max(0, tl.end - now))} · +${Math.round(tl.gained.xp)} XP · ${money(Math.round(tl.gained.money))}`),
    h(Text, { dimColor: true, wrap: 'truncate' }, head),
    ...lines,
    h(Box, { flexGrow: 1 }),
    task?.why ? h(Text, { dimColor: true, wrap: 'truncate' }, `why: ${task.why}`) : null,
    keys);
}
