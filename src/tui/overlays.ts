import React from 'react';
import { Box, Text } from 'ink';
import type { GameState } from '../game/state.ts';
import { POI_STYLE, type Poi } from '../game/poi.ts';
import { formatDuration, money, truncate } from './format.ts';
import type { Hotel } from '../game/hotel.ts';

const h = React.createElement;

export type Mode = 'main' | 'map' | 'char' | 'quests' | 'mail' | 'trade' | 'duels' | 'chat';
/** Full screens that handle their own keys (global shortcuts still work unless they capture input). */
export const SCREEN_MODES: Mode[] = ['char', 'quests', 'mail', 'trade', 'duels', 'chat'];

const SHORTCUTS: Record<Mode | 'global', [string, string][]> = {
  global: [
    ['?', 'show / hide this help'],
    ['m', 'toggle map ⇄ jobs view'],
    ['i', 'character: inventory & skills'],
    ['o', 'quests: log & quest givers'],
    ['M', 'mail: reports & telegrams'],
    ['$', 'trade: bank, shops, market, buy orders'],
    ['D', 'duels: NPCs & players'],
    ['C', 'chat (needs live updates)'],
    ['s', 'sleep: hotel of your town (map: selected town)'],
    ['p', 'points of interest (jump on map)'],
    ['u', 'refresh (queue / inventory / quests)'],
    ['L', 'live updates on / off'],
    ['r', 'reload game state (like F5)'],
    ['A', 'account: fingerprint & login setup'],
    ['q', 'quit'],
  ],
  main: [
    ['Tab', 'switch jobs ⇄ task queue'],
    ['↑ ↓  j k', 'move · PgUp/PgDn ×10'],
    ['/', 'filter jobs by name or product they drop'],
    ['S', 'sort jobs: name · XP · $ · luck · distance'],
    ['a', 'show jobs without enough labor points'],
    ['1 2 3', 'start job: short / medium / long'],
    ['c  Del', 'cancel selected task (confirm y)'],
  ],
  map: [
    ['← ↑ → ↓  h j k l', 'pan · Shift / PgUp PgDn ×10'],
    ['+  -', 'zoom in / out'],
    ['.  c', 'centre on you · g on queue end'],
    ['/', 'find job or town, jump to nearest'],
    ['Enter', 'select things under the cursor'],
    ['1 2 3', '(selected job) start here'],
    ['w', '(town, fort, quest giver) walk there'],
    ['o', '(quest giver) show its quests'],
    ['x', 'clear quest job markers (!)'],
    ['v', 'map layers: choose what is drawn'],
    ['s', '(town) sleep in its hotel'],
    ['Esc', 'back to the map cursor'],
  ],
  char: [
    ['← →', 'Inventory ⇄ Skills'],
    ['Tab', 'equipped ⇄ bag'],
    ['↑ ↓  j k', 'move · PgUp/PgDn ×10'],
    ['Enter  e', '(bag) wear item'],
    ['U', '(bag) use item: drinks, buffs, bags…'],
    ['Enter  x', '(equipped) take off'],
    ['/  t T', 'search bag · cycle item type'],
    ['+  -', '(skills) plan a point'],
    ['Enter', '(skills) save planned points (y)'],
    ['Esc', 'discard plan / back'],
  ],
  quests: [
    ['Tab', 'quest log ⇄ quest givers'],
    ['↑ ↓  j k', 'move · J K scroll text'],
    ['Enter', 'finish (log) · open / accept (givers)'],
    ['a', 'accept quest'],
    ['x', 'cancel quest (confirm y)'],
    ['w', 'walk to the quest giver'],
    ['g', 'mark jobs that drop needed items on the map'],
    ['R', 'route planner: best jobs for quest items'],
    ['  1 2 3', 'route for this quest / its chain / all quests'],
    ['  e', 'optimize per energy ⇄ per time'],
    ['  Enter', 'queue the route (as many as fit, confirm y)'],
    ['  g', 'show route jobs on the map'],
    ['Esc', 'back'],
  ],
  mail: [
    ['Tab  ← →', 'reports ⇄ telegrams'],
    ['↑ ↓  j k', 'move · J K scroll the open one'],
    ['Enter', 'read'],
    ['< >', 'previous / next page'],
    ['f', '(reports) cycle category'],
    ['R', '(telegrams) reply'],
    ['n', 'write a new telegram'],
    ['d', 'delete (confirm y)'],
    ['Esc', 'close / back'],
  ],
  trade: [
    ['← →', 'bank · shops · market · my market'],
    ['Enter', 'deposit · buy · buy now / sell now · pick up'],
    ['Tab', '(shops, market) sell from your bag'],
    ['/', '(market) search: name, for sale / buy orders, category, level, usable, consumable'],
    ['t', '(market) switch between goods for sale and buy orders'],
    ['b', '(market) bid, or ask a price on a buy order'],
    ['n', '(market) place a buy order (item, amount, prices, days)'],
    ['w', '(market) walk to the offer\'s town'],
    ['< >', '(market) previous / next page'],
    ['x', '(my market) withdraw a running offer / buy order'],
    ['P', '(my market) pick up everything finished in this town'],
    ['Esc', 'back'],
  ],
  duels: [
    ['↑ ↓  j k', 'move'],
    ['Enter', 'NPC: fight now · player: queue a duel (confirm y)'],
    ['u', 'refresh'],
    ['Esc', 'back'],
  ],
  chat: [
    ['↑ ↓  j k', 'room / whisper conversation'],
    ['Enter', 'write a message (Enter sends, Esc cancels)'],
    ['t', 'whisper to a player'],
    ['Esc', 'back'],
  ],
};

