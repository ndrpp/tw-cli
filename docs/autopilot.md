# Autopilot

Plays the character on its own while the TUI is open: queues jobs by your priority, sleeps (and wakes early),
banks cash, uses consumables, does quests and safe NPC duels. Every behaviour is a toggle on the Autopilot
screen (`g a`). Spec agreed with the user in a grill session ("Decisions").

## Files
| File | What |
|---|---|
| `src/game/timeline.ts` | Pure projection of a task list: travel, waits, regen, energy/HP/XP/level/cash per step, level-up refill, partial sleeps, instant actions. |
| `src/game/autopilot-config.ts` | Settings, rules, saved plan, spend tracker, duel record (`autopilot.json` in the config dir); `goalWeights`, `fingerprint`, `duelOutlook`. |
| `src/game/autopilot.ts` | Pure planner `planAutopilot(input)`: HP → bank → inserts → jobs by priority, energy sleeps / consumables when short. `parseConsumable`, `expectedHpLoss`. |
| `src/game/autopilot-runner.ts` | `AutopilotRunner` (`state.runner`): replans on input change, sends tasks, wakes from sleep, deposits, uses items, cancels for a better plan, NPC duels for XP, retries/backoff, spend cap. |
| `src/game/autopilot-quests.ts` | `QuestModule`: finish (reward by priority), wear + restore gear, buy in town shops, accept saloon quests. `chooseReward`. |
| `src/game/debug-log.ts`, `src/tui/debug.ts` | Debug log (`state.debug`) and its screen (`g x`); see "Debugging". |
| `src/tui/autopilot.ts` | Screen: priority, module toggles and values on the left, plan pane (`PlanPane`, rows from `planRows`) on the right; `Q` full queue view. |
| `test/autopilot.test.ts`, `test/social.test.ts` (runner) | Timeline, config, planner, consumables, inserts, screen, queue view, rewards, duels; runner against a fake server. |

## Using it
- `g a` opens the screen. `R` run/pause (paused still plans and shows "would do", sends nothing), `X` stop
  (pause + clear the plan; rules stay), `Space`/`Enter` toggle, `←→`/`+-` values, `J K` reorder priority.
- `Q` queue view: queued + planned rows (ETA, travel, energy, HP, XP, $, module). `c` cancel a queued task,
  `d` exclude a planned job / remove an inserted row, `u` clear exclusions, `s`/`b` insert a sleep / bank stop at
  a row's time, `J K` move an inserted row. It captures all keys while open (Esc closes).
- Quest screen route prompt: `a` = autopilot on, Quests first, limited to the route's quests (`rules.onlyQuests`;
  clear it with the "Quests goal" row).
- Plan pane (right): status (running / dry run / paused "what it would do"), goals in rank order, what the plan
  earns (job pay only; deposits are not losses) and when the next level lands, live E/HP/cash/spend. Then "In the
  queue" and numbered "Planned" rows: icon per kind, gains or length, energy before → after, `★` level-up, and the
  task's reason dimmed under it (shown once when the next row shares it, e.g. walk + deposit). Back-to-back runs of
  one job merge (`×3`); energy waits ≥ 1 min are their own `◷` rows.
- Reasons (`PlannedTask.why`): jobs say the goal that gave most of the score (`Candidate.by`): `quest: Cotton for
  "Farmer's woes" (3 left)` (left = before this run) or `best XP per energy · also <quest part>`. Sleeps: `energy low
  (8): sleep until …`; bank: `cash $X is over $Y: banking it`. Home shows the next task's title with its reason.
- Header shows `autopilot ●` while running. Resumes on launch if it was running (after startup + first replan).

## Debugging
- `g x` opens the Debug screen. Every entry also goes to `<config dir>/debug/YYYY-MM-DDTHH.jsonl` (UTC hour,
  one JSON object per line: `id, at, cat, title, data`). Files older than 24 h are deleted when a new hour
  starts. Only the TUI (`root.ts` `makeState`) turns the files on; tests and CLI commands do not write any.
- Categories: `log` (every log-pane line), `state` (diff of server values, queue, quests, bag, worn gear once
  a second; "Started: <task>" when a queued task begins), `request` (every guarded / autopilot call, with
  duration, result or error stack), `autopilot` (runner decisions: idle/acting, wake-up checks, cancel checks
  with both alternatives' values, what it queues and why the batch stopped, duels, failures), `sim` (every
  replan: `reason`, `context`, planner `input` without functions, `output` tasks + timeline), `quest` (finish /
  reward choice, wear, shop, saloon, accept, skips).
- `runner.context()` is what the autopilot sees: energy, HP, home and nearest town with travel seconds, where
  you are, open quests with each requirement (have / need, nearest source job and seconds from the queue end),
  bag, consumables, gear, queue, budget, needs, failures. Logged with every replan; live under **Now**.
