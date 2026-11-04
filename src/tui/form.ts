// Small form for the TUI: a few labelled fields edited in place (telegrams, bank deposit, bids, market offers).
// Typing edits the focused field; Tab / ↑ ↓ move; Enter goes to the next field and submits on the last one;
// choice fields cycle with ← → or Space; Esc cancels.

import { Box, Text } from 'ink';
import React from 'react';
import type { Segment } from '../game/chatlinks.ts';
import { defined } from '../util/defined.ts';
import { truncate } from './format.ts';

const createElement = React.createElement;

export interface FormField {
  key: string;
  label: string;
  value: string;
  /** number: digits only · choice: one of `options` · text: anything. */
  kind?: 'text' | 'number' | 'choice';
  options?: string[];
  hint?: string;
}

export interface FormState {
  title: string;
  fields: FormField[];
  focus: number;
  /** Shown under the fields (e.g. a computed fee). */
  note?: ((values: Record<string, string>) => string) | undefined;
}

export interface KeyLike {
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  shift?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export const formValues = (form: FormState): Record<string, string> =>
  Object.fromEntries(form.fields.map((field) => [field.key, field.value]));

export function makeForm(title: string, fields: FormField[], note?: FormState['note']): FormState {
  return { title, fields, focus: 0, note };
}

/** Applies one key press. Returns the new form, 'submit', or 'cancel'. */
export function formKey(form: FormState, input: string, key: KeyLike): FormState | 'submit' | 'cancel' {
  if (key.escape) {
    return 'cancel';
  }
  const field = form.fields[form.focus];
  if (!field) {
    return 'cancel';
  }
  const set = (value: string): FormState => ({
    ...form,
    fields: form.fields.map((candidate, innerIndex) =>
      innerIndex === form.focus ? { ...candidate, value } : candidate,
    ),
  });
  if (key.return) {
    return form.focus >= form.fields.length - 1 ? 'submit' : { ...form, focus: form.focus + 1 };
  }
  if (key.tab || key.downArrow) {
    return {
      ...form,
      focus: key.shift
        ? (form.focus + form.fields.length - 1) % form.fields.length
        : (form.focus + 1) % form.fields.length,
    };
  }
  if (key.upArrow) {
    return { ...form, focus: (form.focus + form.fields.length - 1) % form.fields.length };
  }
  if (field.kind === 'choice') {
    const options = field.options ?? [];
    const index = Math.max(0, options.indexOf(field.value));
    if (key.leftArrow) {
      return set(options[(index + options.length - 1) % options.length] ?? field.value);
    }
    if (key.rightArrow || input === ' ') {
      return set(options[(index + 1) % options.length] ?? field.value);
    }
    return form;
  }
  if (key.backspace || key.delete) {
    return set(field.value.slice(0, -1));
  }
  if (!input || key.ctrl || key.meta) {
    return form;
  }
  if (field.kind === 'number') {
    const digits = input.replace(/[^0-9]/g, '');
    return digits ? set(field.value + digits) : form;
  }
  return set(field.value + input);
}

export function FormView({ form, width }: { form: FormState; width: number }) {
  const labelW = Math.min(14, Math.max(...form.fields.map((xCoord) => xCoord.label.length)) + 1);
  const note = form.note?.(formValues(form));
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, width },
    createElement(Text, { bold: true, color: 'yellow', wrap: 'truncate' }, form.title),
    ...form.fields.map((xCoord, innerIndex) => {
      const focused = innerIndex === form.focus;
      const shown = xCoord.kind === 'choice' ? `‹ ${xCoord.value} ›` : `${xCoord.value}${focused ? '▏' : ''}`;
      return createElement(
        Text,
        { key: xCoord.key, wrap: 'truncate' },
        createElement(
          Text,
          defined({ color: focused ? 'cyan' : undefined, bold: focused }),
          `${xCoord.label.padEnd(labelW)} `,
        ),
        createElement(
          Text,
          { inverse: focused && xCoord.kind === 'choice' },
          truncate(shown, Math.max(4, width - labelW - 5)).trimEnd(),
        ),
        xCoord.hint && focused ? createElement(Text, { dimColor: true }, `  ${xCoord.hint}`) : '',
      );
    }),
    note ? createElement(Text, { color: 'cyan', wrap: 'truncate' }, note) : null,
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      'Enter next/submit · Tab ↑↓ field · ← → choice · Esc cancel',
    ),
  );
}

/** wrap() for coloured runs: same word breaking, each word keeps its run's colour. */
export function wrapSegments(segs: Segment[], width: number): Segment[][] {
  const out: Segment[][] = [];
  let line: Segment[] = [];
  let len = 0;
  const put = (text: string, color?: string) => {
    const last = line[line.length - 1];
    if (last && last.color === color) {
      last.text += text;
    } else {
      line.push({ text, color });
    }
    len += text.length;
  };
  const words = segs.flatMap((segment) =>
    segment.text
      .split(/\s+/)
      .filter(Boolean)
      .map((textValue) => ({ w: textValue, color: segment.color })),
  );
  for (const { w: textValue, color } of words) {
    for (let innerIndex = 0; innerIndex < textValue.length; innerIndex += width) {
      const piece = textValue.slice(innerIndex, innerIndex + width);
      if (len && len + 1 + piece.length > width) {
        out.push(line);
        line = [];
        len = 0;
      }
      if (len) {
        put(' ', line.at(-1)?.color === color ? color : undefined);
      }
      put(piece, color);
    }
  }
  out.push(line);
  return out;
}

/** Splits text into lines of at most `width` characters (words kept whole when possible). */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) {
        continue;
      }
      if (word.length > width) {
        if (line) {
          out.push(line);
        }
        for (let innerIndex = 0; innerIndex < word.length; innerIndex += width) {
          out.push(word.slice(innerIndex, innerIndex + width));
        }
        line = out.pop() ?? '';
        continue;
      }
      if ((line ? line.length + 1 : 0) + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}
