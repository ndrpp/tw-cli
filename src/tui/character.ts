// Character screen: Inventory (equipped slots + bag) and Skills (attributes/skills, spend free points).
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { formKey, formValues, FormView, makeForm, type FormState } from './form.ts';
import type { GameState } from '../game/state.ts';
import { bonusText, SLOT_NAMES, WEAR_SLOTS, type ItemDef } from '../game/items.ts';
import type { ItemStats, StatKind } from '../game/itemstats.ts';
import {
  adjustPlan, ATTRIBUTE_COLOR, ATTRIBUTE_OF, ATTRIBUTES, emptyPlan, NAMES, plannedDelta, planUsed, SKILLS_OF, type SkillPlan,
} from '../game/skills.ts';
import type { BagItem } from '../game/inventory.ts';
import { money, scrollWindow, truncate } from './format.ts';

const h = React.createElement;

export type CharTab = 'inventory' | 'skills';
const TYPE_FILTERS = ['all', ...WEAR_SLOTS, 'collection', 'recipe'];

export interface ScreenProps {
  state: GameState;
  width: number;
  height: number;
  /** True while the screen takes text input / confirmation (global shortcuts off). */
  onCapture: (capturing: boolean) => void;
  onExit: () => void;
  /** False while an overlay covers the screen. */
  active?: boolean;
}

const TOTAL_LABEL: Record<string, string> = {
  damage_min: 'min damage', damage_max: 'max damage', job: 'labor points', speed: '% speed', luck: '% luck', dollar: '% money',
  experience: '% experience', drop: '% drop chance', regen: '% regeneration', pray: 'praying', damage: 'damage',
  fort_offense: 'attack (fort)', fort_defense: 'defense (fort)', fort_resistance: 'resistance (fort)',
  fort_offense_sector: 'attack (sector)', fort_defense_sector: 'defense (sector)', fort_damage_sector: 'damage (sector)',
};
const PERCENT_KEYS = new Set(['luck', 'dollar', 'experience', 'drop', 'regen']);

/** Difference if `item` replaced `worn`, from the web's computed totals (upgrade + per-level values). */
export function gearDelta(item: ItemStats | null | undefined, worn: ItemStats | null | undefined): string {
  if (!item) return '';
  const keys = new Set([...Object.keys(item.totals), ...Object.keys(worn?.totals ?? {})]);
  const parts: string[] = [];
  for (const k of keys) {
    let diff = (item.totals[k] ?? 0) - (worn?.totals[k] ?? 0);
    if (PERCENT_KEYS.has(k)) diff *= 100;
    diff = Math.round(diff * 100) / 100;
    if (diff) parts.push(`${diff > 0 ? '+' : ''}${diff} ${NAMES[k] ?? TOTAL_LABEL[k] ?? k}`);
  }
  return parts.join(', ');
}

/** What `/` matches: name, slot, set, "L<level>", and bonus texts ("trading", "+5 construction"). */
function itemSearchText(state: GameState, it: BagItem): string {
  const d = state.items?.get(it.itemId);
  return [state.itemName(it.itemId), SLOT_NAMES[d?.type ?? it.type] ?? it.type, d?.set ?? '', d?.level ? `L${d.level}` : '', d ? bonusText(d, it.itemId, state.statContext) : '']
    .join(' | ').toLowerCase();
}

function bagRows(state: GameState, typeFilter: string, filter: string): BagItem[] {
  const f = filter.trim().toLowerCase();
  return state.inventory.items()
    .filter((it) => typeFilter === 'all' || (state.items?.get(it.itemId)?.type ?? it.type) === typeFilter)
    .filter((it) => !f || itemSearchText(state, it).includes(f))
    .sort((a, b) => {
      const ta = WEAR_SLOTS.indexOf(a.type), tb = WEAR_SLOTS.indexOf(b.type);
      if (ta !== tb) return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb);
      return state.itemName(a.itemId).localeCompare(state.itemName(b.itemId));
    });
}

