// Autopilot screen (g a): priority ranking, module toggles and their settings on the left; what the
// autopilot is doing and the projected queue (timeline) on the right. Settings save on every change.

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import type { AutopilotConfig, Goal, ModuleKey, PlannedTask } from '../game/autopilot-config.ts';
import type { GameState } from '../game/state.ts';
import type { ProjectedStep, Timeline } from '../game/timeline.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { formatDuration, money, scrollWindow, shortDuration, truncate } from './format.ts';
import { ICON, stepIcon } from './icons.ts';

const h = React.createElement;

/** Modules that already act; the others are shown but do nothing yet. */
export const BUILT_MODULES = new Set<ModuleKey>([
  'jobs',
  'energySleep',
  'hpSleep',
  'bank',
  'consumables',
  'quests',
  'npcDuels',
]);

const GOAL_LABEL: Record<Goal, string> = {
  quests: 'Quests completed',
  xp: 'Experience',
  money: 'Money',
  products: 'Products (items to sell)',
};

type Row =
  | { kind: 'head'; text: string }
  | { kind: 'goal'; rank: number }
  | { kind: 'scope' }
  | {
      kind: 'toggle';
      label: string;
      indent?: boolean;
      module?: ModuleKey;
      get: (c: AutopilotConfig) => boolean;
      set: (c: AutopilotConfig, v: boolean) => void;
    }
  | {
      kind: 'num';
      label: string;
      get: (c: AutopilotConfig) => number;
      set: (c: AutopilotConfig, v: number) => void;
      step: number;
      min: number;
      max: number;
      fmt: (v: number) => string;
    };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mins = (v: number) => formatDuration(v);
const mod = (module: ModuleKey, label: string): Row => ({
  kind: 'toggle',
  label,
  module,
  get: (c) => c.modules[module],
  set: (c, v) => (c.modules[module] = v),
});
/** A boolean `field` of the config section `section` picks (the field name is checked against it). */
const sub = <F extends PropertyKey>(
  section: (c: AutopilotConfig) => Record<NoInfer<F>, boolean>,
  field: F,
  label: string,
): Row => ({
  kind: 'toggle',
  label,
  indent: true,
  get: (c) => section(c)[field],
  set: (c, v) => (section(c)[field] = v),
});
/** A number `field` of the config section `section` picks (`(c) => c` for top-level settings). */
const num = <F extends PropertyKey>(
  section: (c: AutopilotConfig) => Record<NoInfer<F>, number>,
  field: F,
  label: string,
  step: number,
  min: number,
  max: number,
  fmt: (v: number) => string,
): Row => ({
  kind: 'num',
  label,
  step,
  min,
  max,
  fmt,
  get: (c) => section(c)[field],
  set: (c, v) => (section(c)[field] = v),
});

