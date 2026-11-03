# Autopilot

Plays the character on its own while the TUI is open: queues jobs by your priority, sleeps (and wakes early),
banks cash, uses consumables, does quests and safe NPC duels. Every behaviour is a toggle on the Autopilot
screen (`G`; `P` is taken by the trade screen). Spec agreed with the user in a grill session ("Decisions").

## Files
| File | What |
|---|---|
| `src/game/timeline.ts` | Pure projection of a task list: travel, waits, regen, energy/HP/XP/level/cash per step, level-up refill, partial sleeps, instant actions. |
| `src/game/autopilot-config.ts` | Settings, rules, saved plan, spend tracker, duel record (`autopilot.json` in the config dir); `goalWeights`, `fingerprint`, `duelOutlook`. |
| `src/game/autopilot.ts` | Pure planner `planAutopilot(input)`: HP → bank → inserts → jobs by priority, energy sleeps / consumables when short. `parseConsumable`, `expectedHpLoss`. |
| `src/game/autopilot-runner.ts` | `AutopilotRunner` (`state.runner`): replans on input change, sends tasks, wakes from sleep, deposits, uses items, cancels for a better plan, NPC duels for XP, retries/backoff, spend cap. |
| `src/game/autopilot-quests.ts` | `QuestModule`: finish (reward by priority), wear + restore gear, buy in town shops, accept saloon quests. `chooseReward`. |
| `src/tui/autopilot.ts` | Screen: priority, module toggles and values, Now pane, queue projection; `Q` full queue view. |
| `test/autopilot.test.ts`, `test/social.test.ts` (runner) | Timeline, config, planner, consumables, inserts, screen, queue view, rewards, duels; runner against a fake server. |

## Using it
- `G` opens the screen. `R` run/pause (paused still plans and shows "would do", sends nothing), `X` stop
  (pause + clear the plan; rules stay), `Space`/`Enter` toggle, `←→`/`+-` values, `J K` reorder priority.
- `Q` queue view: queued + planned rows (ETA, travel, energy, HP, XP, $, module). `c` cancel a queued task,
  `d` exclude a planned job / remove an inserted row, `u` clear exclusions, `s`/`b` insert a sleep / bank stop at
  a row's time, `J K` move an inserted row. It captures all keys while open (Esc closes).
- Quest screen route prompt: `a` = autopilot on, Quests first, limited to the route's quests (`rules.onlyQuests`;
  clear it with the "Quests goal" row).
- Header shows `autopilot ●` while running. Resumes on launch if it was running (after startup + first replan).

## How it plans
- **Inputs**: character (server values), server queue (fixed steps; queued jobs cost no energy), jobs and
  locations, quest needs (`state.autopilotNeeds()`: open quests in scope, minus excluded chains / repeatables),
  hotels (home + nearest town, fetched every 10 min), named towns, bag consumables above the reserve, budget
  left today, failing step keys.
- **Replans** when the fingerprint of those inputs changes (checked every 2 s) and after every action.
  The plan is saved to `autopilot.json` for display only, never sent from the file.
- **Loop** until `planJobs` (default 10) jobs are planned: HP under `sleepBelow` → health item that lifts it
  over, else HP sleep (wake ≥ `wakeAbove`) · cash over `bank.above` → walk + deposit (own town within
  `ownTownWithin`, else nearest within `maxDetour`, else later) · your inserts at their time · best job.
- **Job score**: per goal (quest progress, XP, money, products = expected drops × sell price) value per cost,
  normalised by the best candidate for that goal, weighted by rank (1, 0.25, 0.06, 0.015) or custom weights.
  Cost: energy + travel × energy regenerated per second, or seconds (per-hour mode); danger adds HP regen time.
  Repeating a job fades its value 2 % per run (motivation). Jobs whose expected HP loss would cross
  `sleepBelow` are skipped.
- **Energy short**: motivation item if motivation < 75 %; energy item if getting the energy otherwise takes
  ≥ 30 min; else sleep when it reaches the wake target sooner than waiting; else the timeline waits.
- **Wake target** (toggles): enough energy to reach the next level with the best XP/energy job (the level-up
  refill does the rest) · 4× the next job · HP safe · full. The runner cancels the sleep once live energy and HP
  reach it.
- **Cancelling**: queued tasks are cancelled when planning without them (keep the running one, or cancel all)
  is ≥ `cancel.margin` better over `cancel.horizon` (6 h), at most once per `cancel.cooldown`. Queued jobs are
  valued at the plan's average value per XP + $ (estimate).

## Carrying out (runner: one thing per tick, only while running and not dry run)
wake-up cancel → cancel-for-better → quest step → NPC duel for XP → send planned tasks (as many as the queue and
current energy allow; a sleep ends a batch) or, with an empty queue, the next on-the-spot action (deposit in the
town you stand in, use an item).
- Failures: retry after 1 → 5 → 15 min; after 3 the step key is left out of plans. Session errors pause.
- Spend cap: hotel rooms and quest purchases count toward `spend.daily` (UTC day); quest items ≤ $500 per quest.

## Modules: status
| Module | Status |
|---|---|
| Queue jobs, priority, look-ahead | built |
| Energy sleep + wake rules + auto-cancel | built (room rate units unverified) |
| HP (sleep / item / skip risky jobs) | built (danger → HP is a heuristic) |
| Consumables (energy, health, motivation) | built; **buying missing ones: not built** |
| Bank | built |
| Expanded queue + rules | built (planned jobs can only be excluded, not reordered; inserts can move) |
| Quests: finish, rewards, wear + restore, shop buy in the current town, accept from saloons | built |
| Quests: market instant-buy, detours to map quest givers, visit-place and duel requirements | **not built** (logged once and skipped) |
| NPC duels for XP | built; fights only levels the duel record knows (fight NPCs yourself in `D` to fill it) |

## Decisions (grill session)
TUI only (core has no UI deps) · may cancel anything, running tasks included, when the plan is better by the
margin · manual actions are replanned around unless paused · resume on launch · ranked priority, optional custom
weights · own-town hotel/bank within 1 h, else by cost · bank detour ≤ 30 min else the next town · cancel margin
10 % over 6 h, 15 min cooldown · quests: all but excluded chains, time-limited yes, repeatables off · daily cap
$1,000 · consumables valued at shop price · retries 1/5/15 min, 3 strikes · HP < 50 % sleep or item, up at ≥ 70 %
at a hotel, 50–70 % keep working safely · NPC duels only (never players): HP ≥ 70 %, level ≤ duel level + margin,
one loss stops them for the day, for XP when it beats the best job · plan 10 jobs ahead.

## Unverified (check live, then move to docs/game-mechanics.md)
- Hotel room `energy` / `health` units (read as % of max per hour).
- Cancelling a running sleep keeps the regenerated energy (a sync runs after the first wake-up).
- Level-up refills energy and HP.
- Finishing map-giver quests needs you at the giver (the module walks there after a failed finish).
- NPC duel loss detection (`attacker_died`, or "lost"/"defeat" in the result text).