export function CharacterScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [tab, setTab] = useState<CharTab>('inventory');
  const [pane, setPane] = useState<'wear' | 'bag'>('bag');
  const [wearSel, setWearSel] = useState(0);
  const [bagSel, setBagSel] = useState(0);
  const [typeIdx, setTypeIdx] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [skillSel, setSkillSel] = useState(0);
  const [plan, setPlan] = useState<SkillPlan>(emptyPlan);
  const [confirm, setConfirm] = useState(false);
  const [detailScroll, setDetailScroll] = useState(0);
  const [useForm, setUseForm] = useState<{ itemId: number; form: FormState } | null>(null);

  useEffect(() => {
    void (async () => {
      await state.loadItems();
      await state.refreshSkills();
    })();
  }, [state]);
  useEffect(() => {
    onCapture(filtering || confirm || !!useForm);
  }, [filtering, confirm, useForm]);

  const typeFilter = TYPE_FILTERS[typeIdx]!;
  // New selection → detail panel back to the top.
  useEffect(() => setDetailScroll(0), [bagSel, wearSel, pane, typeIdx, filter]);
  const rows = useMemo(() => bagRows(state, typeFilter, filter), [state, state.items, state.inventory, state.inventory.bag.size, typeFilter, filter, state.log.length]);
  const bagIdx = Math.min(bagSel, Math.max(0, rows.length - 1));
  const skillRows = ATTRIBUTES.flatMap((a) => [a, ...SKILLS_OF[a]]);
  const used = planUsed(plan);

  useInput((input, key) => {
    if (useForm) {
      const r = formKey(useForm.form, input, key);
      if (r === 'cancel') return setUseForm(null);
      if (r !== 'submit') return setUseForm({ ...useForm, form: r });
      const n = Math.max(1, Number(formValues(useForm.form).count) || 1);
      setUseForm(null);
      return void state.useItem(useForm.itemId, n);
    }
    if (filtering) {
      if (key.return || key.escape) setFiltering(false);
      if (key.escape) setFilter('');
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.return) setFilter((f) => f + input);
      setBagSel(0);
      return;
    }
    if (confirm) {
      setConfirm(false);
      if (input === 'y') void state.saveSkills(plan).then((ok) => ok && setPlan(emptyPlan()));
      return;
    }
    if (key.leftArrow || key.rightArrow) return setTab((t) => (t === 'inventory' ? 'skills' : 'inventory'));
    if (key.escape) {
      if (tab === 'skills' && (used.attributes || used.skills)) {
        setPlan(emptyPlan());
        return state.info('Discarded planned skill points.');
      }
      if (tab === 'inventory' && filter) return setFilter('');
      return onExit();
    }
    const up = key.upArrow || input === 'k';
    const down = key.downArrow || input === 'j';
    const step = key.pageUp || key.pageDown ? 10 : 1;
    if (tab === 'skills') {
      if (up || key.pageUp) return setSkillSel((i) => Math.max(0, i - step));
      if (down || key.pageDown) return setSkillSel((i) => Math.min(skillRows.length - 1, i + step));
      const k = skillRows[skillSel]!;
      if (input === '+' || input === '=') {
        const p = structuredClone(plan);
        if (adjustPlan(p, state.skills, k, 1)) setPlan(p);
        else state.error(k in SKILLS_OF ? 'No free attribute points.' : 'No free skill points.');
        return;
      }
      if (input === '-' || input === '_') {
        const p = structuredClone(plan);
        if (adjustPlan(p, state.skills, k, -1)) setPlan(p);
        return;
      }
      if (key.return && (used.attributes || used.skills)) return setConfirm(true);
      return;
    }
    if (input === 'J') return setDetailScroll((n) => n + 3);
    if (input === 'K') return setDetailScroll((n) => Math.max(0, n - 3));
    if (key.tab) return setPane((p) => (p === 'bag' ? 'wear' : 'bag'));
    if (input === '/') {
      setPane('bag');
      onCapture(true); // before the next keystroke reaches the global shortcuts
      return setFiltering(true);
    }
    if (input === 't') {
      setBagSel(0);
      return setTypeIdx((i) => (i + 1) % TYPE_FILTERS.length);
    }
    if (input === 'T') {
      setBagSel(0);
      return setTypeIdx((i) => (i + TYPE_FILTERS.length - 1) % TYPE_FILTERS.length);
    }
    if (pane === 'wear') {
      if (up || key.pageUp) return setWearSel((i) => Math.max(0, i - step));
      if (down || key.pageDown) return setWearSel((i) => Math.min(WEAR_SLOTS.length - 1, i + step));
      if ((key.return || input === 'x') && state.inventory.wear.has(WEAR_SLOTS[wearSel]!)) return void state.unwear(WEAR_SLOTS[wearSel]!);
      return;
    }
    if (up || key.pageUp) return setBagSel(Math.max(0, bagIdx - step));
    if (down || key.pageDown) return setBagSel(Math.min(rows.length - 1, bagIdx + step));
    const it = rows[bagIdx];
    if (input === 'U' && it) {
      const d = state.items?.get(it.itemId);
      if (d && d.usetype === 'none') return state.error(`${d.name} cannot be used.`);
      const many = it.count > 1 && d?.usetype !== 'single';
      return setUseForm({
        itemId: it.itemId,
        form: makeForm(`Use ${state.itemName(it.itemId)}${it.count > 1 ? ` (you have ${it.count})` : ''}?`, [
          many ? { key: 'count', label: 'Number of items', value: '1', kind: 'number', hint: `max ${it.count}` } : { key: 'count', label: 'Use', value: '1', kind: 'choice', options: ['1'] },
        ]),
      });
    }
    if ((key.return || input === 'e') && it) {
      const type = state.items?.get(it.itemId)?.type ?? it.type;
      if (!WEAR_SLOTS.includes(type)) return state.error(`${state.itemName(it.itemId)} can't be worn.`);
      return void state.wear(it.itemId);
    }
  }, { isActive: active });

  const tabs = h(Text, { wrap: 'truncate' },
    ...(['inventory', 'skills'] as CharTab[]).map((t) =>
      h(Text, { key: t, inverse: tab === t, bold: tab === t, color: tab === t ? 'cyan' : undefined }, ` ${t === 'inventory' ? 'Inventory' : 'Skills'} `)),
    h(Text, { dimColor: true }, '   ← → switch · Esc back'),
    state.items ? null : h(Text, { color: 'yellow' }, '   loading item data…'));

  const formH = useForm ? useForm.form.fields.length + 4 : 0;
  const body = tab === 'inventory'
    ? h(InventoryTab, { state, width, height: height - 1 - formH, pane, wearSel, rows, bagIdx, typeFilter, filter, filtering, detailScroll })
    : h(SkillsTab, { state, width, height: height - 1, rows: skillRows, selected: skillSel, plan, confirm });
  return h(Box, { flexDirection: 'column', width, height }, tabs, body, useForm ? h(FormView, { form: useForm.form, width }) : null);
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (line && (line + ' ' + word).length > width) {
        out.push(line);
        line = word;
      } else line = line ? line + ' ' + word : word;
    }
    out.push(line);
  }
  return out;
}

