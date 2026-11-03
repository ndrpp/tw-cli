// Small form for the TUI: a few labelled fields edited in place (telegrams, bank deposit, bids, market offers).
// Typing edits the focused field; Tab / ↑ ↓ move; Enter goes to the next field and submits on the last one;
// choice fields cycle with ← → or Space; Esc cancels.
import React from 'react';
import { Box, Text } from 'ink';
import { truncate } from './format.ts';

const h = React.createElement;

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
  note?: (values: Record<string, string>) => string;
}

export interface KeyLike {
  return?: boolean; escape?: boolean; tab?: boolean; shift?: boolean; backspace?: boolean; delete?: boolean;
  upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; ctrl?: boolean; meta?: boolean;
}

export const formValues = (f: FormState): Record<string, string> => Object.fromEntries(f.fields.map((x) => [x.key, x.value]));

export function makeForm(title: string, fields: FormField[], note?: FormState['note']): FormState {
  return { title, fields, focus: 0, note };
}

/** Applies one key press. Returns the new form, 'submit', or 'cancel'. */
export function formKey(f: FormState, input: string, key: KeyLike): FormState | 'submit' | 'cancel' {
  if (key.escape) return 'cancel';
  const field = f.fields[f.focus]!;
  const set = (value: string): FormState => ({ ...f, fields: f.fields.map((x, i) => (i === f.focus ? { ...x, value } : x)) });
  if (key.return) return f.focus >= f.fields.length - 1 ? 'submit' : { ...f, focus: f.focus + 1 };
  if (key.tab || key.downArrow) return { ...f, focus: key.shift ? (f.focus + f.fields.length - 1) % f.fields.length : (f.focus + 1) % f.fields.length };
  if (key.upArrow) return { ...f, focus: (f.focus + f.fields.length - 1) % f.fields.length };
  if (field.kind === 'choice') {
    const opts = field.options ?? [];
    const i = Math.max(0, opts.indexOf(field.value));
    if (key.leftArrow) return set(opts[(i + opts.length - 1) % opts.length] ?? field.value);
    if (key.rightArrow || input === ' ') return set(opts[(i + 1) % opts.length] ?? field.value);
    return f;
  }
  if (key.backspace || key.delete) return set(field.value.slice(0, -1));
  if (!input || key.ctrl || key.meta) return f;
  if (field.kind === 'number') {
    const digits = input.replace(/[^0-9]/g, '');
    return digits ? set(field.value + digits) : f;
  }
  return set(field.value + input);
}

export function FormView({ form, width }: { form: FormState; width: number }) {
  const labelW = Math.min(14, Math.max(...form.fields.map((x) => x.label.length)) + 1);
  const note = form.note?.(formValues(form));
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, width },
    h(Text, { bold: true, color: 'yellow', wrap: 'truncate' }, form.title),
    ...form.fields.map((x, i) => {
      const focused = i === form.focus;
      const shown = x.kind === 'choice' ? `‹ ${x.value} ›` : `${x.value}${focused ? '▏' : ''}`;
      return h(Text, { key: x.key, wrap: 'truncate' },
        h(Text, { color: focused ? 'cyan' : undefined, bold: focused }, `${x.label.padEnd(labelW)} `),
        h(Text, { inverse: focused && x.kind === 'choice' }, truncate(shown, Math.max(4, width - labelW - 5)).trimEnd()),
        x.hint && focused ? h(Text, { dimColor: true }, `  ${x.hint}`) : '');
    }),
    note ? h(Text, { color: 'cyan', wrap: 'truncate' }, note) : null,
    h(Text, { dimColor: true, wrap: 'truncate' }, 'Enter next/submit · Tab ↑↓ field · ← → choice · Esc cancel'),
  );
}

/** Splits text into lines of at most `width` characters (words kept whole when possible). */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (word.length > width) {
        if (line) out.push(line);
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        line = out.pop() ?? '';
        continue;
      }
      if ((line ? line.length + 1 : 0) + word.length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}
