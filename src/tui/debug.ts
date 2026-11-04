// Debug screen (g x): the debug log (state diffs, requests, autopilot decisions, planner input/output, quest
// module) with the selected entry's data, and a live "Now" view of what the autopilot sees. Entries are also
// written to <config dir>/debug/ (hourly files, kept 24 h).

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { DEBUG_CATEGORIES, type DebugCategory, type DebugEntry, debugJson } from '../game/debug-log.ts';
import type { ScreenProps } from './character.ts';
import { scrollWindow, truncate } from './format.ts';

const createElement = React.createElement;

const CATEGORY_COLOR: Record<DebugCategory, string> = {
  log: 'white',
  state: 'cyan',
  request: 'gray',
  autopilot: 'green',
  sim: 'magenta',
  quest: 'yellow',
};
const CATEGORY_ORDER: (DebugCategory | 'all')[] = ['all', ...DEBUG_CATEGORIES];

/** Pretty JSON split into lines no wider than `width` (long lines hard-wrapped). */
export function jsonLines(data: unknown, width: number): string[] {
  if (data === undefined) {
    return ['(no data)'];
  }
  const fieldWidth = Math.max(10, width);
  return debugJson(data, 2)
    .split('\n')
    .flatMap((line) => wrapLine(line, fieldWidth, `${/^ */.exec(line)?.[0] ?? ''}  `));
}

/** Hard-wraps one line to `w`, continuation lines indented. */
function wrapLine(text: string, fieldWidth: number, indent = '    '): string[] {
  if (text.length <= fieldWidth) {
    return [text];
  }
  const out = [text.slice(0, fieldWidth)];
  for (let index = fieldWidth; index < text.length; index += fieldWidth - indent.length) {
    out.push(indent + text.slice(index, index + fieldWidth - indent.length));
  }
  return out;
}

/** An object as `key: compact JSON` lines; lists get one line per item (the Now view). */
export function compactLines(obj: Record<string, unknown>, width: number): string[] {
  const fieldWidth = Math.max(10, width);
  return Object.entries(obj).flatMap(([entryKey, value]) => {
    const one = `${entryKey}: ${debugJson(value)}`;
    if (one.length <= fieldWidth || !Array.isArray(value)) {
      return wrapLine(one, fieldWidth);
    }
    return [
      `${entryKey}: (${value.length})`,
      ...value.flatMap((xCoord) => wrapLine(`  • ${debugJson(xCoord)}`, fieldWidth, '      ')),
    ];
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
  /** l: j k scroll the entry data instead of moving in the log. */
  const [dataFocus, setDataFocus] = useState(false);

  useEffect(() => () => onCapture(false), []);

  const all = state.debug.entries;
  const text = filter.toLowerCase();
  const list = all.filter(
    (entryValue) =>
      (cat === 'all' || entryValue.cat === cat) && (!text || entryValue.title.toLowerCase().includes(text)),
  );
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

  useInput(
    (input, key) => {
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
        if (key.backspace || key.delete) {
          return setFilter((currentFilter) => currentFilter.slice(0, -1));
        }
        if (input && !key.ctrl && !key.meta) {
          setFilter((currentFilter) => currentFilter + input);
        }
        return;
      }
      if (dataFocus && (key.escape || input === 'h')) {
        return setDataFocus(false);
      }
      if (key.escape) {
        return onExit();
      }
      if (key.tab) {
        setDataFocus(false);
        return setView((value) => (value === 'log' ? 'now' : 'log'));
      }
      if (input === 'l' && view === 'log') {
        return setDataFocus(true);
      }
      if (view === 'now' || dataFocus) {
        if (key.pageDown) {
          return setScroll((value) => Math.min(maxScroll, value + bodyRows));
        }
        if (key.pageUp) {
          return setScroll((value) => Math.max(0, value - bodyRows));
        }
        if (key.downArrow || input === 'j') {
          return setScroll((value) => Math.min(maxScroll, value + 1));
        }
        if (key.upArrow || input === 'k') {
          return setScroll((value) => Math.max(0, value - 1));
        }
        if (view === 'now') {
          return;
        }
      }
      const move = (value: number) => {
        const count = Math.max(0, Math.min(list.length - 1, idx + value));
        setSel(count >= list.length - 1 ? -1 : count);
      };
      if (key.upArrow || input === 'k') {
        return move(-1);
      }
      if (key.downArrow || input === 'j') {
        return move(1);
      }
      if (key.pageUp) {
        return move(-bodyRows);
      }
      if (key.pageDown) {
        return move(bodyRows);
      }
      if (input === 'e') {
        return setSel(-1);
      }
      if (input === 'f') {
        setSel(-1);
        return setCat((category) => {
          const next = (CATEGORY_ORDER.indexOf(category) + 1) % CATEGORY_ORDER.length;
          return CATEGORY_ORDER[next] ?? 'all';
        });
      }
      if (input === '/') {
        setTyping(true);
        return onCapture(true);
      }
      if (input === 'x') {
        setSel(-1);
        return state.debug.clear();
      }
    },
    { isActive: active },
  );

  const file = state.debug.file;
  const head = createElement(
    Text,
    { bold: true, wrap: 'truncate' },
    createElement(Text, { color: 'cyan' }, view === 'log' ? 'Debug log' : 'Now (what the autopilot sees)'),
    createElement(
      Text,
      { dimColor: true },
      `  ${list.length}/${all.length} · ${cat}${filter || typing ? ` · /${filter}${typing ? '▏' : ''}` : ''} · ${sel < 0 ? 'following' : 'paused'} · ${file ?? 'not saved to a file'}`,
    ),
  );

  if (view === 'now') {
    return createElement(
      Box,
      { flexDirection: 'column', width, height, borderStyle: 'round', borderColor: 'magenta', paddingX: 1 },
      head,
      ...detail
        .slice(scroll, scroll + bodyRows - 1)
        .map((detailLine, index) => createElement(Text, { key: index, wrap: 'truncate' }, detailLine)),
    );
  }

  const [start, end] = scrollWindow(idx, list.length, bodyRows - 1);
  const left = createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: dataFocus ? 'gray' : 'cyan',
      width: leftW,
      height,
      paddingX: 1,
    },
    head,
    ...list
      .slice(start, end)
      .map((listedEntry, index) =>
        createElement(
          Text,
          { key: listedEntry.id, inverse: start + index === idx, wrap: 'truncate' },
          createElement(Text, { dimColor: true }, `${clock(listedEntry.at)} `),
          createElement(Text, { color: CATEGORY_COLOR[listedEntry.cat] }, listedEntry.cat.padEnd(9)),
          truncate(listedEntry.title, leftW - 22),
        ),
      ),
    list.length ? null : createElement(Text, { dimColor: true }, 'Nothing logged yet.'),
  );
  const right = createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: dataFocus ? 'cyan' : 'gray',
      width: rightW,
      height,
      paddingX: 1,
    },
    createElement(Text, { bold: true, wrap: 'truncate' }, entry ? `${clock(entry.at)} ${entry.cat}` : ' '),
    createElement(Text, { wrap: 'truncate' }, entry?.title ?? ''),
    ...detail
      .slice(scroll, scroll + bodyRows - 2)
      .map((detailLine, index) => createElement(Text, { key: index, wrap: 'truncate' }, detailLine)),
  );
  return createElement(Box, { width, height }, left, right);
}
