# Game mechanics (as the client sees them)

What tw-cli relies on about The West, with where it comes from. **Verified** = seen in live replies or the
browser client's code; **unverified** = assumed, check live and update this file.

## Time, energy, health
- Server time: `Game.init.sincepoch`, refined by `POST /ntp.php` (epoch ms). `ServerClock` in `clock.ts`.
- Regen is continuous: `max · regenFactor · seconds / 3600` (`Character.tick4Character`), for energy
  (`energyRegenFactor`) and health (`healthRegenFactor`). Server values arrive with a timestamp (`energy_date`);
  `CharacterState` regenerates locally from the last server value. Verified.
- Max HP: `100 + (level − 1)·lpPerPoint + healthSkill·(lpPerPoint + lpPerPointBonus)` (`calcMaxHealth`). Verified.
- **Jobs pay their energy when queued** (task/add reply may carry the new `energy`; if it does not, subtract
  locally). Cancelling a queued job refunds it. Verified for queued; running-job refund unverified.
- **Level-up refills energy and health.** Assumed by the autopilot timeline; unverified (check on the first
  live level-up: sync right after and compare).
- Level XP: `levelStartXp(l) = floor((Σk² + 10(l+1) − 21)·3) + 1000·(l−120)^2.9 above 120` (`calcLowerExp`). Verified.

## Tasks and queue
- `task/add {tasks: {<queuePos>: post}}`; positions continue from the queue length. Posts:
  job `{jobId, x, y, duration, taskType:'job'}` · walk `{unitId, type, x?, y?, taskType:'walk'}` (type `town`,
  `fort`, `questgiver`) · sleep `{town_id, room, taskType:'sleep'}` (the server walks there first).
- `task/cancel {tasks: {<pos>: {queueId, type}}}` returns the new queue (+ `extra.energy` / `extra.money`).
- Queue entries carry `date_start` / `date_done` (epoch s), coords, `wayData` (the walk part). They do **not**
  say which duration a job was: infer from `date_done − way end` vs the job's short/middle/long values.
- Queue limit: `taskLimit.normal` (4) / `.premium` (9, with the automation premium bonus).

## Jobs
- `work/index` gives per-character values per duration (energy, money, xp, luck, item drops); `job/job` is the
  only source of **danger** (0–100) and live **motivation** (0–1).
- Item drops: expected items per run = `(prop + probBonus) / 100`.
- Travel time: `distance · Game.travelSpeed · Character.speed` seconds.
- Expected HP loss from danger: no formula known. The autopilot uses a heuristic (danger % of 10 % max HP per
  hour of work). Unverified.

## Hotel and sleep
- `building_hotel get_data {town_id}` → `rooms: {cubby|bedroom|hotel_room|apartment|luxurious_apartment: {name,
  level, available, free, costs, energy, health}}`.
- **Room `energy` / `health` units are unverified.** The autopilot reads them as % of max per hour.
- Whether cancelling a running sleep keeps the energy regenerated so far: unverified (the autopilot syncs right
  after its first wake-up cancel).

## Bank and money
- `building_bank get_data {town_id}` → `deposit_fee` (%) differs per town; deposit `{town_id, amount}` →
  `{deposit, own_money, fee}`. No withdrawal: purchases take cash first, then the bank. You must be in the town.
- Cash in pocket can be lost in duels; that is why the autopilot banks over a limit.

## Items
- Item ids: plain id = base id · 1000; upgrades add to the last digits (`baseId`, `upgradeLevel`).
- `usebonus` texts on `usetype: 'single'` items: `Energy increase: 15%`, `Health point bonus: 20%`,
  `Work motivation increase: 15%`, `Duel motivation increase: 15%`, `Active waytime shortening: 25%`.
  `usetype: 'buff'` items give skills/speed for N uses; `'use'` items are boxes/cards. Verified from the catalog.
- Shops: `building_general|tailor|gunsmith&town_id=N` → `trader_inv` (item ids), `charge` multiplies the price.

## Quests
- Requirement `jsInfo.type`: `inventory_changed` (have item) · `wear_changed` (wear item) · `task-finish-job`
  (`count` = runs, or seconds for timed ones). `jsInfo: null` texts include `Item 'X' bought` and wait timers
  ("you must wait 24 hours"). Shapes for "visit a place" and duel requirements: **not seen yet**.
- `finish_quest` replies may carry `eval` (browser JS): never executed.
- Map quest givers probably require being at the giver to finish; town (saloon) quests from the town. Unverified.

## Duels
- `duel/get_data` → NPCs `{duelnpc_id, npc_name, npc_level, weapon_id, arrival_delta}` and `difficulty`; no win
  odds. `duel/duel_npc {duelnpc_id}` fights at once and returns rounds, energy, health, money, experience.
- Player duels are tasks (`taskType: 'duel'`). The autopilot never duels players.

## Reports
- `reports get_reports {page, folder}` → rows with `popupData`: an HTML table whose field labels are icons
  (`images/job/clock.png` time, `dollar` money, `upb` bonds, `experience` XP, `danger`, event icons) and found
  items as one `<img alt="name">` per item. `popupText` / `popupItems` in `mail.ts` turn that into text.
- `reports show_report` → `page` (HTML; the "Items Found" block is an empty `<span id="jobreward_item_<report>_<item>">`
  the browser fills from `js`) and `reportInfo: {items: [[itemId, ?, count, type], …], job_id}`: the found
  items. Verified on a live Prospecting report (5× Fool's gold).

## Chat
- Messages carry links as tags in the text: `[item=<instance id>]` (seen live: `wtb [item=42085000]`). The client
  shows them as names (`chatlinks.ts`: items yellow, set items green). `[quest=<id>]` is assumed the same way
  (unverified); its title is only known for quests in the log or at the open employer, else `quest <id>`.