export const ROWS: [Row, ...Row[]] = [
  { kind: 'head', text: 'Priority (J K reorder)' },
  { kind: 'goal', rank: 0 },
  { kind: 'goal', rank: 1 },
  { kind: 'goal', rank: 2 },
  { kind: 'goal', rank: 3 },
  {
    kind: 'toggle',
    label: 'Best per hour (off: per energy)',
    get: (c) => c.per === 'time',
    set: (c, v) => (c.per = v ? 'time' : 'energy'),
  },
  { kind: 'head', text: 'Modules (Space toggles · ← → change values)' },
  mod('jobs', 'Queue jobs'),
  mod('energySleep', 'Sleep when out of energy'),
  sub((c) => c.wake, 'levelUp', 'wake: enough to level up'),
  sub((c) => c.wake, 'stretch', 'wake: enough for the next stretch'),
  sub((c) => c.wake, 'hpSafe', 'wake: HP safe'),
  sub((c) => c.wake, 'full', 'wake: full'),
  num((c) => c, 'ownTownWithin', 'own-town hotel / bank within', 900, 0, 6 * 3600, mins),
  mod('hpSleep', 'Sleep or heal when HP is low'),
  num((c) => c.hp, 'sleepBelow', 'below', 0.05, 0.05, 0.95, pct),
  num((c) => c.hp, 'wakeAbove', 'get up at', 0.05, 0.1, 1, pct),
  mod('consumables', 'Use consumables'),
  sub((c) => c.consumables, 'energy', 'energy'),
  sub((c) => c.consumables, 'health', 'health'),
  sub((c) => c.consumables, 'motivation', 'motivation'),
  num((c) => c.consumables, 'reserve', 'keep in reserve', 1, 0, 20, String),
  mod('bank', 'Bank cash'),
  num((c) => c.bank, 'above', 'when cash over', 500, 500, 100_000, money),
  num((c) => c.bank, 'maxDetour', 'max detour', 300, 0, 4 * 3600, mins),
  { kind: 'scope' },
  mod('quests', 'Do quests'),
  sub((c) => c.quests, 'repeatable', 'repeatable quests'),
  sub((c) => c.quests, 'unfinishable', 'also quests it cannot finish'),
  sub((c) => c.quests, 'buy', 'buy items no job drops (shops, mobile trader)'),
  num((c) => c.quests, 'buyLimit', 'buy limit per quest', 500, 0, 1_000_000, money),
  sub((c) => c.quests, 'market', 'also the market (instant buy, picked up there)'),
  num((c) => c.quests, 'marketLimit', 'market limit per quest', 500, 0, 1_000_000, money),
  num((c) => c.quests, 'buyTrip', 'furthest walk to a shop / market town', 900, 0, 6 * 3600, mins),
  num((c) => c.quests, 'walkValue', 'a minute of walking is worth', 5, 0, 10_000, money),
  mod('npcDuels', 'NPC duels (never players)'),
  sub((c) => c.duels, 'forXp', 'also for XP when worth it'),
  num(
    (c) => c.duels,
    'levelMargin',
    'NPC level vs duel level',
    1,
    -20,
    10,
    (v) => (v > 0 ? `+${v}` : String(v)),
  ),
  { kind: 'head', text: 'Replanning & limits' },
  num((c) => c, 'slotCost', 'cost per queue slot (TUI not always open)', 300, 0, 4 * 3600, mins),
  num((c) => c.cancel, 'margin', 'cancel tasks when plan better by', 0.05, 0, 1, pct),
  num((c) => c.cancel, 'horizon', 'plan ahead / compare over', 3600, 3600, 48 * 3600, mins),
  num((c) => c.cancel, 'cooldown', 'between cancels', 300, 0, 4 * 3600, mins),
  num((c) => c.spend, 'daily', 'daily spend cap', 100, 0, 1_000_000, money),
  mod('dryRun', 'Dry run (plan only, send nothing)'),
];

const selectable = (r: Row | undefined) => !!r && r.kind !== 'head';

