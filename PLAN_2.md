# Ballot Ladder: Enhancement Plan (M12–M22)

## Context

Ballot Ladder already has phases 0–5 and milestones M6–M11 built (see `PLAN.md`). The player climbs from town council to President on a real-data US map. The game has:
- a calibrated vote model (98.1% county back-test)
- monthly campaign actions, primaries, generals and election-night playback
- governing: bills, leadership, budgets, vacancies and specials
- more offices: row offices, courts, VP and presidential delegates
- a living world: an AI bench, rivals, 2030 redistricting and town boundaries

The code is about 15k lines of TypeScript. `src/sim/game.ts` alone is 2,260 lines. There are 52 Vitest tests, a balance harness and a Playwright smoke test.

This plan sets out the next round. It comes from `PLAN.md`'s **Known gaps**, its **Ideas for later**, and things I found while reading the code:

- **Balance holes.** Beating a sitting governor or senator is close to impossible (0 of 26 harness races). Primaries knock out 30–50% of active climbers.
- **Thin interactivity.** Debates are a dice roll. Scandals just happen to you. Polls have no crosstabs. AI opponents don't adapt.
- **No ending.** The only game over is a health retirement after age 80. There is no legacy, no score and no retirement choice.
- **Realism gaps in Congress.** There's no filibuster, and votes are close to party-line. `Engine.chamberSupport` (`game.ts:1077`) uses a different, simpler vote rule than `legislature.ts` `support()`, so the same bill can count differently depending on the path.
- **Quality-of-life gaps.**
  - There's one autosave slot.
  - Months can't be skipped.
  - Exported saves are 4–6 MB of plain JSON.
- **Determinism bug.** `governing.ts` builds decision ids from `Date.now()` plus a module-level counter (lines 163, 180, 196). Replays and saves aren't reproducible.
- **Tooling gaps.**
  - ESLint was planned but never added.
  - There is no save-migration framework; every field since M7 is "optional".
  - `game.ts` is too big to change safely.

Each milestone below can be built and committed on its own. Each step is a small commit. Milestones are in recommended order: foundations first, because later ones touch the same engine code.

**Ground rules for every milestone** (same as M7–M11):
- New `GameState` fields are optional, or are added through the M12 migration.
- Old saves must load.
- `npm test` passes, with the back-test at 95% or higher and the determinism test green.
- `npm run smoke` logs zero console errors.
- `PLAN.md` gets a "Mxx (done)" section.

---

## M12: Foundations (refactor, determinism, migrations, lint)

**Goal:** make the engine safe to extend without changing gameplay.

1. **Fix determinism.**
   - Change `generateDecisions` (`src/sim/governing.ts`) to take an id factory: pass `() => e.newId('d')` from `Engine.endTurn`.
   - Drop `Date.now()` and the module counter `nextDecision`.
2. **Golden replay test** (`test/golden.test.ts`).
   - Use a fixed seed and home town, a scripted 36-month run (file → act → decide option 0 → end turn), and the Story difficulty.
   - Snapshot a hash of `exportState()` minus volatile fields.
   - This guards every later refactor.
3. **Split `game.ts`** into function modules that take `e: Engine`, the same pattern as `legislature.ts` and `vacancies.ts`. Keep `Engine` methods as one-line delegates so the worker API and tests don't change.
   - `src/sim/actions.ts`: `act`, `fatigue`, `actionCost`, `FATIGUE`, `EVENT_IDS`
   - `src/sim/races.ts`:
     - `startCampaign`, `raceUnits`, `runPlayerRace`
     - `resolvePrimary`, `resolveGeneral`, `otherNominee`, `loseRace`
     - `aiCampaign`, `maybeDebate`, `poll`
   - `src/sim/background.ts`: `backgroundElections`, `backgroundPresident`, `jointTicket`, `forceWinner`, `preludeTo2027`
   - `src/sim/summary.ts`: `snapshot`, `monthSummary`, `summaryContext`, `pollPair`
   - `src/sim/upkeep.ts`: `playerUpkeep`, `updateApproval`, `approval`, `pushHistory`
   - The golden hash must not change.
