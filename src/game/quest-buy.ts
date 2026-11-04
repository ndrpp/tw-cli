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

const money = (countValue: number) => `$${Math.round(countValue).toLocaleString('en-US')}`;

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
  const walk = (source: BuySource) => (source.kind === 'mobile' ? 0 : travel(source.at));
  for (const need of needs) {
    const all = sources(need.itemId).filter((source) => source.price > 0 && walk(source) <= limits.maxWalk);
    const options: Option[] = [];
    for (const source of all) {
      if (
        source.kind === 'market' ||
        (source.kind === 'mobile' && source.item.limitedCount !== null && source.item.limitedCount < need.count)
      )
        continue;
      options.push({
        picks: [{ ...need, cost: source.price * need.count, source: source }],
        cost: source.price * need.count,
        walk: walk(source),
        market: false,
      });
    }
    const offers = limits.market ? all.filter((source) => source.kind === 'market') : [];
    // The cheapest lot overall and the cheapest in each single town (one pickup walk can beat a cheaper lot).
    const byTown = new Map<number, BuySource[]>();
    for (const optionsValue of offers)
      if (optionsValue.kind === 'market')
        byTown.set(optionsValue.townId, [...(byTown.get(optionsValue.townId) ?? []), optionsValue]);
    const lots = [
      cheapestLot(offers, need.count),
      ...[...byTown.values()].map((list) => cheapestLot(list, need.count)),
    ];
    const lot = lots[0];
    for (const lotOffers of lots) {
      if (!lotOffers) continue;
      // One walk per town the goods wait in.
      const towns = new Map(
        lotOffers.flatMap((offer) => (offer.kind === 'market' ? [[offer.townId, walk(offer)] as const] : [])),
      );
      options.push({
        picks: lotOffers.map((optionsValue) => ({
          ...need,
          count: unitCount(optionsValue),
          cost: optionsValue.price,
          source: optionsValue,
        })),
        cost: lotOffers.reduce((accumulator, current) => accumulator + current.price, 0),
        walk: [...towns.values()].reduce((accumulator, current) => accumulator + current, 0),
        market: true,
      });
    }
    const fits = (optionsValue: Option) =>
      optionsValue.market
        ? market + optionsValue.cost <= limits.marketLimit
        : direct + optionsValue.cost <= limits.buyLimit;
    const score = (optionsValue: Option) => optionsValue.cost + optionsValue.walk * limits.walkValue;
    const best = options
      .filter(fits)
      .sort((first, second) => score(first) - score(second) || first.walk - second.walk)[0];
    if (best) {
      if (best.market) market += best.cost;
      else direct += best.cost;
      picks.push(...best.picks);
      continue;
    }
    const shop = options
      .filter((optionsValue) => !optionsValue.market)
      .sort((first, second) => first.cost - second.cost)[0];
    const others = (spent: number) => (spent > 0 ? ` (with ${money(spent)} for the other items)` : '');
    const got = offers.reduce((accumulator, current) => accumulator + unitCount(current), 0);
    const firstPick = shop?.picks[0];
    const marketOption = options.find((optionsValue) => optionsValue.market);
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
  let best: { cost: number; take: number[] }[] = Array.from({ length: count + 1 }, (_, value) => ({
    cost: value === 0 ? 0 : Infinity,
    take: [],
  }));
  offers.forEach((optionsValue, index) => {
    const next = best.map((second) => ({ ...second }));
    for (let value = 0; value <= count; value++) {
      const from = best[value];
      if (!from || !Number.isFinite(from.cost)) continue;
      const to = Math.min(count, value + unitCount(optionsValue));
      const target = next[to];
      if (!target) continue;
      const cost = from.cost + optionsValue.price;
      if (cost < target.cost || (cost === target.cost && from.take.length + 1 < target.take.length))
        next[to] = { cost, take: [...from.take, index] };
    }
    best = next;
  });
  const end = best[count];
  if (!end || !Number.isFinite(end.cost)) return null;
  return end.take.flatMap((index) => {
    const offer = offers[index];
    return offer ? [offer] : [];
  });
}

const unitCount = (source: BuySource) => (source.kind === 'market' ? Math.max(1, source.offer.count) : 1);

export function where(source: BuySource): string {
  if (source.kind === 'mobile') return 'mobile trader';
  if (source.kind === 'market') return `market in ${source.townName}`;
  return `${source.shop === 'general' ? 'general store' : source.shop} in ${source.townName}`;
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
      offers: offers.filter(
        (offerInfo) =>
          offerInfo.direction === 'SELL' && offerInfo.buyNow !== null && baseId(offerInfo.itemId) === baseId(itemId),
      ),
    });
    this.version++;
  }

  /** An offer was bought (or is gone): forget it. */
  dropOffer(offerId: number): void {
    for (const match of this.market.values())
      match.offers = match.offers.filter((offerInfo) => offerInfo.id !== offerId);
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
    for (const [townId, candidate] of this.shops) {
      const targetValue = town(townId);
      if (!targetValue) continue;
      for (const shop of candidate.shops) {
        const id = shop.items.find((index) => baseId(index) === base);
        if (id !== undefined)
          out.push({
            kind: 'shop',
            shop: shop.key,
            townId,
            townName: targetValue.name,
            at: targetValue.at,
            price: Math.round(price(id) * (shop.charge || 1)),
          });
      }
    }
    for (const index of this.mobile?.trader.items ?? []) {
      const dollar = index.prices.find((pick) => pick.currency === 'dollar');
      if (baseId(index.itemId) === base && dollar && index.limitedCount !== 0)
        out.push({ kind: 'mobile', item: index, price: dollar.amount });
    }
    for (const offerInfo of this.market.get(base)?.offers ?? []) {
      const townId = townAt(offerInfo.town);
      if (townId !== undefined && offerInfo.buyNow !== null && offerInfo.buyNow > 0)
        out.push({
          kind: 'market',
          offer: offerInfo,
          townId,
          townName: offerInfo.town.name,
          at: { x: offerInfo.town.x, y: offerInfo.town.y },
          price: offerInfo.buyNow,
        });
    }
    return out;
  }
}