export function AutopilotScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [sel, setSel] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const cfg = state.autopilot.config;
  const idx = selectable(ROWS[sel]) ? sel : 1;
  const cur = ROWS[idx] ?? ROWS[0];
  const move = (dir: 1 | -1) => {
    for (let j = idx + dir; j >= 0 && j < ROWS.length; j += dir) if (selectable(ROWS[j])) return setSel(j);
  };
  const edit = (fn: (c: AutopilotConfig) => void) => state.updateAutopilot((f) => fn(f.config));

  useInput(
    (input, key) => {
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
        edit((c) => {
          const from = c.priority[cur.rank];
          const toValue = c.priority[to];
          if (from === undefined || toValue === undefined) return;
          c.priority[cur.rank] = toValue;
          c.priority[to] = from;
        });
        return setSel(idx + (to - cur.rank));
      }
      if (cur.kind === 'scope' && (input === ' ' || key.return))
        return state.updateAutopilot((f) => (f.rules.onlyQuests = []));
      if (cur.kind === 'toggle' && (input === ' ' || key.return)) return edit((c) => cur.set(c, !cur.get(c)));
      if (cur.kind === 'num' && (key.leftArrow || key.rightArrow || input === '+' || input === '-')) {
        const d = key.rightArrow || input === '+' ? cur.step : -cur.step;
        return edit((c) => cur.set(c, Math.round(Math.min(cur.max, Math.max(cur.min, cur.get(c) + d)) * 1000) / 1000));
      }
    },
    { isActive: active && !expanded },
  );

  if (expanded) return h(QueueView, { state, width, height, active, onCapture, onClose: () => setExpanded(false) });

  const leftW = Math.max(34, Math.floor(width * 0.45));
  const rightW = width - leftW;
  const [start, end] = scrollWindow(idx, ROWS.length, Math.max(2, height - 3));
  const left = h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    h(
      Text,
      { bold: true, wrap: 'truncate' },
      'Autopilot ',
      cfg.running ? h(Text, { color: 'green' }, '● running') : h(Text, { color: 'yellow' }, '‖ paused'),
    ),
    ...ROWS.slice(start, end).map((r, i) => {
      const n = start + i;
      const inv = n === idx;
      if (r.kind === 'head') return h(Text, { key: n, bold: true, color: 'yellow', wrap: 'truncate' }, r.text);
      if (r.kind === 'scope') {
        const count = state.autopilot.rules.onlyQuests.length;
        return h(
          Text,
          { key: n, inverse: inv, wrap: 'truncate' },
          `     Quests goal: ${count ? `only the route's ${count} quest(s) (Space: all)` : 'all open quests'}`,
        );
      }
      if (r.kind === 'goal') {
        const priority = cfg.priority[r.rank];
        return h(
          Text,
          { key: n, inverse: inv, wrap: 'truncate' },
          ` ${r.rank + 1} ${priority ? GOAL_LABEL[priority] : ''}`,
        );
      }
      if (r.kind === 'num')
        return h(Text, { key: n, inverse: inv, wrap: 'truncate' }, `     ${r.label}: ${r.fmt(r.get(cfg))}`);
      const soon =
        r.module && r.module !== 'dryRun' && !BUILT_MODULES.has(r.module)
          ? h(Text, { dimColor: true }, ' (not built yet)')
          : '';
      return h(
        Text,
        { key: n, inverse: inv, wrap: 'truncate' },
        `${r.indent ? '     ' : ' '}[${r.get(cfg) ? 'x' : ' '}] ${r.label}`,
        soon,
      );
    }),
  );
  return h(Box, { width, height }, left, h(PlanPane, { state, width: rightW, height }));
}

/** One line of the plan pane: a step, back-to-back runs of one job merged, or a wait for energy. */
export interface PlanRow {
  icon: string;
  title: string;
  why?: string | undefined;
  fixed: boolean;
  wait?: boolean;
  levelUp: boolean;
  /** Same key on consecutive rows: merged into one ("×3"). */
  key?: string | undefined;
  count: number;
  step?: ProjectedStep;
  xp: number;
  money: number;
  energyBefore: number;
  energy: number;
  end: number;
}

/** The timeline as plan rows: waits for energy become rows, repeated runs of a job merge. */
export function planRows(tl: Timeline, tasks: PlannedTask[]): PlanRow[] {
  const fixedN = tl.steps.length - tasks.length;
  const rows: PlanRow[] = [];
  tl.steps.forEach((s, i) => {
    const fixed = i < fixedN;
    const task = fixed ? undefined : tasks[i - fixedN];
    const st = s.step;
    if (s.waited >= 60) {
      rows.push({
        icon: ICON.wait,
        title: `wait ${shortDuration(s.waited)} for energy`,
        fixed,
        wait: true,
        levelUp: false,
        count: 1,
        xp: 0,
        money: 0,
        energyBefore: 0,
        energy: 0,
        end: s.start,
      });
    }
    const key = st.kind === 'job' ? `${fixed}:${st.jobId}:${st.duration}` : undefined;
    const last = rows[rows.length - 1];
    if (key && last?.key === key && s.travel < 60 && s.waited < 60) {
      last.count++;
      last.xp += st.kind === 'job' ? st.xp : 0;
      last.money += st.kind === 'job' ? st.money : 0;
      last.energy = s.energy;
      last.levelUp ||= s.levelUp;
      last.end = s.end;
      return;
    }
    rows.push({
      icon: stepIcon(st, task?.action),
      title: st.title,
      why: task?.why,
      fixed,
      levelUp: s.levelUp,
      key,
      count: 1,
      step: s,
      xp: st.kind === 'job' ? st.xp : 0,
      money: st.kind === 'job' ? st.money : 0,
      energyBefore: s.energyBefore,
      energy: s.energy,
      end: s.end,
    });
  });
  return rows;
}

