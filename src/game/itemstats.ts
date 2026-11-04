// Item stats exactly as the web item popup shows them. Ported from tw2game.en_DK.js:
//   ItemManager.calculateItemLevelBonus @194379 (upgrade bonus)
//   west.item.Item.handleItemUpgrade / parseLvlUp / parseSpeed / exportBoni @920500
//   west.item.BonusExtractor @923082 (per-level bonuses, rounding, descriptions)
//   west.item.Weapon.getDamage / getDamageBonus @931800
//   ItemPopup.getXHTML @636900 (order and wording of the lines)
//   west.item.ItemSet.getMergedStages @933000 (set bonus for the number of worn set items)

import { isObj, obj } from '../util/json.ts';
import { NAMES } from './skills.ts';

/** One entry of item.bonus.item / an item set stage. */
export interface RawBonus {
  type: string;
  key?: string;
  name?: string;
  value?: number;
  job?: string | number;
  desc?: string;
  roundingMethod?: string;
  isSector?: boolean;
  bonus?: RawBonus;
}

/** A bonus entry from the item or item-set JSON (unknown fields dropped). */
export function parseRawBonus(currentValue: unknown): RawBonus {
  const json = obj(currentValue);
  const second: RawBonus = { type: String(json.type ?? '') };
  if (typeof json.key === 'string') {
    second.key = json.key;
  }
  if (typeof json.name === 'string') {
    second.name = json.name;
  }
  if (json.value !== undefined && json.value !== null) {
    second.value = Number(json.value);
  }
  if (typeof json.job === 'string' || typeof json.job === 'number') {
    second.job = json.job;
  }
  if (typeof json.desc === 'string') {
    second.desc = json.desc;
  }
  if (typeof json.roundingMethod === 'string') {
    second.roundingMethod = json.roundingMethod;
  }
  if (json.isSector !== undefined) {
    second.isSector = !!json.isSector;
  }
  if (isObj(json.bonus)) {
    second.bonus = parseRawBonus(json.bonus);
  }
  return second;
}

/** The fields of an item the popup needs (kept in the slim item cache). */
export interface StatSource {
  type: string;
  upgradeable: boolean;
  attributes: Record<string, number>;
  skills: Record<string, number>;
  bonusItems: RawBonus[];
  fortbattle: Record<string, number>;
  fortbattlesector: Record<string, number>;
  speed: number | null;
  damage: { min: number; max: number } | null;
}

export interface StatContext {
  /** Character level for "(per Level)" bonuses. Without it the popup shows the per-level description. */
  charLevel?: number;
  /** Job names for "+N labor points towards <job>". */
  jobName?: (id: number) => string | undefined;
}

export type StatKind = 'damage' | 'attribute' | 'skill' | 'other' | 'speed' | 'fort';
export interface StatLine {
  text: string;
  kind: StatKind;
}

export interface ItemStats {
  lines: StatLine[];
  /** exportBoni: key → value (attribute/skill keys, job, speed, luck, experience, damage_min, fort_offense, …). */
  totals: Record<string, number>;
  damage: { min: number; max: number } | null;
  /** Speed after upgrade (travel time multiplier), or null. */
  speed: number | null;
}

/** ItemManager.calculateItemLevelBonus */
export function calculateItemLevelBonus(level: number, value: number): number {
  if (!level || !value) {
    return 0;
  }
  if (value < 1) {
    return Math.round(Math.max(1, value * 1000 * level)) / 10000;
  }
  return Math.round(Math.max(1, (value * level) / 10));
}

/** BonusExtractor.getRoundedValue */
export function roundBy(value: number, method?: string): number {
  switch (method) {
    case 'round':
      return Math.round(value);
    case 'ceil':
      return Math.ceil(value);
    case 'floatceil':
      return Math.ceil(100 * value) / 100;
    case 'floor':
      return Math.floor(value);
    default:
      return value;
  }
}

/** Float noise from the arithmetic (0.1+0.2) — the browser shows it too, but nobody wants to read it. */
const tidy = (currentValue: number) => Math.round(currentValue * 10000) / 10000;

const PERCENT_DESC: Record<string, string> = {
  luck: '+ %1% Increased Luck',
  dollar: '+ %1% Money from jobs and duels',
  regen: '+ %1% Regeneration',
  speed: '+ %1% Speed',
  experience: '+ %1% Experience from jobs, duels and fort battles',
  drop: '+ %1% Improved product drop chance',
};
const FORT_NAMES: Record<string, string> = {
  damage: 'Damage',
  defense: 'Defense',
  offense: 'Attack',
  resistance: 'Resistance',
};
const BUILD_JOB_ID = 1000; // west.job.Build().id: construction

