// Item stats exactly as the web item popup shows them. Ported from tw2game.en_DK.js:
//   ItemManager.calculateItemLevelBonus @194379 (upgrade bonus)
//   west.item.Item.handleItemUpgrade / parseLvlUp / parseSpeed / exportBoni @920500
//   west.item.BonusExtractor @923082 (per-level bonuses, rounding, descriptions)
//   west.item.Weapon.getDamage / getDamageBonus @931800
//   ItemPopup.getXHTML @636900 (order and wording of the lines)
//   west.item.ItemSet.getMergedStages @933000 (set bonus for the number of worn set items)
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
export interface StatLine { text: string; kind: StatKind }

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
  if (!level || !value) return 0;
  if (value < 1) return Math.round(Math.max(1, value * 1000 * level)) / 10000;
  return Math.round(Math.max(1, (value * level) / 10));
}

/** BonusExtractor.getRoundedValue */
export function roundBy(value: number, method?: string): number {
  switch (method) {
    case 'round': return Math.round(value);
    case 'ceil': return Math.ceil(value);
    case 'floatceil': return Math.ceil(100 * value) / 100;
    case 'floor': return Math.floor(value);
    default: return value;
  }
}

/** Float noise from the arithmetic (0.1+0.2) — the browser shows it too, but nobody wants to read it. */
const tidy = (v: number) => Math.round(v * 10000) / 10000;

const PERCENT_DESC: Record<string, string> = {
  luck: '+ %1% Increased Luck',
  dollar: '+ %1% Money from jobs and duels',
  regen: '+ %1% Regeneration',
  speed: '+ %1% Speed',
  experience: '+ %1% Experience from jobs, duels and fort battles',
  drop: '+ %1% Improved product drop chance',
};
const FORT_NAMES: Record<string, string> = { damage: 'Damage', defense: 'Defense', offense: 'Attack', resistance: 'Resistance' };
const BUILD_JOB_ID = 1000; // west.job.Build().id: construction

type Modifier = (v: number) => number;

/** west.item.BonusExtractor */
export class BonusExtractor {
  charLevel: number | undefined;
  itemLevel: number;
  jobName?: (id: number) => string | undefined;

  constructor(ctx: StatContext, itemLevel = 0) {
    this.charLevel = ctx.charLevel;
    this.itemLevel = itemLevel || 0;
    this.jobName = ctx.jobName;
  }

  private perLevel(b: RawBonus): Modifier {
    return (v) => roundBy(v * (this.charLevel ?? 0), b.roundingMethod);
  }

  value(b: RawBonus, mod?: Modifier, rounding?: string): number {
    let v = mod ? mod(b.value ?? 0) : b.value ?? 0;
    if (this.itemLevel && b.type !== 'speed') v += calculateItemLevelBonus(this.itemLevel, v);
    else if (this.itemLevel && b.type === 'speed') v += Math.round(((v * this.itemLevel) / 10) * 100) / 100;
    if (rounding) v = roundBy(v, rounding);
    return tidy(v);
  }

  desc(b: RawBonus, mod?: Modifier, rounding?: string): string {
    switch (b.type) {
      case 'character':
        if (this.charLevel === undefined || b.key !== 'level' || !b.bonus) return b.desc ?? '';
        return this.desc(b.bonus, this.perLevel(b), b.roundingMethod);
      case 'attribute':
      case 'skill':
        return `+ ${this.value(b, mod, rounding)} ${NAMES[b.name ?? ''] ?? b.name}`;
      case 'job': {
        const v = this.value(b, mod, rounding);
        const lp = v === 1 ? 'Labor point' : 'labor points';
        if (Number(b.job) === BUILD_JOB_ID && b.job !== 'all') return `+ ${v} ${lp} towards Construction`;
        if (b.job !== 'all' && b.job !== undefined) return `+ ${v} ${lp} towards ${this.jobName?.(Number(b.job)) ?? `job ${b.job}`}`;
        return `+ ${v} ${lp}`;
      }
      case 'pray':
        return `+${this.value(b, mod, rounding)} Praying`;
      case 'damage':
        return `+${this.value(b, mod, rounding)} Damage`;
      case 'fortbattle':
        return `+${this.value(b, mod, rounding)} ${FORT_NAMES[b.name ?? ''] ?? ''} (${b.isSector ? 'Fort battle sector bonus' : 'Fort battle bonus'})`;
      default:
        if (b.type in PERCENT_DESC) return PERCENT_DESC[b.type]!.replace('%1', String(Math.round(this.value(b, mod, rounding) * 100)));
        return b.desc ?? '';
    }
  }

