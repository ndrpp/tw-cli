// Autopilot quest module: on-the-spot quest steps the runner does between tasks, one per tick: finish
// quests (reward by priority), wear items a quest asks for (and put the old gear back afterwards), buy quest
// items (mobile trader and market offers from anywhere, shops in the town you are in; quest-buy.ts picks the
// source), pick up market goods, and accept quests from the saloon of towns it is in. Job items and job runs
// are not here: the planner's Quests goal covers them, and its shop trips walk to the town. Requirements it
// cannot do are logged once.
import type { GameState } from './state.ts';
import type { Quest } from './quests.ts';
import { goalWeights, type AutopilotConfig } from './autopilot-config.ts';
import type { MarketPickup } from './autopilot-config.ts';
import { baseId } from './items.ts';
import { where, type BuyPick } from './quest-buy.ts';
import { buyMobileTrader, MarketApi, shopBuy } from './trade.ts';
import { walkPost } from './tasks.ts';

/** A quest that only waits for its time window: the quest log is re-read this often so it finishes inside it. */
const WINDOW_CHECK_MS = 10 * 60_000;

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
  private saloonChecked = new Map<number, number>();
  private windowAt = 0;
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
        } else if (r.kind === 'other') {
          this.once(`other:${r.info}`, `Autopilot: skipping a requirement it cannot do yet: "${r.info}" (${q.title}).`);
        }
      }
    }

    if (await this.buyStep(quests, skip)) return true;

    // Everything done but the time window: re-read the quest log now and then (the server should mark the
    // window solved inside it; unverified), so the finish above happens in time.
    const waiting = quests.filter((q) => !q.finishable && q.requirements.some((r) => !r.solved) && q.requirements.every((r) => r.solved || r.kind === 'window'));
    if (waiting.length && Date.now() - this.windowAt > WINDOW_CHECK_MS) {
      this.windowAt = Date.now();
      s.debug.add('quest', `Waiting for a time window: re-reading the quest log (${waiting.map((q) => q.title).join(', ')})`, { windows: waiting.map((q) => ({ quest: q.id, window: q.requirements.find((r) => r.kind === 'window')?.window })) });
      await s.loadQuests(true);
      return true;
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

  /** The planned shop stop (you are in the town): buy and pick up what is due here; true when it did something. */
  async buyHere(): Promise<boolean> {
    return this.buyStep(this.quests(), this.host.skipped());
  }

  /**
   * One purchase or pickup: market goods waiting in the town you are in; then, for quests it can finish once
   * the items are bought, what needs no walk (mobile trader, market offers) or sells in this town's shops.
   */
  private async buyStep(quests: Quest[], skip: Set<string>): Promise<boolean> {
    const s = this.host.state;
    const here = s.townHere;
    const pickup = here && s.autopilot.pickups.find((p) => p.townId === here.id);
    if (pickup) {
      await this.pickUp(pickup);
      return true;
    }
    if (!this.host.config.quests.buy) return false;
    const all = s.questPurchases(quests);
    for (const q of quests) {
      const p = all.get(q.id)!;
      if (p.blocker || p.problem) continue;
      for (const pick of p.picks) {
        if (pick.source.kind === 'shop' && pick.source.townId !== here?.id) continue;
        const key = `item:${baseId(pick.itemId)}`;
        if (skip.has(key)) continue;
        if (pick.cost > this.host.budget()) {
          this.once(`budget:${q.id}:${baseId(pick.itemId)}`, `Autopilot: ${pick.name} ($${pick.cost}) for ${q.title} is over what is left of today's spend cap ($${this.host.budget()}).`);
          continue;
        }
        await this.buy(q, pick, key);
        return true;
      }
    }
    return false;
  }

  private async buy(q: Quest, pick: BuyPick, key: string): Promise<void> {
    const s = this.host.state;
    const src = pick.source;
    const money = (r: { cash?: number; deposit?: number }) => {
      if (typeof r.cash === 'number') s.character.cash = r.cash;
      if (typeof r.deposit === 'number') s.character.deposit = r.deposit;
    };
    s.debug.add('quest', `Buy ${pick.count}× ${pick.name} for ${q.title} (${where(src)})`, { quest: q.id, pick, budget: this.host.budget(), cash: s.character.cash, deposit: s.character.deposit });
    try {
      if (src.kind === 'shop') {
        for (let i = 0; i < pick.count; i++) {
          const r = await s.autopilotCall(() => shopBuy(s.client, src.shop, src.townId, pick.itemId, s.inventory.lastInvId), `buy ${pick.name} (${where(src)})`);
          s.inventory.applyChanges(r.changes);
          money(r);
        }
      } else if (src.kind === 'mobile') {
        for (let i = 0; i < pick.count; i++) money(await s.autopilotCall(() => buyMobileTrader(s.client, src.item, 'dollar'), `buy ${pick.name} (mobile trader)`));
        s.buyCatalog.mobile = null; // stock and limited counts changed: read it again
        await s.refreshInventory();
      } else {
        // Instant buy at the offer's price, from the bank when cash is short (bidtype 1); goods wait in its town.
        const fromBank = s.character.cash < src.price;
        const r = await s.autopilotCall(() => new MarketApi(s.client).bid(src.offer, src.price, fromBank), `buy ${pick.name} (${where(src)})`);
        s.buyCatalog.dropOffer(src.offer.id);
        if (!r.instant) throw new Error('the offer did not sell at its buy-now price (bid placed instead)');
        money(r);
        s.updateAutopilot((f) => f.pickups.push({ offerId: src.offer.id, itemId: pick.itemId, count: pick.count, townId: src.townId, townName: src.townName, at: src.at, quest: q.soloTitle || q.title }));
      }
      this.host.spend(pick.cost);
      s.info(`Autopilot: bought ${pick.count > 1 ? `${pick.count}× ` : ''}${pick.name} for ${q.title} ($${pick.cost}, ${where(src)})${src.kind === 'market' ? `; picking it up in ${src.townName}` : ''}.`);
      void s.loadQuests(true);
    } catch (err) {
      this.host.fail(key, `buying ${pick.name} (${where(src)}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Picks up market goods bought for a quest; once only: a failure leaves it to you (trade screen, market). */
  private async pickUp(p: MarketPickup): Promise<void> {
    const s = this.host.state;
    const name = s.itemName(p.itemId);
    s.debug.add('quest', `Pick up ${name} at the market in ${p.townName}`, { pickup: p });
    s.updateAutopilot((f) => (f.pickups = f.pickups.filter((x) => x.offerId !== p.offerId)));
    try {
      await s.autopilotCall(() => new MarketApi(s.client).fetch(p.offerId), `market: pick up ${name}`);
      s.info(`Autopilot: picked up ${name} at the market in ${p.townName} (for ${p.quest}).`);
      await s.refreshInventory();
      void s.loadQuests(true);
    } catch (err) {
      s.error(`Autopilot: could not pick up ${name} in ${p.townName}: ${err instanceof Error ? err.message : String(err)}. Pick it up on the market tab of the trade screen.`);
    }
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