const MODE_TITLE: Record<Mode, string> = { main: 'Jobs & queue', map: 'Map', char: 'Character', quests: 'Quests', mail: 'Mail', trade: 'Trade', duels: 'Duels', chat: 'Chat' };

const LEGEND: [string, string, string][] = [
  ['@', 'green', 'you'], ['1-9', 'cyan', 'queued tasks'], ['H', 'cyan', 'home town'], ['T', 'white', 'town'],
  ['t', 'gray', 'empty town site'], ['F', 'red', 'fort'], ['?', 'magenta', 'quest giver'], ['*', 'yellowBright', 'gold/silver job'],
  ['j', 'yellow', 'job you can do (gray: not yet)'], ['!', 'magentaBright', 'job for the selected quest'], ['$', 'green', 'market'], ['&', 'magentaBright', 'travelling fair'],
  ['f', 'blue', 'friends'], ['p', 'blueBright', 'players'], ['┊┄', 'gray', 'county border'],
];

export function HelpOverlay({ mode, width, height }: { mode: Mode; width: number; height: number }) {
  const row = (prefix: string) => ([k, d]: [string, string], i: number) =>
    h(Text, { key: `${prefix}${i}`, wrap: 'truncate' }, h(Text, { color: 'yellow' }, k.padEnd(12)), d);
  return h(Box, { flexDirection: 'column', borderStyle: 'double', borderColor: 'yellow', paddingX: 2, width, height },
    h(Text, { bold: true, color: 'yellow' }, `Keyboard shortcuts · ${MODE_TITLE[mode].toLowerCase()}   (any key closes)`),
    h(Text, null, ' '),
    h(Box, { gap: 4 },
      h(Box, { flexDirection: 'column' },
        h(Text, { bold: true }, MODE_TITLE[mode]),
        ...SHORTCUTS[mode].map(row('m')),
      ),
      h(Box, { flexDirection: 'column' },
        h(Text, { bold: true }, 'Everywhere'),
        ...SHORTCUTS.global.map(row('g')),
      ),
      mode === 'map'
        ? h(Box, { flexDirection: 'column' },
          h(Text, { bold: true }, 'Map legend'),
          ...LEGEND.map(([ch, color, d], i) => h(Text, { key: i, wrap: 'truncate' }, h(Text, { color, bold: true }, ch.padEnd(5)), d)))
        : null,
    ),
  );
}

export function PoiOverlay(props: {
  state: GameState;
  pois: (Poi & { dist: number })[];
  selected: number;
  filter: string;
  width: number;
  height: number;
}) {
  const { state, pois, selected, filter, width, height } = props;
  const listRows = Math.max(3, height - 3);
  const start = Math.max(0, Math.min(selected - Math.floor(listRows / 2), pois.length - listRows));
  const travelPerPx = state.travelSpeed * state.character.speed;
  return h(Box, { flexDirection: 'column', borderStyle: 'double', borderColor: 'cyan', paddingX: 1, width, height },
    h(Text, { bold: true, color: 'cyan', wrap: 'truncate' },
      `Points of interest · ${pois.length}  ·  type to filter: ${filter}▏  ·  Enter jump · Esc close`),
    ...pois.slice(start, start + listRows).map((p, i) => {
      const idx = start + i;
      const st = POI_STYLE[p.kind];
      return h(Text, { key: idx, inverse: idx === selected, wrap: 'truncate' },
        h(Text, { color: st.color, bold: true }, ` ${st.ch} `),
        `${truncate(p.label, Math.max(10, width - 40))} `,
        h(Text, { dimColor: true }, `${st.name.padEnd(14)} ${formatDuration(p.dist * travelPerPx).padStart(8)}`));
    }),
    pois.length === 0 ? h(Text, { dimColor: true }, 'Nothing matches.') : null,
  );
}

export function HotelOverlay({ state, hotel, selected, width, height }: { state: GameState; hotel: Hotel | null; selected: number; width: number; height: number }) {
  if (!hotel) {
    return h(Box, { borderStyle: 'double', borderColor: 'blue', paddingX: 2, width, height }, h(Text, { color: 'yellow' }, 'Loading hotel…'));
  }
  const c = state.character;
  return h(Box, { flexDirection: 'column', borderStyle: 'double', borderColor: 'blue', paddingX: 2, width, height },
    h(Text, { bold: true, color: 'blue' }, `Hotel · ${hotel.townName} (level ${hotel.level})${hotel.own ? ' · your town' : ''}`),
    h(Text, { dimColor: true, wrap: 'truncate' }, `Distance ${hotel.waytime || '—'} · Duration 8 hours${hotel.attackable ? ` · can be attacked until ${hotel.attackable}` : ''}`),
    h(Text, { dimColor: true, wrap: 'truncate' }, `Now: energy ${c.energy}/${c.maxEnergy} · health ${c.health}/${c.maxHealth}`),
    h(Text, null, ' '),
    ...hotel.rooms.map((r, i) => h(Text, { key: r.key, inverse: i === selected, color: r.available ? undefined : 'gray', wrap: 'truncate' },
      `${'★'.repeat(r.level).padEnd(5)} ${truncate(r.name, 22)} ${`+${r.energy} energy`.padStart(11)} ${`+${r.health} HP`.padStart(9)}  `,
      h(Text, { color: r.free ? 'green' : 'yellow' }, r.free ? 'free' : money(r.costs)),
      r.available ? '' : '  (not available)')),
    h(Text, null, ' '),
    h(Text, { dimColor: true }, 'Enter sleep here (queued like a job) · Esc close'),
  );
}