const TYPE_TITLE: Record<string, string> = {
  head: 'Headgear', neck: 'Neckband', left_arm: 'Gun', right_arm: 'Duelling weapon', body: 'Clothing', foot: 'Shoes',
  animal: 'Animal', yield: 'Product', belt: 'Belt', pants: 'Pants', recipe: 'Recipe',
};
const SUB_TITLE: Record<string, string> = { shot: 'Firearm', hand: 'Melee weapon' };
const CLASS_TITLE: Record<string, string> = { greenhorn: 'Greenhorn', duelist: 'Dueller', adventurer: 'Adventurer', worker: 'Worker', soldier: 'Soldier' };
const STAT_COLOR: Record<StatKind, Record<string, unknown>> = {
  damage: { color: 'red' }, attribute: { color: 'green', bold: true }, skill: { color: 'green' }, other: { color: 'green' },
  speed: { color: 'cyan' }, fort: { color: 'blue' },
};

/** Bonus lines as the web popup computes them (upgrade level, per-level values for this character). */
export function bonusLines(stats: ItemStats | null | undefined): string[] {
  return stats ? stats.lines.map((l) => l.text) : [];
}

export function ItemDetail(p: { state: GameState; itemId: number | undefined; count: number; wornId: number | undefined; compare: boolean; pane: 'wear' | 'bag'; width: number; height: number; scroll: number }) {
  const { state, itemId, count, wornId, compare, pane, width, height, scroll } = p;
  const def = itemId !== undefined ? state.items?.get(itemId) : undefined;
  const worn = wornId !== undefined ? state.items?.get(wornId) : undefined;
  const w = Math.max(10, width - 4);
  const lines: React.ReactNode[] = [];
  const add = (text: string, props: Record<string, unknown> = {}) => {
    for (const l of wrapText(text, w)) lines.push(h(Text, { key: lines.length, ...props }, l || ' '));
  };
  const gap = () => lines.push(h(Text, { key: lines.length }, ' '));
  const c = state.character;
  if (itemId === undefined) add('Nothing selected', { dimColor: true });
  else if (!def) add(state.itemName(itemId), { bold: true });
  else {
    const up = itemId % 1000;
    const stats = state.itemStats(itemId);
    add(state.itemName(itemId), { bold: true, color: def.set ? 'greenBright' : 'yellow' });
    const type = (def.description || TYPE_TITLE[def.type] || SLOT_NAMES[def.type] || def.type) + (def.subType ? ` (${SUB_TITLE[def.subType] ?? def.subType})` : '');
    add(`${type}${count > 1 ? ` · ×${count}` : ''}${up ? ` · upgrade ${up}` : ''}${def.action ? (def.type === 'recipe' ? ' · learnable' : ' · usable') : ''}`, { dimColor: true });
    if (def.unique) add('Unique', { color: 'magenta' });
    if (def.type === 'recipe' && def.profession) add(`Requires ${def.profession} (${def.professionLevel ?? '?'})`, { color: 'green' });
    if (def.usebonus.length && def.type !== 'recipe') {
      add(def.usebonus.length > 1 ? 'Effects:' : 'Effect:', { bold: true });
      for (const u of def.usebonus) add(`  ${u}`, { color: 'green' });
    }
    gap();
    add('Bonuses', { bold: true });
    if (stats?.lines.length) for (const l of stats.lines) add(`  ${l.text.trim()}`, STAT_COLOR[l.kind]);
    else add('  none', { dimColor: true });
    const set = state.itemSet(itemId);
    if (set) {
      gap();
      add(`${set.name} (${set.worn}/${set.items.length} worn)`, { bold: true, color: 'greenBright' });
      for (const b of set.bonus) add(`  ${b}`, { color: 'green' });
      for (const i of set.items) add(`  ${i.worn ? '●' : '○'} ${i.name}`, { dimColor: !i.worn });
    }
    const req = state.requiredLevel(itemId);
    const reqs: [string, boolean][] = [];
    if (req) reqs.push([req.level !== req.base ? `Level ${req.level} (${req.base})` : `Level ${req.level}`, c.level < req.level]);
    if (def.duelLevel) reqs.push([`Duel level ${def.duelLevel}`, c.duelLevel < def.duelLevel]);
    if (def.charClass) reqs.push([`Class: ${CLASS_TITLE[def.charClass] ?? def.charClass}`, c.charClass !== def.charClass]);
    if (def.charSex) reqs.push([`Gender: ${def.charSex === 'male' ? 'Male' : 'Female'}${c.charClass === 'greenhorn' ? ' (No Greenhorn)' : ''}`, c.charSex !== def.charSex || c.charClass === 'greenhorn']);
    if (reqs.length) {
      gap();
      add('Requires', { bold: true });
      for (const [t, bad] of reqs) add(`  ${t}`, bad ? { color: 'red' } : {});
    }
    gap();
    if (!def.sellable) add('Unsalable', { color: 'red' });
    else add(`Sells for ${money(def.sell)}${def.price ? ` · buy ${money(def.price)}` : ''}`);
    if (def.auctionable) add('Auctionable', { color: 'green' });
    if (!def.upgradeable) add('Not upgradeable', { color: 'red' });
    if (compare && WEAR_SLOTS.includes(def.type)) {
      gap();
      add(`Instead of ${wornId !== undefined ? state.itemName(wornId) : 'nothing'}`, { bold: true });
      const diff = gearDelta(stats, wornId !== undefined && worn ? state.itemStats(wornId) : null);
      if (diff) for (const d of diff.split(', ')) add(`  ${d}`, { color: d.startsWith('-') ? 'red' : 'green' });
      else add('  no change', { dimColor: true });
    }
  }
  const hint = pane === 'wear' ? 'Enter/x take off · Tab bag · J/K scroll' : 'Enter/e wear · / filter · t type · J/K scroll';
  const room = Math.max(1, height - 3);
  const top = Math.min(scroll, Math.max(0, lines.length - room));
  const more = lines.length - top - room;
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, width, height, flexShrink: 0 },
    ...lines.slice(top, top + room), h(Box, { flexGrow: 1 }),
    h(Text, { dimColor: true, wrap: 'truncate' }, more > 0 ? `↓ ${more} more (J) · ${hint}` : hint));
}