type Modifier = (currentValue: number) => number;

/** west.item.BonusExtractor */
export class BonusExtractor {
  charLevel: number | undefined;
  itemLevel: number;
  jobName: ((id: number) => string | undefined) | undefined;

  constructor(ctx: StatContext, itemLevel = 0) {
    this.charLevel = ctx.charLevel;
    this.itemLevel = itemLevel || 0;
    this.jobName = ctx.jobName;
  }

  private perLevel(second: RawBonus): Modifier {
    return (currentValue) => roundBy(currentValue * (this.charLevel ?? 0), second.roundingMethod);
  }

  value(second: RawBonus, mod?: Modifier, rounding?: string): number {
    let currentValue = mod ? mod(second.value ?? 0) : (second.value ?? 0);
    if (this.itemLevel && second.type !== 'speed') {
      currentValue += calculateItemLevelBonus(this.itemLevel, currentValue);
    } else if (this.itemLevel && second.type === 'speed') {
      currentValue += Math.round(((currentValue * this.itemLevel) / 10) * 100) / 100;
    }
    if (rounding) {
      currentValue = roundBy(currentValue, rounding);
    }
    return tidy(currentValue);
  }

  desc(second: RawBonus, mod?: Modifier, rounding?: string): string {
    switch (second.type) {
      case 'character':
        if (this.charLevel === undefined || second.key !== 'level' || !second.bonus) {
          return second.desc ?? '';
        }
        return this.desc(second.bonus, this.perLevel(second), second.roundingMethod);
      case 'attribute':
      case 'skill':
        return `+ ${this.value(second, mod, rounding)} ${NAMES[second.name ?? ''] ?? second.name}`;
      case 'job': {
        const currentValue = this.value(second, mod, rounding);
        const lp = currentValue === 1 ? 'Labor point' : 'labor points';
        if (Number(second.job) === BUILD_JOB_ID && second.job !== 'all') {
          return `+ ${currentValue} ${lp} towards Construction`;
        }
        if (second.job !== 'all' && second.job !== undefined) {
          return `+ ${currentValue} ${lp} towards ${this.jobName?.(Number(second.job)) ?? `job ${second.job}`}`;
        }
        return `+ ${currentValue} ${lp}`;
      }
      case 'pray':
        return `+${this.value(second, mod, rounding)} Praying`;
      case 'damage':
        return `+${this.value(second, mod, rounding)} Damage`;
      case 'fortbattle':
        return `+${this.value(second, mod, rounding)} ${FORT_NAMES[second.name ?? ''] ?? ''} (${second.isSector ? 'Fort battle sector bonus' : 'Fort battle bonus'})`;
      default:
        if (second.type in PERCENT_DESC) {
          return (
            PERCENT_DESC[second.type]?.replace('%1', String(Math.round(this.value(second, mod, rounding) * 100))) ?? ''
          );
        }
        return second.desc ?? '';
    }
  }

  /** getExportValue: {key, value} as the server's validate_itemstats expects. */
  exportValue(second: RawBonus): { key: string; value: number } {
    let value: number;
    let inner = second;
    if (second.type === 'character') {
      value =
        this.charLevel === undefined || second.key !== 'level' || !second.bonus
          ? this.value(second.bonus ?? second)
          : this.value(second.bonus, this.perLevel(second), second.roundingMethod);
      inner = second.bonus ?? second;
    } else {
      value = this.value(second);
    }
    switch (inner.type) {
      case 'skill':
      case 'attribute':
        return { key: String(inner.name), value };
      case 'fortbattle':
        return { key: `fort_${inner.name}${inner.isSector ? '_sector' : ''}`, value };
      default:
        return { key: inner.type, value };
    }
  }

  /** Skills this bonus raises (attributes raise their five skills). */
  affectedSkills(
    second: RawBonus,
    skillsOf: Record<string, string[]>,
    mod?: Modifier,
    rounding?: string,
  ): Record<string, number> {
    if (second.type === 'skill') {
      return { [String(second.name)]: this.value(second, mod, rounding) };
    }
    if (second.type === 'attribute') {
      const currentValue = this.value(second, mod, rounding);
      return Object.fromEntries((skillsOf[String(second.name)] ?? []).map((textValue) => [textValue, currentValue]));
    }
    if (second.type === 'character' && second.key === 'level' && second.bonus) {
      return this.affectedSkills(second.bonus, skillsOf, this.perLevel(second), second.roundingMethod);
    }
    return {};
  }
}