4. **Unify the vote paths.**
   - Reimplement `Engine.chamberSupport` on top of `aiChamberVote` (`legislature.ts:302`), so player votes on AI bills use the same `support()` rule as everything else.
   - Expect small balance shifts. Update the golden snapshot in its own commit, with a note.
5. **Save migrations.**
   - Add `src/sim/migrate.ts` with `migrate(state): GameState`, run in `Engine.load`.
   - Bump `SAVE_VERSION` to 2.
   - Version 1 → 2 fills defaults for the optional M9–M11 fields (`leadership`, `vacancies`, `specials`, `rivals` and so on), so new code can stop writing `?? {}` everywhere.
   - Test by loading a version 1 fixture from `test/fixtures/`.
6. **Lint.**
   - Add ESLint (flat config, typescript-eslint, react-hooks) and `npm run lint`.
   - Add it to `.github/workflows/pages.yml` before the build.
   - Fix or disable the existing warnings explicitly.

**Done when:**
- `game.ts` is under about 900 lines.
- The golden test passes.
- A version 1 save loads.
- Lint runs in CI.

---

## M13: Quality of life (save slots, skip ahead, shortcuts)

**Goal:** remove friction in long careers.

1. **Save slots** (`src/store/game.ts`).
   - Store an index under `ballot-ladder-slots`: `{id, name, office, year, month, updated}[]`.
   - Store each slot under `ballot-ladder-slot:<id>`.
   - Migrate the existing `ballot-ladder-autosave` key into a slot named "Autosave".
   - Autosave writes to the active slot. A menu item "Save as new slot…" forks it.
   - The title screen lists slots, with Continue and Delete.
2. **Compressed export and import.**
   - Export gzips the JSON with `CompressionStream` to a `.json.gz` file.
   - Import detects the gzip magic bytes and falls back to plain JSON.
3. **Skip ahead.**
   - Add a worker API `advance(maxMonths)` (`sim.worker.ts`) that loops `engine.endTurn()` until a stop condition:
     - an election night is pending, or the game is over
     - a new decision arrives
     - the campaign changes stage, or it's the last 3 months before an election
     - the filing deadline for an office in `availableOffices()` arrives
     - `maxMonths` is reached
   - It returns the view plus `{months, stopReason}`.
   - The TopBar gets a "Skip to next event" button, shown when not campaigning.
   - The month summary shows "N months passed — stopped because …" and the merged events.
4. **Keyboard shortcuts.**
   - `E` ends the month, `1`–`6` switch tabs, `M` opens the summary, `Esc` closes modals.
   - Show them in the menu.
   - Add a `useHotkeys` helper in `src/ui/kit.tsx`.
5. **Smoke test.** Extend `test/smoke.mjs` to cover a skip-ahead and a second save slot.

**Done when:** a career can be saved to two slots, reloaded and skipped forward 12 months in one click, without console errors.

---

## M14: Beatable incumbents and a fairer primary path

**Goal:** close the two biggest balance gaps in `PLAN.md`.

1. **Incumbency strength instead of a flag.**
   - Change `Candidate.incumbent: boolean` (`src/sim/vote.ts`) to `incumbent: number` (0..1).
   - `utility` adds `0.35 * incumbent`.
   - In `Engine.candidate`, strength is lower when:
     - `lastShare` was under 54%
     - the incumbent has a scandal
     - the incumbent has served 3 or more terms ("time for a change")
     - it's a midterm and they belong to the President's party at level 5 or above
   - The back-test is unchanged, because generic candidates aren't incumbents.
2. **Incumbent record.**
   - When the player challenges an incumbent, the AI incumbent's `fav` drifts toward an approval figure built from the national environment and their party. This reuses the logic in `updateApproval`.
   - Bad years make incumbents vulnerable.
3. **New action: "Run against the record"** (`ACTIONS` in `campaign.ts`).
   - It needs a campaign against an incumbent, plus a successful oppo in this race (store `c.oppoFound`).
   - It moves the incumbent's `fav` and adds `c.bias` for the player in proportion to the incumbent's issue distance from the district.
4. **Party backing before the primary.**
   - New action "Seek the party's backing" (once per race, before the primary month).
   - Odds come from `partyStanding`, `recIn` and level.
   - Success thins the primary field: drop the weakest challengers, using the count logic in `startCampaign`. It also adds endorsements.
   - Failure costs standing.
   - This lets loyal climbers avoid crowded primaries.
