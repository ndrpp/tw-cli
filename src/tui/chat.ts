// Chat screen (C): rooms from the live connection (town, saloon, …) and whispers. Needs live updates (L).
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScreenProps } from './character.ts';
import { scrollWindow, truncate } from './format.ts';
import { formKey, formValues, FormView, makeForm, wrap, type FormState } from './form.ts';

const h = React.createElement;

export function ChatScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [sel, setSel] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const live = state.live;

  useEffect(() => {
    onCapture(draft !== null || !!form);
  }, [draft, form]);

  const roomIds = live ? [...live.rooms.keys(), ...[...live.history.keys()].filter((k) => k.startsWith('tell:'))] : [];
  const idx = Math.min(sel, Math.max(0, roomIds.length - 1));
  const room = roomIds[idx];
  useEffect(() => {
    if (room && live?.unreadRooms.delete(room)) state.changed();
  }, [room, live?.history.get(room ?? '')?.length]);

  useInput((input, key) => {
    if (form) {
      const r = formKey(form, input, key);
      if (r === 'cancel') return setForm(null);
      if (r !== 'submit') return setForm(r);
      const v = formValues(form);
      setForm(null);
      const name = (v.to ?? '').trim();
      if (name && v.text) void state.chatSay(`tell:${name}`, v.text);
      return;
    }
    if (draft !== null) {
      if (key.escape) return setDraft(null);
      if (key.return) {
        const text = draft;
        setDraft(null);
        if (room && text.trim()) void state.chatSay(room, text);
        return;
      }
      if (key.backspace || key.delete) return setDraft(draft.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setDraft(draft + input);
      return;
    }
    if (key.escape) return onExit();
    if (key.upArrow || input === 'k') return setSel(Math.max(0, idx - 1));
    if (key.downArrow || input === 'j') return setSel(Math.min(roomIds.length - 1, idx + 1));
    if (key.return && room) return setDraft('');
    if (input === 't') return setForm(makeForm('Whisper', [{ key: 'to', label: 'To', value: room?.startsWith('tell:') ? room.slice(5) : '' }, { key: 'text', label: 'Message', value: '' }]));
  }, { isActive: active });

  const leftW = Math.max(20, Math.min(32, Math.floor(width * 0.3)));
  const rightW = width - leftW;
  const [start, end] = scrollWindow(idx, roomIds.length, Math.max(2, height - 3));
  const left = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    h(Text, { bold: true }, 'Chat'),
    ...roomIds.slice(start, end).map((id, i) => {
      const unread = live?.unreadRooms.has(id);
      const members = live?.rooms.get(id)?.members.size;
      return h(Text, { key: id, inverse: start + i === idx, bold: unread, wrap: 'truncate' },
        `${unread ? '•' : ' '}${truncate(live!.roomTitle(id), leftW - 9)}${members ? ` ${members}` : ''}`);
    }),
    !live?.active ? h(Text, { color: 'yellow', wrap: 'wrap' }, 'Live updates are off. Press Esc, then L to connect.') : roomIds.length ? null : h(Text, { dimColor: true }, 'Connecting…'),
  );
  const lines = room && live ? live.history.get(room) ?? [] : [];
  const tw = Math.max(10, rightW - 4);
  const wrapped = lines.flatMap((l) => {
    const time = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return wrap(`${time} ${l.from}: ${l.text}`, tw).map((t, i) => ({ t, own: l.own, first: i === 0, from: l.from }));
  });
  const room4 = Math.max(1, height - 4 - (form ? 6 : 0));
  const shown = wrapped.slice(-room4);
  const topic = room ? live?.rooms.get(room)?.topic : '';
  const right = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: rightW, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, room && live ? live.roomTitle(room) : '', topic ? h(Text, { dimColor: true, bold: false }, ` · ${topic}`) : ''),
    ...shown.map((l, i) => h(Text, { key: i, color: l.own ? 'cyan' : undefined }, l.t || ' ')),
    lines.length ? null : h(Text, { dimColor: true }, room ? 'No messages since you connected.' : ''),
    h(Box, { flexGrow: 1 }),
    form ? h(FormView, { form, width: rightW - 4 }) : null,
    draft !== null
      ? h(Text, { wrap: 'truncate' }, h(Text, { color: 'cyan' }, '> '), `${draft}▏`)
      : h(Text, { dimColor: true, wrap: 'truncate' }, 'Enter write · t whisper · ↑↓ room · Esc back'),
  );
  return h(Box, { width, height }, left, right);
}

/** Rooms (town, saloon, …) then whispers, in the order both chat views show them. */
export function chatRoomIds(state: ScreenProps['state']): string[] {
  const live = state.live;
  return live ? [...live.rooms.keys(), ...[...live.history.keys()].filter((k) => k.startsWith('tell:'))] : [];
}

/**
 * Chat strip of the main view: one room's latest lines and an input line. The App owns the
 * room index and draft (Tab focuses it, ←/→ switch room, Enter write); C opens the full screen.
 */
export function ChatPanel({ state, width, height, focused, roomIdx, draft }: {
  state: ScreenProps['state']; width: number; height: number; focused: boolean; roomIdx: number; draft: string | null;
}) {
  const live = state.live;
  const ids = chatRoomIds(state);
  const room = ids[Math.min(roomIdx, Math.max(0, ids.length - 1))];
  const lines = room && live ? live.history.get(room) ?? [] : [];
  useEffect(() => {
    if (room && live?.unreadRooms.delete(room)) state.changed();
  }, [room, lines.length]);

  const tw = Math.max(10, width - 4);
  const wrapped = lines.flatMap((l) => {
    const time = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return wrap(`${time} ${l.from}: ${l.text}`, tw).map((t) => ({ t, own: l.own }));
  });
  const shown = wrapped.slice(-Math.max(1, height - 4));
  const others = ids.filter((id) => id !== room && live?.unreadRooms.has(id)).length;
  const title = room && live ? live.roomTitle(room) : 'Chat';
  const status = !live?.active ? 'live updates off (L)' : ids.length ? `${Math.min(roomIdx, ids.length - 1) + 1}/${ids.length}${others ? ` · ${others} unread` : ''}` : 'connecting…';
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'cyan' : 'gray', width, height, paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, `${ids.length > 1 ? '◂ ' : ''}${title}${ids.length > 1 ? ' ▸' : ''}`, h(Text, { dimColor: true, bold: false }, `  ${status}`)),
    ...shown.map((l, i) => h(Text, { key: i, color: l.own ? 'cyan' : undefined, wrap: 'truncate' }, l.t || ' ')),
    lines.length || !room ? null : h(Text, { dimColor: true }, 'No messages since you connected.'),
    h(Box, { flexGrow: 1 }),
    draft !== null
      ? h(Text, { wrap: 'truncate' }, h(Text, { color: 'cyan' }, '> '), `${draft}▏`)
      : h(Text, { dimColor: true, wrap: 'truncate' }, focused ? 'Enter write · ←→ room · C full chat (whispers)' : 'Tab here to chat'),
  );
}
