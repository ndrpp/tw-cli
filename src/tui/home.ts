// Home screen (H, the start screen): what the character is doing now and what is queued. No browser
// counterpart; it gathers the header, task queue, report list and chat the web shows in separate windows.
// Layout: working · session · task queue (left) | minimap · reports (right) · chat (bottom, interactive).
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput } from 'ink';
import type { ScreenProps } from './character.ts';
import type { GameState } from '../game/state.ts';
import { regenSeconds } from '../game/timeline.ts';
import { bar, formatDuration, money, truncate } from './format.ts';
import { buildGrid, ZOOMS } from './map.ts';
import { ChatPanel, chatRoomIds } from './chat.ts';
import { QueuePane } from './queue.ts';

const h = React.createElement;
/** How long the "done" line shows after a task ends. */
const DONE_S = 30;

/** Server seconds → local "14:32". */
const clockTime = (s: number) => new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const perHour = (n: number) => Math.round(n).toLocaleString('en-US');

export function HomeScreen({ state, width, height, onCapture, active = true }: ScreenProps) {
  const [room, setRoom] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [zoom, setZoom] = useState(128);
  // The queue panel gets what the working and session panels leave: measured after layout.
  const queueBox = useRef<any>(null);
  const [queueRows, setQueueRows] = useState(3);
  useEffect(() => {
    if (!queueBox.current) return;
    const rows = Math.max(1, measureElement(queueBox.current).height - 2);
    if (rows !== queueRows) setQueueRows(rows);
  });

  useEffect(() => {
    onCapture(draft !== null || confirm);
  }, [draft, confirm]);
  useEffect(() => () => onCapture(false), []);

  // Reports: one read on first show; then the live "new report" push refreshes them (announceNewReport).
  // Without live updates, re-read a few seconds after a job ends, when its report has been written.
  useEffect(() => {
    if (state.recentReports === null) void state.loadRecentReports();
  }, []);
  useEffect(() => {
    if (!state.rates.jobsDone || state.live?.active) return;
    const t = setTimeout(() => void state.loadRecentReports(), 5000);
    return () => clearTimeout(t);
  }, [state.rates.jobsDone]);

  useInput((input, key) => {
    if (confirm) {
      if (input === 'y') void state.cancel(0);
      return setConfirm(false);
    }
    if (draft !== null) {
      if (key.escape) return setDraft(null);
      if (key.return) {
        const id = chatRoomIds(state)[room];
        setDraft(null);
        if (id && draft.trim()) void state.chatSay(id, draft);
        return;
      }
      if (key.backspace || key.delete) return setDraft(draft.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setDraft(draft + input);
      return;
    }
    const n = chatRoomIds(state).length;
    if (key.leftArrow || input === 'h') return setRoom((i) => (n ? (Math.min(i, n - 1) + n - 1) % n : 0));
    if (key.rightArrow || input === 'l') return setRoom((i) => (n ? (Math.min(i, n - 1) + 1) % n : 0));
    if (key.return) {
      if (!state.live?.active) return state.error('Live updates are off: press L to connect to chat.');
      if (!n) return state.error('No chat room yet (still connecting).');
      return setDraft('');
    }
    if ((input === 'c' || key.delete) && state.queue[0]) return setConfirm(true);
    if (input === '+' || input === '=') return setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)]!);
    if (input === '-' || input === '_') return setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)]!);
  }, { isActive: active });

  // Small terminals drop panels: chat first, then the right column (minimap, reports).
  const chatH = height >= 24 ? Math.max(6, Math.floor(height * 0.3)) : 0;
  const topH = height - chatH;
  const wide = width >= 96;
  const leftW = wide ? Math.max(48, Math.floor(width * 0.5)) : width;
  const rightW = width - leftW;
  const mapH = Math.max(6, Math.floor(topH * 0.5));

  return h(Box, { flexDirection: 'column', width, height },
    h(Box, { height: topH },
      h(Box, { flexDirection: 'column', width: leftW, height: topH },
        h(WorkingPanel, { state, width: leftW, confirm }),
        h(SessionPanel, { state, width: leftW }),
        h(Box, { ref: queueBox, flexGrow: 1, flexDirection: 'column', overflow: 'hidden' },
          h(QueuePane, { state, selected: 0, focused: false, width: leftW, confirm: false, maxRows: queueRows })),
      ),
      wide ? h(Box, { flexDirection: 'column', width: rightW, height: topH },
        h(Minimap, { state, width: rightW, height: mapH, zoom }),
        h(ReportsPanel, { state, width: rightW, height: topH - mapH }),
      ) : null,
    ),
    chatH ? h(ChatPanel, { state, width, height: chatH, focused: true, roomIdx: room, draft }) : null,
  );
}

