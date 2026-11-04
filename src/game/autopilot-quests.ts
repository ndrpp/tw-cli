// Autopilot quest module: on-the-spot quest steps the runner does between tasks, one per tick: finish
// quests (reward by priority), wear items a quest asks for (and put the old gear back afterwards), buy
// quest items in the town's shops, and accept quests from the saloon of towns it is in. Job items and job
// runs are not here: the planner's Quests goal covers them. Requirements it cannot do are logged once.
import type { GameState } from './state.ts';
import type { Quest } from './quests.ts';
import { goalWeights, type AutopilotConfig } from './autopilot-config.ts';
import { SHOPS, fetchShop, shopBuy, type Shop } from './trade.ts';
import { walkPost } from './tasks.ts';

/** Per-quest limit for items bought for it. */
export const QUEST_BUY_LIMIT = 500;

/** Picks a reward option by the priority: XP / money / items; an item you could wear now that beats yours always wins. */
export function chooseReward(options: { id: number; text: string }[], config: AutopilotConfig, isUpgrade: (text: string) => boolean = () => false): number | undefined {
  if (options.length <= 1) return options[0]?.id;
  const w = goalWeights(config);
  const score = (t: string) => {
    if (isUpgrade(t)) return Infinity;
    const n = Number(t.match(/([\d.,]+)/)?.[1]?.replace(/[.,]/g, '') ?? 0) || 1;
    if (/experience|xp/i.test(t)) return w.xp * n;
    if (/dollar|\$/i.test(t)) return w.money * n;
    return w.products * 100; // an item: valued like a product
  };
  return options.reduce((a, b) => (score(b.text) > score(a.text) ? b : a)).id;
}

export interface QuestHost {
  state: GameState;
  config: AutopilotConfig;
  budget(): number;
  spend(amount: number): void;
  skipped(): Set<string>;
  fail(key: string, msg: string): void;
}

/** Remembers gear taken off for a quest and which towns' saloons were checked. */
export class QuestModule {
  private host: QuestHost;
  /** Quest id → the item that was worn in that slot before. */
  private swapped = new Map<number, { slot: string; prev: number | null }>();
  private spentOn = new Map<number, number>();
  private saloonChecked = new Map<number, number>();
  private shops = new Map<string, { at: number; shop: Shop }>();
  private logged = new Set<string>();

  constructor(host: QuestHost) {
    this.host = host;
  }

  private quests(): Quest[] {
    const { state, config } = this.host;
    const rules = state.autopilot.rules;
    return state.quests.filter((q) =>
      q.accepted &&
      (!rules.onlyQuests.length || rules.onlyQuests.includes(q.id)) &&
      !rules.excludedQuests.includes(q.id) &&
      !config.quests.excludedChains.includes(q.group) &&
      (config.quests.repeatable || !/repeatable/i.test(q.group)));
  }

