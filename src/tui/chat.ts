// Chat screen (g c): rooms from the live connection (town, saloon, …) and whispers. Needs live updates (g L).
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScreenProps } from './character.ts';
import { scrollWindow, truncate } from './format.ts';
import { formKey, formValues, FormView, makeForm, wrapSegments, type FormState } from './form.ts';
import { chatPresence, TOWN_ROLES, type ChatClient } from '../realtime/chat.ts';
import { chatSegments, type Segment } from '../game/chatlinks.ts';
import { defined } from '../util/defined.ts';

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
  const chatRoom = room ? live?.rooms.get(room) : undefined;
  // Town chat: the connected players of the town, with role and level.
  const rosterW = chatRoom?.kind === 'town' && width >= 90 ? Math.max(24, Math.min(32, Math.floor(width * 0.24))) : 0;
  const rightW = width - leftW - rosterW;
  const [start, end] = scrollWindow(idx, roomIds.length, Math.max(2, height - 3));
  const left = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    h(Text, { bold: true }, 'Chat'),
    ...roomIds.slice(start, end).map((id, i) => {
      const unread = live?.unreadRooms.has(id);
      const members = live?.rooms.get(id)?.members.size;
      return h(Text, defined({ key: id, inverse: start + i === idx, bold: unread, wrap: 'truncate' }),
        `${unread ? '•' : ' '}${truncate(live!.roomTitle(id), leftW - 9)}${members ? ` ${members}` : ''}`);
    }),
    !live?.active ? h(Text, { color: 'yellow', wrap: 'wrap' }, 'Live updates are off. Press Esc, then L to connect.') : roomIds.length ? null : h(Text, { dimColor: true }, 'Connecting…'),
  );
  const lines = room && live ? live.history.get(room) ?? [] : [];
  const tw = Math.max(10, rightW - 4);
  const wrapped = lines.flatMap((l) => {
    const time = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return wrapSegments(lineSegments(state, `${time} ${l.from}: `, l.text, l.own), tw);
  });
  const room4 = Math.max(1, height - 4 - (form ? 6 : 0) - (chatRoom?.kind === 'town' && !rosterW ? 1 : 0));
  const shown = wrapped.slice(-room4);
  const topic = chatRoom?.topic ?? '';
  const right = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: rightW, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, room && live ? live.roomTitle(room) : '', topic ? h(Text, { dimColor: true, bold: false }, ` · ${topic}`) : ''),
    h(Text, { bold: true, wrap: 'truncate' }, chatRoom?.kind === 'town' ? `Town roster · ${rosterSummary(chatRoom.members, live?.clients)}` : ''),
    chatRoom?.kind === 'town' && !rosterW ? h(Text, { dimColor: true, wrap: 'truncate' }, 'Widen the terminal to see the town roster.') : null,
    ...shown.map((l, i) => segLine(l, i)),
    lines.length ? null : h(Text, { dimColor: true }, room ? 'No messages since you connected.' : ''),
    h(Box, { flexGrow: 1 }),
    form ? h(FormView, { form, width: rightW - 4 }) : null,
    draft !== null
      ? h(Text, { wrap: 'truncate' }, h(Text, { color: 'cyan' }, '> '), `${draft}▏`)
      : h(Text, { dimColor: true, wrap: 'truncate' }, 'Enter write · t whisper · ↑↓ room · Esc back'),
  );
  const roster = rosterW && chatRoom?.kind === 'town'
    ? h(TownRoster, { clients: live?.clients, members: chatRoom.members, width: rosterW, height })
    : null;
  return h(Box, { width, height }, left, right, roster);
}

function rosterSummary(members: Set<string>, clients: Map<string, ChatClient> | undefined): string {
  let online = 0;
  for (const id of members) if (chatPresence(clients?.get(id)?.actioned) === 'online') online++;
  return `${online}/${members.size} online`;
}

const PRESENCE_STYLE = { online: ['●', 'green'], idle: ['◐', 'yellow'], unknown: ['?', 'gray'] } as const;