  /** getExportValue: {key, value} as the server's validate_itemstats expects. */
  exportValue(b: RawBonus): { key: string; value: number } {
    let value: number;
    let inner = b;
    if (b.type === 'character') {
      value = this.charLevel === undefined || b.key !== 'level' || !b.bonus ? this.value(b.bonus ?? b) : this.value(b.bonus, this.perLevel(b), b.roundingMethod);
      inner = b.bonus ?? b;
    } else value = this.value(b);
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
  affectedSkills(b: RawBonus, skillsOf: Record<string, string[]>, mod?: Modifier, rounding?: string): Record<string, number> {
    if (b.type === 'skill') return { [String(b.name)]: this.value(b, mod, rounding) };
    if (b.type === 'attribute') {
      const v = this.value(b, mod, rounding);
      return Object.fromEntries((skillsOf[String(b.name)] ?? []).map((s) => [s, v]));
    }
    if (b.type === 'character' && b.key === 'level' && b.bonus) return this.affectedSkills(b.bonus, skillsOf, this.perLevel(b), b.roundingMethod);
    return {};
  }
}

/** Item.handleItemUpgrade: every fixed number (attributes, skills, fort bonuses) gains the upgrade bonus. */
function upgraded(o: Record<string, number>, level: number): Record<string, number> {
  if (!level) return { ...o };
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v + calculateItemLevelBonus(level, v)]));
}

/** Item.parseSpeed */
export function upgradedSpeed(speed: number | null, level: number): number | null {
  if (!speed || speed === 1 || !level) return speed;
  let s = Math.round((1 / speed - 1) * 10000);
  s += calculateItemLevelBonus(level, s);
  return 1 / (s / 10000 + 1);
}

/** The popup's "Speed: +N%". */
export const speedPercent = (speed: number) => Math.round((1 / speed) * 100 - 100);

const hasDamageBonus = (d: StatSource) => d.bonusItems.some((b) => b.type === 'character' && b.bonus?.type === 'damage');

/** Weapon.getDamage */
function weaponDamage(d: StatSource, level: number, charLevel: number | undefined): { min: number; max: number } | null {
  if (!d.damage) return null;
  let { min, max } = d.damage;
  if (level && d.upgradeable) {
    min += calculateItemLevelBonus(level, min);
    max += calculateItemLevelBonus(level, max);
  }
  let bonus = 0;
  if (charLevel !== undefined) {
    for (const b of d.bonusItems) {
      if (b.type === 'character' && b.bonus?.type === 'damage') {
        const v = (b.bonus.value ?? 0) * charLevel;
        bonus += Math.round(v) + calculateItemLevelBonus(level, v);
      }
    }
  }
  return { min: min + bonus, max: max + bonus };
}

/** Item level from the instance id (base·1000 + level). */
const levelOf = (itemId: number) => itemId % 1000;

/** All bonus lines of an item, in the popup's order, with upgrade and character level applied. */
export function itemStats(d: StatSource, itemId: number, ctx: StatContext = {}): ItemStats {
  const level = levelOf(itemId);
  const ex = new BonusExtractor(ctx, level);
  const lines: StatLine[] = [];
  const totals: Record<string, number> = {};
  const add = (k: string, v: number) => {
    totals[k] = tidy((totals[k] ?? 0) + v);
  };
  const isWeapon = d.type === 'right_arm' || d.type === 'left_arm';
  const withChar = ctx.charLevel !== undefined;

  const damage = isWeapon ? weaponDamage(d, level, ctx.charLevel) : null;
  if (damage) {
    lines.push({ kind: 'damage', text: `${damage.min}-${damage.max} ${hasDamageBonus(d) && !withChar ? 'Base damage' : 'Damage'}` });
    add('damage_min', damage.min);
    add('damage_max', damage.max);
  }
  const attributes = upgraded(d.attributes, level);
  for (const [k, v] of Object.entries(attributes)) {
    if (!v) continue;
    lines.push({ kind: 'attribute', text: `${v > 0 ? '+ ' : ''}${tidy(v)} ${NAMES[k] ?? k}` });
    add(k, v);
  }
  const skills = upgraded(d.skills, level);
  for (const [k, v] of Object.entries(skills)) {
    if (!v) continue;
    lines.push({ kind: 'skill', text: `${v > 0 ? '+ ' : ''}${tidy(v)} ${NAMES[k] ?? k}` });
    add(k, v);
  }
  for (const b of d.bonusItems) {
    const inner = b.type === 'character' ? b.bonus : b;
    if (withChar && inner?.type === 'damage' && b.type === 'character') continue; // already in Damage
    const kind: StatKind = inner?.type === 'skill' ? 'skill' : inner?.type === 'attribute' ? 'attribute' : 'other';
    const text = ex.desc(b);
    if (text) lines.push({ kind, text });
    const e = ex.exportValue(b);
    if (isWeapon && e.key === 'damage') continue;
    add(e.key, e.key === 'speed' ? e.value * 100 : e.value);
  }
  const speed = upgradedSpeed(d.speed, level);
  if (speed) {
    const pct = speedPercent(speed);
    lines.push({ kind: 'speed', text: `Speed: ${speed <= 1 ? '+' : ''}${pct}%` });
    add('speed', pct);
  }
  const fb = upgraded(d.fortbattle, level);
  if (fb.offense || fb.defense || fb.resistance) {
    lines.push({ kind: 'fort', text: 'Fort battle bonus' });
    for (const k of ['defense', 'offense', 'resistance']) {
      if (!fb[k]) continue;
      lines.push({ kind: 'fort', text: `  +${tidy(fb[k]!)} ${FORT_NAMES[k]}` });
      add(`fort_${k}`, fb[k]!);
    }
  }
  const fs = upgraded(d.fortbattlesector, level);
  if (fs.damage || fs.offense || fs.defense) {
    lines.push({ kind: 'fort', text: 'Fort battle sector bonus' });
    for (const k of ['defense', 'offense', 'damage']) {
      if (!fs[k]) continue;
      lines.push({ kind: 'fort', text: `  +${tidy(fs[k]!)} ${FORT_NAMES[k]}` });
      add(`fort_${k}_sector`, fs[k]!);
    }
  }
  return { lines, totals, damage, speed };
}

