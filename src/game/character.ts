// Character state from Character.init (game.php) plus the client's own regen ticker
// (Character.tick4Character @723978) and max-health formula (calcMaxHealth @723529).
import type { ServerClock } from './clock.ts';

export interface Position { x: number; y: number }

/**
 * Total XP at which `level` starts (Character.calcLowerExp @717300): floor((Σk² for k≤level + 10·(level+1) − 21) · 3)
 * plus 1000·(level − 120)^2.9 above level 120; capped at the world's max level.
 */
export function levelStartXp(level: number, maxLevel = 250): number {
  const l = Math.min(level, maxLevel);
  return Math.floor(((l * (l + 1) * (2 * l + 1)) / 6 + (l + 1) * 10 - 21) * 3 + (l > 120 ? 1000 * Math.pow(l - 120, 2.9) : 0));
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

  static fromInit(data: Record<string, any>, clock: ServerClock): CharacterState {
    const c = new CharacterState(clock);
    c.playerId = data.playerId;
    c.name = data.name;
    c.level = data.level;
    c.charClass = data.charClass?.type ?? '';
    c.charSex = data.charSex ?? '';
    c.duelLevel = Number(data.duelLevel) || 0;
    c.itemLevelDecrease = data.itemLevelRequirementDecrease && !Array.isArray(data.itemLevelRequirementDecrease) ? data.itemLevelRequirementDecrease : {};
    c.experience = data.experience;
    c.cash = data.cash;
    c.deposit = data.deposit;
    c.nuggets = data.nuggets;
    c.position = { x: data.pos?.x ?? 0, y: data.pos?.y ?? 0 };
    c.homeTown = data.town ? { id: data.town.id, x: data.town.coords.x, y: data.town.coords.y } : null;
    c.speed = data.charSpeed ?? 1;
    c.maxEnergy = data.maxEnergy;
    c.healthRegen = data.healthRegenFactor ?? 0;
    c.energyRegen = data.energyRegenFactor ?? 0;
    if (data.taskLimit) c.taskLimit = data.taskLimit;
    c.skills = data.skillData?.skills ?? {};
    c.skillBonus = data.skillData?.skillBonus ?? {};
    const lp = data.lpPerPoint ?? 0;
    const lpBonus = data.lpPerPointBonus ?? 0;
    const healthPoints = (c.skills.health ?? 0) + (c.skillBonus.health ?? 0);
    c.maxHealth = Math.trunc(100 + (c.level - 1) * lp + healthPoints * (lp + lpBonus));
    c.setHealth(data.health);
    c.setEnergy(data.energy);
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