/** Item.handleItemUpgrade: every fixed number (attributes, skills, fort bonuses) gains the upgrade bonus. */
function upgraded(options: Record<string, number>, level: number): Record<string, number> {
  if (!level) {
    return { ...options };
  }
  return Object.fromEntries(
    Object.entries(options).map(([key, currentValue]) => [
      key,
      currentValue + calculateItemLevelBonus(level, currentValue),
    ]),
  );
}

/** Item.parseSpeed */
export function upgradedSpeed(speed: number | null, level: number): number | null {
  if (!speed || speed === 1 || !level) {
    return speed;
  }
  let currentValue = Math.round((1 / speed - 1) * 10000);
  currentValue += calculateItemLevelBonus(level, currentValue);
  return 1 / (currentValue / 10000 + 1);
}

/** The popup's "Speed: +N%". */
export const speedPercent = (speed: number) => Math.round((1 / speed) * 100 - 100);

const hasDamageBonus = (data: StatSource) =>
  data.bonusItems.some((second) => second.type === 'character' && second.bonus?.type === 'damage');

/** Weapon.getDamage */
function weaponDamage(
  data: StatSource,
  level: number,
  charLevel: number | undefined,
): { min: number; max: number } | null {
  if (!data.damage) {
    return null;
  }
  let { min, max } = data.damage;
  if (level && data.upgradeable) {
    min += calculateItemLevelBonus(level, min);
    max += calculateItemLevelBonus(level, max);
  }
  let bonus = 0;
  if (charLevel !== undefined) {
    for (const second of data.bonusItems) {
      if (second.type === 'character' && second.bonus?.type === 'damage') {
        const currentValue = (second.bonus.value ?? 0) * charLevel;
        bonus += Math.round(currentValue) + calculateItemLevelBonus(level, currentValue);
      }
    }
  }
  return { min: min + bonus, max: max + bonus };
}

/** Item level from the instance id (base·1000 + level). */
const levelOf = (itemId: number) => itemId % 1000;

/** All bonus lines of an item, in the popup's order, with upgrade and character level applied. */
export function itemStats(data: StatSource, itemId: number, ctx: StatContext = {}): ItemStats {
  const level = levelOf(itemId);
  const extractor = new BonusExtractor(ctx, level);
  const lines: StatLine[] = [];
  const totals: Record<string, number> = {};
  const add = (key: string, currentValue: number) => {
    totals[key] = tidy((totals[key] ?? 0) + currentValue);
  };
  const isWeapon = data.type === 'right_arm' || data.type === 'left_arm';
  const withChar = ctx.charLevel !== undefined;

  const damage = isWeapon ? weaponDamage(data, level, ctx.charLevel) : null;
  if (damage) {
    lines.push({
      kind: 'damage',
      text: `${damage.min}-${damage.max} ${hasDamageBonus(data) && !withChar ? 'Base damage' : 'Damage'}`,
    });
    add('damage_min', damage.min);
    add('damage_max', damage.max);
  }
  const attributes = upgraded(data.attributes, level);
  for (const [key, currentValue] of Object.entries(attributes)) {
    if (!currentValue) {
      continue;
    }
    lines.push({
      kind: 'attribute',
      text: `${currentValue > 0 ? '+ ' : ''}${tidy(currentValue)} ${NAMES[key] ?? key}`,
    });
    add(key, currentValue);
  }
  const skills = upgraded(data.skills, level);
  for (const [entryKey, skillValue] of Object.entries(skills)) {
    if (!skillValue) {
      continue;
    }
    lines.push({
      kind: 'skill',
      text: `${skillValue > 0 ? '+ ' : ''}${tidy(skillValue)} ${NAMES[entryKey] ?? entryKey}`,
    });
    add(entryKey, skillValue);
  }
  for (const second of data.bonusItems) {
    const inner = second.type === 'character' ? second.bonus : second;
    if (withChar && inner?.type === 'damage' && second.type === 'character') {
      continue; // already in Damage
    }
    const kind: StatKind = inner?.type === 'skill' ? 'skill' : inner?.type === 'attribute' ? 'attribute' : 'other';
    const text = extractor.desc(second);
    if (text) {
      lines.push({ kind, text });
    }
    const entry = extractor.exportValue(second);
    if (isWeapon && entry.key === 'damage') {
      continue;
    }
    add(entry.key, entry.key === 'speed' ? entry.value * 100 : entry.value);
  }
  const speed = upgradedSpeed(data.speed, level);
  if (speed) {
    const pct = speedPercent(speed);
    lines.push({ kind: 'speed', text: `Speed: ${speed <= 1 ? '+' : ''}${pct}%` });
    add('speed', pct);
  }
  const fb = upgraded(data.fortbattle, level);
  if (fb.offense || fb.defense || fb.resistance) {
    lines.push({ kind: 'fort', text: 'Fort battle bonus' });
    for (const fortField of ['defense', 'offense', 'resistance']) {
      const value = fb[fortField];
      if (!value) {
        continue;
      }
      lines.push({ kind: 'fort', text: `  +${tidy(value)} ${FORT_NAMES[fortField]}` });
      add(`fort_${fortField}`, value);
    }
  }
  const fs = upgraded(data.fortbattlesector, level);
  if (fs.damage || fs.offense || fs.defense) {
    lines.push({ kind: 'fort', text: 'Fort battle sector bonus' });
    for (const sectorField of ['defense', 'offense', 'damage']) {
      const value = fs[sectorField];
      if (!value) {
        continue;
      }
      lines.push({ kind: 'fort', text: `  +${tidy(value)} ${FORT_NAMES[sectorField]}` });
      add(`fort_${sectorField}_sector`, value);
    }
  }
  return { lines, totals, damage, speed };
}

