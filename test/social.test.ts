// Mail, trade (bank / shops / market / item use), duels, chat sending, route energy budget, quest reward
// choice, and their TUI screens. Replies follow the client JS (offsets in the game modules' headers).
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

const home = mkdtempSync(join(tmpdir(), 'twcli-social-'));
process.env.TW_CLI_HOME = home;
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
process.env.TW_ITEMS_FILE = `${FIX}items.sample.json`;

const React = (await import('react')).default;
const { render } = await import('ink');
const { CookieJar } = await import('../src/http/cookie-jar.ts');
const { GameClient } = await import('../src/http/game-client.ts');
const { resetThrottle } = await import('../src/http/throttle.ts');
const { GameState } = await import('../src/game/state.ts');
const { ItemCatalog } = await import('../src/game/items.ts');
const { parseQuest } = await import('../src/game/quests.ts');
const { ChatPoller } = await import('../src/realtime/chat.ts');
const { MarketApi, parseOffer, depositFee, marketFee, buyOrderProblem, suggestedBid, DEFAULT_FILTER } = await import('../src/game/trade.ts');
const { bbText } = await import('../src/game/mail.ts');
const { planRoute } = await import('../src/game/route.ts');
const { App } = await import('../src/tui/app.ts');

const WORLD = 'https://en32.the-west.net';
const FAST = { concurrency: 1, minIntervalMs: 0, jitterMs: 0, maxRetries: 0, baseBackoffMs: 0, maxBackoffMs: 0, breakerThreshold: 100, breakerCooldownMs: 0, timeoutMs: 5_000 };
const json = (name: string) => JSON.parse(readFileSync(`${FIX}${name}.json`, 'utf8'));
const BAG = json('bag_init.sample');
const ITEMS = json('items.sample');
const QUESTS = json('open_quests.sample');

function bootstrap(): any {
  const now = Math.floor(Date.now() / 1000);
  return {
    h: 'abc123',
    game: { sincepoch: now, travelSpeed: 1, currentWorldName: 'Quebec', jobs: [] },
    character: {
      playerId: 42, name: 'shallax', level: 30, charClass: { type: 'adventurer' }, experience: 1000, cash: 50, deposit: 10, nuggets: 0,
      pos: { x: 100, y: 100 }, town: { id: 1421, coords: { x: 200, y: 200 } }, charSpeed: 1, maxEnergy: 100, energy: 40, health: 300,
      healthRegenFactor: 0, energyRegenFactor: 0, taskQueue: [], taskLimit: { normal: 4, premium: 9 }, skillData: {}, lpPerPoint: 10,
    },
    premium: null,
    bag: BAG,
  };
}

interface Call { url: string; body: string }
let calls: Call[];
let realFetch: typeof fetch;
let routes: Record<string, (body: string) => unknown>;
const params = (body: string) => new URLSearchParams(body);
const callTo = (part: string) => calls.filter((c) => c.url.includes(part));

function fakeServer() {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body });
    const path = url.replace(WORLD, '').replace(/&h=\w+/, '');
    const route = routes[path];
    if (route) {
      const r = route(body);
      return r instanceof Response ? r : Response.json(r);
    }
    return new Response('unexpected ' + url, { status: 404 });
  }) as typeof fetch;
}

function makeState() {
  const b = bootstrap();
  const client = new GameClient({ worldUrl: WORLD, h: b.h, jar: new CookieJar(), identity: { userAgent: 'UA', acceptLanguage: 'en' }, policy: FAST });
  const s = new GameState({ client, bootstrap: b }, async () => ({ client, bootstrap: b }));
  s.items = ItemCatalog.fromRaw(ITEMS);
  s.inventory.retype(s.items);
  return s;
}

function tui(state: any, size = { columns: 130, rows: 40 }) {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { ...size, isTTY: true });
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void; ref: () => void; unref: () => void };
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (d) => (out += d.toString()));
  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  const app = render(React.createElement(App, { state }), { stdout: stdout as any, stdin: stdin as any, exitOnCtrlC: false, patchConsole: false });
  return {
    plain: () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    reset: () => (out = ''),
    settle,
    keys: async (...ks: string[]) => {
      for (const k of ks) {
        stdin.write(k);
        await settle();
      }
    },
    type: async (text: string) => {
      for (const ch of text) {
        stdin.write(ch);
        await settle(15);
      }
      await settle();
    },
    done: () => app.unmount(),
  };
}

