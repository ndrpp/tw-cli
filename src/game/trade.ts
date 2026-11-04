// Bank, town shops, item use and the market.
//   Bank (BankWindow @1222900): building_bank get_data (mode) {town_id} → {error:false, deposit, own_money,
//     deposit_fee (%), town_name, stage}; building_bank/deposit {town_id, amount} → {error:false, deposit,
//     own_money, fee}. There is no withdrawal: purchases take money from cash first, then the bank.
//   Shops (Trader @1159503): window=building_<gunsmith|tailor|general>&town_id=N (no mode) → {trader_inv:[{item_id}],
//     charge (price factor), level, town_name}; <window>/buy {item_id, town_id, last_inv_id} → {changes,
//     money:{barrows, deposit}} | {expressoffer, price} when not in town | {error}; <window>/sell {inv_id, town_id,
//     item_id, count, last_inv_id} → {money, changes} | {error}.
//   Item use (ItemUse.doIt @822715): itemuse/use_item {item_id, item_count, lastInvId} → {msg:{changes, effects:[
//     {type: experience|dollar|energy|hitpoints|buff|content|lottery|...}], cooldown, itemCooldown}} | {error, msg}.
//   Mobile trader (shop_trader index @2124565, the "trader" tab of the item shop): shop_trader/index (mode) {}
//     → {inventory:{trader:[{item_id, tab, currency (bitmask 1 bonds · 2 nuggets · 4 dollar · 8 veteran),
//     price_<currency>, reduced_value, limited_time, limited_count, teaser}]}, currencies, traderTime (epoch s)};
//     shop_trader/buy {item_id, category, currency} → {bonds, cash, deposit, msg}.
//   Market (MarketWindow @1659317–@1756000):
//     building_market/search {pattern, nav:'first', page, sort:'bid', order:'asc', type:'', level_range_min:'0',
//       level_range_max:'', usable, has_effect, visibility:2, direction_sell:true, direction_buy:false}
//       → {msg:{search_result:[offer], next}}   (Buy.init(false,true) → offers people sell)
//     building_market/bid {bidtype (0 cash · 1 bank), bid, market_offer_id, direction} → {msg:{money, deposit,
//       instantBuy}} | {error, msg}
//     building_market/fetch_bids {} → my bids; fetch_offers {page:0} → my sell offers; both {msg:{search_result}}
//     building_market/fetch {market_offer_id} → {msg:{money}}  (pick up goods / money; on site only, else nuggets)
//     building_market/putup {town_id, item_id, itemcount, auctioncount, sellrights (2 = everyone), auctionlength
//       (days), description, direction:'SELL', bidtype:0, auctionprice?, maxprice?} → {msg:{money, deposit, costs}}
//     Buy orders ("wanted", direction BUY): the same search with direction_sell:false, direction_buy:true; sell
//       into one with bid {direction:'BUY'} (≤ max_price sells at max_price, @1725381); place one with putup
//       {direction:'BUY', bidtype 0 cash · 1 bank} where, if both are set, auctionprice > maxprice and the unit
//       price ≥ the item's shop sell price (putupOffer @1740900); get_own_buy_offers {town_id} → {msg:[offer],
//       is_at_town} (BuyItem.initData @1692396).
//     building_market/offtake {offer_id, direction} → {money} (refunded fee, −1 none; deleteFromMarket @1723990)
//     building_market/fetch_all {townId} → {msg:{money}} (everything finished at that town; fetchAll @1729990)
//     search filters: type = item type (category accordion @1676688), level_range_min/max, usable, has_effect
//       ("Consumable"); nav 'first' | 'next' | 'prev' (getNewPageNo)
//     fee (showMarketFees @1744617): ceil(int(price·0.02·10 + days·3) / market stage · (home town ? 1 : 2)) · auctions,
//       price = min(start, buy now) when both are set, else whichever is set
//   offer: {market_offer_id, item_id, item_count, current_bid|auction_price, max_price, auction_ends_in (s),
//     seller_name, seller_player_id, market_town_name, market_town_x, market_town_y, is_highest_bidder,
//     bidder_name, direction, description}
import type { GameClient } from '../http/game-client.ts';
import { arr, type JsonObject, obj, objs } from '../util/json.ts';
import { plainText } from './quests.ts';

const errText = (json: JsonObject, what: string) =>
  plainText(json.msg ?? (typeof json.error === 'string' ? json.error : '')) || `${what} failed`;
const optNum = (v: unknown) => (typeof v === 'number' ? v : undefined);

