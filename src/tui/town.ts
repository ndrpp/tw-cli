// Town screen (g t): the city hall of your home town — building levels, progress and construction jobs.

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import type { BuildDuration, TownBuilding } from '../game/townhall.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { type FormState, FormView, formKey, formValues, makeForm } from './form.ts';
import { bar, formatDuration, scrollWindow, truncate } from './format.ts';

const createElement = React.createElement;

const durationLabel = (duration: BuildDuration): string => duration.formatted || formatDuration(duration.seconds);
const durationFor = (durations: readonly BuildDuration[], label: string): BuildDuration | undefined =>
  durations.find((duration) => durationLabel(duration) === label);

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

  const openConstruction = (buildingB: TownBuilding) => {
    void state.openConstruction(buildingB).then((candidate) => {
      if (!candidate) return;
      const labels = candidate.durations.map(durationLabel);
      if (!labels.length) return state.error(`${candidate.name} has no construction durations.`);
      const defaultDuration =
        candidate.durations.find((duration) => duration.seconds === candidate.defaultDuration) ??
        candidate.durations[0];
      if (!defaultDuration) return;
      const defaultLabel = durationLabel(defaultDuration);
      setForm(
        makeForm(
          `Construction: ${candidate.name}`,
          [
            { key: 'duration', label: 'Duration', value: defaultLabel, kind: 'choice', options: labels },
            {
              key: 'paid',
              label: 'Paid by',
              value: 'Town treasury',
              kind: 'choice',
              options: ['Town treasury', 'Private treasury'],
            },
          ],
          (values) => {
            const duration = durationFor(candidate.durations, values.duration ?? '') ?? defaultDuration;
            return `${duration.xpMin}-${duration.xpMax} XP · ${duration.formatted} · ${values.paid?.startsWith('Town') ? `town treasury $${candidate.deposit}` : 'your cash / bank'}`;
          },
        ),
      );
    });
  };

  useInput(
    (input, key) => {
      if (form && construction) {
        const otherForm = formKey(form, input, key);
        if (otherForm === 'cancel') return setForm(null);
        if (otherForm !== 'submit') return setForm(otherForm);
        const values = formValues(form);
        const duration = durationFor(construction.durations, values.duration ?? '') ?? construction.durations[0];
        setForm(null);
        if (duration)
          void state.queueConstruction(duration.seconds, values.paid === 'Private treasury' ? 'player' : 'town');
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
  const list = createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height: bodyH, paddingX: 1 },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `City hall · ${hall?.townName ?? (state.character.homeTown ? 'home town' : 'no home town')}`,
    ),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      hall ? `${buildings.length} building(s) · u refresh · Enter build` : 'Loading buildings…',
    ),
    ...buildings.slice(start, end).map((buildingB, index) => {
      const stage = buildingB.infinite ? `${buildingB.stage}/∞` : `${buildingB.stage}/${buildingB.maxStage}`;
      const full = !buildingB.infinite && buildingB.stage >= buildingB.maxStage;
      const prog = buildingB.infinite || full ? '' : bar(buildingB.buildPoints, buildingB.nextStagePoints, 8);
      return createElement(
        Text,
        defined({
          key: buildingB.key,
          inverse: start + index === idx,
          color: full ? 'green' : undefined,
          wrap: 'truncate',
        }),
        `${truncate(buildingB.name, Math.max(12, leftW - 25)).padEnd(Math.max(12, leftW - 25))} ${stage.padStart(6)} ${prog}`,
      );
    }),
    buildings.length === 0 && hall ? createElement(Text, { dimColor: true }, 'No buildings returned.') : null,
  );

  const detail = createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: rightW, height: bodyH, paddingX: 1 },
    building
      ? createElement(
          Text,
          { bold: true, wrap: 'truncate' },
          `${building.name} · level ${building.stage}${building.infinite ? '' : ` / ${building.maxStage}`}`,
        )
      : createElement(Text, { bold: true }, 'No building selected'),
    construction
      ? createElement(
          Text,
          { wrap: 'truncate' },
          `Labor points ${construction.jobPoints} · motivation ${Math.round(construction.motivation * 100)}% · build points ${construction.buildPoints}/${construction.buildPointLimit}`,
        )
      : building
        ? createElement(Text, { dimColor: true, wrap: 'truncate' }, 'Enter loads its construction detail.')
        : null,
    construction
      ? createElement(
          Text,
          { wrap: 'truncate' },
          `Town treasury $${construction.deposit}${construction.singleDuration ? ' · single duration' : ''}`,
        )
      : null,
    construction?.description ? createElement(Text, { dimColor: true, wrap: 'wrap' }, construction.description) : null,
    construction
      ? createElement(
          Text,
          { wrap: 'truncate' },
          `Skills: ${construction.skills.map((source) => `${source.skill} ×${source.coefficient}`).join(', ') || '—'} · malus ${construction.malus}`,
        )
      : null,
    construction
      ? createElement(
          Text,
          { wrap: 'truncate' },
          `Durations: ${construction.durations.map((data) => data.formatted).join(' · ')}`,
        )
      : null,
    createElement(Box, { flexGrow: 1 }),
    form
      ? createElement(FormView, { form, width: rightW - 4 })
      : createElement(
          Text,
          { dimColor: true, wrap: 'truncate' },
          'Enter start construction · ↑↓ building · u refresh · Esc back',
        ),
  );
  return createElement(Box, { width, height }, list, detail);
}
