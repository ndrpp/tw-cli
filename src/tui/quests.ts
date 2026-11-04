// Quests screen: quest log (accepted quests) and quest givers (saloon + a giver opened from the map).
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { GameState } from '../game/state.ts';
import { groupByChain, type Quest, type QuestChain } from '../game/quests.ts';
import { formatDuration, money, scrollWindow, shortDuration, truncate } from './format.ts';
import type { RouteObjective, RoutePlan } from '../game/route.ts';
import type { ScreenProps } from './character.ts';

const h = React.createElement;

type List = 'log' | 'givers';
type Confirm = { kind: 'finish'; quest: Quest; choice: number } | { kind: 'cancel'; quest: Quest } | { kind: 'route'; plan: RoutePlan } | null;
type RouteScope = 'quest' | 'chain' | 'all';
const SCOPE_LABEL: Record<RouteScope, string> = { quest: 'this quest', chain: 'this chain', all: 'all quests' };
const DURATION_LABEL = { short: '15 s', middle: '10 min', long: '1 h' } as const;

/** Compact estimate for a list row: "~2h10", "~2h10+?" when some need can't come from jobs, "" when nothing to do. */
export function estimateTag(plan: RoutePlan | undefined): string {
  if (!plan || (!plan.stops.length && !plan.unmet.length)) return '';
  if (!plan.stops.length) return '?';
  return `~${shortDuration(plan.totals.seconds)}${plan.unmet.length ? '+?' : ''}`;
}

interface Row { kind: 'quest'; quest: Quest; tag?: string }
interface ChainRow { kind: 'chain'; chain: QuestChain; indent: boolean }
interface GiverRow { kind: 'giver'; key: string; name: string; at: { x: number; y: number } | null }

function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + ' ' + word).trim().length > width) {
        if (line) out.push(line);
        line = word;
      } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}