5. **Harness.**
   - Add a `vs-incumbent statewide` rung and a `--env` option for good and bad years to `test/balance/harness.ts`.
   - Target: a climber running a balanced campaign beats a sitting senator or governor 10–20% of the time in a wave year against them, and under 5% otherwise.
   - Target: primary losses for an active climber fall to 20–35%.
   - Add guard-rail bands to `test/balance.test.ts`.

**Done when:** `npm run balance` hits those bands and the 2016→2020 back-test is still 95% or higher.

---

## M15: Scandals and crisis response

**Goal:** turn scandals from random penalties into decisions.

1. **Scandal decision.**
   - When `playerUpkeep` rolls a scandal (`game.ts:1866–1874`, `upkeep.ts` after M12), also push a `Decision` with `meta.kind: 'scandal'`. Options:
     - **Apologize:** smaller fav hit, ends the story
     - **Deny:** no hit now, but a hidden `truth` roll can blow up next month
     - **Attack the press:** party standing goes up, independents go down
     - **Lawyer up:** costs cash, slows the story
   - Severity and truth are seeded from the rng. Integrity skews them.
   - Add `'scandal'` to the `Decision.meta` kind union (`model.ts:403`).
2. **Escalation chain.**
   - `GameState.scandals?: {id, stage: 'story'|'investigation'|'charges', severity, truth, since}[]`.
   - An unresolved, true, severe scandal can escalate to an investigation (a monthly fav drain) and then charges.
   - At charges, the party pressures you to resign. A new decision offers to resign, which calls `vacate` and gives a big legacy hit (see M17), or to fight on.
3. **Opponent scandals with responses.** AI responses are picked by integrity. Oppo hits (`act` case `'oppo'`) now create a story whose damage depends on the AI's response.
4. **UI.**
   - A "Scandal watch" card on the Office and Campaign tabs shows active stories and their stage.
   - The month summary explains the scandal effects.
   - Add a `HELP` entry for scandal risk (`src/ui/help.ts`).
5. **Tests.** Add `test/scandal.test.ts`:
   - each response's effect
   - escalation only when true and severe
   - resigning opens a vacancy
   - old saves without `scandals` load

---

## M16: Campaign trail depth

**Goal:** make the campaign month more than a grid of buttons.