// ---- item sets ------------------------------------------------------------------------------

export interface ItemSetDef { key: string; name: string; items: number[]; bonus: Record<string, RawBonus[]> }

/** ItemSet.getMergedStages(cnt): stage bonuses up to `cnt` worn items, same bonuses summed. */
export function mergedStages(set: ItemSetDef, cnt: number): RawBonus[] {
  const merge = (bb: RawBonus, b: RawBonus): boolean => {
    if (bb.type !== b.type) return false;
    if (b.type === 'character' && b.roundingMethod === bb.roundingMethod && b.key === bb.key && bb.bonus && b.bonus) return merge(bb.bonus, b.bonus);
    if (b.type === 'job' && b.job === bb.job) {
      bb.value = (bb.value ?? 0) + (b.value ?? 0);
      return true;
    }
    if (['speed', 'regen', 'luck', 'pray', 'experience', 'dollar', 'damage', 'drop'].includes(b.type)) {
      bb.value = (bb.value ?? 0) + (b.value ?? 0);
      return true;
    }
    if (['skill', 'attribute', 'fortbattle'].includes(b.type) && b.name === bb.name && b.isSector === bb.isSector) {
      bb.value = (bb.value ?? 0) + (b.value ?? 0);
      return true;
    }
    return false;
  };
  const out: RawBonus[] = [];
  for (const [stage, list] of Object.entries(set.bonus ?? {})) {
    if (parseInt(stage, 10) > cnt || !Array.isArray(list)) continue;
    next: for (const sb of list) {
      for (const m of out) if (merge(m, sb)) continue next;
      out.push(structuredClone(sb));
    }
  }
  // The popup sorts: attributes (by name), then skills, then the rest.
  const tag = (b: RawBonus, t: string) => { const x = b.bonus ?? b; return x.type === t ? String(x.name) : null; };
  return out.sort((a, b) => {
    const aa = tag(a, 'attribute'), ab = tag(b, 'attribute'), sa = tag(a, 'skill'), sb = tag(b, 'skill');
    if (aa && ab) return aa < ab ? -1 : 1;
    if (aa) return -1;
    if (ab) return 1;
    if (sa && sb) return 0;
    if (sa) return -1;
    if (sb) return 1;
    return 0;
  });
}

/** Set bonus lines for `worn` set items, as the popup shows them (per-level values for this character). */
export function setBonusLines(set: ItemSetDef, worn: number, ctx: StatContext): string[] {
  const ex = new BonusExtractor(ctx);
  return mergedStages(set, worn).map((b) => ex.desc(b)).filter(Boolean);
}

/** Set bonus totals (same keys as ItemStats.totals). */
export function setBonusTotals(set: ItemSetDef, worn: number, ctx: StatContext): Record<string, number> {
  const ex = new BonusExtractor(ctx);
  const totals: Record<string, number> = {};
  for (const b of mergedStages(set, worn)) {
    const e = ex.exportValue(b);
    totals[e.key] = tidy((totals[e.key] ?? 0) + (e.key === 'speed' ? e.value * 100 : e.value));
  }
  return totals;
}