  /** One quest step if there is one to do now; true when it sent a request. */
  async step(): Promise<boolean> {
    const s = this.host.state;
    if (!s.items) return false;
    const skip = this.host.skipped();
    const quests = this.quests();

    for (const q of quests.filter((x) => x.finishable)) {
      const key = `finish:${q.id}`;
      if (skip.has(key)) continue;
      // Map quest givers want you there: walk first when not at the giver.
      const at = q.employerAt;
      const p = s.character.position;
      if (at && (at.x !== p.x || at.y !== p.y) && skip.has(`finish-here:${q.id}`)) {
        if (s.queue.length) continue;
        s.debug.add('quest', `Walk to ${q.employerName} to finish ${q.title}`, { quest: q.id, giverAt: at, position: p });
        const r = await s.autopilotCall(() => s.tasks.add(s.queue.length, [walkPost(q.employer, 'questgiver', at)], s.taskLimit)).catch((e) => (this.host.fail(`walk:${q.id}`, String(e)), null));
        if (r?.added.length) {
          s.queue.push(...r.added);
          s.info(`Autopilot: walking to ${q.employerName} to finish ${q.title}.`);
        }
        return true;
      }
      const reward = chooseReward(q.rewardOptions, this.host.config, (t) => this.isUpgrade(t));
      s.debug.add('quest', `Finish ${q.title}`, { quest: q.id, giver: q.employerName, giverAt: at, position: p, rewardOptions: q.rewardOptions, chosen: reward });
      const before = s.log.length;
      await s.finishQuest(q, reward);
      if (s.log.slice(before).some((l) => l.level === 'error')) this.host.fail(at ? `finish-here:${q.id}` : key, `could not finish ${q.title}`);
      return true;
    }

    for (const q of quests) {
      for (const r of q.requirements.filter((x) => !x.solved)) {
        if (r.kind === 'wear' && r.itemId !== undefined) {
          if (s.inventory.countBase(r.itemId) > 0 && !skip.has(`wear:${r.itemId}`)) {
            const id = [...s.inventory.bag.values()].find((b) => Math.floor(b.itemId / 1000) === Math.floor(r.itemId! / 1000))!.itemId;
            const slot = s.items.get(id)?.type ?? '';
            if (!this.swapped.has(q.id)) this.swapped.set(q.id, { slot, prev: s.inventory.wear.get(slot) ?? null });
            s.debug.add('quest', `Wear ${s.itemName(id)} for ${q.title}`, { quest: q.id, requirement: r.info, slot, previous: this.swapped.get(q.id) });
            const before = s.log.length;
            await s.wear(id);
            if (s.log.slice(before).some((l) => l.level === 'error')) this.host.fail(`wear:${r.itemId}`, `could not wear ${s.itemName(id)} for ${q.title}`);
            else void s.loadQuests(true);
            return true;
          }
          if (await this.buy(q, r.itemId, skip)) return true;
        } else if (r.kind === 'bought' && r.buy) {
          const id = s.items.findByName(r.buy);
          if (id !== undefined && (await this.buy(q, id, skip))) return true;
          this.once(`bought:${q.id}`, `Autopilot: ${q.title} needs "${r.buy}" bought; no shop in this town sells it.`);
        } else if (r.kind === 'other') {
          this.once(`other:${r.info}`, `Autopilot: skipping a requirement it cannot do yet: "${r.info}" (${q.title}).`);
        }
      }
    }

    // Quest done (finished or wear requirement solved): put the old gear back unless the quest item is better.
    for (const [qid, sw] of this.swapped) {
      const q = s.quests.find((x) => x.id === qid);
      const stillNeeded = q?.requirements.some((r) => r.kind === 'wear' && !r.solved) || (q && !q.finishable && q.requirements.some((r) => r.kind === 'wear'));
      if (stillNeeded) continue;
      this.swapped.delete(qid);
      s.debug.add('quest', `Quest gear no longer needed (${q?.title ?? qid})`, { slot: sw.slot, previous: sw.prev && s.itemName(sw.prev) });
      if (sw.prev && s.inventory.count(sw.prev) > 0 && !this.betterThan(s.inventory.wear.get(sw.slot), sw.prev)) {
        await s.wear(sw.prev);
        s.info(`Autopilot: put ${s.itemName(sw.prev)} back on.`);
        return true;
      }
    }

    return this.acceptInTown(skip);
  }

