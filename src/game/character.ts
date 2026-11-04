// Character state from Character.init (game.php) plus the client's own regen ticker
// (Character.tick4Character @723978) and max-health formula (calcMaxHealth @723529).

import { isObj, type JsonObject, nums, obj } from '../util/json.ts';
import type { ServerClock } from './clock.ts';

export interface Position {
  x: number;
  y: number;
}

/**
 * Total XP at which `level` starts (Character.calcLowerExp @717300): floor((Σk² for k≤level + 10·(level+1) − 21) · 3)
 * plus 1000·(level − 120)^2.9 above level 120; capped at the world's max level.
 */
export function levelStartXp(level: number, maxLevel = 250): number {
  const l = Math.min(level, maxLevel);
  return Math.floor(
    ((l * (l + 1) * (2 * l + 1)) / 6 + (l + 1) * 10 - 21) * 3 + (l > 120 ? 1000 * (l - 120) ** 2.9 : 0),
  );
}

export interface LevelProgress {
  /** XP earned within the current level (Character.getExperience4Level). */
  have: number;
  /** XP the level needs in all (getMaxExperience4Level); 0 at the max level. */
  need: number;
  /** have / need, 0..1 (1 at the max level). */
  ratio: number;
  maxed: boolean;
}

export function levelProgress(level: number, experience: number, maxLevel = 250): LevelProgress {
  const lo = levelStartXp(level, maxLevel);
  const hi = levelStartXp(level + 1, maxLevel);
  const have = Math.max(0, experience - lo);
  if (hi <= lo) return { have, need: 0, ratio: 1, maxed: true };
  return { have, need: hi - lo, ratio: Math.min(1, have / (hi - lo)), maxed: false };
}

export class CharacterState {
  playerId = 0;
  name = '';
  level = 0;
  charClass = '';
  charSex = '';
  duelLevel = 0;
  /** Character.itemLevelRequirementDecrease: {all, <slot>} levels off item requirements. */
  itemLevelDecrease: Record<string, number> = {};
  experience = 0;
  /** Game.init.maxLevel (250 on en32). */
  maxLevel = 250;
  cash = 0;
  deposit = 0;
  nuggets = 0;
  position: Position = { x: 0, y: 0 };
  homeTown: { id: number; x: number; y: number } | null = null;
  /** Character.speed (charSpeed): multiplies travel time. */
  speed = 1;
  maxEnergy = 100;
  maxHealth = 100;
  healthRegen = 0;
  energyRegen = 0;
  taskLimit = { normal: 4, premium: 9 };
  /** Max HP gained per level (Character.lpPerPoint). */
  lpPerPoint = 0;
  skills: Record<string, number> = {};
  skillBonus: Record<string, number> = {};
  private baseEnergy = 0;
  private energyAt = 0; // server seconds
  private baseHealth = 0;
  private healthAt = 0;

  private clock: ServerClock;

  get progress(): LevelProgress {
    return levelProgress(this.level, this.experience, this.maxLevel);
  }

  constructor(clock: ServerClock) {
    this.clock = clock;
  }

  static fromInit(data: JsonObject, clock: ServerClock): CharacterState {
    const c = new CharacterState(clock);
    c.playerId = Number(data.playerId);
    c.name = String(data.name ?? '');
    c.level = Number(data.level);
    c.charClass = String(obj(data.charClass).type ?? '');
    c.charSex = String(data.charSex ?? '');
    c.duelLevel = Number(data.duelLevel) || 0;
    c.itemLevelDecrease = nums(data.itemLevelRequirementDecrease);
    c.experience = Number(data.experience);
    c.cash = Number(data.cash);
    c.deposit = Number(data.deposit);
    c.nuggets = Number(data.nuggets);
    const pos = obj(data.pos);
    c.position = { x: Number(pos.x ?? 0), y: Number(pos.y ?? 0) };
    const town = isObj(data.town) ? data.town : null;
    c.homeTown = town ? { id: Number(town.id), x: Number(obj(town.coords).x), y: Number(obj(town.coords).y) } : null;
    c.speed = Number(data.charSpeed ?? 1);
    c.maxEnergy = Number(data.maxEnergy);
    c.healthRegen = Number(data.healthRegenFactor ?? 0);
    c.energyRegen = Number(data.energyRegenFactor ?? 0);
    if (isObj(data.taskLimit))
      c.taskLimit = { normal: Number(data.taskLimit.normal) || 4, premium: Number(data.taskLimit.premium) || 9 };
    c.skills = nums(obj(data.skillData).skills);
    c.skillBonus = nums(obj(data.skillData).skillBonus);
    const lp = Number(data.lpPerPoint ?? 0);
    c.lpPerPoint = lp;
    const lpBonus = Number(data.lpPerPointBonus ?? 0);
    const healthPoints = (c.skills.health ?? 0) + (c.skillBonus.health ?? 0);
    c.maxHealth = Math.trunc(100 + (c.level - 1) * lp + healthPoints * (lp + lpBonus));
    c.setHealth(Number(data.health));
    c.setEnergy(Number(data.energy));
    return c;
  }

  /** `at`: server time (s) the value was measured (energy_date from live updates); default now. */
  setEnergy(e: number, at?: number): void {
    this.baseEnergy = Math.floor(e);
    this.energyAt = at && at <= this.clock.now() ? at : this.clock.now();
  }

  setHealth(h: number, at?: number): void {
    this.baseHealth = Math.min(Math.floor(h), this.maxHealth);
    this.healthAt = at && at <= this.clock.now() ? at : this.clock.now();
  }

  /** The last server values (no regen): changes only when the server tells us something new. */
  get serverValues(): { energy: number; energyAt: number; health: number; healthAt: number } {
    return { energy: this.baseEnergy, energyAt: this.energyAt, health: this.baseHealth, healthAt: this.healthAt };
  }

  /** Current energy including regeneration since the last server value. */
  get energy(): number {
    const diff = this.clock.now() - this.energyAt;
    return Math.min(this.maxEnergy, Math.floor(this.baseEnergy + (this.maxEnergy * this.energyRegen * diff) / 3600));
  }

  get health(): number {
    const diff = this.clock.now() - this.healthAt;
    return Math.min(this.maxHealth, Math.floor(this.baseHealth + (this.maxHealth * this.healthRegen * diff) / 3600));
  }
}