export function QuestsScreen({ state, width, height, onCapture, onExit, startOnGivers, onShowOnMap, active = true }: ScreenProps & { startOnGivers?: boolean; onShowOnMap?: (at: { x: number; y: number }) => void }) {
  const [list, setList] = useState<List>(startOnGivers ? 'givers' : 'log');
  const [sel, setSel] = useState(0);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [scroll, setScroll] = useState(0);
  const [route, setRoute] = useState<{ scope: RouteScope; objective: RouteObjective } | null>(null);

  useEffect(() => {
    void (async () => {
      await state.loadItems();
      if (!state.saloon.length) await state.loadSaloon();
    })();
  }, [state]);
  useEffect(() => {
    onCapture(!!confirm);
  }, [confirm]);

  type AnyRow = GiverRow | Row | ChainRow;
  const chained = (quests: Quest[], indent: boolean, tag?: (q: Quest) => string): AnyRow[] =>
    groupByChain(quests).flatMap((chain) => [
      { kind: 'chain', chain, indent } as ChainRow,
      ...chain.quests.map((quest) => ({ kind: 'quest', quest, tag: tag?.(quest) }) as Row),
    ]);
  const logRows = chained(state.quests, false);
  const giverRows: AnyRow[] = [];
  const emp = state.employer;
  if (emp) {
    giverRows.push({ kind: 'giver', key: emp.key, name: `▾ ${emp.name}`, at: emp.x !== null ? { x: emp.x, y: emp.y! } : null });
    giverRows.push(...chained(emp.open, true, (q) => (q.accepted ? 'accepted' : q.acceptable ? 'new' : 'locked')));
  }
  for (const s of state.saloon) if (s.key !== emp?.key) giverRows.push({ kind: 'giver', key: s.key, name: `${s.name} (saloon)`, at: null });
  const rows: AnyRow[] = list === 'log' ? logRows : giverRows;
  // Chain headers are labels: the cursor always lands on a quest or giver row.
  const selectable = (i: number) => rows[i] !== undefined && rows[i]!.kind !== 'chain';
  const nearestSelectable = (i: number, dir: 1 | -1): number => {
    for (let j = i; j >= 0 && j < rows.length; j += dir) if (selectable(j)) return j;
    for (let j = i; j >= 0 && j < rows.length; j -= dir) if (selectable(j)) return j;
    return 0;
  };
  const idx = nearestSelectable(Math.min(sel, Math.max(0, rows.length - 1)), 1);
  const cur = rows[idx];
  const quest = cur?.kind === 'quest' ? cur.quest : undefined;
  const routeQuests = route ? state.routeQuests(route.scope, quest?.accepted ? quest : undefined) : [];
  const plan = route ? state.planQuestRoute(routeQuests, route.objective) : null;
  // Time estimates per quest and per chain: the same plan the route planner would make (per energy).
  const estimates = useMemo(() => {
    const byQuest = new Map<number, RoutePlan>();
    const byChain = new Map<string, RoutePlan>();
    if (!state.jobs.length) return { byQuest, byChain };
    const all = [...state.quests, ...(state.employer?.open ?? [])];
    for (const q of all) if (!q.finishable && !byQuest.has(q.id)) byQuest.set(q.id, state.planQuestRoute([q]));
    for (const c of groupByChain(state.quests)) byChain.set(`${c.groupId}:${c.title}`, state.planQuestRoute(c.quests.filter((q) => !q.finishable)));
    return { byQuest, byChain };
  }, [state, state.quests, state.employer, state.jobs, state.inventory.bag.size, state.queue.length]);

  useInput((input, key) => {
    if (confirm) {
      // Reward choice (quest.rewardOptions): ← → or the option number, then y.
      if (confirm.kind === 'finish' && confirm.quest.rewardOptions.length > 1) {
        const n = confirm.quest.rewardOptions.length;
        if (key.leftArrow || input === 'h') return setConfirm({ ...confirm, choice: (confirm.choice + n - 1) % n });
        if (key.rightArrow || input === 'l' || key.tab) return setConfirm({ ...confirm, choice: (confirm.choice + 1) % n });
        const d = Number(input);
        if (Number.isInteger(d) && d >= 1 && d <= n) return setConfirm({ ...confirm, choice: d - 1 });
      }
      setConfirm(null);
      if (confirm.kind === 'route' && input === 'a') return state.startAutopilotForQuests(routeQuests.map((q) => q.id), route ? SCOPE_LABEL[route.scope] : 'route');
      if (input !== 'y') return;
      if (confirm.kind === 'route') void state.queueRoute(confirm.plan);
      else if (confirm.kind === 'finish') void state.finishQuest(confirm.quest, confirm.quest.rewardOptions[confirm.choice]?.id);
      else void state.cancelQuest(confirm.quest);
      return;
    }
    if (route) {
      if (key.escape || input === 'R') return setRoute(null);
      if (input === '1') return setRoute({ ...route, scope: 'quest' });
      if (input === '2') return setRoute({ ...route, scope: 'chain' });
      if (input === '3') return setRoute({ ...route, scope: 'all' });
      if (input === 'e') return setRoute({ ...route, objective: route.objective === 'energy' ? 'time' : 'energy' });
      if (input === 'J') return setScroll((s) => s + 3);
      if (input === 'K') return setScroll((s) => Math.max(0, s - 3));
      if (input === 'x' && state.autoRoute) return state.stopAutoRoute();
      if (!plan?.stops.length) return;
      if (key.return) return setConfirm({ kind: 'route', plan });
      if (input === 'g') {
        const at = state.highlightRoute(plan, `route: ${SCOPE_LABEL[route.scope]}`);
        if (at) {
          state.info(`Route jobs marked with ! on the map (${plan.stops.length} stops).`);
          onShowOnMap?.(at);
        }
      }
      return;
    }
    if (key.escape) return onExit();
    if (input === 'R') {
      if (!state.quests.length) return state.error('No accepted quests to plan for.');
      setScroll(0);
      return setRoute({ scope: quest?.accepted && !quest.finishable ? 'quest' : 'all', objective: 'energy' });
    }
    if (key.tab) {
      setSel(0);
      setScroll(0);
      return setList((l) => (l === 'log' ? 'givers' : 'log'));
    }
    const step = key.pageUp || key.pageDown ? 10 : 1;
    if (key.upArrow || input === 'k' || key.pageUp) {
      setScroll(0);
      return setSel(nearestSelectable(Math.max(0, idx - step), -1));
    }
    if (key.downArrow || input === 'j' || key.pageDown) {
      setScroll(0);
      return setSel(nearestSelectable(Math.min(rows.length - 1, idx + step), 1));
    }
    if (input === 'J') return setScroll((s) => s + 3);
    if (input === 'K') return setScroll((s) => Math.max(0, s - 3));
    if (cur?.kind === 'giver' && key.return) return void state.openEmployer(cur.key, cur.at).then(() => setSel(0));
    if (cur?.kind === 'giver' && input === 'w' && cur.at) return void state.walkToQuestGiver(cur.key, cur.name, cur.at);
    if (!quest) return;
    if (input === 'a') {
      if (quest.accepted) return state.error('Already accepted.');
      return void state.acceptQuest(quest);
    }
    if (key.return || input === 'f') {
      if (!quest.accepted && list === 'givers') return void state.acceptQuest(quest);
      if (!quest.finishable) return state.error('Not finished yet: ' + quest.requirements.filter((r) => !r.solved).map((r) => r.info).join('; '));
      return setConfirm({ kind: 'finish', quest, choice: 0 });
    }
    if (input === 'x' && quest.accepted) return setConfirm({ kind: 'cancel', quest });
    if (input === 'g') {
      const at = state.highlightQuest(quest);
      if (!at) return state.error('No job on the map provides what this quest still needs.');
      state.info(`Marked ${state.mapHighlight!.jobIds.size} job(s) for "${quest.title}" with ! on the map.`);
      return onShowOnMap?.(at);
    }
    if (input === 'w' && quest.employerAt) return void state.walkToQuestGiver(quest.employer, quest.employerName, quest.employerAt);
  }, { isActive: active });

  const leftW = Math.max(30, Math.floor(width * 0.42));
  const rightW = width - leftW;
  const listRows = Math.max(2, height - 3);
  const [start, end] = scrollWindow(idx, rows.length, listRows);
  const tabs = (['log', 'givers'] as List[]).map((l) =>
    h(Text, { key: l, inverse: list === l, bold: list === l, color: list === l ? 'cyan' : undefined },
      l === 'log' ? ` Quest log ${state.quests.length}/${state.questCapacity || '?'} ` : ' Quest givers '));
  const left = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    h(Text, { wrap: 'truncate' }, ...tabs, h(Text, { dimColor: true }, ' Tab')),
    ...rows.slice(start, end).map((r, i) => {
      const n = start + i;
      if (r.kind === 'chain') {
        const c = r.chain;
        return h(Text, { key: `c${n}`, bold: true, color: 'yellow', wrap: 'truncate' },
          truncate(`${r.indent ? '  ' : ''}${c.title}`, leftW - 14),
          h(Text, { dimColor: true, bold: false }, ` ${c.quests.length}`),
          c.finishable ? h(Text, { color: 'green' }, ` ✔${c.finishable}`) : '',
          r.indent ? '' : h(Text, { color: 'cyan', bold: false }, ` ${estimateTag(estimates.byChain.get(`${c.groupId}:${c.title}`))}`));
      }
      if (r.kind === 'giver') return h(Text, { key: `g${r.key}`, inverse: n === idx, color: 'magenta', bold: r.name.startsWith('▾'), wrap: 'truncate' }, truncate(r.name, leftW - 4));
      const q = r.quest;
      const mark = q.finishable ? '✔' : q.accepted ? '·' : r.tag === 'new' ? '!' : ' ';
      const est = q.finishable ? '' : estimateTag(estimates.byQuest.get(q.id));
      const titleW = leftW - 10 - (est ? est.length + 1 : 0);
      return h(Text, { key: q.id, inverse: n === idx, wrap: 'truncate', color: q.finishable ? 'green' : r.tag === 'locked' ? 'gray' : undefined },
        `${list === 'givers' ? '    ' : '  '}${mark} ${truncate(q.soloTitle || q.title, titleW).padEnd(titleW)}`,
        est ? h(Text, { color: 'cyan' }, ` ${est}`) : '');
    }),
    rows.length === 0 ? h(Text, { dimColor: true }, list === 'log' ? 'No accepted quests.' : 'Loading saloon… (or open a quest giver from the map: o)') : null,
  );

  let detailLines: React.ReactNode[] = [];
  if (route && plan) {
    detailLines = routeLines(state, plan, route, routeQuests.length, rightW - 4, height - 3, scroll);
  } else if (quest) {
    const dw = Math.max(10, rightW - 4);
    const info: React.ReactNode[] = [
      h(Text, { key: 't', bold: true, wrap: 'truncate' }, quest.soloTitle || quest.title),
      h(Text, { key: 'g', color: 'yellow', wrap: 'truncate' }, quest.group),
      h(Text, { key: 'e', dimColor: true, wrap: 'truncate' }, `${quest.employerName || quest.employer}${quest.employerAt ? ` · at ${quest.employerAt.x},${quest.employerAt.y} · ${formatDuration(state.travelTo(quest.employerAt))}` : ''}`),
      ...(quest.limited ? [h(Text, { key: 'l', color: 'yellow', wrap: 'truncate' }, quest.limited)] : []),
      ...estimateLines(estimates.byQuest.get(quest.id), quest.finishable),
      h(Text, { key: 'rq', bold: true }, 'Requirements'),
      ...quest.requirements.flatMap((r, i) => {
        const row = h(Text, { key: `r${i}`, color: r.solved ? 'green' : 'red', wrap: 'truncate' }, `${r.solved ? '✔' : '✘'} ${r.info}`);
        if (r.solved) return [row];
        // Where to get it: jobs that drop the item (or the job itself), nearest first.
        const src = state.requirementSources(r).sort((a, b) => (a.way ?? Infinity) - (b.way ?? Infinity));
        const have = r.itemId !== undefined ? state.inventory.countBase(r.itemId) : 0;
        const extra = [];
        if (have) extra.push(h(Text, { key: `h${i}`, dimColor: true, wrap: 'truncate' }, `    in bag: ${have}`));
        for (const s of src.slice(0, 3)) {
          const ok = s.job.jobPoints >= s.job.workPoints;
          extra.push(h(Text, { key: `s${i}-${s.job.id}`, color: ok ? 'magentaBright' : 'gray', wrap: 'truncate' },
            `    ↳ ${s.job.name}${s.chance !== null ? ` ${Math.round(s.chance * 100)}%` : ''} · ${s.job.laborPoints} LP${s.way !== null ? ` · ${formatDuration(s.way)}` : ''}${ok ? '' : ' (not enough LP)'}`));
        }
        if (src.length > 3) extra.push(h(Text, { key: `m${i}`, dimColor: true }, `    +${src.length - 3} more jobs (g shows all on the map)`));
        return [row, ...extra];
      }),
      h(Text, { key: 'rw', bold: true }, 'Rewards'),
      h(Text, { key: 'rws', wrap: 'truncate' }, quest.rewards.map((r) => r.text).join(' · ') || '—'),
      ...(quest.rewardOptions.length ? [h(Text, { key: 'ro', dimColor: true, wrap: 'truncate' }, `Choice: ${quest.rewardOptions.map((o, i) => `${i + 1}) ${o.text}`).join(' / ')} (pick when finishing)`)] : []),
      h(Text, { key: 'sp' }, ' '),
    ];
    const text = wrapLines([quest.description, quest.hint && `Hint: ${quest.hint}`].filter(Boolean).join('\n\n'), dw);
    const room = Math.max(0, height - 3 - info.length);
    const s = Math.min(scroll, Math.max(0, text.length - room));
    detailLines = [...info, ...text.slice(s, s + room).map((l, i) => h(Text, { key: `d${i}`, dimColor: true }, l || ' '))];
  } else if (cur?.kind === 'giver') {
    detailLines = [
      h(Text, { key: 'n', bold: true, color: 'magenta' }, cur.name.replace(/^▾ /, '')),
      h(Text, { key: 'h', dimColor: true }, cur.at ? `at ${cur.at.x},${cur.at.y} · travel ${formatDuration(state.travelTo(cur.at))}` : 'In the saloon'),
      h(Text, { key: 'k' }, 'Enter: show quests · w: walk there'),
    ];
  }
  const keys = confirm
    ? confirm.kind === 'finish' && confirm.quest.rewardOptions.length > 1
      ? h(Box, { flexDirection: 'column' },
        h(Text, { color: 'yellow', wrap: 'truncate' }, `Finish "${confirm.quest.title}"? Choose a reward (← → or 1-${confirm.quest.rewardOptions.length}), then y:`),
        ...confirm.quest.rewardOptions.map((o, i) => h(Text, { key: o.id, inverse: i === confirm.choice, color: i === confirm.choice ? 'green' : undefined, wrap: 'truncate' }, ` ${i + 1}) ${o.text}`)))
      : h(Text, { color: 'yellow', wrap: 'truncate' }, confirm.kind === 'route'
        ? `Queue ${Math.min(confirm.plan.fitRuns, Math.max(0, state.taskLimit - state.queue.length))} of ${confirm.plan.totals.runs} route jobs? y yes · a autopilot: quests first until these are done (G) · n no`
        : `${confirm.kind === 'finish' ? 'Finish' : 'Cancel'} "${confirm.quest.title}"${confirm.kind === 'finish' && confirm.quest.rewardOptions.length === 1 ? ` (reward: ${confirm.quest.rewardOptions[0]!.text})` : ''}? y / n`)
    : route
      ? h(Text, { dimColor: true, wrap: 'truncate' }, `${state.autoRoute ? `auto: ${state.autoRoute.runs.length} left, x stop · ` : ''}1 quest · 2 chain · 3 all · e energy/time · Enter queue · g map · J/K · Esc`)
      : h(Text, { dimColor: true, wrap: 'truncate' }, quest
        ? `${quest.accepted ? (quest.finishable ? 'Enter finish · ' : '') + 'x cancel quest · R route' : 'a/Enter accept'} · g jobs on map${quest.employerAt ? ' · w walk to giver' : ''} · J/K scroll`
        : 'Enter open · R route · Esc back');
  const right = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: rightW, height, paddingX: 1 },
    ...detailLines, h(Box, { flexGrow: 1 }), keys);
  return h(Box, { width, height }, left, right);
}