- Per-tick decisions use `debug.once(key, …)`, which logs only when the title changes. Keep titles free of
  values that change every tick (live energy) and put those in `data`, or the log fills up once a second.
- Planner input jobs list each duration's `items` as `[itemId, percent]` and the job's `groupid`, so a logged plan
  can be replayed: locations from `job_groups` in the cached minimap (`cache/minimap-*.json`), `wayTime` =
  distance × `travelSpeed` × character speed (check it against `context.homeTown.seconds`), the rest as logged.
- Memory: 3000 entries; only the newest 50 `sim` entries keep their data (the files keep all of it).

## How it plans
- **Inputs**: character (server values), server queue (fixed steps; queued jobs cost no energy, their drops
  count toward needs; queued sleeps keep their room rates in `state.sleepRates`), jobs and locations (drops
  blended with calibration), quest needs (`state.autopilotNeeds()`, below), hotels (home + nearest town, every
  10 min, energy rate × calibrated room scale), named towns, bag consumables above the reserve, budget left
  today, failing step keys, calibrated motivation and HP scale.
- **Quests in scope** (`state.autopilotQuests()`): open quests (or the route's), minus excluded quests / chains,
  repeatables unless on, and quests it cannot finish (`questBlocker`: an item no doable job drops and you do not
  have, a job you cannot do, or "Go to / Resolve / Accept / Lose against …") unless "also quests it cannot
  finish" is on. Each need carries `weight` (1, up to 2 for a quest ending within 72 h; `questEnds` reads the
  `limited` date as UTC, unverified) and `xpPerUnit` / `moneyPerUnit` (the quests' rewards spread over the units
  they still need), added to the XP and Money goals.
- **Replans** when the fingerprint of those inputs changes (checked every 2 s; queue times and server values
  rounded) and after every action. The plan is saved to `autopilot.json` for display only.
- **Loop** until the timeline reaches `cancel.horizon` (6 h; `MAX_JOBS` = 200 caps it), so plans of short and long
  runs cover the same time and compare: HP under `sleepBelow` → health item that lifts it over, else HP sleep
  (wake ≥ `wakeAbove`) · cash over `bank.above` → walk + deposit (own town within `ownTownWithin`, else nearest
  within `maxDetour`, else later) · your inserts at their time · best job.
- **Bank walk is sticky**: the deposit is an on-the-spot action, so only the walk goes into the server queue. The
  runner records that walk (`bankWalk` in `autopilot.json`, kept across restarts) and passes its town as
  `bankTownId`. While the queue ends there, the deposit comes first whatever the cash projection says, so no job
  is queued behind the walk. Without this, one replan whose projected cash dipped under `bank.above` put a job
  after the walk, and the next one walked to town a second time (live, 2026-11-04: `telegraph → Slobozia →
  Prospecting → Slobozia`, replayed from the debug log). The record is dropped after the deposit, or when the
  walk is gone from the queue and you are not in that town.
- **Job score**: per goal (quest progress × weight, XP incl. quest rewards, money incl. quest rewards, products
  = expected drops × sell price) gain per cost, divided by the goal's **exchange rate** and weighted by rank (1,
  0.25, 0.06, 0.015) or custom weights. Exchange rates = best gain per cost per goal from where the server queue
  ends, fixed for the whole plan (`plan.rates`) and passed to the cancel check's alternatives, so values compare
  and the last crumbs of a need lose to the next goal.
- **Cost**: per energy: net energy + (travel + HP regen time + slot cost) × energy regenerated per second. Per
  hour: `min(max(duration, net energy ÷ base regen), duration + net energy ÷ best room rate)` + travel + HP regen
  time + slot cost. Net energy = energy − XP × maxEnergy ÷ XP-per-level (a level-up refills energy), at least a
  quarter of the energy (the refill tops up to the max). Slot cost (`slotCost`, 10 min): each run takes a queue
  slot and the TUI is not always open, so runs that fill slots fast leave you idle.
- **Motivation**: pay (XP, $, products) scales with projected motivation, `m − perRun × runs + perHour × hours`
  (calibrated; 2 % per run, no recovery until then). Jobs whose expected HP loss (heuristic × calibrated scale)
  would cross `sleepBelow` are skipped. A level-up raises max HP by `lpPerPoint` in the timeline.
- **Energy short**: motivation item if motivation < 75 %; energy item if getting the energy otherwise takes
  ≥ 30 min; else sleep when it reaches the wake target sooner than waiting; else the timeline waits.
- **Wake target** (toggles): enough energy to reach the next level with the best XP/energy job (the level-up
  refill does the rest) · 4× the next job · HP safe · full. The runner cancels the sleep once live energy and HP
  reach it.
