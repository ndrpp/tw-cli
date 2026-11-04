// Town screen (g t): the city hall of your home town — building levels, progress and construction jobs.

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import type { TownBuilding } from '../game/townhall.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { type FormState, FormView, formKey, formValues, makeForm } from './form.ts';
import { bar, formatDuration, scrollWindow, truncate } from './format.ts';

const h = React.createElement;

export function TownScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [sel, setSel] = useState(0);
  const [form, setForm] = useState<FormState | null>(null);
  const hall = state.townHall;
  const buildings = hall?.buildings ?? [];
  const idx = Math.min(sel, Math.max(0, buildings.length - 1));
  const building = buildings[idx];
  const construction = state.construction && state.construction.key === building?.key ? state.construction : null;

  useEffect(() => {
    void state.loadTownHall();
  }, [state]);
  useEffect(() => {
    onCapture(!!form);
  }, [form, onCapture]);

  const openConstruction = (b: TownBuilding) => {
    void state.openConstruction(b).then((c) => {
      if (!c) return;
      const labels = c.durations.map((d) => d.formatted || formatDuration(d.seconds));
      if (!labels.length) return state.error(`${c.name} has no construction durations.`);
      const def = c.durations.find((d) => d.seconds === c.defaultDuration) ?? c.durations[0];
      if (!def) return;
      const defLabel = def.formatted || formatDuration(def.seconds);
      setForm(
        makeForm(
          `Construction: ${c.name}`,
          [
            { key: 'duration', label: 'Duration', value: defLabel, kind: 'choice', options: labels },
            {
              key: 'paid',
              label: 'Paid by',
              value: 'Town treasury',
              kind: 'choice',
              options: ['Town treasury', 'Private treasury'],
            },
          ],
          (v) => {
            const d = c.durations.find((x) => (x.formatted || formatDuration(x.seconds)) === v.duration) ?? def;
            return `${d.xpMin}-${d.xpMax} XP · ${d.formatted} · ${v.paid?.startsWith('Town') ? `town treasury $${c.deposit}` : 'your cash / bank'}`;
          },
        ),
      );
    });
  };

  useInput(
    (input, key) => {
      if (form && construction) {
        const r = formKey(form, input, key);
        if (r === 'cancel') return setForm(null);
        if (r !== 'submit') return setForm(r);
        const v = formValues(form);
        const d =
          construction.durations.find((x) => (x.formatted || formatDuration(x.seconds)) === v.duration) ??
          construction.durations[0];
        setForm(null);
        if (d) void state.queueConstruction(d.seconds, v.paid === 'Private treasury' ? 'player' : 'town');
        return;
      }
      if (key.escape) return onExit();
      if (key.upArrow || input === 'k') return setSel(Math.max(0, idx - 1));
      if (key.downArrow || input === 'j') return setSel(Math.min(buildings.length - 1, idx + 1));
      if (key.pageUp) return setSel(Math.max(0, idx - 10));
      if (key.pageDown) return setSel(Math.min(buildings.length - 1, idx + 10));
      if (key.return && building) return openConstruction(building);
      if (input === 'u') void state.loadTownHall();
    },
    { isActive: active },
  );

  const leftW = Math.max(42, Math.min(64, Math.floor(width * 0.48)));
  const rightW = width - leftW;
  const listRows = Math.max(2, height - 4);
  const [start, end] = scrollWindow(idx, buildings.length, listRows);
  const bodyH = height;
  const list = h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height: bodyH, paddingX: 1 },
    h(
      Text,
      { bold: true, wrap: 'truncate' },
      `City hall · ${hall?.townName ?? (state.character.homeTown ? 'home town' : 'no home town')}`,
    ),
    h(
      Text,
      { dimColor: true, wrap: 'truncate' },
      hall ? `${buildings.length} building(s) · u refresh · Enter build` : 'Loading buildings…',
    ),
    ...buildings.slice(start, end).map((b, i) => {
      const stage = b.infinite ? `${b.stage}/∞` : `${b.stage}/${b.maxStage}`;
      const full = !b.infinite && b.stage >= b.maxStage;
      const prog = b.infinite || full ? '' : bar(b.buildPoints, b.nextStagePoints, 8);
      return h(
        Text,
        defined({ key: b.key, inverse: start + i === idx, color: full ? 'green' : undefined, wrap: 'truncate' }),
        `${truncate(b.name, Math.max(12, leftW - 25)).padEnd(Math.max(12, leftW - 25))} ${stage.padStart(6)} ${prog}`,
      );
    }),
    buildings.length === 0 && hall ? h(Text, { dimColor: true }, 'No buildings returned.') : null,
  );

  const detail = h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: rightW, height: bodyH, paddingX: 1 },
    building
      ? h(
          Text,
          { bold: true, wrap: 'truncate' },
          `${building.name} · level ${building.stage}${building.infinite ? '' : ` / ${building.maxStage}`}`,
        )
      : h(Text, { bold: true }, 'No building selected'),
    construction
      ? h(
          Text,
          { wrap: 'truncate' },
          `Labor points ${construction.jobPoints} · motivation ${Math.round(construction.motivation * 100)}% · build points ${construction.buildPoints}/${construction.buildPointLimit}`,
        )
      : building
        ? h(Text, { dimColor: true, wrap: 'truncate' }, 'Enter loads its construction detail.')
        : null,
    construction
      ? h(
          Text,
          { wrap: 'truncate' },
          `Town treasury $${construction.deposit}${construction.singleDuration ? ' · single duration' : ''}`,
        )
      : null,
    construction?.description ? h(Text, { dimColor: true, wrap: 'wrap' }, construction.description) : null,
    construction
      ? h(
          Text,
          { wrap: 'truncate' },
          `Skills: ${construction.skills.map((s) => `${s.skill} ×${s.coefficient}`).join(', ') || '—'} · malus ${construction.malus}`,
        )
      : null,
    construction
      ? h(Text, { wrap: 'truncate' }, `Durations: ${construction.durations.map((d) => d.formatted).join(' · ')}`)
      : null,
    h(Box, { flexGrow: 1 }),
    form
      ? h(FormView, { form, width: rightW - 4 })
      : h(Text, { dimColor: true, wrap: 'truncate' }, 'Enter start construction · ↑↓ building · u refresh · Esc back'),
  );
  return h(Box, { width, height }, list, detail);
}
