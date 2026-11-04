// Debug screen (B): the debug log (state diffs, requests, autopilot decisions, planner input/output, quest
// module) with the selected entry's data, and a live "Now" view of what the autopilot sees. Entries are also
// written to <config dir>/debug/ (hourly files, kept 24 h).
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { DEBUG_CATEGORIES, debugJson, type DebugCategory, type DebugEntry } from '../game/debug-log.ts';
import type { ScreenProps } from './character.ts';
import { scrollWindow, truncate } from './format.ts';

const h = React.createElement;

const CAT_COLOR: Record<DebugCategory, string> = { log: 'white', state: 'cyan', request: 'gray', autopilot: 'green', sim: 'magenta', quest: 'yellow' };

/** Pretty JSON split into lines no wider than `width` (long lines hard-wrapped). */
export function jsonLines(data: unknown, width: number): string[] {
  if (data === undefined) return ['(no data)'];
  const w = Math.max(10, width);
  return debugJson(data, 2).split('\n').flatMap((l) => wrapLine(l, w, l.match(/^ */)![0] + '  '));
}

/** Hard-wraps one line to `w`, continuation lines indented. */
function wrapLine(l: string, w: number, indent = '    '): string[] {
  if (l.length <= w) return [l];
  const out = [l.slice(0, w)];
  for (let i = w; i < l.length; i += w - indent.length) out.push(indent + l.slice(i, i + w - indent.length));
  return out;
}

/** An object as `key: compact JSON` lines; lists get one line per item (the Now view). */
export function compactLines(obj: Record<string, unknown>, width: number): string[] {
  const w = Math.max(10, width);
  return Object.entries(obj).flatMap(([k, v]) => {
    const one = `${k}: ${debugJson(v)}`;
    if (one.length <= w || !Array.isArray(v)) return wrapLine(one, w);
    return [`${k}: (${v.length})`, ...v.flatMap((x) => wrapLine(`  • ${debugJson(x)}`, w, '      '))];
  });
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

export function DebugScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [view, setView] = useState<'log' | 'now'>('log');
  const [cat, setCat] = useState<DebugCategory | 'all'>('all');
  const [filter, setFilter] = useState('');
  const [typing, setTyping] = useState(false);
  const [sel, setSel] = useState(-1); // -1: follow the newest
  const [scroll, setScroll] = useState(0);

  useEffect(() => () => onCapture(false), []);

  const all = state.debug.entries;
  const f = filter.toLowerCase();
  const list = all.filter((e) => (cat === 'all' || e.cat === cat) && (!f || e.title.toLowerCase().includes(f)));
  const idx = sel < 0 ? list.length - 1 : Math.min(sel, list.length - 1);
  const entry: DebugEntry | undefined = list[idx];

  const leftW = Math.max(40, Math.floor(width * 0.5));
  const rightW = Math.max(20, width - leftW);
  const bodyRows = Math.max(3, height - 3);
  const entryLines = useMemo(() => (entry ? jsonLines(entry.data, rightW - 4) : []), [entry?.id, rightW]);
  // "Now" is live: recomputed on every render (the 1 s ticker).
  const detail = view === 'now' ? compactLines(state.runner.context(), width - 4) : entryLines;
  const maxScroll = Math.max(0, detail.length - (bodyRows - 1));
  useEffect(() => setScroll(0), [entry?.id, view]);

  useInput((input, key) => {
    if (typing) {
      if (key.escape) {
        setFilter('');
        setTyping(false);
        return onCapture(false);
      }
      if (key.return) {
        setTyping(false);
        return onCapture(false);
      }
      if (key.backspace || key.delete) return setFilter((x) => x.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setFilter((x) => x + input);
      return;
    }
    if (key.escape) return onExit();
    if (key.tab) return setView((v) => (v === 'log' ? 'now' : 'log'));
    if (input === 'J' || (key.pageDown && view === 'now')) return setScroll((s) => Math.min(maxScroll, s + (input === 'J' ? 3 : bodyRows)));
    if (input === 'K' || (key.pageUp && view === 'now')) return setScroll((s) => Math.max(0, s - (input === 'K' ? 3 : bodyRows)));
    if (view === 'now') {
      if (key.downArrow || input === 'j') return setScroll((s) => Math.min(maxScroll, s + 1));
      if (key.upArrow || input === 'k') return setScroll((s) => Math.max(0, s - 1));
      return;
    }
    const move = (d: number) => {
      const n = Math.max(0, Math.min(list.length - 1, idx + d));
      setSel(n >= list.length - 1 ? -1 : n);
    };
    if (key.upArrow || input === 'k') return move(-1);
    if (key.downArrow || input === 'j') return move(1);
    if (key.pageUp) return move(-bodyRows);
    if (key.pageDown) return move(bodyRows);
    if (input === 'e') return setSel(-1);
    if (input === 'f') {
      const order: (DebugCategory | 'all')[] = ['all', ...DEBUG_CATEGORIES];
      setSel(-1);
      return setCat((c) => order[(order.indexOf(c) + 1) % order.length]!);
    }
    if (input === '/') {
      setTyping(true);
      return onCapture(true);
    }
    if (input === 'x') {
      setSel(-1);
      return state.debug.clear();
    }
  }, { isActive: active });

  const file = state.debug.file;
  const head = h(Text, { bold: true, wrap: 'truncate' },
    h(Text, { color: 'cyan' }, view === 'log' ? 'Debug log' : 'Now (what the autopilot sees)'),
    h(Text, { dimColor: true }, `  ${list.length}/${all.length} · ${cat}${filter || typing ? ` · /${filter}${typing ? '▏' : ''}` : ''} · ${sel < 0 ? 'following' : 'paused'} · ${file ?? 'not saved to a file'}`));

  if (view === 'now') {
    return h(Box, { flexDirection: 'column', width, height, borderStyle: 'round', borderColor: 'magenta', paddingX: 1 },
      head,
      ...detail.slice(scroll, scroll + bodyRows - 1).map((l, i) => h(Text, { key: i, wrap: 'truncate' }, l)),
    );
  }

  const [start, end] = scrollWindow(idx, list.length, bodyRows - 1);
  const left = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    head,
    ...list.slice(start, end).map((e, i) => h(Text, { key: e.id, inverse: start + i === idx, wrap: 'truncate' },
      h(Text, { dimColor: true }, `${clock(e.at)} `),
      h(Text, { color: CAT_COLOR[e.cat] }, e.cat.padEnd(9)),
      truncate(e.title, leftW - 22))),
    list.length ? null : h(Text, { dimColor: true }, 'Nothing logged yet.'),
  );
  const right = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: rightW, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, entry ? `${clock(entry.at)} ${entry.cat}` : ' '),
    h(Text, { wrap: 'truncate' }, entry?.title ?? ''),
    ...detail.slice(scroll, scroll + bodyRows - 2).map((l, i) => h(Text, { key: i, wrap: 'truncate' }, l)),
  );
  return h(Box, { width, height }, left, right);
}