/** The queue head: progress, time left, expected rewards; idle and the autopilot's next step otherwise. */
function WorkingPanel({ state, width, confirm }: { state: GameState; width: number; confirm: boolean }) {
  const now = state.clock.now();
  const head = state.queue[0];
  const w = width - 4;
  const rows: React.ReactNode[] = [];
  const last = state.rates.lastTask;
  if (last && now - last.end < DONE_S) {
    // The job report is usually there by now (live push or the re-read above): show what it paid.
    const rep = state.recentReports?.find((r) => r.title.includes(last.title));
    const paid = rep ? ` · ${rep.summary.replace(/\s*\n\s*/g, ' · ')}` : '';
    rows.push(h(Text, { key: 'done', color: 'green', wrap: 'truncate' }, `✓ ${last.title} done${paid}`));
  }
  let title = 'Idle';
  if (!head) {
    rows.push(h(Text, { key: 'idle', color: 'yellow', wrap: 'truncate' },
      last ? `Nothing queued for ${formatDuration(now - last.end)}` : 'Nothing queued', h(Text, { dimColor: true }, ' · W jobs · G autopilot')));
  } else {
    const walking = !!head.way && head.way.end > now;
    const from = walking ? head.way!.start : head.way?.end ?? head.start;
    const to = walking ? head.way!.end : head.end;
    const ratio = to > from ? Math.min(1, Math.max(0, (now - from) / (to - from))) : 1;
    const q = head.type === 'job' ? state.queuedJob(head) : null;
    title = walking ? 'Walking' : head.type === 'job' ? 'Working' : head.type === 'sleep' ? 'Sleeping' : head.title;
    rows.push(h(Text, { key: 't', bold: true, wrap: 'truncate' },
      walking ? `→ ${head.title}` : head.title,
      h(Text, { dimColor: true, bold: false }, ` · ${head.coords.x},${head.coords.y} · ${formatDuration(head.end - (head.way?.end ?? head.start))}`)));
    rows.push(h(Text, { key: 'bar', wrap: 'truncate' },
      h(Text, { color: walking ? 'cyan' : 'green' }, bar(ratio, 1, Math.max(8, w - 28))),
      ` ${String(Math.floor(ratio * 100)).padStart(3)}%  ${formatDuration(to - now)} left (${clockTime(to)})`));
    if (q) {
      const v = q.values;
      const luck = q.job.luckValue[1] > 0 ? `  luck ${money(q.job.luckValue[0])}–${money(q.job.luckValue[1])}` : '';
      rows.push(h(Text, { key: 'r', wrap: 'truncate' },
        h(Text, { color: 'green' }, `+${v.experience} xp  ${money(v.money)}`), luck,
        q.job.danger !== null ? h(Text, { color: q.job.danger >= 50 ? 'red' : undefined }, `  danger ${q.job.danger}%`) : ''));
      const drops = (v.items?.length ? v.items.map((i) => ({ name: state.itemName(i.itemId), percent: i.percent as number | null })) : state.jobProducts(q.job))
        .map((p) => `${p.name}${p.percent !== null ? ` ${p.percent}%` : ''}`).join(' · ');
      if (drops) rows.push(h(Text, { key: 'd', color: 'magenta', wrap: 'truncate' }, `Drops: ${drops}`));
    }
    const next = state.queue[1];
    if (next) {
      const end = state.queue[state.queue.length - 1]!.end;
      const more = state.queue.length > 2 ? ` (+${state.queue.length - 2} more)` : '';
      rows.push(h(Text, { key: 'n', dimColor: true, wrap: 'truncate' }, `then ${truncate(next.title, Math.max(8, w - 30))}${more} · queue ends ${clockTime(end)}`));
    }
  }
  const cfg = state.autopilot.config;
  const plan = state.runner.plan;
  if (cfg.running || plan) {
    const status = cfg.running ? (cfg.modules.dryRun ? 'dry run' : 'running') : 'paused';
    rows.push(h(Text, { key: 'ap', wrap: 'truncate' },
      h(Text, { color: cfg.running ? 'green' : 'yellow' }, `autopilot ${status}`),
      h(Text, { dimColor: true }, plan ? ` · ${cfg.running ? 'next' : 'would do'}: ${plan.why}` : ' · planning…')));
  }
  if (confirm && head) rows.push(h(Text, { key: 'cf', color: 'red', wrap: 'truncate' }, `Cancel ${head.title}? y / n`));
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width, paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true, color: 'cyan' }, title),
    ...rows,
  );
}