// ---- bank ----------------------------------------------------------------------------------

export interface Bank {
  townId: number;
  townName: string;
  fee: number;
  deposit: number;
  cash: number;
}

export async function fetchBank(client: GameClient, townId: number): Promise<Bank> {
  const json = await client.remoteCallMode('building_bank', 'get_data', { town_id: townId });
  if (json.error) throw new Error(errText(json, 'Bank'));
  return {
    townId,
    townName: plainText(json.town_name),
    fee: Number(json.deposit_fee) || 0,
    deposit: Number(json.deposit) || 0,
    cash: Number(json.own_money) || 0,
  };
}

export async function deposit(
  client: GameClient,
  townId: number,
  amount: number,
): Promise<{ deposit: number; cash: number; fee: number }> {
  const json = await client.remoteCall('building_bank', 'deposit', { town_id: townId, amount });
  if (json.error) throw new Error(errText(json, 'Deposit'));
  return { deposit: Number(json.deposit) || 0, cash: Number(json.own_money) || 0, fee: Number(json.fee) || 0 };
}

/** BankWindow fee: amount · fee% (shown before depositing). */
export const depositFee = (amount: number, feePercent: number) => Math.ceil((amount * feePercent) / 100);

// ---- shops ---------------------------------------------------------------------------------

export const SHOPS = [
  { key: 'general', window: 'building_general', label: 'General store' },
  { key: 'tailor', window: 'building_tailor', label: 'Tailor' },
  { key: 'gunsmith', window: 'building_gunsmith', label: 'Gunsmith' },
] as const;
export type ShopKey = (typeof SHOPS)[number]['key'];
const shopWindow = (k: ShopKey): string => SHOPS.find((s) => s.key === k)?.window ?? SHOPS[0].window;

export interface Shop {
  key: ShopKey;
  townId: number;
  townName: string;
  level: number;
  charge: number;
  items: number[];
}

export async function fetchShop(client: GameClient, key: ShopKey, townId: number): Promise<Shop> {
  // Trader.open: remoteCallMode(window + '&town_id=' + id, '') → game.php?window=building_x&town_id=N
  const json = await client.request(client.buildUrl({ window: `${shopWindow(key)}&town_id=${townId}` }), {});
  if (json.error) throw new Error(errText(json, 'Shop'));
  return {
    key,
    townId,
    townName: plainText(json.town_name),
    level: Number(json.level) || 0,
    charge: json.charge !== undefined ? Number(json.charge) : 1,
    items: objs(json.trader_inv).map((r) => Number(r.item_id)),
  };
}

export interface MoneyChange {
  changes: unknown[];
  cash?: number | undefined;
  deposit?: number | undefined;
}

export async function shopBuy(
  client: GameClient,
  key: ShopKey,
  townId: number,
  itemId: number,
  lastInvId: number,
): Promise<MoneyChange> {
  const json = await client.remoteCall(shopWindow(key), 'buy', {
    item_id: itemId,
    town_id: townId,
    last_inv_id: lastInvId,
  });
  if (json.error) throw new Error(errText(json, 'Buy'));
  if (json.expressoffer)
    throw new Error(
      'You are not in this town; walk there first (express delivery costs nuggets and is not offered here).',
    );
  return {
    changes: arr(json.changes),
    cash: optNum(obj(json.money).barrows),
    deposit: optNum(obj(json.money).deposit),
  };
}

export async function shopSell(
  client: GameClient,
  key: ShopKey,
  townId: number,
  item: { itemId: number; invId: number },
  count: number,
  lastInvId: number,
): Promise<MoneyChange> {
  const json = await client.remoteCall(shopWindow(key), 'sell', {
    inv_id: item.invId,
    town_id: townId,
    item_id: item.itemId,
    count,
    last_inv_id: lastInvId,
  });
  if (json.error) throw new Error(errText(json, 'Sell'));
  return { changes: arr(json.changes), cash: optNum(json.money) };
}

// ---- item use ------------------------------------------------------------------------------

export interface UseResult {
  changes: unknown[];
  effects: string[];
  energy?: number | undefined;
  health?: number | undefined;
}