const ICON_COLOR: Record<string, string> = {
  [ICON.job]: 'green',
  [ICON.walk]: 'cyan',
  [ICON.sleep]: 'blue',
  [ICON.bank]: 'yellow',
  [ICON.item]: 'magenta',
  [ICON.duel]: 'red',
};
const GOAL_SHORT: Record<Goal, string> = { quests: 'Quests', xp: 'XP', money: 'Money', products: 'Products' };

/** Title and right-hand column of a plan row. */
function rowText(r: PlanRow, now: number): { title: string; info: string } {
  const s = r.step;
  if (!s) return { title: r.title, info: '' };
  const st = s.step;
  const walk = s.travel >= 60 && st.kind !== 'walk' ? `${ICON.walk}${shortDuration(s.travel)} ` : '';
  const en = `E ${Math.floor(r.energyBefore)}→${Math.floor(r.energy)}`;
  const eta = r.fixed ? ` · ${r.end - now <= 0 ? 'done' : `${shortDuration(r.end - now)} left`}` : '';
  switch (st.kind) {
    case 'job': {
      const len = shortDuration(st.duration);
      const title = r.count > 1 ? `${st.title} ×${r.count} (${len} each)` : `${st.title} (${len})`;
      return { title, info: `${walk}+${r.xp}xp ${money(r.money)}${r.fixed ? eta : ` ${en}`}` };
    }
    case 'sleep':
      return {
        title: st.title,
        info: `${walk}${shortDuration(s.end - s.start)}${st.cost ? ` ${money(st.cost)}` : ''}${r.fixed ? eta : ` ${en}`}`,
      };
    case 'walk':
      return { title: st.title, info: `${shortDuration(s.end - s.depart)} walk${eta}` };
    case 'action': {
      const parts = [
        st.cash ? money(Math.abs(st.cash)) : '',
        st.energy ? `+${Math.round(st.energy)}E` : '',
        st.health ? `+${Math.round(st.health)}HP` : '',
      ].filter(Boolean);
      return { title: st.title, info: `${walk}${parts.join(' ')}${eta}` };
    }
  }
}

/**
 * The plan for an end user: status, goals, what the plan earns, then the queue and the planned steps, each
 * with why the autopilot picked it. Repeated runs merge; waits for energy are their own rows.
 */