/** Right panel for the route planner. */
function routeLines(state: GameState, plan: RoutePlan, route: { scope: RouteScope; objective: RouteObjective }, questCount: number, width: number, room: number, scroll: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const add = (text: string, props: Record<string, unknown> = {}) => out.push(h(Text, { key: out.length, wrap: 'truncate', ...props }, truncate(text, width)));
  const head: React.ReactNode[] = [];
  head.push(h(Text, { key: 'h', bold: true, wrap: 'truncate' }, `Route · ${SCOPE_LABEL[route.scope]} (${questCount} quest${questCount === 1 ? '' : 's'}) · best per ${route.objective}`));
  const t = plan.totals;
  head.push(h(Text, { key: 't', color: 'cyan', wrap: 'truncate' },
    `${t.runs} jobs · ${t.energy} energy · ${formatDuration(t.seconds)} (${formatDuration(t.travel)} travel) · ${t.xp} XP · ${money(t.money)}`));
  if (plan.energyShort > 0) {
    head.push(h(Text, { key: 'en', color: 'yellow', wrap: 'truncate' },
      `Energy: have ${state.character.energy}, ${plan.energyShort} short · ${plan.fitRuns} of ${t.runs} jobs can be queued now`));
  }
  const label = (k: string) => plan.needs.find((n) => n.key === k)?.label ?? k;
  const unitOf = (k: string) => plan.needs.find((n) => n.key === k)?.unit;
  const fmtGain = (k: string, g: number) => unitOf(k) === 'seconds' ? `${formatDuration(g)} ${label(k)}` : unitOf(k) === 'runs' ? `${g}× ${label(k)}` : `~${Math.round(g * 10) / 10} ${label(k)}`;
  add('Needs', { bold: true });
  for (const n of plan.needs) add(`  ${n.unit === 'seconds' ? formatDuration(n.amount) : n.amount}${n.unit === 'items' ? '×' : n.unit === 'runs' ? ' runs' : ''} ${n.label} — ${n.quests.join(', ')}`, { dimColor: true });
  if (!plan.needs.length) add('  nothing — all requirements met or not job-related', { dimColor: true });
  if (plan.stops.length) add('Stops', { bold: true });
  plan.stops.forEach((s, i) => {
    add(`${String(i + 1).padStart(2)}. ${s.job.name} · ${s.runs}× ${DURATION_LABEL[s.duration]} @ ${s.at.x},${s.at.y}`, { color: 'magentaBright' });
    add(`    ${s.travel ? `walk ${formatDuration(s.travel)} · ` : ''}${s.energy} energy · ${s.xp} XP · ${money(s.money)}`, { dimColor: true });
    add(`    → ${Object.entries(s.gains).map(([k, g]) => fmtGain(k, g)).join(', ')}`, { color: 'green' });
  });
  for (const u of plan.unmet) add(`✘ ${u.need.label}: ${u.why}`, { color: 'red' });
  for (const [k, r] of Object.entries(plan.leftover)) add(`… ${label(k)}: ~${Math.round(r * 10) / 10} still open after the run limit`, { color: 'yellow' });
  if (plan.stops.length) add('Drop amounts are expected values (job window %); re-plan after the jobs finish.', { dimColor: true });
  const body = Math.max(0, room - head.length);
  const top = Math.min(scroll, Math.max(0, out.length - body));
  return [...head, ...out.slice(top, top + body)];
}

/** Quest detail: "≈ 2h 10m · 24 energy · 3 jobs (12m walking)", with what the estimate can't cover. */
function estimateLines(plan: RoutePlan | undefined, finishable: boolean): React.ReactNode[] {
  if (finishable || !plan || (!plan.stops.length && !plan.unmet.length)) return [];
  const t = plan.totals;
  const out: React.ReactNode[] = [];
  if (plan.stops.length) {
    out.push(h(Text, { key: 'est', color: 'cyan', wrap: 'truncate' },
      `≈ ${formatDuration(t.seconds)} · ${t.energy} energy · ${t.runs} job${t.runs === 1 ? '' : 's'}${t.travel ? ` (${formatDuration(t.travel)} walking)` : ''} · R for the route`));
  }
  if (plan.unmet.length) {
    out.push(h(Text, { key: 'estu', color: 'yellow', wrap: 'truncate' }, `${plan.stops.length ? '+ not from jobs' : 'No job estimate'}: ${plan.unmet.map((u) => u.need.label).join(', ')}`));
  }
  return out;
}