/** ItemUse.doIt effect messages (texts as the web shows them). */
export function effectText(m: JsonObject, itemName: (id: number) => string): string[] {
  const buff = obj(m.buff);
  switch (m.type) {
    case 'experience':
    case 'level':
      return [`+${Math.ceil(Number(m.experience))} XP`];
    case 'dollar':
      return [`+$${Math.ceil(Number(m.dollar))}`];
    case 'energy':
      return [`Your energy increased to ${Math.floor(Number(m.energy))} points.`];
    case 'hitpoints':
      return [`Your health points increased to ${Math.round(Number(m.hitpoints))} points.`];
    case 'walk_time':
      return ['Walking time decreased.'];
    case 'duel_motivation':
      return [`Your duel motivation increased to ${Math.round(Number(m.duelmotivation) * 100)}%.`];
    case 'work_motivation':
      return ['Your work motivation has increased.'];
    case 'buff':
      return [
        Number(buff.duration) > 0 ? 'Buffed:' : `Raised for ${String(buff.charge ?? '?')} action(s):`,
        ...arr(buff.description).map((d) => plainText(d)),
      ];
    case 'content':
    case 'lottery':
      return [
        `You get: ${objs(m.items)
          .map((i) => `${Number(i.count) > 1 ? `${Number(i.count)}× ` : ''}${itemName(Number(i.item_id))}`)
          .join(', ')}`,
      ];
    case 'learn_recipe':
      return ['You learned a new recipe.'];
    default:
      return [String(m.type ?? 'done')];
  }
}

export async function useItem(
  client: GameClient,
  itemId: number,
  count: number,
  lastInvId: number,
  itemName: (id: number) => string,
): Promise<UseResult> {
  const json = await client.remoteCall('itemuse', 'use_item', { item_id: itemId, item_count: count, lastInvId });
  if (json.error) throw new Error(errText(json, 'Use item'));
  const msg = obj(json.msg);
  const effects = objs(msg.effects);
  return {
    changes: arr(msg.changes),
    effects: effects.flatMap((e) => effectText(e, itemName)),
    energy: optNum(effects.find((e) => e.type === 'energy')?.energy),
    health: optNum(effects.find((e) => e.type === 'hitpoints')?.hitpoints),
  };
}

// ---- mobile trader -------------------------------------------------------------------------

/** Currency bit → name, from shop_trader/index `currencies` (verified live: {1:bonds, 2:nuggets, 4:dollar, 8:veteran}). */
const SHOP_CURRENCIES: [number, string][] = [
  [1, 'bonds'],
  [2, 'nuggets'],
  [4, 'dollar'],
  [8, 'veteran'],
];

export interface MobileTraderPrice {
  currency: string;
  amount: number;
  base: number;
}

export interface MobileTraderItem {
  itemId: number;
  tab: string;
  /** Prices the offer accepts; the first one is used for a purchase. */
  prices: MobileTraderPrice[];
  discount: number;
  /** Epoch seconds when the offer changes; null when it does not rotate. */
  limitedAt: number | null;
  limitedCount: number | null;
  teaser: string;
}

export interface MobileTrader {
  items: MobileTraderItem[];
  /** Epoch seconds of the next rotation (shop_trader/index `traderTime`). */
  changesAt: number | null;
}

export function parseMobileTraderItem(r: JsonObject): MobileTraderItem {
  const currency = Number(r.currency) || 0;
  const discount = Number(r.reduced_value) || 0;
  const prices: MobileTraderPrice[] = [];
  for (const [bit, name] of SHOP_CURRENCIES) {
    if (!(currency & bit)) continue;
    const base = Number(r[`price_${name}`]) || 0;
    if (!base) continue;
    prices.push({ currency: name, base, amount: discount ? Math.round((base * (100 - discount)) / 100) : base });
  }
  // The mobile trader is a dollar shop; prefer that price when an offer accepts several currencies.
  prices.sort((a, b) => Number(b.currency === 'dollar') - Number(a.currency === 'dollar'));
  const limited = Number(r.limited_count);
  const limitedAt = Number(r.limited_time) || null;
  return {
    itemId: Number(r.item_id),
    tab: String(r.tab ?? 'trader'),
    prices,
    discount,
    limitedAt,
    limitedCount:
      Number.isFinite(limited) && r.limited_count !== null && r.limited_count !== undefined ? limited : null,
    teaser: plainText(String(r.teaser ?? '')),
  };
}

/** The rotating offers of the mobile trader (the "trader" tab of the item shop). */
export async function fetchMobileTrader(client: GameClient): Promise<MobileTrader> {
  const json = await client.remoteCallMode('shop_trader', 'index', {});
  if (json.error) throw new Error(errText(json, 'Mobile trader'));
  return {
    items: objs(obj(json.inventory).trader)
      .map(parseMobileTraderItem)
      .filter((i) => i.prices.length > 0),
    changesAt: Number(json.traderTime) || null,
  };
}

