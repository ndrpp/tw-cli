// Static item data. The browser loads Game.init.itemsFile ("cache/items_en_DK.json?<version>") from
// the world host with a GET (ItemManager.doRequest @191721) — not from the CDN. We do the same once
// per version and keep a slim copy in ~/.config/tw-cli/cache/. Item ids: instance id = base id ·
// 1000 + upgrade level (ItemManager.load strips the last three digits).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';
import { type GameClient, send } from '../http/game-client.ts';
import { arr, entries, isObj, type JsonObject, numOrNull, nums, obj, objs, strOrNull, vals } from '../util/json.ts';
import {
  type ItemSetDef,
  type ItemStats,
  itemStats,
  parseRawBonus,
  type RawBonus,
  type StatContext,
} from './itemstats.ts';
import { NAMES } from './skills.ts';

export interface ItemDef {
  id: number; // base id
  name: string;
  type: string;
  level: number | null;
  price: number;
  sell: number;
  set: string | null;
  attributes: Record<string, number>;
  skills: Record<string, number>;
  /** Level-scaled and other bonuses, as the game describes them ("+0.1 Trading (per Level)"). */
  extra: string[];
  /** Raw bonus.item entries (for the web's per-level / upgrade calculation, see itemstats.ts). */
  bonusItems: RawBonus[];
  fortbattle: Record<string, number>;
  fortbattlesector: Record<string, number>;
  damage: { min: number; max: number } | null;
  upgradeable: boolean;
  usetype: string;
  speed: number | null;
  charClass: string | null;
  charSex: string | null;
  duelLevel: number | null;
  subType: string | null;
  description: string | null;
  usebonus: string[];
  action: boolean;
  unique: boolean;
  sellable: boolean;
  auctionable: boolean;
  profession: string | null;
  professionLevel: number | null;
}

export const SLOT_NAMES: Record<string, string> = {
  head: 'Hat',
  neck: 'Neck',
  body: 'Body',
  right_arm: 'Weapon',
  left_arm: 'Fire weapon',
  yield: 'Product',
  foot: 'Shoes',
  animal: 'Horse',
  belt: 'Belt',
  pants: 'Pants',
  collection: 'Collection',
  recipe: 'Recipe',
};
/** Wear.slots @1170912 */
export const WEAR_SLOTS = ['head', 'neck', 'body', 'right_arm', 'left_arm', 'yield', 'foot', 'animal', 'belt', 'pants'];

export const baseId = (itemId: number) => Math.floor(itemId / 1000);
export const upgradeLevel = (itemId: number) => itemId % 1000;

export function slimItem(raw: JsonObject): ItemDef {
  const json = obj(raw.bonus);
  return {
    id: baseId(Number(raw.item_id)),
    name: String(raw.name ?? '?'),
    type: String(raw.type ?? ''),
    level: numOrNull(raw.level),
    price: Number(raw.price) || 0,
    sell: Number(raw.sell_price) || 0,
    set: strOrNull(raw.set),
    attributes: nums(json.attributes),
    skills: nums(json.skills),
    extra: objs(json.item)
      .map((extraItem) => String(extraItem.desc ?? ''))
      .filter(Boolean),
    bonusItems: arr(json.item).map(parseRawBonus),
    fortbattle: nums(json.fortbattle),
    fortbattlesector: nums(json.fortbattlesector),
    damage: isObj(raw.damage)
      ? { min: Number(raw.damage.damage_min) || 0, max: Number(raw.damage.damage_max) || 0 }
      : null,
    upgradeable: !!raw.upgradeable,
    usetype: String(raw.usetype ?? 'none'),
    speed: numOrNull(raw.speed),
    charClass: strOrNull(raw.characterClass),
    charSex: strOrNull(raw.characterSex),
    duelLevel: numOrNull(raw.duelLevel),
    subType: strOrNull(raw.sub_type),
    description: raw.description ? String(raw.description) : null,
    usebonus: arr(raw.usebonus).map(String),
    action: !!raw.action,
    unique: !!raw.unique,
    sellable: raw.sellable !== false,
    auctionable: !!raw.auctionable,
    profession: strOrNull(raw.profession),
    professionLevel: numOrNull(raw.min_level),
  };
}

export class ItemCatalog {
  private items = new Map<number, ItemDef>();

  static fromRaw(list: JsonObject[]): ItemCatalog {
    const candidate = new ItemCatalog();
    for (const json of list) candidate.add(slimItem(json));
    return candidate;
  }

  static fromSlim(list: ItemDef[]): ItemCatalog {
    const candidate = new ItemCatalog();
    for (const item of list) candidate.add(item);
    return candidate;
  }

  add(item: ItemDef): void {
    this.items.set(item.id, item);
  }

  get size(): number {
    return this.items.size;
  }

  get(itemId: number): ItemDef | undefined {
    return this.items.get(baseId(itemId));
  }

  name(itemId: number): string {
    const entry = this.get(itemId);
    const up = upgradeLevel(itemId);
    return (entry?.name ?? `item ${itemId}`) + (up ? ` ☆${up}` : '');
  }

  /** Plain item id (`id · 1000`) of the item with this exact name (case-insensitive), if any. */
  findByName(name: string): number | undefined {
    const otherName = name.trim().toLowerCase();
    for (const item of this.items.values()) if (item.name.toLowerCase() === otherName) return item.id * 1000;
    return undefined;
  }

  /** Every item (base definitions; the plain item id is `id · 1000`). */
  all(): ItemDef[] {
    return [...this.items.values()];
  }

