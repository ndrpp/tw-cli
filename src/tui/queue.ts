// Task queue panel (jobs screen and home): the server queue with time left per task (walk legs apart), the
// projected end, XP and $ of the whole queue (TaskQueueUi in the browser).
import React from 'react';
import { Box, Text } from 'ink';
import type { GameState } from '../game/state.ts';
import { queueSummary, walkLeft, workLeft } from '../game/tasks.ts';
import { formatClock, formatDuration, money, scrollWindow, truncate } from './format.ts';

const h = React.createElement;

/** `maxRows`: lines inside the border; `selected` / `focused` highlight a task (the jobs screen's queue focus). */
export function QueuePane({ state, selected, focused, width, confirm, maxRows }: { state: GameState; selected: number; focused: boolean; width: number; confirm: boolean; maxRows: number }) {
  const now = state.clock.now();
  const total = state.queue.length ? state.timeline() : null;
  const summary = queueSummary(state.queue, now);
  const rowsForTasks = Math.max(1, maxRows - (confirm ? 1 : 0) - (total ? 1 : 0));
  const overflow = state.queue.length > rowsForTasks;
  const [start, end] = scrollWindow(selected, state.queue.length, overflow ? rowsForTasks - 1 : rowsForTasks);
  const hidden = state.queue.length - (end - start);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'cyan' : 'gray', width, paddingX: 1, flexGrow: 1, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, `Task queue ${state.queue.length}/${state.taskLimit}`),
    state.queue.length === 0 ? h(Text, { dimColor: true }, 'Idle') : null,
    ...state.queue.slice(start, end).map((t, j) => {
      const i = start + j;
      const sel = i === selected && focused;
      // Running task counts down; later ones show their full length. Walk legs are shown apart.
      const walk = i === 0 ? walkLeft(t, now) : t.way ? t.way.end - t.way.start : 0;
      const work = i === 0 ? workLeft(t, now) : t.end - t.start;
      const time = formatDuration(work).padStart(7);
      const right = walk > 0 ? `walk ${formatDuration(walk)} + ${time}` : time;
      const label = `${i + 1}. ${t.type === 'job' ? '' : `[${t.type}] `}${t.title}`;
      return h(Text, { key: t.queueId || i, inverse: sel, color: i === 0 ? 'green' : undefined, wrap: 'truncate' },
        `${truncate(label, Math.max(8, width - 8 - right.length))} ${right}`);
    }),
    overflow ? h(Text, { dimColor: true }, `  +${hidden} more`) : null,
    total ? h(Text, { color: 'cyan', wrap: 'truncate' },
      `ends ${formatClock(total.end, now)} · +${total.gained.xp} xp ${money(total.gained.money)} · ${formatDuration(total.end - now)} left${summary && summary.walk > 0 ? ` · walk ${formatDuration(summary.walk)}` : ''}`) : null,
    confirm ? h(Text, { color: 'red' }, 'Cancel this task? y / n') : null,
  );
}