  /** Buys an item for a quest in the shops of the town you are in (cap + per-quest limit). */
  private async buy(q: Quest, itemId: number, skip: Set<string>): Promise<boolean> {
    const s = this.host.state;
    const town = s.townHere;
    const key = `buy:${itemId}`;
    if (!town || skip.has(key) || !this.host.config.modules.quests) return false;
    for (const def of SHOPS) {
      const ck = `${def.key}:${town.id}`;
      let c = this.shops.get(ck);
      if (!c || Date.now() - c.at > 30 * 60_000) {
        try {
          c = { at: Date.now(), shop: await s.autopilotCall(() => fetchShop(s.client, def.key, town.id), `shop ${def.key} ${town.name}`) };
          this.shops.set(ck, c);
        } catch {
          continue;
        }
      }
      if (!c.shop.items.some((i) => Math.floor(i / 1000) === Math.floor(itemId / 1000))) continue;
      const price = Math.round((s.items?.get(itemId)?.price ?? 0) * (c.shop.charge || 1));
      const spent = this.spentOn.get(q.id) ?? 0;
      s.debug.add('quest', `Shop ${def.key} in ${town.name} sells ${s.itemName(itemId)} for ${q.title}`, { price, spentOnQuest: spent, questLimit: QUEST_BUY_LIMIT, budget: this.host.budget() });
      if (price > this.host.budget() || spent + price > QUEST_BUY_LIMIT) {
        this.once(`afford:${q.id}:${itemId}`, `Autopilot: ${s.itemName(itemId)} ($${price}) for ${q.title} is over the spend limits.`);
        return false;
      }
      try {
        const r = await s.autopilotCall(() => shopBuy(s.client, def.key, town.id, itemId, s.inventory.lastInvId), `buy ${s.itemName(itemId)}`);
        s.inventory.applyChanges(r.changes);
        if (typeof r.cash === 'number') s.character.cash = r.cash;
        if (typeof r.deposit === 'number') s.character.deposit = r.deposit;
        this.host.spend(price);
        this.spentOn.set(q.id, spent + price);
        s.info(`Autopilot: bought ${s.itemName(itemId)} for ${q.title} ($${price}).`);
        void s.loadQuests(true);
      } catch (err) {
        this.host.fail(key, `buying ${s.itemName(itemId)}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    return false;
  }

  /** In a town: once an hour, accept what its saloon offers (filters, room in the quest log). */
  private async acceptInTown(skip: Set<string>): Promise<boolean> {
    const s = this.host.state;
    const town = s.townHere;
    if (!town || Date.now() - (this.saloonChecked.get(town.id) ?? 0) < 3600_000) return false;
    this.saloonChecked.set(town.id, Date.now());
    if (s.questCapacity && s.quests.length >= s.questCapacity) return false;
    await s.loadSaloon();
    s.debug.add('quest', `Saloon in ${town.name}: ${s.saloon.length} quest giver(s)`, { givers: s.saloon, questLog: `${s.quests.length}/${s.questCapacity || '?'}` });
    const cfg = this.host.config;
    for (const e of s.saloon) {
      if (!(await s.openEmployer(e.key)) || !s.employer) continue;
      for (const q of s.employer.open) {
        if (!q.acceptable || q.accepted || skip.has(`accept:${q.id}`)) continue;
        if (cfg.quests.excludedChains.includes(q.group) || (!cfg.quests.repeatable && /repeatable/i.test(q.group))) continue;
        if (s.questCapacity && s.quests.length >= s.questCapacity) return true;
        s.debug.add('quest', `Accept ${q.title}`, { quest: q.id, chain: q.group, giver: e.name, requirements: q.requirements });
        await s.acceptQuest(q);
      }
    }
    return true;
  }

  private isUpgrade(text: string): boolean {
    const s = this.host.state;
    const id = s.items?.findByName(text.trim());
    if (id === undefined) return false;
    const slot = s.items?.get(id)?.type;
    const req = s.requiredLevel(id);
    if (!slot || (req && req.level > s.character.level)) return false;
    return this.betterThan(id, s.inventory.wear.get(slot) ?? undefined);
  }

  /** Item a beats b by total attribute + skill points (a rough "better gear" test). */
  private betterThan(a: number | undefined, b: number | undefined): boolean {
    if (!a) return false;
    if (!b) return true;
    const s = this.host.state;
    const pts = (id: number) => {
      const d = s.items?.get(id);
      return d ? Object.values(d.attributes).reduce((x, y) => x + y, 0) + Object.values(d.skills).reduce((x, y) => x + y, 0) : 0;
    };
    return pts(a) > pts(b);
  }

  private once(key: string, msg: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.host.state.debug.add('quest', msg.replace(/^Autopilot: /, 'Skip: '), { key });
    this.host.state.info(msg);
  }
}