function InventoryTab(p: {
  state: GameState; width: number; height: number; pane: 'wear' | 'bag'; wearSel: number; rows: BagItem[]; bagIdx: number;
  typeFilter: string; filter: string; filtering: boolean; detailScroll: number;
}) {
  const { state, width, height, pane, wearSel, rows, bagIdx, typeFilter, filter, filtering, detailScroll } = p;
  const inv = state.inventory;
  // Wide terminals: equipped | bag | details side by side. Narrow: details below, still tall.
  const side = width >= 100;
  const wearW = Math.min(40, Math.max(28, Math.floor(width * 0.28)));
  const detailW = side ? Math.min(46, Math.max(32, Math.floor(width * 0.32))) : width;
  const bagW = side ? width - wearW - detailW : width - wearW;
  const detailH = side ? height : Math.max(8, Math.floor(height * 0.45));
  const listH = side ? height : Math.max(6, height - detailH);
  const sel = pane === 'wear' ? inv.wear.get(WEAR_SLOTS[wearSel]!) : rows[bagIdx]?.itemId;
  const def = sel !== undefined ? state.items?.get(sel) : undefined;
  const wornId = def && pane === 'bag' ? inv.wear.get(def.type) : undefined;

  const wearPane = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: pane === 'wear' ? 'cyan' : 'gray', width: wearW, height: listH, paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true }, 'Equipped'),
    ...WEAR_SLOTS.map((slot, i) => {
      const id = inv.wear.get(slot);
      return h(Box, { key: slot, flexDirection: 'column' },
        h(Text, { color: 'yellow', dimColor: !(pane === 'wear' && i === wearSel), wrap: 'truncate' }, SLOT_NAMES[slot] ?? slot),
        h(Text, { inverse: pane === 'wear' && i === wearSel, wrap: 'truncate', dimColor: id === undefined }, `  ${id === undefined ? '—' : state.itemName(id)}`));
    }).slice(0, Math.max(1, Math.floor((listH - 4) / 2))),
    h(Text, { dimColor: true, wrap: 'truncate' }, `speed ×${state.character.speed.toFixed(2)}`),
  );

  const listRows = Math.max(1, listH - 4);
  const [start, end] = scrollWindow(bagIdx, rows.length, listRows);
  const nameW = Math.max(10, bagW - 16);
  const typeLabel = typeFilter === 'all' ? 'all types' : SLOT_NAMES[typeFilter] ?? typeFilter;
  const bagPane = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: pane === 'bag' ? 'cyan' : 'gray', width: bagW, height: listH, paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true, wrap: 'truncate' }, `Bag  ${rows.length ? `${bagIdx + 1}/${rows.length}` : '0'}${rows.length !== inv.bag.size ? ` of ${inv.bag.size}` : ''}`),
    h(Text, { wrap: 'truncate' },
      h(Text, { color: filtering ? 'cyan' : filter ? 'yellow' : 'gray' }, filtering ? `/${filter}▏` : filter ? `/${filter}` : '/ filter'),
      h(Text, { dimColor: true }, '  ·  '),
      h(Text, { color: typeFilter === 'all' ? 'gray' : 'yellow' }, `t ${typeLabel}`)),
    ...rows.slice(start, end).map((it, i) => {
      const idx = start + i;
      const d = state.items?.get(it.itemId);
      return h(Text, { key: it.itemId, inverse: pane === 'bag' && idx === bagIdx, wrap: 'truncate' },
        `${truncate(state.itemName(it.itemId), nameW)} `,
        h(Text, { dimColor: true }, `${(it.count > 1 ? `×${it.count}` : '').padStart(5)} ${(d?.level ? `L${d.level}` : '').padStart(4)}`));
    }),
    rows.length === 0 ? h(Text, { dimColor: true }, inv.bag.size ? 'Nothing matches. Esc clears the filter.' : 'Bag is empty (u refreshes).') : null,
  );

  const detail = h(ItemDetail, { state, itemId: sel, count: sel !== undefined ? inv.count(sel) : 0, wornId, compare: pane === 'bag', pane, width: detailW, height: detailH, scroll: detailScroll });
  return side
    ? h(Box, null, wearPane, bagPane, detail)
    : h(Box, { flexDirection: 'column' }, h(Box, null, wearPane, bagPane), detail);
}