/** Town chat roster: status, name, role and level of the clients in the room, online first. */
function TownRoster({ clients, members, width, height }: { clients: Map<string, ChatClient> | undefined; members: Set<string>; width: number; height: number }) {
  const now = Date.now();
  const rows = [...members]
    .map((id) => clients?.get(id))
    .filter((c): c is ChatClient => !!c)
    .sort((a, b) => {
      const pa = chatPresence(a.actioned, now) === 'online' ? 0 : chatPresence(a.actioned, now) === 'idle' ? 1 : 2;
      const pb = chatPresence(b.actioned, now) === 'online' ? 0 : chatPresence(b.actioned, now) === 'idle' ? 1 : 2;
      if (pa !== pb) return pa - pb;
      if (a.townRights !== b.townRights) return b.townRights - a.townRights;
      return a.name.localeCompare(b.name);
    });
  const roomRows = Math.max(1, height - 4);
  const roleW = 7;
  // Border (2) + padding (2) + dot + space + space + role + space + "L" + level.
  const nameW = Math.max(6, width - 4 - 2 - 1 - roleW - 1 - 4);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, `Town · ${rosterSummary(members, clients)}`),
    ...rows.slice(0, roomRows).map((c) => {
      const presence = chatPresence(c.actioned, now);
      const [dot, color] = PRESENCE_STYLE[presence];
      const role = TOWN_ROLES[c.townRights] ?? 'Guest';
      return h(Text, { key: c.id, wrap: 'truncate' },
        h(Text, { color }, dot), ' ', h(Text, { bold: c.townRights >= 2 }, truncate(c.name, nameW)), ' ',
        h(Text, defined({ color: c.townRights >= 2 ? 'yellow' : undefined, dimColor: c.townRights < 2 }), role.padEnd(roleW).slice(0, roleW)), ` L${c.level}`);
    }),
    rows.length > roomRows ? h(Text, { dimColor: true }, `+${rows.length - roomRows} more`) : null,
    rows.length === 0 ? h(Text, { dimColor: true }, 'No clients yet.') : null,
  );
}

/** A chat line as coloured runs: own lines cyan, [item=…] / [quest=…] links as names. */
function lineSegments(state: ScreenProps['state'], head: string, text: string, own: boolean): Segment[] {
  const color = own ? 'cyan' : undefined;
  return [{ text: head, color }, ...chatSegments(text, {
    item: (id) => ({ name: state.itemName(id), set: !!state.items?.get(id)?.set }),
    quest: (id) => state.questTitle(id),
  }, color)];
}

function segLine(segs: Segment[], key: number, wrap?: 'truncate') {
  return h(Text, { key, wrap }, ...(segs.length ? segs.map((s, i) => h(Text, defined({ key: i, color: s.color }), s.text)) : [' ']));
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
    return wrapSegments(lineSegments(state, `${time} ${l.from}: `, l.text, l.own), tw);
  });
  const shown = wrapped.slice(-Math.max(1, height - 4));
  const others = ids.filter((id) => id !== room && live?.unreadRooms.has(id)).length;
  const title = room && live ? live.roomTitle(room) : 'Chat';
  const status = !live?.active ? 'live updates off (g L)' : ids.length ? `${Math.min(roomIdx, ids.length - 1) + 1}/${ids.length}${others ? ` · ${others} unread` : ''}` : 'connecting…';
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'cyan' : 'gray', width, height, paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, `${ids.length > 1 ? '◂ ' : ''}${title}${ids.length > 1 ? ' ▸' : ''}`, h(Text, { dimColor: true, bold: false }, `  ${status}`)),
    ...shown.map((l, i) => segLine(l, i, 'truncate')),
    lines.length || !room ? null : h(Text, { dimColor: true }, 'No messages since you connected.'),
    h(Box, { flexGrow: 1 }),
    draft !== null
      ? h(Text, { wrap: 'truncate' }, h(Text, { color: 'cyan' }, '> '), `${draft}▏`)
      : h(Text, { dimColor: true, wrap: 'truncate' }, focused ? 'Enter write · ←→ room · C full chat (whispers)' : 'Tab here to chat'),
  );
}