/** Buys one mobile-trader offer. The reply has no bag changes; refresh the inventory afterwards. */
export async function buyMobileTrader(
  client: GameClient,
  item: MobileTraderItem,
  currency = item.prices[0]?.currency,
): Promise<{ cash?: number | undefined; deposit?: number | undefined; bonds?: number | undefined; message: string }> {
  if (!currency) throw new Error('This offer has no price.');
  const json = await client.remoteCall('shop_trader', 'buy', { item_id: item.itemId, category: item.tab, currency });
  if (json.error) throw new Error(errText(json, 'Mobile trader buy'));
  return {
    cash: optNum(json.cash),
    deposit: optNum(json.deposit),
    bonds: optNum(json.bonds),
    message: plainText(String(json.msg ?? '')),
  };
}

// ---- market --------------------------------------------------------------------------------

/** Market item categories (MarketWindow category accordion), as item `type`s. */
export const MARKET_CATEGORIES: { type: string; label: string }[] = [
  { type: '', label: 'all' },
  { type: 'belt', label: 'Belt' },
  { type: 'body', label: 'Clothing' },
  { type: 'right_arm', label: 'Duelling weapon' },
  { type: 'head', label: 'Headgear' },
  { type: 'left_arm', label: 'Left hand' },
  { type: 'neck', label: 'Neckband' },
  { type: 'pants', label: 'Pants' },
  { type: 'yield', label: 'Product' },
  { type: 'recipe', label: 'Recipe' },
  { type: 'animal', label: 'Animal' },
  { type: 'foot', label: 'Shoes' },
];

export interface MarketFilter {
  /** Item type ('' = all). */
  type: string;
  levelMin: number;
  /** 0 = no upper limit. */
  levelMax: number;
  usable: boolean;
  consumable: boolean;
  /** true: buy orders (people who want an item) instead of goods for sale. */
  buyOrders: boolean;
}

export const DEFAULT_FILTER: MarketFilter = {
  type: '',
  levelMin: 0,
  levelMax: 0,
  usable: false,
  consumable: false,
  buyOrders: false,
};

export interface MarketOffer {
  id: number;
  itemId: number;
  count: number;
  /** Current bid (or the starting price); null when there is no auction part. */
  bid: number | null;
  /** The auction's starting price (auction_price); null without an auction part. */
  startPrice: number | null;
  /** The highest bid so far (current_bid); null before the first bid. */
  currentBid: number | null;
  /** Buy-now price (for a buy order: the instant sale price); null when only bidding. */
  buyNow: number | null;
  endsIn: number;
  seller: string;
  sellerId: number;
  bidder: string;
  town: { name: string; x: number; y: number };
  highestBidder: boolean;
  direction: 'SELL' | 'BUY';
  finished: boolean;
  description: string;
}

export function parseOffer(o: JsonObject): MarketOffer {
  const bid = o.current_bid ?? o.auction_price;
  const ends = Number(o.auction_ends_in) || 0;
  return {
    id: Number(o.market_offer_id),
    itemId: Number(o.item_id),
    count: Number(o.item_count) || 1,
    bid: bid === null || bid === undefined || bid === '' ? null : Number(bid),
    startPrice:
      o.auction_price === null || o.auction_price === undefined || o.auction_price === ''
        ? null
        : Number(o.auction_price),
    currentBid:
      o.current_bid === null || o.current_bid === undefined || o.current_bid === '' ? null : Number(o.current_bid),
    buyNow: o.max_price === null || o.max_price === undefined || o.max_price === '' ? null : Number(o.max_price),
    endsIn: Math.max(0, ends),
    seller: o.seller_name ? String(o.seller_name) : 'Deleted',
    sellerId: Number(o.seller_player_id) || 0,
    bidder: o.bidder_name ? String(o.bidder_name) : '',
    town: { name: String(o.market_town_name ?? ''), x: Number(o.market_town_x) || 0, y: Number(o.market_town_y) || 0 },
    highestBidder: !!o.is_highest_bidder,
    direction: o.direction === 'BUY' ? 'BUY' : 'SELL',
    finished: ends <= 0,
    description: o.description ? plainText(String(o.description)) : '',
  };
}

const offerList = (rows: unknown): MarketOffer[] => objs(rows).map(parseOffer);
const offers = (json: JsonObject): MarketOffer[] => offerList(obj(json.msg).search_result);