function SkillsTab(p: { state: GameState; width: number; height: number; rows: string[]; selected: number; plan: SkillPlan; confirm: boolean }) {
  const { state, width, height, rows, selected, plan, confirm } = p;
  const s = state.skills;
  const used = planUsed(plan);
  const listRows = Math.max(3, height - 4);
  const [start, end] = scrollWindow(selected, rows.length, listRows);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, width, height },
    h(Text, { wrap: 'truncate' },
      'Free: ', h(Text, { color: s.freeAttributes - used.attributes ? 'green' : undefined, bold: true }, `${s.freeAttributes - used.attributes} attribute`),
      ' · ', h(Text, { color: s.freeSkills - used.skills ? 'green' : undefined, bold: true }, `${s.freeSkills - used.skills} skill`),
      h(Text, { dimColor: true }, '   + / − plan a point · Enter save · Esc discard'),
    ),
    h(Text, { dimColor: true, wrap: 'truncate' }, `${''.padEnd(22)}${'own'.padStart(5)}${'bonus'.padStart(7)}${'total'.padStart(7)}`),
    ...rows.slice(start, end).map((k, i) => {
      const idx = start + i;
      const isAttr = k in SKILLS_OF;
      const attr = isAttr ? k : ATTRIBUTE_OF[k]!;
      const delta = plannedDelta(plan, k);
      const own = s.base(k);
      const bonus = isAttr ? (s.attributeBonus[k] ?? 0) : (s.skillBonus[k] ?? 0);
      const name = (isAttr ? '' : '  ') + (NAMES[k] ?? k);
      return h(Text, { key: k, inverse: idx === selected, wrap: 'truncate' },
        h(Text, { color: ATTRIBUTE_COLOR[attr as keyof typeof ATTRIBUTE_COLOR], bold: isAttr }, name.padEnd(22)),
        String(own).padStart(5), h(Text, { dimColor: true }, `+${bonus}`.padStart(7)), String(own + bonus + delta).padStart(7),
        delta ? h(Text, { color: 'green', bold: true }, `  +${delta}`) : null);
    }),
    confirm ? h(Text, { color: 'yellow' }, `Spend ${used.attributes} attribute and ${used.skills} skill point(s)? This is permanent. y / n`) : null,
  );
}
