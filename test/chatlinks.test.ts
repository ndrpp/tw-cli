import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatSegments } from '../src/game/chatlinks.ts';
import { wrapSegments } from '../src/tui/form.ts';

const names = {
  item: (id: number) => (id === 42085000 ? { name: 'Golden gun', set: true } : { name: `item ${id}` }),
  quest: (id: number) => (id === 7 ? 'The letter' : undefined),
};

test('chat item and quest links become coloured names', () => {
  assert.deepEqual(chatSegments('wtb [item=42085000] or [item=1000] for [quest=7] [quest=8] [town=3]', names), [
    { text: 'wtb ', color: undefined },
    { text: '[Golden gun]', color: 'greenBright' },
    { text: ' or ', color: undefined },
    { text: '[item 1000]', color: 'yellow' },
    { text: ' for ', color: undefined },
    { text: '[The letter]', color: 'magentaBright' },
    { text: ' ', color: undefined },
    { text: '[quest 8]', color: 'magentaBright' },
    { text: ' [town=3]', color: undefined },
  ]);
});

test('wrapSegments keeps colours across line breaks', () => {
  const lines = wrapSegments([{ text: 'Ang: wtb ' }, { text: '[Golden gun]', color: 'yellow' }, { text: ' now' }], 12);
  assert.deepEqual(lines.map((l) => l.map((s) => s.text).join('')), ['Ang: wtb', '[Golden gun]', 'now']);
  assert.deepEqual(lines[1], [{ text: '[Golden gun]', color: 'yellow' }]);
  assert.deepEqual(wrapSegments([], 10), [[]]);
});