beforeEach(() => {
  calls = [];
  routes = {};
  realFetch = globalThis.fetch;
  resetThrottle();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test.after(() => rmSync(home, { recursive: true, force: true }));

const REPORTS = { count: 2, page: 1, reports: [
  { report_id: 501, title: 'Job report: Tending pigs', hash: 'h501', read: false, date_received: '10:12', popupData: 'You worked 1 hour' },
  { report_id: 502, title: 'Duel: you won', hash: 'h502', read: true, date_received: 'yesterday', popupData: '' },
] };
const TELEGRAMS = { page: 1, count: 1, folders: [], messages: [
  { message_id: 77, subject: 'Hello there', partner_name: ['Bob'], partner_id: [9], own_status: 5, other_status: [4], last_post_date: '09:00' },
] };

function mailRoutes() {
  routes['/game.php?window=reports&action=get_reports'] = () => REPORTS;
  routes['/game.php?window=reports&mode=show_report'] = () => ({ title: 'Job report: Tending pigs', date_received: '10:12', reportType: 'job', page: '<page><div>You earned <b>$ 90</b><br/>and 50 XP</div></page>' });
  routes['/game.php?window=messages&action=get_messages'] = () => TELEGRAMS;
  routes['/game.php?window=messages&action=get_message'] = () => ({ subject: 'Hello there', page: 0, pages: 1, head_id: 77, posts: [{ name: 'Bob', post_date: '09:00', text: 'Want to [b]trade[/b] some ham?', player_id: 9 }] });
  routes['/game.php?window=messages&action=send'] = () => [true, 'sent'];
  routes['/game.php?window=messages&action=reply'] = () => [true, 'ok'];
  routes['/game.php?window=reports&action=delete_single_report'] = () => [false];
}

test('mail: reports and telegrams requests, HTML/BBCode to text, errors from [ok, msg] replies', async () => {
  fakeServer();
  mailRoutes();
  const state = makeState();
  state.unread.reports = true;
  await state.loadReports(1, 'job');
  assert.equal(state.unread.reports, false);
  assert.deepEqual(Object.fromEntries(params(callTo('get_reports')[0]!.body)), { page: '1', folder: 'job' });
  const r = await state.openReport(state.reports!.reports[0]!);
  assert.equal(r!.text, 'You earned $ 90\nand 50 XP');
  assert.equal(params(callTo('show_report')[0]!.body).get('hash'), 'h501');
  await state.deleteReport(state.reports!.reports[0]!);
  assert.deepEqual(Object.fromEntries(params(callTo('delete_single_report')[0]!.body)), { report: '501', type: 'job', deleted: 'false' });
  await state.loadTelegrams();
  assert.deepEqual(state.telegrams!.telegrams[0], { id: 77, subject: 'Hello there', partners: ['Bob'], unread: true, answered: false, date: '09:00' });
  const t = await state.openTelegram(77);
  assert.equal(t!.posts[0]!.text, 'Want to trade some ham?');
  assert.equal(bbText('[player]Ann[/player] &amp; co'), 'Ann & co');
  assert.equal(await state.sendTelegram('Bob', 'Hi', 'ab'), false, 'text under 3 characters is refused before sending');
  assert.equal(callTo('action=send').length, 0);
  routes['/game.php?window=messages&action=send'] = () => [false, 'Player not found', ['not_found', ['Bobb']]];
  assert.equal(await state.sendTelegram('Bobb', 'Hi', 'hello'), false);
  assert.match(state.log.at(-1)!.msg, /Player not found/);
});

test('trade: bank deposit, shop buy/sell, item use and market requests', async () => {
  fakeServer();
  const state = makeState();
  routes['/game.php?window=building_bank&mode=get_data'] = () => ({ error: false, deposit: 10, own_money: 50, deposit_fee: 4, town_name: 'Slobozia', stage: 2 });
  routes['/game.php?window=building_bank&action=deposit'] = () => ({ error: false, deposit: 58, own_money: 0, fee: 2 });
  routes['/game.php?window=building_general&town_id=1421'] = () => ({ trader_inv: [{ item_id: 16000 }, { item_id: 700000 }], charge: 1.5, level: 3, town_name: 'Slobozia' });
  routes['/game.php?window=building_general&action=buy'] = () => ({ changes: [{ item_id: 700000, count: 2, inv_id: 2000000, type: 'yield' }], money: { barrows: 35, deposit: 10 } });
  routes['/game.php?window=building_general&action=sell'] = () => ({ money: 65, changes: [{ item_id: 701000, count: 1, inv_id: 709577, type: 'yield' }] });
  routes['/game.php?window=itemuse&action=use_item'] = () => ({ error: false, msg: { changes: [{ item_id: 702000, count: 1, inv_id: 1614984, type: 'yield' }], effects: [{ type: 'energy', energy: 70 }, { type: 'content', items: [{ item_id: 700000, count: 2 }] }] } });

  await state.openBank(1421);
  assert.equal(state.bank!.fee, 4);
  assert.equal(depositFee(50, 4), 2);
  await state.depositMoney(50);
  assert.deepEqual(Object.fromEntries(params(callTo('action=deposit')[0]!.body)), { town_id: '1421', amount: '50' });
  assert.deepEqual([state.character.cash, state.character.deposit], [0, 58]);

  await state.openShop('general', 1421);
  assert.ok(callTo('window=building_general&town_id=1421')[0]!.url.endsWith('game.php?window=building_general&town_id=1421'), 'Trader.open: no mode / action');
  assert.equal(state.shopPrice(700000), 15, 'price × charge');
  state.character.cash = 50;
  await state.buyFromShop(700000);
  assert.deepEqual(Object.fromEntries(params(callTo('action=buy')[0]!.body)), { item_id: '700000', town_id: '1421', last_inv_id: '1614984' });
  assert.equal(state.inventory.count(700000), 2);
  assert.equal(state.character.cash, 35);
  await state.sellToShop(701000, 2);
  assert.deepEqual(Object.fromEntries(params(callTo('action=sell')[0]!.body)), { inv_id: '709577', town_id: '1421', item_id: '701000', count: '2', last_inv_id: '2000000' });
  assert.equal(state.character.cash, 65);

  state.items!.get(702000)!.usetype = 'normal';
  await state.useItem(702000, 1);
  assert.deepEqual(Object.fromEntries(params(callTo('use_item')[0]!.body)), { item_id: '702000', item_count: '1', lastInvId: '2000000' });
  assert.equal(state.character.energy, 70);
  assert.match(state.log.at(-1)!.msg, /You get: 2× Ham/);
  await state.useItem(16000);
  assert.match(state.log.at(-1)!.msg, /cannot be used/);

  // Market
  const offer = { market_offer_id: 9, item_id: 16000, item_count: 1, current_bid: 300, max_price: 900, auction_ends_in: 3600, seller_name: 'Ann', seller_player_id: 5, market_town_name: 'Slobozia', market_town_x: 200, market_town_y: 200, direction: 'SELL' };
  routes['/game.php?window=building_market&action=search'] = () => ({ error: false, msg: { search_result: [offer, { ...offer, market_offer_id: 10, auction_ends_in: 0 }], next: false } });
  routes['/game.php?window=building_market&action=bid'] = () => ({ error: false, msg: { money: 0, deposit: 3, instantBuy: true } });
  routes['/game.php?window=building_market&action=fetch'] = () => ({ error: false, msg: { money: 0 } });
  routes['/game.php?window=building_market&action=putup'] = () => ({ error: false, msg: { money: 60, deposit: 3, costs: 5 } });
  routes['/game.php?window=building_market&action=fetch_bids'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=building_market&action=fetch_offers'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=inventory&action=inventory_changed'] = () => ({ changes: false, wear: {} });
  await state.searchMarket('knife');
  const s = Object.fromEntries(params(callTo('action=search')[0]!.body));
  assert.equal(s.pattern, 'knife');
  assert.deepEqual([s.direction_sell, s.direction_buy, s.visibility, s.sort], ['true', 'false', '2', 'bid']);
  assert.equal(state.market.offers.length, 1, 'finished offers are hidden');
  await state.bidMarket(state.market.offers[0]!, 900, true);
  assert.deepEqual(Object.fromEntries(params(callTo('action=bid')[0]!.body)), { bidtype: '1', bid: '900', market_offer_id: '9', direction: 'SELL' });
  assert.match(state.log.filter((l) => l.level === 'info').at(-1)!.msg, /won Bowie knife/);
  await state.pickUpMarket(parseOffer(offer));
  assert.match(state.log.at(-1)!.msg, /Go to Slobozia/);
  assert.equal(calls.filter((c) => /action=fetch&h=/.test(c.url)).length, 0, 'not sent while away from the market town');
  state.character.position = { x: 200, y: 200 };
  await state.pickUpMarket(parseOffer(offer));
  assert.equal(params(calls.find((c) => /action=fetch&h=/.test(c.url))!.body).get('market_offer_id'), '9');
  state.world.towns = [{ id: 1421, x: 200, y: 200, name: 'Slobozia', members: 3, npc: false, points: 0 }];
  assert.equal(await state.sellOnMarket({ itemId: 700000, count: 1, days: 2, buyNow: 40 }), true);
  assert.deepEqual(Object.fromEntries(params(callTo('action=putup')[0]!.body)), {
    town_id: '1421', item_id: '700000', itemcount: '1', auctioncount: '1', sellrights: '2', auctionlength: '2', description: '', direction: 'SELL', bidtype: '0', maxprice: '40',
  });
  await assert.rejects(new MarketApi(state.client).sell({ townId: 1, itemId: 1, count: 1, days: 1 }), /starting bid or a buy-now price/);
});

test('market: buy orders, filters, paging, selling into a buy order, withdraw, pick up all, fees', async () => {
  fakeServer();
  const state = makeState();
  const want = { market_offer_id: 21, item_id: 700000, item_count: 2, current_bid: null, auction_price: null, max_price: 30, auction_ends_in: 7200, seller_name: 'Bob', seller_player_id: 9, market_town_name: 'Slobozia', market_town_x: 200, market_town_y: 200, direction: 'BUY', description: 'need <b>ham</b>' };
  routes['/game.php?window=building_market&action=search'] = () => ({ error: false, msg: { search_result: [want], next: true } });
  routes['/game.php?window=building_market&action=bid'] = () => ({ error: false, msg: { money: 80, instantBuy: true } });
  routes['/game.php?window=building_market&action=putup'] = () => ({ error: false, msg: { money: 20, deposit: 10, costs: 4 } });
  routes['/game.php?window=building_market&action=fetch_bids'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=building_market&action=fetch_offers'] = () => ({ error: false, msg: { search_result: [{ ...want, market_offer_id: 30, direction: 'SELL', seller_player_id: 42 }] } });
  routes['/game.php?window=building_market&action=get_own_buy_offers'] = () => ({ error: false, is_at_town: false, msg: [{ ...want, market_offer_id: 31, seller_player_id: 42, auction_ends_in: 0 }] });
  routes['/game.php?window=building_market&action=offtake'] = () => ({ error: false, money: 6 });
  routes['/game.php?window=building_market&action=fetch_all'] = () => ({ error: false, msg: { money: 95 } });
  routes['/game.php?window=inventory&action=inventory_changed'] = () => ({ changes: false, wear: {} });

  // Buy orders with filters (searchForMarketOffers: direction_sell / direction_buy, type, levels, usable, has_effect).
  await state.searchMarket('ham', 1, { ...DEFAULT_FILTER, buyOrders: true, type: 'yield', levelMin: 0, levelMax: 20, consumable: true });
  let s = Object.fromEntries(params(callTo('action=search')[0]!.body));
  assert.deepEqual([s.direction_sell, s.direction_buy, s.type, s.level_range_min, s.level_range_max, s.usable, s.has_effect, s.nav], ['false', 'true', 'yield', '0', '20', 'false', 'true', 'first']);
  const o = state.market.offers[0]!;
  assert.deepEqual([o.direction, o.buyNow, o.bid, o.description], ['BUY', 30, null, 'need ham']);
  // Paging keeps the filter and sends nav next / prev like getNewPageNo.
  await state.searchMarket('ham', 2);
  s = Object.fromEntries(params(callTo('action=search')[1]!.body));
  assert.deepEqual([s.page, s.nav, s.direction_buy, s.type], ['2', 'next', 'true', 'yield']);
  await state.searchMarket('ham', 2);
  await state.searchMarket('ham', 1);
  assert.equal(params(callTo('action=search').at(-1)!.body).get('nav'), 'first');

  // Selling into a buy order needs the goods; a price below the instant price is raised to it (bid dialog).
  state.inventory.applyChanges([{ item_id: 700000, count: 0, inv_id: 1, type: 'yield' }]);
  const before = callTo('action=bid').length;
  await state.bidMarket(o, 30);
  assert.match(state.log.at(-1)!.msg, /You need 2× Ham/);
  assert.equal(callTo('action=bid').length, before);
  state.inventory.applyChanges([{ item_id: 700000, count: 3, inv_id: 2000001, type: 'yield' }]);
  await state.bidMarket(o, 10, true);
  assert.deepEqual(Object.fromEntries(params(callTo('action=bid')[0]!.body)), { bidtype: '1', bid: '30', market_offer_id: '21', direction: 'BUY' });
  assert.equal(state.character.cash, 80);
  assert.ok(state.log.some((l) => /You sold Ham for \$ 30/.test(l.msg)));

  // Buy order: item found by name, the web's checks, putup with direction BUY and bidtype.
  assert.equal(await state.placeBuyOrder({ query: 'Bowie knife', count: 1, days: 3, instant: 100, fromBank: false }), false, 'below the shop sell price (425)');
  assert.match(state.log.at(-1)!.msg, /at least the shop sell price \(\$ 425\)/);
  assert.equal(await state.placeBuyOrder({ query: 'bowie knife', count: 1, days: 3, instant: 900, maxBid: 800, fromBank: false }), false);
  assert.match(state.log.at(-1)!.msg, /maximum bid must be higher/);
  assert.equal(await state.placeBuyOrder({ query: 'a', count: 1, days: 3, instant: 900, fromBank: false }), false);
  assert.match(state.log.at(-1)!.msg, /matches \d+ items/);
  assert.equal(callTo('action=putup').length, 0);
  assert.equal(await state.placeBuyOrder({ query: 'bowie knife', count: 2, days: 3, instant: 900, maxBid: 1200, fromBank: true }), true);
  assert.deepEqual(Object.fromEntries(params(callTo('action=putup')[0]!.body)), {
    town_id: '1421', item_id: '16000', itemcount: '2', auctioncount: '1', sellrights: '2', auctionlength: '3', description: '', direction: 'BUY', bidtype: '1', auctionprice: '1200', maxprice: '900',
  });
  assert.equal(params(callTo('get_own_buy_offers')[0]!.body).get('town_id'), '1421');
  assert.equal(state.marketMine!.buyOrders.length, 1);
  assert.equal(state.marketMine!.offers.length, 1);

  // Withdraw (offtake) and pick up all (fetch_all) only on site.
  const mine = state.marketMine!.offers[0]!;
  await state.withdrawMarket(mine);
  assert.match(state.log.at(-1)!.msg, /Go to Slobozia/);
  state.character.position = { x: 200, y: 200 };
  state.world.towns = [{ id: 1421, x: 200, y: 200, name: 'Slobozia', members: 3, npc: false, points: 0 }];
  const cash = state.character.cash;
  await state.withdrawMarket(mine);
  assert.deepEqual(Object.fromEntries(params(callTo('action=offtake')[0]!.body)), { offer_id: '30', direction: 'SELL' });
  assert.equal(state.character.cash, cash + 6);
  await state.pickUpAllMarket();
  assert.deepEqual(Object.fromEntries(params(callTo('action=fetch_all')[0]!.body)), { townId: '1421' });
  assert.equal(state.character.cash, 95);

  // Fee (showMarketFees) and the pre-filled bid.
  assert.equal(marketFee({ startPrice: 1000, buyNow: 500, days: 2, homeTown: true }), 106); // int(500·0.02·10 + 6)
  assert.equal(marketFee({ buyNow: 500, days: 2, stage: 4, homeTown: false }), 53); // ceil(106/4·2)
  assert.equal(marketFee({ days: 2, homeTown: true }), 0);
  assert.equal(buyOrderProblem({ count: 1 }, 0), 'Set an instant price or a maximum bid.');
  assert.equal(suggestedBid(parseOffer({ ...want, direction: 'SELL', auction_price: 100, current_bid: 150 })), 151);
  assert.equal(suggestedBid(parseOffer({ ...want, direction: 'SELL', auction_price: 100, current_bid: null })), 100);
  assert.equal(suggestedBid(o), 30);
});

test('duels: NPC list and fight, opponents, player duel is a task', async () => {
  fakeServer();
  const state = makeState();
  const npcs = { npcs: [{ duelnpc_id: 3, npc_name: 'Dusty Joe', npc_level: 12, weapon_id: 16000, arrival_delta: 0 }, { duelnpc_id: 4, npc_name: 'Slim', npc_level: 14, weapon_id: 0, arrival_delta: 0 }], arrival_delay: 0, difficulty: 'easy' };
  routes['/game.php?window=duel&action=get_data'] = () => ({ npcs, motivation: 0.8, motivation_npc: 1 });
  routes['/game.php?window=duel&action=search_op'] = () => ({ oplist: { pclist: [{ player_id: 9, player_name: 'Bob', duellevel: 20, town_name: 'Dodge', character_x: 300, character_y: 100 }], page: 0, next: false } });
  routes['/game.php?window=duel&action=duel_npc'] = () => ({
    data: { rounds: [{ own: { damage: 30 }, other: null }, { own: null, other: { damage: 12 } }], duelResult: '<b>You won!</b>' },
    npcs, energy: 38, health: 288, money: 70, experience: 1040, level: 30, motivation: 0.8, motivation_npc: 0.9, attacker_died: false,
  });
  routes['/game.php?window=task&action=add'] = (body) => ({ tasks: { 0: { task: { type: 'duel', queueId: 5, date_start: 1, date_done: 2, data: { title: 'Bob', coords: { x: 300, y: 100 } } } } } });
  await state.loadDuels();
  assert.deepEqual(state.duels!.npcs.map((n) => n.name), ['Dusty Joe', 'Slim']);
  assert.equal(state.duelOpponents[0]!.name, 'Bob');
  assert.deepEqual(Object.fromEntries(params(callTo('search_op')[0]!.body)), { distance: '7200', order_by: 'ASC', page: '0', sort: 'range', next: 'false' });
  await state.fightNpc(3);
  assert.equal(params(callTo('duel_npc')[0]!.body).get('duelnpc_id'), '3');
  assert.deepEqual([state.character.energy, state.character.cash, state.character.experience], [38, 70, 1040]);
  assert.equal(state.lastNpcDuel!.result, 'You won!');
  assert.deepEqual(state.lastNpcDuel!.rounds, [{ own: 30, other: null }, { own: null, other: 12 }]);
  await state.duelPlayer(state.duelOpponents[0]!);
  assert.deepEqual(Object.fromEntries(params(callTo('task&action=add')[0]!.body)), { 'tasks[0][player_id]': '9', 'tasks[0][taskType]': 'duel' });
});

test('chat: rooms and history from Status / Text / tells, sending is a second request', async () => {
  fakeServer();
  const state = makeState();
  const sent: any[] = [];
  routes['/gameservice/chat/'] = (body) => {
    const req = JSON.parse(decodeURIComponent(body));
    if (req.batch[0].op === 'send') {
      sent.push(req.batch[0]);
      return { timenow: Date.now(), batch: [{ id: 'Text', t: 5, payload: { cid: 'client_42', to: 'room_town_1421', message: req.batch[0].message } }] };
    }
    return { timenow: Date.now(), batch: [] };
  };
  const poller = new ChatPoller(state.client, { policy: { ...FAST, lane: 'chat' } as any, errorPauseMs: 10 });
  poller.handle({ id: 'Status', t: 1, payload: {
    self: { id: 'client_42', name: 'shallax' }, clients: [{ id: 'client_9', name: 'Bob' }], disabledrooms: [],
    rooms: [{ roomdescription: { id: 'room_town_1421', room: 'town', title: 'Slobozia' }, members: ['client_42', 'client_9'] }, { roomdescription: { id: 'room_general_1', room: 'general', general_id: 1 }, members: [] }],
  } });
  assert.deepEqual([...poller.rooms.values()].map((r) => r.title), ['Slobozia', 'Saloon 1']);
  poller.handle({ id: 'Text', t: 2, payload: { cid: 'client_9', to: 'room_town_1421', message: 'howdy &amp; hi' } });
  poller.handle({ id: 'TellReceived', t: 3, payload: { from: { id: 'client_7', name: 'Ann' }, message: 'psst' } });
  assert.deepEqual(poller.history.get('room_town_1421')!.map((l) => `${l.from}: ${l.text}`), ['Bob: howdy & hi']);
  assert.deepEqual(poller.history.get('tell:Ann')!.map((l) => l.text), ['psst']);
  assert.ok(poller.unreadRooms.has('tell:Ann'));
  await poller.say('room_town_1421', 'hello town');
  await poller.say('Ann', 'hi back', true);
  assert.deepEqual(sent.map((b) => [b.op, b.to, b.message, b.tell]), [['send', 'room_town_1421', 'hello town', undefined], ['send', 'Ann', 'hi back', true]]);
  assert.equal(poller.history.get('room_town_1421')!.at(-1)!.own, true);
});

test('route: energy budget (runs that fit, shortfall) and walking weighted by regeneration', () => {
  const need = { key: 'item:700', label: 'Ham', amount: 6, unit: 'items' as const, itemId: 700000, quests: ['A'] };
  const job = (id: number, groupid: number): any => ({
    id, groupid, name: `job${id}`, jobPoints: 10, workPoints: 1, laborPoints: 9, durations: {},
    values: { long: { duration: 3600, energy: 12, money: 1, experience: 1, luck: 0, items: [{ itemId: 700000, expected: 1.5, percent: 150 }] } },
  });
  const base = { needs: [need], jobs: [job(1, 1)], locations: () => [{ x: 10, y: 0 }], from: { x: 0, y: 0 }, wayTime: () => 60 };
  const plan = planRoute({ ...base, energyAvailable: 30 });
  assert.equal(plan.totals.runs, 4);
  assert.equal(plan.fitRuns, 2, '12 energy per run, 30 available');
  assert.equal(plan.energyShort, 18);
  assert.equal(planRoute(base).fitRuns, 4, 'no budget: all runs');
  // Two jobs: a slightly cheaper one far away vs. a near one. Fast regeneration makes walking expensive.
  const far = { ...job(2, 2), values: { long: { ...job(2, 2).values.long, energy: 11 } } };
  const jobs = [job(1, 1), far];
  const locs: Record<number, any[]> = { 1: [{ x: 1, y: 0 }], 2: [{ x: 5000, y: 0 }] };
  const opts = { needs: [need], jobs, locations: (g: number) => locs[g], from: { x: 0, y: 0 }, wayTime: (a: any, b: any) => Math.abs(a.x - b.x) };
  assert.equal(planRoute({ ...opts, walkEnergyPerSecond: 1 / 6000 }).stops[0]!.job.id, 2, 'slow regen: walking is cheap');
  assert.equal(planRoute({ ...opts, walkEnergyPerSecond: 100 / 3600 }).stops[0]!.job.id, 1, 'fast regen: walking costs energy-time');
});

test('TUI: mail, trade, duels and chat screens; quest reward choice', async () => {
  fakeServer();
  mailRoutes();
  const state = makeState();
  routes['/game.php?window=building_quest&mode='] = () => ({ questEmployer: [] });
  routes['/game.php?window=building_quest'] = routes['/game.php?window=building_quest&mode='];
  routes['/game.php?window=building_bank&mode=get_data'] = () => ({ error: false, deposit: 10, own_money: 50, deposit_fee: 4, town_name: 'Slobozia', stage: 2 });
  routes['/game.php?window=building_bank&action=deposit'] = () => ({ error: false, deposit: 30, own_money: 30, fee: 1 });
  routes['/game.php?window=building_general&town_id=1421'] = () => ({ trader_inv: [{ item_id: 700000 }], charge: 1, level: 3, town_name: 'Slobozia' });
  routes['/game.php?window=building_tailor&town_id=1421'] = routes['/game.php?window=building_general&town_id=1421'];
  routes['/game.php?window=building_gunsmith&town_id=1421'] = routes['/game.php?window=building_general&town_id=1421'];
  routes['/game.php?window=building_market&action=search'] = () => ({ error: false, msg: { search_result: [{ market_offer_id: 21, item_id: 700000, item_count: 2, max_price: 30, auction_ends_in: 7200, seller_name: 'Bob', seller_player_id: 9, market_town_name: 'Slobozia', market_town_x: 200, market_town_y: 200, direction: 'BUY' }], next: false } });
  routes['/game.php?window=building_market&action=fetch_bids'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=building_market&action=fetch_offers'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=duel&action=get_data'] = () => ({ npcs: { npcs: [{ duelnpc_id: 3, npc_name: 'Dusty Joe', npc_level: 12, weapon_id: 0, arrival_delta: 0 }], arrival_delay: 0 }, motivation: 0.8, motivation_npc: 1 });
  routes['/game.php?window=duel&action=search_op'] = () => ({ oplist: { pclist: [], page: 0, next: false } });
  routes['/game.php?window=quest&action=finish_quest'] = () => ({ error: false, msg: 'Done', allRewards: [] });
  routes['/game.php?window=building_quest&mode=get_open_quests'] = () => QUESTS;
  routes['/game.php?window=inventory&action=inventory_changed'] = () => ({ changes: false, wear: {} });
  state.quests = QUESTS.quests.map((q: any) => parseQuest(q, (id: number) => state.itemName(id)));
  const fin = state.quests.find((q) => q.finishable)!;
  fin.rewardOptions = [{ id: 11, text: 'A horse' }, { id: 12, text: 'A gun' }];
  // Chat: a poller that is "active" with one room (no network loop).
  const poller = new ChatPoller(state.client, { policy: { ...FAST, lane: 'chat' } as any });
  (poller as any).running = true;
  poller.handle({ id: 'Status', t: 1, payload: { self: { id: 'client_42', name: 'shallax' }, clients: [{ id: 'client_9', name: 'Bob' }], disabledrooms: [], rooms: [{ roomdescription: { id: 'room_town_1421', room: 'town', title: 'Slobozia' }, members: ['client_42'] }] } });
  poller.handle({ id: 'Text', t: Date.now(), payload: { cid: 'client_9', to: 'room_town_1421', message: 'anyone selling ham?' } });
  const said: string[] = [];
  poller.say = async (_to: string, m: string) => void said.push(m);
  state.live = poller;

  const t = tui(state);
  try {
    await t.settle();
    // Main view: chat strip under jobs/queue; Tab Tab focuses it, Enter + typing does not trigger shortcuts.
    assert.match(t.plain(), /Slobozia/);
    assert.match(t.plain(), /Bob: anyone selling ham\?/);
    await t.keys('\t', '\t');
    assert.match(t.plain(), /Enter write · ←\/→ room/);
    await t.keys('\r');
    await t.type('more ham m q');
    await t.keys('\r');
    assert.deepEqual(said, ['more ham m q']);
    said.length = 0;
    await t.keys('\t');
    // Mail: reports listed, Enter opens one, Tab → telegrams, Enter reads, n composes and sends.
    await t.keys('M');
    await t.settle(300);
    assert.match(t.plain(), /Job report: Tending pigs/);
    await t.keys('\r');
    assert.match(t.plain(), /You earned \$ 90/);
    await t.keys('\t', '\r');
    assert.match(t.plain(), /Want to trade some ham\?/);
    await t.keys('n');
    await t.type('Bob');
    await t.keys('\r');
    await t.type('Ham');
    await t.keys('\r');
    await t.type('Got any? q i');
    await t.keys('\r');
    await t.settle(200);
    assert.deepEqual(Object.fromEntries(params(callTo('action=send')[0]!.body)), { to: 'Bob', subject: 'Ham', text: 'Got any? q i', masstelegramm: '0' });
    assert.equal(callTo('action=send').length, 1, 'typed letters did not trigger global shortcuts');
    await t.keys('\x1b', '\x1b');

    // Header: XP within the level (level 30 starts at 29232 XP and needs 2913; this test character has less).
    assert.match(t.plain(), /XP ░+ 0\/2913 0%/);
    // Trade: bank → Enter → deposit form prefilled with the cash; edit to 20 and submit.
    await t.keys('$');
    await t.settle(200);
    assert.match(t.plain(), /Deposit fee 4%/);
    assert.match(t.plain(), /home town; you are not there/);
    await t.keys('\r', '\x7f', '\x7f');
    await t.type('20');
    assert.match(t.plain(), /Fee: \$ 1/);
    await t.keys('\r');
    await t.settle(200);
    assert.equal(params(callTo('action=deposit')[0]!.body).get('amount'), '20');
    // General store: buying needs you in town.
    await t.keys('\x1b[C');
    await t.settle(200);
    assert.match(t.plain(), /Ham/);
    await t.keys('\r');
    assert.match(t.plain(), /You are not in town 1421/);
    // Market (two tabs on): t shows buy orders; n opens the buy-order form, which resolves the item name.
    await t.keys('\x1b[C', '\x1b[C', '\x1b[C');
    await t.settle(200);
    assert.match(t.plain(), /For sale/);
    t.reset();
    await t.keys('t');
    await t.settle(200);
    assert.equal(params(callTo('action=search').at(-1)!.body).get('direction_buy'), 'true');
    assert.match(t.plain(), /Buy orders \(wanted\)/);
    assert.match(t.plain(), /2× Ham/);
    await t.keys('n');
    await t.type('bowie');
    assert.match(t.plain(), /Bowie knife · fee up to/);
    await t.keys('\x1b', '\x1b');

    // Duels
    await t.keys('D');
    await t.settle(300);
    assert.match(t.plain(), /Dusty Joe/);
    // W jumps back to the jobs view from any screen.
    t.reset();
    await t.keys('W');
    assert.match(t.plain(), /Task queue/);

    // Chat: history shown; Enter, type, Enter sends.
    await t.keys('C');
    assert.match(t.plain(), /Bob: anyone selling ham\?/);
    await t.keys('\r');
    await t.type('yes, 3 q');
    await t.keys('\r');
    assert.deepEqual(said, ['yes, 3 q']);
    await t.keys('\x1b');

    // Quests: finishing with two reward options → choose the second.
    await t.keys('o');
    await t.settle(200);
    // Move down until the finishable quest is selected (its key hint offers "Enter finish").
    for (let i = 0; i < 8 && !/Enter finish/.test(t.plain().split('Quest log').at(-1)!); i++) {
      t.reset();
      await t.keys('j');
    }
    await t.keys('\r');
    assert.match(t.plain(), /Choose a reward/);
    await t.keys('\x1b[C', 'y');
    await t.settle(200);
    assert.equal(params(callTo('finish_quest')[0]!.body).get('reward_option_id'), '12');
  } finally {
    t.done();
  }
});

test('sync: background game.php re-read updates health/money and flags a drop (no push after being dueled)', async () => {
  const b = bootstrap();
  const client = new GameClient({ worldUrl: WORLD, h: b.h, jar: new CookieJar(), identity: { userAgent: 'UA', acceptLanguage: 'en' }, policy: FAST });
  let next = b;
  let reopened = 0;
  const s = new GameState({ client, bootstrap: b }, async () => (reopened++, { client: {} as any, bootstrap: next }));
  assert.equal(s.character.health, 300);

  next = bootstrap();
  next.character = { ...next.character, health: 120, cash: 20, experience: 1500, pos: { x: 200, y: 200 }, taskQueue: [] };
  await s.syncCharacter();
  assert.equal(reopened, 1);
  assert.equal(s.character.health, 120);
  assert.equal(s.character.cash, 20);
  assert.equal(s.character.experience, 1500);
  assert.deepEqual(s.character.position, { x: 200, y: 200 });
  assert.equal(s.client, client, 'keeps the live client');
  assert.ok(s.lastSync > 0);
  assert.match(s.log.at(-1)!.msg, /Health 300 → 120, cash \$50 → \$20\. Attacked\?/);

  // Nothing changed: no warning.
  const n = s.log.length;
  await s.syncCharacter();
  assert.equal(s.log.length, n);

  // Failure is logged, not thrown, and does not lock other actions.
  const bad = new GameState({ client, bootstrap: bootstrap() }, async () => { throw new Error('down'); });
  await bad.syncCharacter('report');
  assert.match(bad.log.at(-1)!.msg, /Sync \(report\): down/);
  assert.equal(bad.busy, false);
});

test('auto-route: queues the rest of a route as queue space and energy allow, in order', async () => {
  fakeServer();
  const s = makeState();
  let nextId = 100;
  const added: number[] = [];
  routes['/game.php?window=task&action=add'] = (body) => {
    const idx = [...new Set([...params(body).keys()].map((k) => k.match(/^tasks\[(\d+)\]/)?.[1]).filter(Boolean))] as string[];
    const tasks: Record<string, unknown> = {};
    for (const i of idx) {
      const jobId = Number(params(body).get(`tasks[${i}][jobId]`));
      added.push(jobId);
      tasks[i] = { task: { queue_id: nextId++, type: 'job', date_start: 1, date_done: 2, data: { job_id: jobId, title: `job${jobId}`, coords: { x: 1, y: 1 } } } };
    }
    return { tasks };
  };
  const job = (id: number): any => ({ id, groupid: 1, name: `job${id}`, durations: { long: 3600 }, values: { long: { duration: 3600, energy: 12, money: 1, experience: 1, luck: 0, items: [] } } });
  const stop = (id: number, runs: number) => ({ job: job(id), at: { x: 1, y: 1 }, duration: 'long', runs, travel: 0, gains: {}, energy: 12 * runs, seconds: 0, xp: 0, money: 0 });
  const plan: any = { needs: [], stops: [stop(1, 2), stop(2, 3)], unmet: [], leftover: {}, totals: { energy: 60, seconds: 0, travel: 0, xp: 0, money: 0, runs: 5 }, fitRuns: 3, energyShort: 24 };

  s.character.setEnergy(40); // 3 × 12 fit; queue limit 4 (no automation)
  await s.queueRoute(plan, { auto: true, label: 'this quest' });
  assert.deepEqual(added, [1, 1, 2]);
  assert.equal(s.queue.length, 3);
  assert.equal(s.autoRoute?.runs.length, 2);

  // No energy for the next run: no request.
  const n = calls.length;
  await s.autoRouteStep();
  assert.equal(calls.length, n);

  // Energy back, but only one free slot.
  s.character.setEnergy(100);
  await s.autoRouteStep();
  assert.deepEqual(added, [1, 1, 2, 2]);
  assert.equal(s.autoRoute?.runs.length, 1);

  // Queue full: no request. A task finishes → the last run goes in and auto-route ends.
  await s.autoRouteStep();
  assert.equal(added.length, 4);
  s.queue.shift();
  await s.autoRouteStep();
  assert.deepEqual(added, [1, 1, 2, 2, 2]);
  assert.equal(s.autoRoute, null);
  assert.match(s.log.at(-1)!.msg, /Auto-route done: all 5 job\(s\) queued/);

  // Refused by the server: retried later, not every second; x (stop) clears it.
  routes['/game.php?window=task&action=add'] = () => ({ tasks: { 0: { error: true, msg: 'Not enough energy' } } });
  routes['/game.php?window=task&mode=get_tasks'] = () => ({ queue: [] });
  s.queue = [];
  await s.queueRoute(plan, { auto: true });
  assert.ok(s.log.some((l) => /Auto-route: Not enough energy/.test(l.msg)));
  assert.ok((s.autoRoute as any).retryAt > Date.now());
  const m = calls.length;
  await s.autoRouteStep();
  assert.equal(calls.length, m);
  s.stopAutoRoute();
  assert.equal(s.autoRoute, null);
});

test('wake: a timer gap far above the interval counts as sleep; the rebuilt state keeps log and auto-route', async () => {
  const { WakeDetector } = await import('../src/util/wake.ts');
  let t = 1_000_000;
  const woke: number[] = [];
  const w = new WakeDetector((ms) => woke.push(ms), { intervalMs: 5_000, gapMs: 60_000, now: () => t });
  t += 5_000;
  assert.equal(w.check(), null);
  t += 59_000; // a slow tick (busy event loop) is not a sleep
  assert.equal(w.check(), null);
  t += 2 * 3600_000;
  assert.equal(w.check(), 2 * 3600_000);
  assert.deepEqual(woke, [2 * 3600_000]);
  t += 5_000;
  assert.equal(w.check(), null, 'measured from the wake, not from before the sleep');

  const old = makeState();
  old.info('before sleep');
  old.autoRoute = { label: 'this quest', runs: [{ post: {}, energy: 12, title: 'job1' }] as any, total: 3, retryAt: Date.now() + 60_000 };
  const next = makeState();
  next.carryOver(old);
  assert.ok(next.log.some((l) => l.msg === 'before sleep'));
  assert.equal(next.autoRoute?.runs.length, 1);
  assert.equal(next.autoRoute?.retryAt, 0, 'retries right away after waking');
});
