// Quest items no job drops, bought instead: in town shops (general store, tailor, gunsmith; read remotely for the
// towns within the buy trip, bought on the spot), from the mobile trader (anywhere) or as market instant-buy
// offers (bought from anywhere, picked up in the offer's town). `chooseBuys` (pure) picks a source per item
// within the per-quest limits; `BuyCatalog` keeps what the runner fetched.
import type { Position } from './character.ts';
import { baseId } from './items.ts';
import type { MarketOffer, MobileTrader, MobileTraderItem, Shop, ShopKey } from './trade.ts';

/** `price`: per item for a shop or the mobile trader; the whole offer (`offer.count` items) on the market. */
export type BuySource =
  | { kind: 'shop'; shop: ShopKey; townId: number; townName: string; at: Position; price: number }
  | { kind: 'mobile'; item: MobileTraderItem; price: number }
  | { kind: 'market'; offer: MarketOffer; townId: number; townName: string; at: Position; price: number };

export interface BuyNeed {
  itemId: number;
  name: string;
  count: number;
}
export interface BuyPick {
  itemId: number;
  name: string;
  count: number;
  cost: number;
  source: BuySource;
}
/**
 * buyLimit / marketLimit: per quest, shops + mobile trader / market. walkValue: $ one second of walking is worth
 * (a shop further away must be that much cheaper). maxWalk: furthest walk to a shop or market town (s).
 */
export interface BuyLimits {
  buyLimit: number;
  marketLimit: number;
  market: boolean;
  walkValue: number;
  maxWalk: number;
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** One way to get a needed item: a shop / the mobile trader, or a lot of market offers. */
interface Option {
  picks: BuyPick[];
  cost: number;
  walk: number;
  market: boolean;
}

/**
 * A source for each needed item, the cheapest counting walking (price + walk × walkValue; equal: less walk):
 * a shop or the mobile trader within `buyLimit` for the quest, or the cheapest lot of market offers within
 * `marketLimit`. Sources beyond `maxWalk`, without a price, or a mobile offer limited to fewer than needed are
 * left out. Stops at the first item it cannot get: `problem` says why, and nothing should be bought for the quest.
 */
export function chooseBuys(
  needs: BuyNeed[],
  sources: (itemId: number) => BuySource[],
  limits: BuyLimits,
  travel: (at: Position) => number,
): { picks: BuyPick[]; problem: string | null } {
  const picks: BuyPick[] = [];
  let direct = 0;
  let market = 0;
  const walk = (s: BuySource) => (s.kind === 'mobile' ? 0 : travel(s.at));
  for (const need of needs) {
    const all = sources(need.itemId).filter((s) => s.price > 0 && walk(s) <= limits.maxWalk);
    const options: Option[] = [];
    for (const s of all) {
      if (
        s.kind === 'market' ||
        (s.kind === 'mobile' && s.item.limitedCount !== null && s.item.limitedCount < need.count)
      )
        continue;
      options.push({
        picks: [{ ...need, cost: s.price * need.count, source: s }],
        cost: s.price * need.count,
        walk: walk(s),
        market: false,
      });
    }
    const offers = limits.market ? all.filter((s) => s.kind === 'market') : [];
    // The cheapest lot overall and the cheapest in each single town (one pickup walk can beat a cheaper lot).
    const byTown = new Map<number, BuySource[]>();
    for (const o of offers) if (o.kind === 'market') byTown.set(o.townId, [...(byTown.get(o.townId) ?? []), o]);
    const lots = [
      cheapestLot(offers, need.count),
      ...[...byTown.values()].map((list) => cheapestLot(list, need.count)),
    ];
    const lot = lots[0];
    for (const l of lots) {
      if (!l) continue;
      // One walk per town the goods wait in.
      const towns = new Map(l.map((o) => [(o as { townId: number }).townId, walk(o)]));
      options.push({
        picks: l.map((o) => ({ ...need, count: unitCount(o), cost: o.price, source: o })),
        cost: l.reduce((a, o) => a + o.price, 0),
        walk: [...towns.values()].reduce((a, w) => a + w, 0),
        market: true,
      });
    }
    const fits = (o: Option) => (o.market ? market + o.cost <= limits.marketLimit : direct + o.cost <= limits.buyLimit);
    const score = (o: Option) => o.cost + o.walk * limits.walkValue;
    const best = options.filter(fits).sort((a, b) => score(a) - score(b) || a.walk - b.walk)[0];
    if (best) {
      if (best.market) market += best.cost;
      else direct += best.cost;
      picks.push(...best.picks);
      continue;
    }
    const shop = options.filter((o) => !o.market).sort((a, b) => a.cost - b.cost)[0];
    const others = (spent: number) => (spent > 0 ? ` (with ${money(spent)} for the other items)` : '');
    const got = offers.reduce((a, o) => a + unitCount(o), 0);
    const firstPick = shop?.picks[0];
    const marketOption = options.find((o) => o.market);
    const problem = shop
      ? `${need.name}: ${money(shop.cost)} (${firstPick ? where(firstPick.source) : 'unknown'}), over the ${money(limits.buyLimit)} quest buy limit${others(direct)}`
      : lot
        ? `${need.name}: ${money(marketOption?.cost ?? 0)} on the market, over the ${money(limits.marketLimit)} market limit${others(market)}`
        : offers.length
          ? `${need.name}: the market has only ${got} of ${need.count}`
          : `${need.name}: no job drops it, and no shop in reach${limits.market ? ', the mobile trader or the market' : ' or the mobile trader'} sells it`;
    return { picks, problem };
  }
  return { picks, problem: null };
}

/** The cheapest set of offers with at least `count` items between them (0/1 knapsack over the count), or null. */
function cheapestLot(offers: BuySource[], count: number): BuySource[] | null {
  if (count <= 0 || !offers.length) return null;
  // best[u]: cheapest cost for at least u items (u capped at count), with the offers taken.
  let best: { cost: number; take: number[] }[] = Array.from({ length: count + 1 }, (_, u) => ({
    cost: u === 0 ? 0 : Infinity,
    take: [],
  }));
  offers.forEach((o, i) => {
    const next = best.map((b) => ({ ...b }));
    for (let u = 0; u <= count; u++) {
      const from = best[u];
      if (!from || !Number.isFinite(from.cost)) continue;
      const to = Math.min(count, u + unitCount(o));
      const target = next[to];
      if (!target) continue;
      const cost = from.cost + o.price;
      if (cost < target.cost || (cost === target.cost && from.take.length + 1 < target.take.length))
        next[to] = { cost, take: [...from.take, i] };
    }
    best = next;
  });
  const end = best[count];
  if (!end || !Number.isFinite(end.cost)) return null;
  return end.take.flatMap((i) => {
    const offer = offers[i];
    return offer ? [offer] : [];
  });
}

const unitCount = (s: BuySource) => (s.kind === 'market' ? Math.max(1, s.offer.count) : 1);

export function where(s: BuySource): string {
  if (s.kind === 'mobile') return 'mobile trader';
  if (s.kind === 'market') return `market in ${s.townName}`;
  return `${s.shop === 'general' ? 'general store' : s.shop} in ${s.townName}`;
}

/** How long fetched data counts: shop stock (unverified how often it changes), market offers, the mobile trader. */
export const SHOP_TTL_MS = 6 * 3600_000;
export const MARKET_TTL_MS = 30 * 60_000;
export const MOBILE_TTL_MS = 30 * 60_000;

/** What the runner fetched about where to buy; `version` changes with every update (a planner input). */
export class BuyCatalog {
  /** Town id → its shops (empty when they could not be read). */
  shops = new Map<number, { at: number; shops: Shop[] }>();
  mobile: { at: number; trader: MobileTrader } | null = null;
  /** Base item id → instant-buy offers. */
  market = new Map<number, { at: number; offers: MarketOffer[] }>();
  version = 0;