/** The bid the web's bid dialog pre-fills: just above the current bid / starting price, else the instant price. */
export function suggestedBid(o: MarketOffer): number {
  if (o.startPrice) return Math.max(o.startPrice - 1, o.currentBid ?? 0) + 1;
  return o.buyNow ?? (o.bid ?? 0) + 1;
}

/** The fee the market window shows before putting up an offer or buy order (showMarketFees). */
export function marketFee(o: {
  startPrice?: number | undefined;
  buyNow?: number | undefined;
  days: number;
  stage?: number | undefined;
  homeTown: boolean;
  auctions?: number | undefined;
}): number {
  const a = o.startPrice || 0;
  const b = o.buyNow || 0;
  if (!a && !b) return 0;
  const price = a && b ? Math.min(a, b) : Math.max(a, b);
  const base = Math.trunc(price * 0.02 * 10 + o.days * 3);
  return Math.ceil((base / Math.max(1, o.stage ?? 1)) * (o.homeTown ? 1 : 2)) * (o.auctions ?? 1);
}

/** calcUnitPrice: the buy-now price if set, else the starting price, per item (rounded up). */
export const unitPrice = (startPrice: number | undefined, buyNow: number | undefined, count: number) =>
  Math.ceil((buyNow || startPrice || 0) / Math.max(1, count));

/** putupOffer's checks for a buy order; returns the error text or null. */
export function buyOrderProblem(
  o: { maxBid?: number | undefined; instant?: number | undefined; count: number },
  itemSellPrice: number,
): string | null {
  if (!o.maxBid && !o.instant) return 'Set an instant price or a maximum bid.';
  if (o.maxBid && o.instant && o.instant >= o.maxBid) return 'The maximum bid must be higher than the instant price.';
  if (unitPrice(o.maxBid, o.instant, o.count) < itemSellPrice)
    return `The price per item must be at least the shop sell price ($ ${itemSellPrice}).`;
  return null;
}

export class MarketApi {
  private client: GameClient;

  constructor(client: GameClient) {
    this.client = client;
  }

  async search(
    pattern: string,
    page = 1,
    filter: MarketFilter = DEFAULT_FILTER,
    nav: 'first' | 'next' | 'prev' = page > 1 ? 'next' : 'first',
  ): Promise<{ offers: MarketOffer[]; next: boolean }> {
    const json = await this.client.remoteCall('building_market', 'search', {
      pattern,
      nav: page > 1 ? nav : 'first',
      page,
      sort: 'bid',
      order: 'asc',
      type: filter.type,
      level_range_min: String(filter.levelMin || 0),
      level_range_max: filter.levelMax ? String(filter.levelMax) : '',
      usable: filter.usable,
      has_effect: filter.consumable,
      visibility: 2,
      direction_sell: !filter.buyOrders,
      direction_buy: filter.buyOrders,
    });
    if (json.error) throw new Error(errText(json, 'Market search'));
    return { offers: offers(json).filter((o) => !o.finished), next: !!obj(json.msg).next };
  }

  /**
   * Bids `amount` on an offer. On goods for sale, ≥ the buy-now price buys instantly; on a buy order you sell
   * your item, and ≤ the instant price sells instantly at that price. bidtype 0 pays cash, 1 the bank account.
   */
  async bid(
    offer: MarketOffer,
    amount: number,
    fromBank: boolean,
  ): Promise<{ instant: boolean; cash?: number | undefined; deposit?: number | undefined; changes: unknown[] }> {
    const json = await this.client.remoteCall('building_market', 'bid', {
      bidtype: fromBank ? 1 : 0,
      bid: amount,
      market_offer_id: offer.id,
      direction: offer.direction,
    });
    if (json.error) throw new Error(errText(json, 'Bid'));
    const m = obj(json.msg);
    return {
      instant: !!(m.instantBuy ?? json.instantBuy),
      cash: optNum(m.money) || undefined,
      deposit: optNum(m.deposit) || undefined,
      changes: arr(m.changes),
    };
  }

  async myBids(): Promise<MarketOffer[]> {
    const json = await this.client.remoteCall('building_market', 'fetch_bids', {});
    if (json.error) throw new Error(errText(json, 'Market bids'));
    return offers(json);
  }

  async myOffers(): Promise<MarketOffer[]> {
    const json = await this.client.remoteCall('building_market', 'fetch_offers', { page: 0 });
    if (json.error) throw new Error(errText(json, 'Market offers'));
    return offers(json);
  }