/** Measured XP/h and $/h (rolling hour), what the queue would pay, level and regen ETAs. */
function SessionPanel({ state, width }: { state: GameState; width: number }) {
  const now = state.clock.now();
  const c = state.character;
  const r = state.rates.rates(now, c.experience, c.cash + c.deposit);
  const first = state.rates.first;
  const tl = state.queue.length ? state.timeline() : null;
  const left = tl ? tl.end - now : 0;
  const p = c.progress;
  const eta = r && r.xpH > 0 && !p.maxed ? ` · lvl ${c.level + 1} in ~${formatDuration(Math.round(((p.need - p.have) / r.xpH) * 3600))}` : '';
  const full = (have: number, max: number, rate: number) => {
    const s = regenSeconds(have, max, max, rate);
    return s === 0 ? 'full' : Number.isFinite(s) ? `full ${clockTime(now + s)}` : '—';
  };
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, 'Session',
      h(Text, { dimColor: true, bold: false }, ` · ${state.rates.jobsDone} job(s) · ${first ? formatDuration(now - first.t) : '0s'}`)),
    h(Text, { wrap: 'truncate' },
      h(Text, { color: 'green' }, r ? `${perHour(r.xpH)} xp/h  ${money(Math.round(r.moneyH))}/h` : 'measuring…'),
      h(Text, { dimColor: true }, r ? ` (last ${formatDuration(r.span)})${eta}` : ' (needs 5 min)')),
    tl && left > 60
      ? h(Text, { dimColor: true, wrap: 'truncate' }, `queued: ${perHour((tl.gained.xp * 3600) / left)} xp/h ${money(Math.round((tl.gained.money * 3600) / left))}/h until ${clockTime(tl.end)}`)
      : null,
    h(Text, { wrap: 'truncate' },
      h(Text, { color: 'cyan' }, 'EN '), full(c.energy, c.maxEnergy, c.energyRegen), '   ',
      h(Text, { color: 'red' }, 'HP '), full(c.health, c.maxHealth, c.healthRegen)),
  );
}

/** The map around the character (zoom with + / -); m opens the full map. */
function Minimap({ state, width, height, zoom }: { state: GameState; width: number; height: number; zoom: number }) {
  const cols = Math.max(10, width - 2);
  const rows = Math.max(2, height - 3);
  const grid = buildGrid(state, { ...state.character.position, zoom }, cols, rows);
  const county = state.world.countyAt(state.character.position);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, height, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, ` ${county?.name ?? 'Map'}`, h(Text, { dimColor: true, bold: false }, ` · ${zoom}px · +/- zoom · m map`)),
    ...grid.map((segs, r) =>
      h(Text, { key: r, wrap: 'truncate' },
        ...segs.map((s, i) => h(Text, { key: i, color: s.color, dimColor: s.dim, bold: s.bold }, s.inverse && s.text === '+' ? ' ' : s.text)))),
  );
}

/** Newest reports (all folders): title, then the list summary (rewards, items found). */
function ReportsPanel({ state, width, height }: { state: GameState; width: number; height: number }) {
  const list = state.recentReports;
  const shown = list?.slice(0, Math.max(1, Math.floor((height - 3) / 2))) ?? [];
  const unread = list?.filter((r) => !r.read).length ?? 0;
  const w = width - 4;
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, height, paddingX: 1, overflow: 'hidden' },
    h(Text, { bold: true, wrap: 'truncate' }, 'Reports', h(Text, { dimColor: true, bold: false }, `${unread ? ` · ${unread} unread` : ''} · M all`)),
    list === null ? h(Text, { dimColor: true }, 'Loading…') : list.length ? null : h(Text, { dimColor: true }, 'No reports.'),
    ...shown.flatMap((r) => [
      h(Text, { key: `${r.id}t`, bold: !r.read, wrap: 'truncate' }, truncate(`${r.read ? ' ' : '•'}${r.title}`, w - r.date.length - 1), h(Text, { dimColor: true, bold: false }, ` ${r.date}`)),
      h(Text, { key: `${r.id}s`, dimColor: true, wrap: 'truncate' }, `  ${r.summary.replace(/\s*\n\s*/g, ' · ')}`),
    ]),
  );
}