  setShops(townId: number, shops: Shop[]): void {
    this.shops.set(townId, { at: Date.now(), shops });
    this.version++;
  }

  setMobile(trader: MobileTrader): void {
    this.mobile = { at: Date.now(), trader };
    this.version++;
  }

  setMarket(itemId: number, offers: MarketOffer[]): void {
    this.market.set(baseId(itemId), {
      at: Date.now(),
      offers: offers.filter((o) => o.direction === 'SELL' && o.buyNow !== null && baseId(o.itemId) === baseId(itemId)),
    });
    this.version++;
  }

  /** An offer was bought (or is gone): forget it. */
  dropOffer(offerId: number): void {
    for (const m of this.market.values()) m.offers = m.offers.filter((o) => o.id !== offerId);
    this.version++;
  }

  mobileStale(now = Date.now()): boolean {
    if (!this.mobile) return true;
    const rotates = this.mobile.trader.changesAt;
    return now - this.mobile.at > MOBILE_TTL_MS || (!!rotates && now / 1000 > rotates);
  }

  /** Every place that sells the item, priced: shop price = item price × the shop's charge. */
  sources(
    itemId: number,
    price: (itemId: number) => number,
    town: (id: number) => { name: string; at: Position } | undefined,
    townAt: (at: Position) => number | undefined,
  ): BuySource[] {
    const base = baseId(itemId);
    const out: BuySource[] = [];
    for (const [townId, c] of this.shops) {
      const t = town(townId);
      if (!t) continue;
      for (const shop of c.shops) {
        const id = shop.items.find((i) => baseId(i) === base);
        if (id !== undefined)
          out.push({
            kind: 'shop',
            shop: shop.key,
            townId,
            townName: t.name,
            at: t.at,
            price: Math.round(price(id) * (shop.charge || 1)),
          });
      }
    }
    for (const i of this.mobile?.trader.items ?? []) {
      const dollar = i.prices.find((p) => p.currency === 'dollar');
      if (baseId(i.itemId) === base && dollar && i.limitedCount !== 0)
        out.push({ kind: 'mobile', item: i, price: dollar.amount });
    }
    for (const o of this.market.get(base)?.offers ?? []) {
      const townId = townAt(o.town);
      if (townId !== undefined && o.buyNow !== null && o.buyNow > 0)
        out.push({
          kind: 'market',
          offer: o,
          townId,
          townName: o.town.name,
          at: { x: o.town.x, y: o.town.y },
          price: o.buyNow,
        });
    }
    return out;
  }
}
