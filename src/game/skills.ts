// Attributes and skills. Names and the attribute → skill grouping come from CharacterSkills
// (tw2game @736000: keyNames, skillKeys4Attr). Initial values from Character.init.skillData
// {attributes, attributeBonus, skills, skillBonus, freeAttribute, freeSkill}; fresh values from
// skill/overview (SkillsWindow.getNewJsonData @1583276) → {attributes, skills, attributeBonuspoints,
// skillBonuspoints, open_attrPoints, open_skillPoints}.
// Saving (SkillsWindow butExpertOkClicked @1597175):
//   remoteCall('skill','save_skill_changes', {modifier:'add', data: JSON.stringify({attribute_modifications,
//   skill_modifications, attribute_points_used, skill_points_used})}) → {error, msg, ...}
// Raising an attribute raises each of its five skills by one (SkillsWindow.Attributes[...]).
import type { GameClient } from '../http/game-client.ts';
import { type JsonObject, nums } from '../util/json.ts';

export const ATTRIBUTES = ['strength', 'flexibility', 'dexterity', 'charisma'] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

export const SKILLS_OF: Record<Attribute, string[]> = {
  strength: ['build', 'punch', 'tough', 'endurance', 'health'],
  flexibility: ['ride', 'reflex', 'dodge', 'hide', 'swim'],
  dexterity: ['aim', 'shot', 'pitfall', 'finger_dexterity', 'repair'],
  charisma: ['leadership', 'tactic', 'trade', 'animal', 'appearance'],
};

export const ATTRIBUTE_OF: Record<string, Attribute> = Object.fromEntries(
  ATTRIBUTES.flatMap((first) => SKILLS_OF[first].map((text) => [text, first])),
) as Record<string, Attribute>;

export const NAMES: Record<string, string> = {
  strength: 'Strength',
  flexibility: 'Mobility',
  dexterity: 'Dexterity',
  charisma: 'Charisma',
  build: 'Construction',
  punch: 'Vigor',
  tough: 'Toughness',
  endurance: 'Stamina',
  health: 'Health Points',
  ride: 'Horseback Riding',
  reflex: 'Reflex',
  dodge: 'Dodging',
  hide: 'Hiding',
  swim: 'Swimming',
  aim: 'Aiming',
  shot: 'Shooting',
  pitfall: 'Setting Traps',
  finger_dexterity: 'Fine Motor Skills',
  repair: 'Repairing',
  leadership: 'Leadership',
  tactic: 'Tactics',
  trade: 'Trading',
  animal: 'Animal Instinct',
  appearance: 'Appearance',
};

/** TUI colour per attribute group (the game colours them red/green/blue/yellow). */
export const ATTRIBUTE_COLOR: Record<Attribute, string> = {
  strength: 'red',
  flexibility: 'green',
  dexterity: 'blue',
  charisma: 'yellow',
};

export class Skills {
  attributes: Record<string, number> = {};
  attributeBonus: Record<string, number> = {};
  skills: Record<string, number> = {};
  skillBonus: Record<string, number> = {};
  freeAttributes = 0;
  freeSkills = 0;

  static fromInit(skillData: JsonObject | undefined): Skills {
    const source = new Skills();
    if (!skillData) {
      return source;
    }
    source.attributes = nums(skillData.attributes);
    source.attributeBonus = nums(skillData.attributeBonus);
    source.skills = nums(skillData.skills);
    source.skillBonus = nums(skillData.skillBonus);
    source.freeAttributes = Number(skillData.freeAttribute) || 0;
    source.freeSkills = Number(skillData.freeSkill) || 0;
    return source;
  }

  static fromOverview(json: JsonObject): Skills {
    const source = new Skills();
    source.attributes = nums(json.attributes);
    source.attributeBonus = nums(json.attributeBonuspoints);
    source.skills = nums(json.skills);
    source.skillBonus = nums(json.skillBonuspoints);
    source.freeAttributes = Number(json.open_attrPoints) || 0;
    source.freeSkills = Number(json.open_skillPoints) || 0;
    return source;
  }

  /** Total = own points + bonus from items/sets/buffs (what job labor points use). */
  total(key: string): number {
    if (key in SKILLS_OF) {
      return (this.attributes[key] ?? 0) + (this.attributeBonus[key] ?? 0);
    }
    return (this.skills[key] ?? 0) + (this.skillBonus[key] ?? 0);
  }

  base(key: string): number {
    return key in SKILLS_OF ? (this.attributes[key] ?? 0) : (this.skills[key] ?? 0);
  }
}

/** Points the player is about to spend (not yet saved). */
export interface SkillPlan {
  attributes: Record<string, number>;
  skills: Record<string, number>;
}

export const emptyPlan = (): SkillPlan => ({ attributes: {}, skills: {} });

export function planUsed(plan: SkillPlan): { attributes: number; skills: number } {
  const sum = (options: Record<string, number>) =>
    Object.values(options).reduce((accumulator, current) => accumulator + current, 0);
  return { attributes: sum(plan.attributes), skills: sum(plan.skills) };
}

/** Adds (delta=+1) or removes (−1) one planned point; returns false if not allowed. */
export function adjustPlan(plan: SkillPlan, skills: Skills, key: string, delta: 1 | -1): boolean {
  const isAttr = key in SKILLS_OF;
  const bucket = isAttr ? plan.attributes : plan.skills;
  const used = planUsed(plan);
  if (delta > 0) {
    if (isAttr ? used.attributes >= skills.freeAttributes : used.skills >= skills.freeSkills) {
      return false;
    }
    bucket[key] = (bucket[key] ?? 0) + 1;
    return true;
  }
  if (!bucket[key]) {
    return false;
  }
  if (--bucket[key] === 0) {
    delete bucket[key];
  }
  return true;
}

/** What the plan adds to a row: an attribute point also adds one to each of its skills. */
export function plannedDelta(plan: SkillPlan, key: string): number {
  if (key in SKILLS_OF) {
    return plan.attributes[key] ?? 0;
  }
  const attribute = ATTRIBUTE_OF[key];
  return (plan.skills[key] ?? 0) + (attribute === undefined ? 0 : (plan.attributes[attribute] ?? 0));
}

export function savePayload(plan: SkillPlan): { modifier: 'add'; data: string } {
  const used = planUsed(plan);
  return {
    modifier: 'add',
    data: JSON.stringify({
      attribute_modifications: plan.attributes,
      skill_modifications: plan.skills,
      attribute_points_used: used.attributes,
      skill_points_used: used.skills,
    }),
  };
}

export class SkillApi {
  client: GameClient;

  constructor(client: GameClient) {
    this.client = client;
  }

  async overview(): Promise<Skills> {
    const json = await this.client.remoteCallMode('skill', 'overview');
    if (json.error) {
      throw new Error(String(json.msg ?? 'skill/overview failed'));
    }
    return Skills.fromOverview(json);
  }

  async save(plan: SkillPlan): Promise<string> {
    const json = await this.client.remoteCall('skill', 'save_skill_changes', savePayload(plan));
    if (json.error) {
      throw new Error(String(json.msg ?? 'Saving skills failed'));
    }
    return String(json.msg ?? 'Skills saved.');
  }
}
