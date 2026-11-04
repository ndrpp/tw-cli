// Trade screen (g b): bank, town shops (buy / sell), the market (goods for sale and buy orders: search with filters,
// bid, buy now, sell into a buy order, place a buy order, sell, pick up, withdraw).
// Shops and the bank are those of the town you stand in, else your home town (buying needs you there).
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { depositFee, marketFee, MARKET_CATEGORIES, SHOPS, suggestedBid, type MarketFilter, type MarketOffer, type ShopKey } from '../game/trade.ts';
import { ItemDetail, type ScreenProps } from './character.ts';
import { formatDuration, money, scrollWindow, truncate } from './format.ts';
import { formKey, formValues, FormView, makeForm, type FormField, type FormState } from './form.ts';

const h = React.createElement;

type Tab = 'bank' | 'trader' | ShopKey | 'market' | 'mine';
const TABS: { key: Tab; label: string }[] = [
  { key: 'bank', label: 'Bank' },
  { key: 'trader', label: 'Mobile trader' },
  ...SHOPS.map((s) => ({ key: s.key as Tab, label: s.label })),
  { key: 'market', label: 'Market' },
  { key: 'mine', label: 'My market' },
];
type Pending =
  | { kind: 'deposit' }
  | { kind: 'bid'; offer: MarketOffer }
  | { kind: 'sell-shop'; itemId: number }
  | { kind: 'sell-market'; itemId: number }
  | { kind: 'buy-order' }
  | { kind: 'search' };
type Confirm = { text: string; run: () => void } | null;

const isShop = (t: Tab): t is ShopKey => SHOPS.some((s) => s.key === t);
const DAYS = ['1', '2', '3', '4', '5', '6', '7'];
const YES_NO = ['no', 'yes'];
const catLabel = (type: string) => MARKET_CATEGORIES.find((c) => c.type === type)?.label ?? 'all';
const catType = (label: string) => MARKET_CATEGORIES.find((c) => c.label === label)?.type ?? '';
const itemsLabel = (state: ScreenProps['state'], o: MarketOffer) => `${o.count > 1 ? `${o.count}× ` : ''}${state.itemName(o.itemId)}`;
const priceLabel = (p: { currency: string; amount: number }) => (p.currency === 'dollar' ? money(p.amount) : `${p.amount} ${p.currency}`);

function filterText(f: MarketFilter): string {
  const parts = [f.type ? catLabel(f.type) : '', f.levelMin || f.levelMax ? `level ${f.levelMin || 0}–${f.levelMax || '∞'}` : '', f.usable ? 'usable' : '', f.consumable ? 'consumable' : ''];
  return parts.filter(Boolean).join(', ');
}

