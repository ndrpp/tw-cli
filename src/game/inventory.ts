// Bag + worn items.
// Initial: game.php Bag.init({bag:{<type>:[{count,item_id,inv_id,type}]}, wear:[item ids], setItems, ...}).
// Changes (Bag.handleChanges @661624): [{item_id, count, inv_id, type}] with the NEW total count;
// count 0 removes the item. Requests (Wear @1173660-1174600, Bag @657892):
//   inventory/carry   {item_id, last_inv_id} → {changes, wearSets, workPointBonus, bonus, speed, error, message}
//   inventory/uncarry {last_inv_id, type}     → same
//   inventory/inventory_changed {inv_id}      → {changes|false, wear:{slot:item_id|null}}
import type { GameClient } from '../http/game-client.ts';
import { baseId, WEAR_SLOTS, type ItemCatalog } from './items.ts';

export interface BagItem { itemId: number; count: number; invId: number; type: string }

export interface ClothChange {
  changes: BagItem[];
  speed?: number;
  workPointBonus?: unknown;
  error?: string;
}

const toBagItem = (r: Record<string, any>): BagItem => ({
  itemId: Number(r.item_id), count: Number(r.count) || 0, invId: Number(r.inv_id) || 0, type: String(r.type ?? ''),
});

export class Inventory {
  /** item_id → bag entry */
  bag = new Map<number, BagItem>();
  /** slot → item_id */
  wear = new Map<string, number>();
  lastInvId = 0;

  static fromInit(bagInit: Record<string, any> | null | undefined, catalog?: ItemCatalog): Inventory {
    const inv = new Inventory();
    for (const list of Object.values<any>(bagInit?.bag ?? {})) {
      for (const r of list as any[]) inv.put(toBagItem(r));
    }
    for (const id of (bagInit?.wear ?? []) as number[]) {
      const type = catalog?.get(id)?.type;
      if (type) inv.wear.set(type, Number(id));
      else inv.wear.set(`#${id}`, Number(id)); // type unknown until items load; fixed by retype()
    }
    return inv;
  }

  /** Puts worn items under their slot once the item catalog is available. */
  retype(catalog: ItemCatalog): void {
    for (const [slot, id] of [...this.wear]) {
      if (!slot.startsWith('#')) continue;
      const type = catalog.get(id)?.type;
      if (type) {
        this.wear.delete(slot);
        this.wear.set(type, id);
      }
    }
  }

  private put(item: BagItem): void {
    this.bag.set(item.itemId, item);
    if (item.invId > this.lastInvId) this.lastInvId = item.invId;
  }

  applyChanges(changes: unknown): void {
    if (!Array.isArray(changes)) return;
    for (const r of changes) {
      const c = toBagItem(r);
      if (c.count <= 0) this.bag.delete(c.itemId);
      else this.put({ ...this.bag.get(c.itemId), ...c, type: c.type || this.bag.get(c.itemId)?.type || '' });
      if (c.invId > this.lastInvId) this.lastInvId = c.invId;
    }
  }

  applyWear(wear: unknown): void {
    if (!wear || typeof wear !== 'object') return;
    for (const slot of WEAR_SLOTS) {
      if (!(slot in wear)) continue;
      const id = (wear as Record<string, unknown>)[slot];
      if (id === null || id === undefined || id === 0) this.wear.delete(slot);
      else this.wear.set(slot, Number(id));
    }
  }

  items(): BagItem[] {
    return [...this.bag.values()];
  }

  count(itemId: number): number {
    return this.bag.get(itemId)?.count ?? 0;
  }

  isWorn(itemId: number): boolean {
    for (const id of this.wear.values()) if (id === itemId) return true;
    return false;
  }

  /** Count of an item by base id across upgrade levels (quest requirements use base·1000). */
  countBase(itemId: number): number {
    let n = 0;
    for (const it of this.bag.values()) if (baseId(it.itemId) === baseId(itemId)) n += it.count;
    return n;
  }
}

export class InventoryApi {
  client: GameClient;

  constructor(client: GameClient) {
    this.client = client;
  }

  private cloth(json: Record<string, any>): ClothChange {
    return {
      changes: Array.isArray(json.changes) ? json.changes : [],
      speed: typeof json.speed === 'number' ? json.speed : undefined,
      workPointBonus: json.workPointBonus,
      error: json.error ? String(json.message || json.msg || json.error) : undefined,
    };
  }

  async carry(itemId: number, lastInvId: number): Promise<ClothChange> {
    return this.cloth(await this.client.remoteCall('inventory', 'carry', { item_id: itemId, last_inv_id: lastInvId }));
  }

  async uncarry(type: string, lastInvId: number): Promise<ClothChange> {
    return this.cloth(await this.client.remoteCall('inventory', 'uncarry', { last_inv_id: lastInvId, type }));
  }

  async changedSince(invId: number): Promise<{ changes: unknown; wear: unknown }> {
    const json = await this.client.remoteCall('inventory', 'inventory_changed', { inv_id: invId });
    return { changes: json.changes === false ? [] : json.changes, wear: json.wear };
  }
}