- **Cancelling**: checked at most every 30 s. Queued tasks are cancelled when planning without them (keep the
  running one, or cancel all) is ≥ `cancel.margin` better over `cancel.horizon`, at most once per
  `cancel.cooldown`. Queued jobs are valued at the plan's average value per XP + $ (estimate). Manual town
  construction tasks (`type: 'build'`) are never cancelled.

## Calibration (`calibration.ts`, `calibration.json` in the config dir; TUI only)
Each estimate blends the game's number (or the old heuristic) with what was observed, the prior counting as 5
samples. Logged to the debug log (`Calibration: …`); `runner.context().calibration` shows the current values.
- **Drops** per job + duration: every new job report (page 1 of the report list, on the "new report" push) is
  read once with `show_report` (`parseJobReport`: `reportInfo.job_id`, `items`, run length from the page).
- **HP loss**: the first server health after a dangerous job ends (live update or sync) vs the regen estimate;
  drops over 30 % of max HP count as attacks and are skipped. Gives `hpScale`.
- **Motivation**: work/index is re-read every 30 min; each job's motivation change with the runs finished
  between gives least-squares `perRun` / `perHour` (pairs at 100 % are skipped: recovery is capped there).
- **Hotel rooms**: a sleep the autopilot queued and cancelled at its wake target: energy gained per hour vs the
  rate read from the hotel gives `roomScale` (only uncapped sleeps of 15+ min).
- **Level-ups**: whether energy was full after each (`levelUps.refilled / seen`); the planner assumes it is.

## Carrying out (runner: one thing per tick, only while running and not dry run)
wake-up cancel → cancel-for-better → quest step → NPC duel for XP → send planned tasks (as many as the queue and
current energy allow; a sleep ends a batch) or, with an empty queue, the next on-the-spot action (deposit in the
town you stand in, use an item).
- Failures: retry after 1 → 5 → 15 min; after 3 the step key is left out of plans. Session errors pause.
  Exception: a job refused for "N more energy points" is not a failure. Our energy estimate was ahead of the
  server's, so local energy is set to `job energy − N` and the plan is redone.
- Cancel-for-better counts each cancelled job's energy refund at its queued duration's cost, not the long job's.
- Spend cap: hotel rooms and quest purchases count toward `spend.daily` (UTC day); quest items ≤ $500 per quest.

## Modules: status
| Module | Status |
|---|---|
| Queue jobs, priority, look-ahead | built |
| Energy sleep + wake rules + auto-cancel | built (room rate units unverified) |
| HP (sleep / item / skip risky jobs) | built (danger → HP is a heuristic) |
| Consumables (energy, health, motivation) | built; uses what is in the bag (it never buys them) |
| Bank | built |
| Expanded queue + rules | built (planned jobs can only be excluded, not reordered; inserts can move) |
| Quests: finish, rewards, wear + restore, shop buy in the current town, accept from saloons | built |
| Quests: market instant-buy, detours to map quest givers, visit-place and duel requirements | **not built** (logged once and skipped) |
| NPC duels for XP | built; fights only levels the duel record knows (fight NPCs yourself in `g d` to fill it) |

## Decisions (grill session)
TUI only (core has no UI deps) · may cancel anything, running tasks included, when the plan is better by the
margin · manual actions are replanned around unless paused · resume on launch · ranked priority, optional custom
weights · own-town hotel/bank within 1 h, else by cost · bank detour ≤ 30 min else the next town · cancel margin
10 % over 6 h, 15 min cooldown · quests: all but excluded chains, time-limited yes, repeatables off · daily cap
$1,000 · consumables valued at shop price · retries 1/5/15 min, 3 strikes · HP < 50 % sleep or item, up at ≥ 70 %
at a hotel, 50–70 % keep working safely · NPC duels only (never players): HP ≥ 70 %, level ≤ duel level + margin,
one loss stops them for the day, for XP when it beats the best job · plan to the 6 h horizon (was 10 jobs) · skip quests it cannot finish · level-up energy refund always on ·
queue slots cost 10 min (the TUI is not open 24/7) · calibrate drops, HP, motivation, rooms from your own game.

## Unverified (check live, then move to docs/game-mechanics.md)
- Hotel room `energy` / `health` units (read as % of max per hour; energy now calibrated from sleeps, health not).
- Cancelling a running sleep keeps the regenerated energy (a sync runs after the first wake-up).
- Level-up refills energy and HP (counted by calibration: `levelUps`).
- Motivation scales XP / money / drops linearly; drop % > 100 means that many items on average.
- Finishing map-giver quests needs you at the giver (the module walks there after a failed finish).
- NPC duel loss detection (`attacker_died`, or "lost"/"defeat" in the result text).