// ---- item sets ------------------------------------------------------------------------------

export interface ItemSetDef {
  key: string;
  name: string;
  items: number[];
  bonus: Record<string, RawBonus[]>;
}

/** ItemSet.getMergedStages(cnt): stage bonuses up to `cnt` worn items, same bonuses summed. */
export function mergedStages(set: ItemSetDef, cnt: number): RawBonus[] {
  const merge = (bb: RawBonus, second: RawBonus): boolean => {
    if (bb.type !== second.type) {
      return false;
    }
    if (
      second.type === 'character' &&
      second.roundingMethod === bb.roundingMethod &&
      second.key === bb.key &&
      bb.bonus &&
      second.bonus
    ) {
      return merge(bb.bonus, second.bonus);
    }
    if (second.type === 'job' && second.job === bb.job) {
      bb.value = (bb.value ?? 0) + (second.value ?? 0);
      return true;
    }
    if (['speed', 'regen', 'luck', 'pray', 'experience', 'dollar', 'damage', 'drop'].includes(second.type)) {
      bb.value = (bb.value ?? 0) + (second.value ?? 0);
      return true;
    }
    if (
      ['skill', 'attribute', 'fortbattle'].includes(second.type) &&
      second.name === bb.name &&
      second.isSector === bb.isSector
    ) {
      bb.value = (bb.value ?? 0) + (second.value ?? 0);
      return true;
    }
    return false;
  };
  const out: RawBonus[] = [];
  for (const [stage, list] of Object.entries(set.bonus ?? {})) {
    if (parseInt(stage, 10) > cnt || !Array.isArray(list)) {
      continue;
    }
    next: for (const sb of list) {
      for (const match of out) {
        if (merge(match, sb)) {
          continue next;
        }
      }
      out.push(structuredClone(sb));
    }
  }
  // The popup sorts: attributes (by name), then skills, then the rest.
  const tag = (second: RawBonus, textValue: string) => {
    const xCoord = second.bonus ?? second;
    return xCoord.type === textValue ? String(xCoord.name) : null;
  };
  return out.sort((first, second) => {
    const aa = tag(first, 'attribute'),
      ab = tag(second, 'attribute'),
      sa = tag(first, 'skill'),
      sb = tag(second, 'skill');
    if (aa && ab) {
      return aa < ab ? -1 : 1;
    }
    if (aa) {
      return -1;
    }
    if (ab) {
      return 1;
    }
    if (sa && sb) {
      return 0;
    }
    if (sa) {
      return -1;
    }
    if (sb) {
      return 1;
    }
    return 0;
  });
}

/** Set bonus lines for `worn` set items, as the popup shows them (per-level values for this character). */
export function setBonusLines(set: ItemSetDef, worn: number, ctx: StatContext): string[] {
  const extractor = new BonusExtractor(ctx);
  return mergedStages(set, worn)
    .map((second) => extractor.desc(second))
    .filter(Boolean);
}

/** Set bonus totals (same keys as ItemStats.totals). */
export function setBonusTotals(set: ItemSetDef, worn: number, ctx: StatContext): Record<string, number> {
  const extractor = new BonusExtractor(ctx);
  const totals: Record<string, number> = {};
  for (const second of mergedStages(set, worn)) {
    const entry = extractor.exportValue(second);
    totals[entry.key] = tidy((totals[entry.key] ?? 0) + (entry.key === 'speed' ? entry.value * 100 : entry.value));
  }
  return totals;
}
