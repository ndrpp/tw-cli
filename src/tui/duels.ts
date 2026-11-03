// Duels screen (D): NPC duels (fought at once) and players in duel range (queued as a duel task).
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DuelNpc, DuelOpponent } from '../game/duels.ts';
import type { ScreenProps } from './character.ts';
import { formatDuration, scrollWindow, truncate } from './format.ts';

const h = React.createElement;

type Row = { kind: 'npc'; npc: DuelNpc } | { kind: 'player'; o: DuelOpponent } | { kind: 'head'; text: string };

export function DuelsScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [sel, setSel] = useState(1);
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);

  useEffect(() => {
    void (async () => {
      await state.loadItems();
      await state.loadDuels();
    })();
  }, [state]);
  useEffect(() => {
    onCapture(!!confirm);
  }, [confirm]);

  const d = state.duels;
  const rows: Row[] = [
    { kind: 'head', text: `NPC duels${d?.difficulty ? ` · difficulty ${d.difficulty}` : ''}` },
    ...(d?.npcs ?? []).map((npc) => ({ kind: 'npc', npc }) as Row),
    { kind: 'head', text: 'Players in range (2 h walk)' },
    ...state.duelOpponents.map((o) => ({ kind: 'player', o }) as Row),
  ];
  const selectable = (i: number) => rows[i] !== undefined && rows[i]!.kind !== 'head';
  const move = (from: number, dir: 1 | -1) => {
    for (let j = from; j >= 0 && j < rows.length; j += dir) if (selectable(j)) return j;
    return sel;
  };
  const idx = selectable(sel) ? sel : move(Math.min(sel, rows.length - 1), 1);
  const cur = rows[idx];

  useInput((input, key) => {
    if (confirm) {
      setConfirm(null);
      if (input === 'y') confirm.run();
      return;
    }
    if (key.escape) return onExit();
    if (key.upArrow || input === 'k') return setSel(move(idx - 1, -1));
    if (key.downArrow || input === 'j') return setSel(move(idx + 1, 1));
    if (!cur || !key.return) return;
    if (cur.kind === 'npc') {
      if (cur.npc.readyIn > 0) return state.error(`${cur.npc.name} is ready in ${formatDuration(cur.npc.readyIn)}.`);
      return setConfirm({ text: `Duel ${cur.npc.name} (level ${cur.npc.level}) now?`, run: () => void state.fightNpc(cur.npc.id) });
    }
    if (cur.kind === 'player') {
      const c = state.character;
      const ally = cur.o.allianceId && c.homeTown ? ' (check: may be an alliance member)' : '';
      return setConfirm({ text: `Queue a duel against ${cur.o.name} (duel level ${cur.o.duelLevel})${ally}?`, run: () => void state.duelPlayer(cur.o) });
    }
  }, { isActive: active });

  const leftW = Math.max(30, Math.floor(width * 0.45));
  const rightW = width - leftW;
  const [start, end] = scrollWindow(idx, rows.length, Math.max(2, height - 4));
  const left = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    h(Text, { bold: true, wrap: 'truncate' }, `Duels · motivation ${Math.round((d?.motivation ?? 0) * 100)}% · NPC ${Math.round((d?.npcMotivation ?? 0) * 100)}%`),
    ...rows.slice(start, end).map((r, i) => {
      const n = start + i;
      if (r.kind === 'head') return h(Text, { key: `h${n}`, bold: true, color: 'yellow', wrap: 'truncate' }, r.text);
      if (r.kind === 'npc') {
        return h(Text, { key: `n${r.npc.id}`, inverse: n === idx, color: r.npc.readyIn > 0 ? 'gray' : undefined, wrap: 'truncate' },
          `  ${truncate(r.npc.name, leftW - 22)} L${String(r.npc.level).padStart(3)} ${r.npc.readyIn > 0 ? formatDuration(r.npc.readyIn).padStart(8) : '   ready'}`);
      }
      return h(Text, { key: `p${r.o.playerId}`, inverse: n === idx, wrap: 'truncate' },
        `  ${truncate(r.o.name, leftW - 24)} L${String(r.o.duelLevel).padStart(3)} ${formatDuration(state.travelTo(r.o)).padStart(8)}`);
    }),
    !d ? h(Text, { dimColor: true }, 'Loading…') : null,
  );

  const lines: React.ReactNode[] = [];
  if (cur?.kind === 'npc') {
    const w = cur.npc.weaponId ? state.itemName(cur.npc.weaponId) : '—';
    lines.push(h(Text, { key: 'n', bold: true }, cur.npc.name), h(Text, { key: 'l' }, `Level ${cur.npc.level} · weapon ${w}`));
  } else if (cur?.kind === 'player') {
    lines.push(h(Text, { key: 'n', bold: true }, cur.o.name),
      h(Text, { key: 'l', wrap: 'truncate' }, `Duel level ${cur.o.duelLevel}${cur.o.town ? ` · ${cur.o.town}` : ''}`),
      h(Text, { key: 'w', dimColor: true, wrap: 'truncate' }, `at ${cur.o.x},${cur.o.y} · ${formatDuration(state.travelTo(cur.o))} walk (the duel task walks there)`));
  }
  const last = state.lastNpcDuel;
  if (last) {
    lines.push(h(Text, { key: 'sp' }, ' '), h(Text, { key: 'lr', bold: true }, 'Last NPC duel'));
    last.rounds.slice(0, Math.max(0, height - 12)).forEach((r, i) =>
      lines.push(h(Text, { key: `r${i}`, wrap: 'truncate' }, `  round ${i + 1}: you ${r.own !== null ? `-${r.own} HP` : 'no hit'} · them ${r.other !== null ? `-${r.other} HP` : 'no hit'}`)));
    lines.push(h(Text, { key: 'res', color: last.died ? 'red' : 'green', wrap: 'wrap' }, last.result || '—'));
  }
  const keys = confirm
    ? h(Text, { color: 'yellow', wrap: 'truncate' }, `${confirm.text} y / n`)
    : h(Text, { dimColor: true, wrap: 'truncate' }, 'Enter duel · u refresh · Esc back');
  const right = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: rightW, height, paddingX: 1 },
    ...lines, h(Box, { flexGrow: 1 }), keys);
  return h(Box, { width, height }, left, right);
}