function PlanPane({ state, width, height }: { state: GameState; width: number; height: number }) {
  const plan = state.runner.plan;
  const tl = plan?.timeline ?? state.timeline();
  const cfg = state.autopilot.config;
  const now = state.clock.now();
  const c = state.character;
  const status = !plan
    ? h(Text, { dimColor: true }, 'planning…')
    : cfg.running
      ? cfg.modules.dryRun
        ? h(Text, { color: 'yellow' }, '● dry run · plans only, sends nothing')
        : h(Text, { color: 'green' }, '● running')
      : h(Text, { color: 'yellow' }, '‖ paused · this is what it would do');
  const only = state.autopilot.rules.onlyQuests.length;
  const goals = cfg.priority
    .map((g) => (g === 'quests' && only ? `Quests (${only} on route)` : GOAL_SHORT[g]))
    .join(' › ');
  const lvl = tl.steps.find((s) => s.levelUp);
  // Job pay only: gained.money also counts deposits as money gone.
  const earned = tl.steps.reduce((a, s) => a + (s.step.kind === 'job' ? s.step.money : 0), 0);
  const head: React.ReactNode[] = [
    h(Text, { key: 'st', bold: true, wrap: 'truncate' }, 'Plan  ', status),
    h(
      Text,
      { key: 'g', wrap: 'truncate' },
      h(Text, { dimColor: true }, 'Goals  '),
      goals,
      h(Text, { dimColor: true }, ` · best per ${cfg.per === 'energy' ? 'energy' : 'hour'}`),
    ),
    h(
      Text,
      { key: 'tot', wrap: 'truncate' },
      h(Text, { dimColor: true }, 'Gains  '),
      tl.steps.length
        ? `${shortDuration(Math.max(0, tl.end - now))} · +${Math.round(tl.gained.xp).toLocaleString('en-US')} XP · +${money(earned)}`
        : 'nothing planned',
      lvl
        ? h(
            Text,
            { color: 'yellow' },
            ` · ${ICON.level} level ${lvl.level} in ${shortDuration(Math.max(0, lvl.end - now))}`,
          )
        : '',
    ),
    h(
      Text,
      { key: 'now', wrap: 'truncate' },
      h(Text, { dimColor: true }, 'Now    '),
      `E ${c.energy}/${c.maxEnergy} · HP ${c.health}/${c.maxHealth} · ${money(c.cash)} · spent ${money(state.autopilot.spent.amount)}/${money(cfg.spend.daily)}`,
    ),
    h(Text, { key: 'sp' }, ' '),
  ];
  const rows = planRows(tl, plan?.tasks ?? []);
  const texts = rows.map((r) => rowText(r, now));
  const infoW = Math.min(Math.floor(width / 2), Math.max(0, ...texts.map((t) => t.info.length)));
  const titleW = Math.max(8, width - 4 - 8 - infoW);
  // Border, key line and the "+N more" line stay free.
  const room = Math.max(1, height - 4 - head.length);
  const body: React.ReactNode[] = [];
  let n = 0;
  let section: boolean | null = null;
  let shown = 0;
  let lastWhy: string | undefined;
  for (const [i, r] of rows.entries()) {
    // A reason shared with the row above (walk + deposit) is shown once.
    const why = r.why && r.why !== lastWhy ? r.why : undefined;
    const need = (section !== r.fixed ? 1 : 0) + 1 + (why ? 1 : 0);
    if (body.length + need > room) break;
    if (section !== r.fixed) {
      section = r.fixed;
      body.push(h(Text, { key: `h${i}`, bold: true, color: 'cyan' }, r.fixed ? 'In the queue' : 'Planned'));
    }
    const t = texts[i];
    if (!t) continue;
    const mark = r.fixed ? (i === 0 ? '▶ ' : '  ') : r.wait ? '  ' : String(++n).padStart(2);
    body.push(
      h(
        Text,
        defined({ key: `r${i}`, wrap: 'truncate', dimColor: r.wait }),
        h(Text, defined({ color: r.fixed && i === 0 ? 'green' : undefined, dimColor: !r.fixed }), mark),
        ' ',
        h(Text, defined({ color: ICON_COLOR[r.icon] }), r.icon),
        ' ',
        h(Text, { bold: !r.fixed && n === 1 && !r.wait }, truncate(t.title, titleW)),
        ' ',
        h(Text, { dimColor: true }, t.info.slice(0, infoW).padStart(infoW)),
        r.levelUp ? h(Text, { color: 'yellow' }, ` ${ICON.level}`) : '',
      ),
    );
    if (why) body.push(h(Text, { key: `w${i}`, dimColor: true, italic: true, wrap: 'truncate' }, `      ${why}`));
    if (!r.wait) lastWhy = r.why;
    shown++;
  }
  if (shown < rows.length)
    body.push(h(Text, { key: 'more', dimColor: true }, `  +${rows.length - shown} more · Q full queue`));
  if (!rows.length) body.push(h(Text, { key: 'idle', dimColor: true }, 'Idle'));
  if (plan && !plan.tasks.length) body.push(h(Text, { key: 'none', color: 'yellow', wrap: 'wrap' }, plan.why));
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, height, paddingX: 1 },
    ...head,
    ...body,
    h(Box, { flexGrow: 1 }),
    h(
      Text,
      { dimColor: true, wrap: 'truncate' },
      'Space toggle · ← → value · J K rank · Q queue · R run/pause · X stop · Esc back',
    ),
  );
}