function endsIn(sec: number): string {
  if (sec <= 0) return 'ended';
  if (sec >= 86400) return `${Math.floor(sec / 86400)}d`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h`;
  return `${Math.max(1, Math.floor(sec / 60))}m`;
}

export function TradeScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('bank');
  const [sel, setSel] = useState(0);
  /** Shop and market tabs: the shop's goods / offers, or your bag (to sell). */
  const [side, setSide] = useState<'goods' | 'bag'>('goods');
  const [form, setForm] = useState<FormState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const town = state.tradeTown;

  useEffect(() => void state.loadItems(), [state]);
  useEffect(() => {
    onCapture(!!form || !!confirm);
  }, [form, confirm]);
  useEffect(() => {
    setSel(0);
    setSide('goods');
    if (tab === 'trader') return void state.openMobileTrader();
    if (!town) return;
    if (tab === 'bank') void state.openBank(town.id);
    else if (isShop(tab)) void state.openShop(tab, town.id);
    else if (tab === 'mine') void state.loadMarketMine();
  }, [tab, town?.id]);

  const bagItems = state.inventory.items()
    .filter((b) => !state.inventory.isWorn(b.itemId))
    .sort((a, b) => state.itemName(a.itemId).localeCompare(state.itemName(b.itemId)));
  const shopItems = state.shop && isShop(tab) && state.shop.key === tab ? state.shop.items : [];
  const mine = state.marketMine ? [
    ...state.marketMine.bids.map((o) => ({ o, mineKind: 'bid' as const })),
    ...state.marketMine.offers.map((o) => ({ o, mineKind: 'offer' as const })),
    ...state.marketMine.buyOrders.map((o) => ({ o, mineKind: 'want' as const })),
  ] : [];
  const filter = state.market.filter;
  const traderItems = state.mobileTrader?.items ?? [];
  const rowsCount = tab === 'bank' ? 0
    : tab === 'trader' ? traderItems.length
      : side === 'bag' ? bagItems.length
        : isShop(tab) ? shopItems.length
          : tab === 'market' ? state.market.offers.length : mine.length;
  const idx = Math.min(sel, Math.max(0, rowsCount - 1));

  const ask = (p: Pending, f: FormState) => {
    setPending(p);
    setForm(f);
  };

  const submit = (p: Pending, v: Record<string, string>) => {
    const n = (k: string) => Number(v[k] ?? '') || 0;
    if (p.kind === 'deposit') return void state.depositMoney(n('amount'));
    if (p.kind === 'search') {
      const f: MarketFilter = {
        type: catType(v.cat ?? ''), levelMin: n('lmin'), levelMax: n('lmax'), usable: v.usable === 'yes', consumable: v.consumable === 'yes', buyOrders: v.dir === 'buy orders',
      };
      return void state.searchMarket(v.query ?? '', 1, f).then(() => setSel(0));
    }
    if (p.kind === 'bid') return void state.bidMarket(p.offer, n('amount'), v.pay === 'bank account');
    if (p.kind === 'buy-order') {
      return void state.placeBuyOrder({ query: v.item ?? '', count: Math.max(1, n('count')), days: Math.max(1, n('days')), maxBid: n('maxbid') || undefined, instant: n('instant') || undefined, fromBank: v.pay === 'bank account' });
    }
    if (p.kind === 'sell-shop') return void state.sellToShop(p.itemId, Math.max(1, n('count')));
    if (p.kind === 'sell-market') {
      return void state.sellOnMarket({ itemId: p.itemId, count: Math.max(1, n('count')), days: Math.max(1, n('days')), startPrice: n('start') || undefined, buyNow: n('buynow') || undefined });
    }
  };

  useInput((input, key) => {
    if (form && pending) {
      const r = formKey(form, input, key);
      if (r === 'cancel') return (setForm(null), setPending(null));
      if (r !== 'submit') return setForm(r);
      setForm(null);
      setPending(null);
      return submit(pending, formValues(form));
    }
    if (confirm) {
      setConfirm(null);
      if (input === 'y') confirm.run();
      return;
    }
    if (key.escape) {
      if (side === 'bag') return setSide('goods');
      return onExit();
    }
    if (key.leftArrow || key.rightArrow) {
      const d = key.rightArrow ? 1 : TABS.length - 1;
      return setTab((cur) => TABS[(TABS.findIndex((t) => t.key === cur) + d) % TABS.length]!.key);
    }
    const step = key.pageUp || key.pageDown ? 10 : 1;
    if (key.upArrow || input === 'k' || key.pageUp) return setSel(Math.max(0, idx - step));
    if (key.downArrow || input === 'j' || key.pageDown) return setSel(Math.min(rowsCount - 1, idx + step));
    if (tab === 'trader') {
      const item = traderItems[idx];
      if (key.return && item?.prices[0]) {
        const soldOut = item.limitedCount === 0 || (item.limitedAt !== null && item.limitedAt * 1000 <= Date.now());
        if (soldOut) return state.error('This mobile-trader offer has ended.');
        const p = item.prices[0];
        setConfirm({ text: `Buy ${state.itemName(item.itemId)} for ${priceLabel(p)}?`, run: () => void state.buyMobileTrader(item) });
      }
      return;
    }
    if (!town) return;

    if (tab === 'bank') {
      if (key.return || input === 'd') {
        const fee = state.bank?.fee ?? 0;
        return ask({ kind: 'deposit' }, makeForm(`Deposit in ${state.bank?.townName || town.name} (fee ${fee}%)`, [
          { key: 'amount', label: 'Amount $', value: String(state.character.cash), kind: 'number' },
        ], (v) => `Fee: $ ${depositFee(Number(v.amount) || 0, fee)} · you have $ ${state.character.cash} in cash`));
      }
      return;
    }

    if ((isShop(tab) || tab === 'market') && key.tab) {
      setSel(0);
      return setSide((s) => (s === 'goods' ? 'bag' : 'goods'));
    }

    if (side === 'bag') {
      const it = bagItems[idx];
      if (!it || !key.return) return;
      const d = state.items?.get(it.itemId);
      if (isShop(tab)) {
        if (d && !d.sellable) return state.error(`${d.name} cannot be sold.`);
        if (it.count > 1) {
          return ask({ kind: 'sell-shop', itemId: it.itemId }, makeForm(`Sell ${state.itemName(it.itemId)} for $ ${d?.sell ?? '?'} each`, [
            { key: 'count', label: 'How many', value: '1', kind: 'number', hint: `max ${it.count}` },
          ], (v) => `Total: $ ${(d?.sell ?? 0) * (Number(v.count) || 0)}`));
        }
        return setConfirm({ text: `Sell ${state.itemName(it.itemId)} for $ ${d?.sell ?? '?'}?`, run: () => void state.sellToShop(it.itemId, 1) });
      }
      if (d && !d.auctionable) return state.error(`${d.name} cannot be sold on the market.`);
      return ask({ kind: 'sell-market', itemId: it.itemId }, makeForm(`Sell ${state.itemName(it.itemId)} on the market of ${town.name}`, [
        { key: 'count', label: 'Amount', value: '1', kind: 'number', hint: `max ${it.count}` },
        { key: 'start', label: 'Starting bid $', value: '', kind: 'number', hint: 'empty: buy-now only' },
        { key: 'buynow', label: 'Buy now $', value: '', kind: 'number', hint: 'empty: auction only' },
        { key: 'days', label: 'Days', value: '1', kind: 'choice', options: DAYS },
      ], (v) => {
        const fee = marketFee({ startPrice: Number(v.start) || 0, buyNow: Number(v.buynow) || 0, days: Number(v.days) || 1, homeTown: town.id === state.character.homeTown?.id });
        return `Shop sell price $ ${d?.sell ?? '?'} each · fee up to $ ${fee} (less at a bigger market)`;
      }));
    }

    if (isShop(tab)) {
      const itemId = shopItems[idx];
      if (itemId !== undefined && key.return) {
        const price = state.shopPrice(itemId);
        if (!town.here) return state.error(`You are not in ${town.name}. Walk there first.`);
        return setConfirm({ text: `Buy ${state.itemName(itemId)} for $ ${price}?`, run: () => void state.buyFromShop(itemId) });
      }
      return;
    }

    if (tab === 'market') {
      if (input === '/') {
        return ask({ kind: 'search' }, makeForm('Search the market', [
          { key: 'query', label: 'Item name', value: state.market.query, hint: 'empty: everything' },
          { key: 'dir', label: 'Show', value: filter.buyOrders ? 'buy orders' : 'for sale', kind: 'choice', options: ['for sale', 'buy orders'] },
          { key: 'cat', label: 'Category', value: catLabel(filter.type), kind: 'choice', options: MARKET_CATEGORIES.map((c) => c.label) },
          { key: 'lmin', label: 'Level from', value: filter.levelMin ? String(filter.levelMin) : '', kind: 'number' },
          { key: 'lmax', label: 'Level to', value: filter.levelMax ? String(filter.levelMax) : '', kind: 'number', hint: 'empty: any' },
          { key: 'usable', label: 'Usable by me', value: filter.usable ? 'yes' : 'no', kind: 'choice', options: YES_NO },
          { key: 'consumable', label: 'Consumable', value: filter.consumable ? 'yes' : 'no', kind: 'choice', options: YES_NO },
        ]));
      }
      if (input === 't') return void state.searchMarket(state.market.query, 1, { ...filter, buyOrders: !filter.buyOrders }).then(() => setSel(0));
      if (input === 'n') {
        return ask({ kind: 'buy-order' }, makeForm(`Buy order at the market of ${town.name}`, [
          { key: 'item', label: 'Item name', value: '' },
          { key: 'count', label: 'Amount', value: '1', kind: 'number' },
          { key: 'instant', label: 'Instant price $', value: '', kind: 'number', hint: 'a seller gets this at once' },
          { key: 'maxbid', label: 'Max bid $', value: '', kind: 'number', hint: 'auction; above the instant price' },
          { key: 'days', label: 'Days', value: '1', kind: 'choice', options: DAYS },
          { key: 'pay', label: 'Pay from', value: 'cash', kind: 'choice', options: ['cash', 'bank account'] },
        ], (v) => {
          const found = state.findAuctionable(v.item ?? '');
          const what = !v.item ? 'type an item name' : found.length === 1 ? found[0]!.name : found.length ? `${found.length} matches: ${found.slice(0, 3).map((f) => f.name).join(', ')}…` : 'no such market item';
          const fee = marketFee({ startPrice: Number(v.maxbid) || 0, buyNow: Number(v.instant) || 0, days: Number(v.days) || 1, homeTown: town.id === state.character.homeTown?.id });
          return `${what} · fee up to $ ${fee}`;
        }));
      }
      if (input === '>' && state.market.next) return void state.searchMarket(state.market.query, state.market.page + 1).then(() => setSel(0));
      if (input === '<' && state.market.page > 1) return void state.searchMarket(state.market.query, state.market.page - 1).then(() => setSel(0));
      const o = state.market.offers[idx];
      if (!o) return;
      if (input === 'w') return void state.walkToTownAt(o.town, o.town.name);
      const wanted = o.direction === 'BUY';
      if (key.return && o.buyNow !== null) {
        return setConfirm(wanted
          ? { text: `Sell ${itemsLabel(state, o)} to ${o.seller} now for $ ${o.buyNow}?`, run: () => void state.bidMarket(o, o.buyNow!) }
          : { text: `Buy ${itemsLabel(state, o)} now for $ ${o.buyNow} (cash, then bank)?`, run: () => void state.bidMarket(o, o.buyNow!) });
      }
      if (input === 'b' || key.return) {
        const fields: FormField[] = [{ key: 'amount', label: wanted ? 'Your price $' : 'Your bid $', value: String(suggestedBid(o)), kind: 'number', hint: o.buyNow !== null ? `${wanted ? 'instant sale' : 'buy now'}: $ ${o.buyNow}` : '' }];
        if (!wanted) fields.push({ key: 'pay', label: 'Pay from', value: 'cash', kind: 'choice', options: ['cash', 'bank account'] });
        return ask({ kind: 'bid', offer: o }, makeForm(`${wanted ? 'Sell into the buy order for' : 'Bid on'} ${itemsLabel(state, o)}`, fields,
          wanted ? () => `You have ${state.inventory.count(o.itemId)} · the item leaves your bag when you win` : undefined));
      }
      return;
    }

    // My market: pick up finished bids / offers / buy orders in the market town, withdraw running ones.
    if (input === 'P') return setConfirm({ text: `Pick up everything finished at the market of ${state.townHere?.name ?? 'this town'}?`, run: () => void state.pickUpAllMarket() });
    const m = mine[idx];
    if (!m) return;
    if (input === 'w') return void state.walkToTownAt(m.o.town, m.o.town.name);
    if (key.return && m.o.finished) return void state.pickUpMarket(m.o);
    if (input === 'x' && m.mineKind !== 'bid' && !m.o.finished) {
      return setConfirm({ text: `Withdraw your ${m.mineKind === 'want' ? 'buy order' : 'offer'} for ${itemsLabel(state, m.o)}? Fees are only partly refunded.`, run: () => void state.withdrawMarket(m.o) });
    }
  }, { isActive: active });

  // ---- render ------------------------------------------------------------------------------
  const leftW = Math.max(34, Math.floor(width * 0.5));
  const rightW = width - leftW;
  const bodyH = height - 1; // below the tab row
  const formH = form ? form.fields.length + 4 + (form.note ? 1 : 0) : 0;
  const listRows = Math.max(2, height - 6 - (confirm ? 1 : 0));
  const [start, end] = scrollWindow(idx, rowsCount, listRows);
  const tabs = h(Text, { wrap: 'truncate' }, ...TABS.map((t) =>
    h(Text, { key: t.key, inverse: tab === t.key, bold: tab === t.key, color: tab === t.key ? 'cyan' : undefined }, ` ${t.label} `)),
  h(Text, { dimColor: true }, ' ← →'));
  const trader = state.mobileTrader;
  const traderLeft = trader?.changesAt ? Math.max(0, trader.changesAt - state.clock.now()) : 0;
  const where = tab === 'trader'
    ? `${trader ? `Mobile trader · ${trader.items.length} offer(s)` : 'Loading mobile trader…'}${traderLeft ? ` · changes in ${endsIn(traderLeft)}` : ''} · cash ${money(state.character.cash)} · bank ${money(state.character.deposit)}`
    : town
      ? `${town.name}${town.here ? ' (you are here)' : ' (home town; you are not there)'} · cash ${money(state.character.cash)} · bank ${money(state.character.deposit)}`
      : 'No town: stand in a town or join one.';

  const rows: React.ReactNode[] = [];
  let detail: React.ReactNode = null;
  if (tab === 'bank') {
    const b = state.bank;
    rows.push(h(Text, { key: 'b', bold: true }, b ? `Bank of ${b.townName || town?.name}` : 'Loading bank…'));
    if (b) {
      rows.push(h(Text, { key: 'c' }, `Cash        ${money(state.character.cash)}`));
      rows.push(h(Text, { key: 'd' }, `Bank        ${money(state.character.deposit)}`));
      rows.push(h(Text, { key: 'f' }, `Deposit fee ${b.fee}%`));
      rows.push(h(Text, { key: 'n', dimColor: true, wrap: 'wrap' }, 'Money in the bank is safe from duels. Purchases use cash first, then the bank. Enter: deposit.'));
    }
  } else if (tab === 'trader') {
    rows.push(h(Text, { key: 'hd', dimColor: true, wrap: 'truncate' }, 'Rotating offers · buy with cash, then bank · Enter buy · u refresh'));
    traderItems.slice(start, end).forEach((item, i) => {
      const p = item.prices[0];
      const level = state.items?.get(item.itemId)?.level;
      const soldOut = item.limitedCount === 0 || (item.limitedAt !== null && item.limitedAt * 1000 <= Date.now());
      const price = p ? priceLabel(p) : '—';
      const unaffordable = !!p && p.currency === 'dollar' && p.amount > state.character.cash + state.character.deposit;
      const limited = item.limitedAt ? endsIn(item.limitedAt - state.clock.now()) : item.limitedCount !== null ? `${item.limitedCount} left` : '';
      rows.push(h(Text, { key: item.itemId, inverse: start + i === idx, color: soldOut ? 'gray' : unaffordable ? 'red' : undefined, wrap: 'truncate' },
        `${truncate(state.itemName(item.itemId), leftW - 28)} ${level ? `L${level}`.padStart(4) : '    '} ${price.padStart(9)} ${truncate(limited, 6).padStart(6)}`));
    });
    const item = traderItems[idx];
    if (item) {
      const p = item.prices[0];
      detail = h(Box, { flexDirection: 'column', width: rightW, height: bodyH - formH },
        h(Text, { bold: true, color: 'yellow', wrap: 'truncate' }, p ? `${priceLabel(p)}${item.discount ? ` (${item.discount}% off ${priceLabel({ ...p, amount: p.base })})` : ''}${item.teaser ? ` · ${item.teaser}` : ''}` : 'No price'),
        h(ItemDetail, { state, itemId: item.itemId, count: 1, wornId: undefined, compare: false, pane: 'bag', width: rightW, height: Math.max(6, bodyH - formH - 2), scroll: 0 }));
    }
  } else if (side === 'bag') {
    rows.push(h(Text, { key: 'hd', dimColor: true, wrap: 'truncate' }, `Your bag: Enter ${isShop(tab) ? 'sells to the shop' : 'offers on the market'} · Tab back`));
    bagItems.slice(start, end).forEach((b, i) => {
      const d = state.items?.get(b.itemId);
      const ok = isShop(tab) ? d?.sellable !== false : d?.auctionable !== false;
      rows.push(h(Text, { key: b.itemId, inverse: start + i === idx, color: ok ? undefined : 'gray', wrap: 'truncate' },
        `${truncate(state.itemName(b.itemId), leftW - 18)} ${b.count > 1 ? `×${b.count}`.padStart(4) : '    '} ${money(d?.sell ?? 0).padStart(8)}`));
    });
    const it = bagItems[idx];
    if (it) detail = h(ItemDetail, { state, itemId: it.itemId, count: it.count, wornId: undefined, compare: false, pane: 'bag', width: rightW, height: bodyH - formH, scroll: 0 });
  } else if (isShop(tab)) {
    const s = state.shop;
    rows.push(h(Text, { key: 'hd', dimColor: true, wrap: 'truncate' }, s && s.key === tab ? `${SHOPS.find((x) => x.key === tab)!.label} level ${s.level} · ${s.items.length} items · Tab: sell` : 'Loading shop…'));
    shopItems.slice(start, end).forEach((id, i) => {
      const req = state.requiredLevel(id);
      const tooLow = req && req.level > state.character.level;
      const price = state.shopPrice(id);
      rows.push(h(Text, { key: id, inverse: start + i === idx, color: tooLow ? 'gray' : price > state.character.cash + state.character.deposit ? 'red' : undefined, wrap: 'truncate' },
        `${truncate(state.itemName(id), leftW - 18)} ${req ? `L${req.level}`.padStart(4) : '    '} ${money(price).padStart(8)}`));
    });
    const id = shopItems[idx];
    if (id !== undefined) {
      const d = state.items?.get(id);
      const wornId = d ? state.inventory.wear.get(d.type) : undefined;
      detail = h(ItemDetail, { state, itemId: id, count: 1, wornId, compare: wornId !== undefined, pane: 'bag', width: rightW, height: bodyH - formH, scroll: 0 });
    }
  } else if (tab === 'market') {
    const m = state.market;
    const f = filterText(filter);
    rows.push(h(Text, { key: 'mode', wrap: 'truncate' },
      h(Text, { color: filter.buyOrders ? 'magenta' : 'green', bold: true }, filter.buyOrders ? 'Buy orders (wanted)' : 'For sale'),
      h(Text, { dimColor: true }, ` · t switch${f ? ` · ${f}` : ''}`)));
    rows.push(h(Text, { key: 'hd', dimColor: true, wrap: 'truncate' }, m.searched
      ? `${m.query ? `"${m.query}"` : 'everything'} · page ${m.page}${m.next ? ' (> next)' : ''} · / search · n buy order · Tab sell`
      : '/ search (filters) · n place a buy order · Tab sell from your bag'));
    if (m.offers.length) rows.push(h(Text, { key: 'cols', dimColor: true, wrap: 'truncate' }, `${'Item'.padEnd(leftW - 30)}     bid ${filter.buyOrders ? 'instant' : 'buy now'}  ends`));
    m.offers.slice(start, end).forEach((o, i) => {
      const price = o.buyNow !== null ? money(o.buyNow) : '';
      const bid = o.bid !== null ? money(o.bid) : '';
      const have = o.direction === 'BUY' && state.inventory.count(o.itemId) >= o.count;
      rows.push(h(Text, { key: o.id, inverse: start + i === idx, bold: o.highestBidder, color: have ? 'green' : undefined, wrap: 'truncate' },
        `${truncate(itemsLabel(state, o), leftW - 30)} ${bid.padStart(7)} ${price.padStart(7)} ${endsIn(o.endsIn).padStart(5)}`));
    });
    const o = m.offers[idx];
    if (o) detail = offerDetail(state, o, rightW, bodyH - formH);
  } else {
    const mm = state.marketMine;
    rows.push(h(Text, { key: 'hd', dimColor: true, wrap: 'truncate' }, mm
      ? `${mm.bids.length} bid(s) · ${mm.offers.length} offer(s) · ${mm.buyOrders.length} buy order(s) at ${town?.name ?? '?'}`
      : 'Loading…'));
    mine.slice(start, end).forEach(({ o, mineKind }, i) => {
      const status = o.finished
        ? mineKind === 'bid' ? (o.highestBidder ? 'won, pick up' : 'ended') : 'ended, collect'
        : endsIn(o.endsIn);
      const label = mineKind === 'bid' ? (o.direction === 'BUY' ? 'sell ' : 'bid  ') : mineKind === 'want' ? 'want ' : 'offer';
      rows.push(h(Text, { key: `${mineKind}${o.id}`, inverse: start + i === idx, color: o.finished ? 'green' : undefined, wrap: 'truncate' },
        `${label} ${truncate(itemsLabel(state, o), leftW - 30)} ${(o.bid !== null ? money(o.bid) : '').padStart(7)} ${status.padStart(14)}`));
    });
    const m = mine[idx];
    if (m) detail = offerDetail(state, m.o, rightW, bodyH - formH);
  }

  const help = confirm
    ? h(Text, { color: 'yellow', wrap: 'truncate' }, `${confirm.text} y / n`)
    : h(Text, { dimColor: true, wrap: 'truncate' }, tab === 'bank' ? 'Enter deposit · ← → tab · Esc back'
      : tab === 'trader' ? 'Enter buy · u refresh · ← → tab · Esc back'
        : side === 'bag' ? 'Enter sell · Tab back · Esc back'
          : isShop(tab) ? 'Enter buy · Tab sell · ← → tab · Esc back'
            : tab === 'market' ? (filter.buyOrders ? '/ search · t for sale · Enter sell now (or ask) · b ask · n buy order · w walk · < > page'
              : '/ search · t buy orders · Enter buy now (or bid) · b bid · n buy order · w walk · < > page · Tab sell')
              : 'Enter pick up · P pick up all here · x withdraw · w walk to town · ← → tab · Esc back');
  const left = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height: bodyH, paddingX: 1 },
    h(Text, { color: town?.here ? 'green' : 'yellow', wrap: 'truncate' }, where),
    ...rows,
    rowsCount === 0 && tab !== 'bank' ? h(Text, { dimColor: true }, tab === 'market' ? '' : tab === 'trader' ? (trader ? 'No offers right now.' : 'Loading offers…') : 'Nothing here.') : null,
    h(Box, { flexGrow: 1 }), help);
  const right = h(Box, { flexDirection: 'column', width: rightW, height: bodyH },
    detail ? h(Box, { flexGrow: 1, flexDirection: 'column' }, detail) : h(Box, { flexGrow: 1 }),
    form ? h(FormView, { form, width: rightW }) : null);
  return h(Box, { flexDirection: 'column', width, height }, tabs, h(Box, { width, height: bodyH }, left, right));
}

function offerDetail(state: ScreenProps['state'], o: MarketOffer, width: number, height: number): React.ReactNode {
  const way = state.travelTo(o.town);
  const lines = [
    h(Text, { key: 'n', bold: true, wrap: 'truncate' }, `${o.direction === 'BUY' ? 'Wanted: ' : ''}${itemsLabel(state, o)}`),
    h(Text, { key: 'p', wrap: 'truncate' }, `Bid ${o.bid !== null ? money(o.bid) : '—'} · ${o.direction === 'BUY' ? 'Instant' : 'Buy now'} ${o.buyNow !== null ? money(o.buyNow) : '—'}${o.count > 1 && o.buyNow !== null ? ` (${money(Math.floor(o.buyNow / o.count))} each)` : ''}`),
    h(Text, { key: 's', dimColor: true, wrap: 'truncate' }, `${o.direction === 'BUY' ? 'Buyer' : 'Seller'} ${o.seller}${o.bidder ? ` · best bid ${o.bidder}` : ''}${o.highestBidder ? ' (you)' : ''}`),
    o.direction === 'BUY' ? h(Text, { key: 'h', dimColor: true, wrap: 'truncate' }, `You have ${state.inventory.count(o.itemId)} in your bag`) : null,
    o.description ? h(Text, { key: 'd', dimColor: true, wrap: 'truncate' }, `“${o.description}”`) : null,
    h(Text, { key: 't', dimColor: true, wrap: 'truncate' }, `${o.finished ? 'Ended' : `Ends in ${endsIn(o.endsIn)}`} · at ${o.town.name} (${formatDuration(way)} away)`),
  ];
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, width, height: Math.max(6, Math.min(height, 10)) }, ...lines);
}