  toJSON(): ItemDef[] {
    return this.all();
  }
}

/** Stats as the web popup shows them for this instance (upgrade level from the id, per-level values for ctx). */
export function statsOf(item: ItemDef, itemId: number, ctx: StatContext = {}): ItemStats {
  return itemStats(item, itemId, ctx);
}

/** "+ 2 Strength, + 5 Construction, …" — computed like the web when ctx.charLevel is given. */
export function bonusText(item: ItemDef | undefined, itemId?: number, ctx?: StatContext): string {
  if (!item) return '';
  if (ctx)
    return itemStats(item, itemId ?? item.id * 1000, ctx)
      .lines.map((line) => line.text.trim())
      .join(', ');
  const parts = [
    ...Object.entries(item.attributes).map(([entryKey, value]) => `+${value} ${NAMES[entryKey] ?? entryKey}`),
    ...Object.entries(item.skills).map(([entryKey, value]) => `+${value} ${NAMES[entryKey] ?? entryKey}`),
    ...item.extra,
  ];
  if (item.speed) parts.push(`speed ×${item.speed}`);
  return parts.join(', ');
}

/** Bonus a single skill gets from this item (fixed values only; attribute bonus counts for its skills). */
export function skillBonusOf(item: ItemDef | undefined, skill: string, attributeOf: Record<string, string>): number {
  if (!item) return 0;
  return (item.skills[skill] ?? 0) + (item.attributes[attributeOf[skill] ?? ''] ?? 0);
}

/** Bump when ItemDef changes so old slim caches are rebuilt. */
const SLIM_VERSION = 2;
/** Large static JSON is reused for up to 12 h (and always refetched when the game version changes). */
export const STATIC_CACHE_MS = 12 * 3600_000;

const cacheFile = (itemsFile: string) => {
  const version = itemsFile.split('?')[1] ?? '0';
  const [path] = itemsFile.split('?');
  const base =
    path
      ?.split('/')
      .pop()
      ?.replace(/\.json$/, '') ?? 'items';
  return join(CONFIG_DIR, 'cache', `${base}-${version.replace(/[^\w.-]/g, '')}.slim${SLIM_VERSION}.json`);
};

/**
 * Static game data file: disk cache for this version, else a local copy from `envVar`, else a GET from
 * the world host like the browser. `slim` keeps only what we use.
 */
async function loadStatic<Value>(
  client: GameClient,
  file: string,
  envVar: string,
  label: string,
  slim: (raw: unknown[]) => Value[],
  log?: (message: string) => void,
): Promise<Value[]> {
  const cached = cacheFile(file);
  if (existsSync(cached) && Date.now() - statSync(cached).mtimeMs < STATIC_CACHE_MS) {
    try {
      return JSON.parse(readFileSync(cached, 'utf8')) as Value[];
    } catch {
      /* re-fetch */
    }
  }
  let raw: unknown;
  const local = process.env[envVar];
  if (local && existsSync(local)) {
    raw = JSON.parse(readFileSync(local, 'utf8'));
  } else {
    log?.(`Downloading ${label} (one time per game version)…`);
    const url = `${client.worldUrl}/${file.replace(/^\//, '')}`;
    const res = await send(
      client.jar,
      client.identity,
      url,
      {
        accept: 'application/json, text/javascript, */*; q=0.01',
        ajax: true,
        referer: `${client.worldUrl}/game.php`,
      },
      { ...client.policy, timeoutMs: 120_000 },
    );
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
    raw = await res.json();
  }
  const out = slim(vals(raw));
  mkdirSync(join(CONFIG_DIR, 'cache'), { recursive: true, mode: 0o700 });
  writeFileSync(cached, JSON.stringify(out), { mode: 0o600 });
  return out;
}

/** Item catalog (Game.init.itemsFile; local override TW_ITEMS_FILE). */
export async function loadItemCatalog(
  client: GameClient,
  itemsFile: string | undefined,
  log?: (message: string) => void,
): Promise<ItemCatalog> {
  const list = await loadStatic(
    client,
    itemsFile ?? 'cache/items_en_DK.json',
    'TW_ITEMS_FILE',
    'item data (~13 MB)',
    (raw) => raw.filter(isObj).map(slimItem),
    log,
  );
  return ItemCatalog.fromSlim(list);
}

export class ItemSetCatalog {
  sets = new Map<string, ItemSetDef>();
  constructor(list: ItemSetDef[] = []) {
    for (const source of list) this.sets.set(source.key, source);
  }
  get(key: string | null | undefined): ItemSetDef | undefined {
    return key ? this.sets.get(key) : undefined;
  }
}

export const slimItemSet = (json: JsonObject): ItemSetDef => ({
  key: String(json.key),
  name: String(json.name ?? json.key),
  items: arr(json.items).map(Number),
  bonus: Object.fromEntries(entries(obj(json.bonus)).map(([stage, list]) => [stage, vals(list).map(parseRawBonus)])),
});

/** Item sets (Game.init.itemSetsFile; local override TW_ITEMSETS_FILE). */
export async function loadItemSets(
  client: GameClient,
  file: string | undefined,
  log?: (message: string) => void,
): Promise<ItemSetCatalog> {
  return new ItemSetCatalog(
    await loadStatic(
      client,
      file ?? 'cache/itemsets_en_DK.json',
      'TW_ITEMSETS_FILE',
      'item sets',
      (raw) => raw.filter(isObj).map(slimItemSet),
      log,
    ),
  );
}