/**
 * Full queue (Q): server tasks then planned ones, with ETA, energy/HP after, XP, $. The plan is recomputed from
 * inputs, so edits are rules: d excludes a planned job (or removes an inserted row), s / b insert a sleep / bank
 * stop at a row's time, J K move an inserted row, c cancels a server task.
 */
function QueueView({
  state,
  width,
  height,
  active,
  onCapture,
  onClose,
}: {
  state: GameState;
  width: number;
  height: number;
  active: boolean;
  onCapture: (c: boolean) => void;
  onClose: () => void;
}) {
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

  useInput(
    (input, key) => {
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
      if (input === 'd' && ins)
        return state.updateAutopilot(
          (f) => (f.rules.inserts = f.rules.inserts.filter((x) => !(x.kind === ins.kind && x.at === ins.at))),
        );
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
        state.updateAutopilot(
          (f) =>
            (f.rules.inserts = f.rules.inserts.map((x) => (x.kind === ins.kind && x.at === ins.at ? { ...x, at } : x))),
        );
        return setSel(idx + (input === 'J' ? 1 : -1));
      }
    },
    { isActive: active },
  );

  const nameW = Math.max(10, width - 62);
  const [start, end] = scrollWindow(idx, tl.steps.length, Math.max(2, height - 5));
  const head = `${'    '}${'Task'.padEnd(nameW - 2)} ${'ETA'.padStart(8)} ${'travel'.padStart(7)} ${'EN'.padStart(4)} ${'HP'.padStart(5)} ${'XP'.padStart(6)} ${'$'.padStart(6)}  by`;
  const lines = tl.steps.slice(start, end).map((st, j) => {
    const i = start + j;
    const t = i >= fixedN ? plan?.tasks[i - fixedN] : undefined;
    const xp = st.step.kind === 'job' ? `+${st.step.xp}` : st.levelUp ? '★' : '';
    const cash =
      st.step.kind === 'job'
        ? `+${st.step.money}`
        : st.step.kind === 'action' && st.step.cash
          ? String(Math.round(st.step.cash))
          : '';
    const by = i < fixedN ? 'queued' : insertAt(t?.key) ? 'you' : (t?.module ?? '');
    return h(
      Text,
      defined({
        key: i,
        inverse: i === idx,
        dimColor: i >= fixedN && i !== idx,
        color: st.levelUp ? 'yellow' : undefined,
        wrap: 'truncate',
      }),
      `${i < fixedN ? '▪' : '·'} ${stepIcon(st.step, t?.action)} ${truncate(st.step.title, nameW - 2).padEnd(nameW - 2)} ${formatDuration(Math.max(0, st.end - now)).padStart(8)} ${(st.travel ? formatDuration(st.travel) : '').padStart(7)} ${String(Math.floor(st.energy)).padStart(4)} ${String(Math.floor(st.health)).padStart(5)} ${xp.padStart(6)} ${cash.padStart(6)}  ${by}${st.levelUp ? ' ★ level up' : ''}`,
    );
  });
  const keys =
    confirm !== null
      ? h(Text, { color: 'yellow', wrap: 'truncate' }, `Cancel "${tl.steps[confirm]?.step.title}" on the server? y / n`)
      : h(
          Text,
          { dimColor: true, wrap: 'truncate' },
          `c cancel (queued) · d exclude job / remove insert · s b insert sleep / bank here · J K move insert · ${rules.excludedJobs.length ? `u clear ${rules.excludedJobs.length} exclusion(s) · ` : ''}Esc back`,
        );
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width, height, paddingX: 1 },
    h(
      Text,
      { bold: true, wrap: 'truncate' },
      `Queue & plan · ${fixedN} queued · ${tl.steps.length - fixedN} planned · ends in ${formatDuration(Math.max(0, tl.end - now))} · +${Math.round(tl.gained.xp)} XP · ${money(Math.round(tl.gained.money))}`,
    ),
    h(Text, { dimColor: true, wrap: 'truncate' }, head),
    ...lines,
    h(Box, { flexGrow: 1 }),
    task?.why ? h(Text, { dimColor: true, wrap: 'truncate' }, `why: ${task.why}`) : null,
    keys,
  );
}