1. **Interactive debates.**
   - Change `maybeDebate` to push a `Decision` (`meta.kind: 'debate'`) the month before the debate, with 3 questions.
   - Each question is drawn from the top-salience issues in the jurisdiction, with options: give a policy answer, pivot to your strength, or attack the opponent.
   - Outcome = skills + `debatePrep` + option fit with the audience (the issue distance for the jurisdiction's blocs) + noise.
   - If the player doesn't answer, the old dice roll is used.
2. **Poll crosstabs.**
   - `poll()` already calls `unitShares`, which returns `byBloc`. Store `PollPoint.blocs` (optional).
   - The Polling card (`CampaignPanel.tsx`) gets a crosstab table by bloc.
   - A higher campaign-manager tier shrinks the margin of error and unlocks the crosstabs (tier 1 or above).
3. **Adaptive AI** (`aiCampaign`).
   - AI candidates emphasize the issue where the player is furthest from the median bloc. They store `c.aiEmphasis[id]`, which feeds `Candidate.emphasis`.
   - Attack ads name that issue in the news.
   - AI nominees move about 30% toward the center for the general.
4. **Get out the vote.**
   - New action, available in the final month only. It costs cash and AP and scales with the field director.
   - It raises turnout weight for the blocs that favor the player. This needs an optional per-candidate `turnoutBoost` in `RaceCtx`, applied in `blocWeights`.
5. **Public polls.**
   - Every other month, a "media poll" news item with its own noise, for races at level 3 and above.
   - It shows as a separate series in the poll chart.
6. **Balance.** Re-run `npm run balance`. Keep the M7 table within ±5 points, or retune `FATIGUE` and the AI budgets.

---

## M17: Legacy, achievements and a real ending

**Goal:** give careers a shape and a payoff.

1. **Legacy score** (new `src/sim/legacy.ts`).
   - It adds up:
     - years in each office × level weight
     - elections won (more for flips and beating incumbents)
     - laws enacted (`P.policies`, plus bills that reach the `law` stage)
     - leadership posts, and average approval in office
     - minus scandals and lost races
   - Compute it on demand. Show it on the Career tab with a breakdown.
2. **Achievements.**
   - `GameState.achievements?: {id, year, month}[]`, checked at the end of each `endTurn`. Examples:
     - first win, flip a seat, beat an incumbent
     - Speaker, Governor, 270 electoral votes
     - survive a scandal investigation, win a primary as an underdog
     - pass a veto override, draw your own map
   - Show a toast and a news item. List them on the Career tab.
3. **Voluntary retirement.**
   - Add a menu item "Retire from politics". It triggers the normal leaving-office flow and sets `gameOver`.
   - Party-switching is out of scope.
4. **Career-end screen.** Replace the game-over modal in `App.tsx` with a recap:
   - the timeline (`me.career`)
   - legacy score and rank
   - biggest wins and losses
   - rivals and the record against them
   - achievements
   - an "export career card" image (canvas → PNG)
5. **Hall of fame.**
   - Store finished careers under an IndexedDB key `ballot-ladder-hall` (name, party, peak office, score, years, seed).
   - Show them on the title screen.
6. **Tests.**
   - The score is monotonic for clear cases.
   - Achievements fire exactly once.
   - Retiring ends the game and keeps the save loadable.

---

## M18: Congress and legislature realism

**Goal:** fix the "votes are close to party-line" and "no filibuster" gaps.

1. **Cross-pressure** in `support()` (`legislature.ts:250`).
   - Add a term for the member's own district lean relative to their party: `(districtLean - partyMedianLean) * k * dir`, signed per issue.
   - Members in swing seats defect more.
   - Cache seat lean per office id, through `e.jurUnit(e.def(p.officeId))`.
2. **Senate filibuster.**
   - In the `senate` chamber, non-budget bills need 60 votes for cloture. `countVotes` and `aiChamberVote` take `needed` from a new `passThreshold(key, bill)`.
   - Tax and spending bills can go through reconciliation (simple majority, once a year, tracked in `GameState.reconciliation?`).
   - A player who is Senate Majority Leader gets a "nuclear option" decision once a term: it removes the filibuster at a big party and independent cost.
3. **Bipartisan cosponsors.**
   - New `billAction`, `'cosponsor'`: spend favors to recruit an other-party cosponsor.
   - It adds +0.06 support from other-party members whose `support` is between −0.3 and 0.
4. **National lawmaking uses the same rules** (`nationalLawmaking`, which moves to `background.ts` in M12). A trifecta without 60 senators passes only reconciliation-eligible bills.
5. **Tests** (extend `test/governing.test.ts`):
   - the filibuster blocks a 55-seat majority
   - reconciliation passes
   - swing-seat members defect more often than safe-seat members (statistical check over seeds)

---

## M19: Ballot measures

**Goal:** new content that ties issues, turnout and activism together.

1. **Data.** Add `INITIATIVE_STATES` (about 24 states with citizen initiatives) and local measures for towns of 50k or more, in a new `src/sim/measures.ts`.
2. **Generation.**
   - Each even year in June, each initiative state draws 0–2 measures from templates built on the `BILLS` issues in `governing.ts`, weighted by state lean and salience.
   - Store them in `GameState.measures?: {id, st, title, issue, dir, year, support, result?}[]`.
3. **Resolution.**
   - Resolve them in November in background elections with an issue-only model: `unitShares` with two pseudo-candidates at `±dir` on the issue, no valence, over the state's counties.
   - Passed measures apply `lawEcon` and salience shifts, and metrics if the player governs that area.
4. **Player play.**
   - New action "Campaign for or against a measure" in the player's state. It raises recognition and group standing, and shifts support.
   - Governors and legislators can get a "refer a measure" decision.
5. **UI.**
   - The state inspector lists the year's measures and their results.
   - News kind `measure`.
   - Election night shows the player's state measures as a side card, if cheap to do.
6. **Tests:**
   - generation is deterministic
   - results match the state lean on average
   - old saves load

---

## M20: Rivals 2.0 and officeholder endorsements

**Goal:** finish the "Ideas for later" from M11.

1. **Announcements.**
   - In `monthlyRivals` (`careers.ts`), rivals with high ambition announce runs 6–10 months ahead.
   - Store this in `RivalInfo.plan?: {officeId, year}` and cover it in the news.
   - They then reliably appear in that race: `rivalFor` prefers announced rivals.
2. **Primary challenges to incumbents**, the player included.
   - If the player's `partyStanding` is under 35, or their ideology is more than 0.35 from the party base, a rival or a generated challenger enters the player's re-election primary. This happens in `startCampaign` when the player is the incumbent.
   - AI incumbents in safe seats also face occasional primary challenges in `backgroundElections`.
3. **Officeholder endorsements.**
   - New action "Seek an endorsement from an officeholder". The target list comes from overlapping officeholders of the player's party, through `cover()`.
   - Odds come from favors, standing and the target's ideology distance. It adds `c.endorse` weighted by the endorser's level.
   - Rivals never endorse you.
4. **The Rivals card shows announced plans.** "Show on map" points to the target race.
5. **Tests:**
   - announced rivals show up in the announced race
   - a player with low standing draws a primary challenger
   - endorsement odds are bounded

---

## M21: Data and map refresh

**Goal:** close the data gaps listed under Known gaps.

1. **2026 results.**
   - When a source exists, add `pipeline/raw/results_2026.csv` and run `data:history` and `data:validate`. The path is already built (`pipeline/README.md`).
   - Add a validate check that `results/latest.json` cycles include 2026 once the file is present.
2. **Hawaii and DC home towns.**
   - Include Hawaii census-designated places in `pipeline/build.ts` (flagged `cdp: true`).
   - Regenerate `places/HI.json` and run `data:towns` to rebuild the PMTiles.
   - DC becomes a single "District of Columbia" town with a council.
   - Update the validate counts.
3. **Holder map mode.** Unmaterialized counties draw with a hatched lean fill and a legend note, instead of nothing (`MapView.tsx`).
4. **Town inspector boundary.** Selecting a town highlights its PMTiles boundary through feature state.
5. **Decision-desk realism (optional).**
   - Early calls use a noisy estimate. Rarely (under 2% of called units) a call is retracted. This needs a change to `planNight` in `night.ts` and its call invariants in `test/night.test.ts`.

---

## M22 (stretch): Redistricting 2.0

1. Add more than one gerrymander intensity per party ("lean", "aggressive") in `pipeline/redistrict.ts`, which needs more annealing runs. Choose by trifecta strength.
2. Commission politics: a deadlocked commission falls back to a court, and the court draws its own plan seed.
3. A 2040 census using the same machinery (`CENSUS` becomes a list).
4. Mid-decade redraws after a court strike-down or a trifecta flip (Ohio and Texas style).

---

## Critical files (by frequency of change)
- **Engine:**
  - `src/sim/game.ts` (split in M12)
  - new modules: `actions.ts`, `races.ts`, `background.ts`, `summary.ts`, `upkeep.ts`, `migrate.ts`, `legacy.ts`, `measures.ts`
- **Models and systems:** `src/sim/model.ts`, `vote.ts`, `legislature.ts`, `careers.ts`, `campaign.ts`, `governing.ts`
- **Glue and UI:** `src/workers/sim.worker.ts`, `src/store/game.ts`, `src/App.tsx`, `src/ui/TopBar.tsx`, `src/ui/hq/{CampaignPanel,NewsCareer,OfficePanel}.tsx`
- **Tests:** `test/golden.test.ts` (new), `test/balance/harness.ts`, plus a new test file per milestone

## Verification (every milestone)
1. `npm run lint && npm test`:
   - the back-test is 95% or higher
   - the golden and determinism tests pass, or the snapshot was updated in a commit that explains why
   - the new tests for the milestone pass
2. `npm run balance` for any milestone that touches vote, campaign or AI code (M12 step 4, M14, M16, M18). Compare against the M7 table and the M14 targets.
3. `npm run build && npx vite preview --port 4173`, then `npm run smoke -- ./smoke-out`. Review the screenshots and expect zero console errors.
4. Load a save from before the milestone, using a fixture in `test/fixtures/` and a manual load. Play 12 months.
5. Add a "Mxx (done)" section to `PLAN.md`, and update **Known gaps** to drop what was fixed.