  /** Your buy orders (BuyItem.initData sends the market's town). */
  async myBuyOrders(townId: number): Promise<MarketOffer[]> {
    const json = await this.client.remoteCall('building_market', 'get_own_buy_offers', { town_id: townId });
    if (json.error) throw new Error(errText(json, 'Buy orders'));
    return offerList(Array.isArray(json.msg) ? json.msg : obj(json.msg).search_result);
  }

  /** Picks up a finished offer's goods or money (must be in the market town). */
  async fetch(offerId: number): Promise<{ cash?: number | undefined }> {
    const json = await this.client.remoteCall('building_market', 'fetch', { market_offer_id: offerId });
    if (json.error) throw new Error(errText(json, 'Pick up'));
    return { cash: optNum(obj(json.msg).money) };
  }

  /** Picks up everything finished at this town's market. */
  async fetchAll(townId: number): Promise<{ cash?: number | undefined }> {
    const json = await this.client.remoteCall('building_market', 'fetch_all', { townId });
    if (json.error) throw new Error(errText(json, 'Pick up'));
    return { cash: optNum(obj(json.msg).money) };
  }

  /** Withdraws one of your sell offers or buy orders; returns the refunded fee (0 when none). */
  async withdraw(offer: MarketOffer): Promise<{ refund: number }> {
    const json = await this.client.remoteCall('building_market', 'offtake', {
      offer_id: offer.id,
      direction: offer.direction,
    });
    if (json.error) throw new Error(errText(json, 'Withdraw'));
    const refund = Number(json.money);
    return { refund: Number.isFinite(refund) ? Math.max(0, refund) : 0 };
  }

  /** Puts items up for sale in a town's market (MarketWindow.Offer.getOfferObject). */
  async sell(o: {
    townId: number;
    itemId: number;
    count: number;
    days: number;
    startPrice?: number | undefined;
    buyNow?: number | undefined;
    description?: string | undefined;
  }): Promise<{ fee: number; cash?: number | undefined; deposit?: number | undefined }> {
    if (!o.startPrice && !o.buyNow) throw new Error('Set a starting bid or a buy-now price.');
    return this.putup({
      townId: o.townId,
      itemId: o.itemId,
      count: o.count,
      days: o.days,
      auctionprice: o.startPrice,
      maxprice: o.buyNow,
      description: o.description,
      direction: 'SELL',
      bidtype: 0,
    });
  }

  /** Places a buy order: you pay at most `maxBid` (auction) or `instant` (sells to you at once). */
  async buyOrder(o: {
    townId: number;
    itemId: number;
    count: number;
    days: number;
    maxBid?: number | undefined;
    instant?: number | undefined;
    fromBank: boolean;
    description?: string | undefined;
  }): Promise<{ fee: number; cash?: number | undefined; deposit?: number | undefined }> {
    if (!o.maxBid && !o.instant) throw new Error('Set an instant price or a maximum bid.');
    if (o.maxBid && o.instant && o.instant >= o.maxBid)
      throw new Error('The maximum bid must be higher than the instant price.');
    return this.putup({
      townId: o.townId,
      itemId: o.itemId,
      count: o.count,
      days: o.days,
      auctionprice: o.maxBid,
      maxprice: o.instant,
      description: o.description,
      direction: 'BUY',
      bidtype: o.fromBank ? 1 : 0,
    });
  }

  private async putup(o: {
    townId: number;
    itemId: number;
    count: number;
    days: number;
    auctionprice?: number | undefined;
    maxprice?: number | undefined;
    description?: string | undefined;
    direction: 'SELL' | 'BUY';
    bidtype: 0 | 1;
  }) {
    const post: Record<string, string | number> = {
      town_id: o.townId,
      item_id: o.itemId,
      itemcount: o.count,
      auctioncount: 1,
      sellrights: 2,
      auctionlength: o.days,
      description: o.description ?? '',
      direction: o.direction,
      bidtype: o.bidtype,
    };
    if (o.auctionprice) post.auctionprice = o.auctionprice;
    if (o.maxprice) post.maxprice = o.maxprice;
    const json = await this.client.remoteCall('building_market', 'putup', post);
    if (json.error) throw new Error(errText(json, o.direction === 'BUY' ? 'Buy order' : 'Market offer'));
    const m = obj(json.msg);
    return { fee: Number(m.costs) || 0, cash: optNum(m.money), deposit: optNum(m.deposit) };
  }
}
