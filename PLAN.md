# US Political Sim: Implementation Plan

## Context
This is a new browser game in an empty repo (`elections/`), hosted on GitLab Pages. The player creates a politician and climbs from town council up to President. A map of the US is the main screen, with layers for state, county, congressional district, state legislative districts and towns. The map is seeded with real past election results. Every other office is held by simulated politicians with invented names, but their party and lean match reality. Each year runs as a cycle: governing and decisions, then primaries, then the general election, then repeat. The game should be detailed and number-heavy but still feel smooth and responsive.

**Decisions made:**
- Towns are clickable dots. States, counties, congressional districts and state legislative districts are full shapes.
- Real results are used where they exist (President, Senate, Governor, US House at state, county and district level). Lower offices are simulated from each area's real lean and demographics, and labeled as simulated.
- Stack: Vite, React and TypeScript.
- First build: a playable vertical slice.

## Architecture

```
elections/
  pipeline/            Node/TS scripts: download raw data, clean it, write game data (run locally, not in CI)
    raw/               (gitignored) downloaded source files
  public/data/         Generated, committed game data (~40–80MB)
    geo/               TopoJSON: states, counties, cd119, sldu/<ST>, sldl/<ST>
    places/<ST>.json   Town dots: id, name, lat/lon, population, county, CD/SLD membership
    results/           Real results, split by office/year
    demo/              Demographics (ACS) per county and place
    seats.json         Current party of every real seat (Congress, governors, state legislature)
  src/
    sim/               Simulation engine (pure TS, no React), runs in a Web Worker
    ui/                React components
    store/             Zustand store (UI state plus a mirror of the worker's game state)
    workers/sim.worker.ts   (uses Comlink)
  .gitlab-ci.yml
```

**Libraries:**
- MapLibre GL JS for the map. It needs no basemap or API key: just boundary polygons on a plain background.
- Apache ECharts for charts. It handles many charts quickly.
- Zustand for state, Tailwind for styling.
- Comlink for the Web Worker, so the simulation never blocks the UI.
- idb-keyval for IndexedDB saves.
- Vitest for tests.
- mapshaper (an npm package that runs on Windows) for simplifying shapes and converting them to TopoJSON.

## Data sources (free and public; check each license in the pipeline README)

| Data | Source |
|---|---|
| State, county, CD-119, SLDU and SLDL shapes | Census cartographic boundary files (cb_2024, 1:500k) |
| Town points and population | Census Gazetteer files: incorporated places plus county subdivisions in townships states |
| Which county, CD and SLD each place is in | Census relationship files, or a point-in-polygon pass in the pipeline |
| Demographics | ACS 5-year: population, age, race/ethnicity, education, median income, urban/rural |
| President by county, 2000–2024 | MIT Election Data + Science Lab (MEDSL) County Presidential (Harvard Dataverse) |
| Senate and House, state and district | MEDSL datasets |
| Governor | State-level totals, plus county-level where a clean source exists |
| Current state legislators' party by district | Open States bulk people data (CC0) |
| Name generation | Census surname list (2010) plus SSA first-name lists, weighted by region and generation |

The 2026 midterms happened last week. Their results go into the data once MEDSL publishes them. Until then, the game's history ends in 2024 and seat control uses the current post-election parties where they're known.

The pipeline calculates a **partisan lean** for every county, CD, SLD and town from recent presidential results, weighted toward the latest cycle. Towns use their county's lean, adjusted by demographic differences. This lean is the starting point for every simulated race.

## Simulation design (`src/sim/`)

**Core entities (`model.ts`):**
- `Jurisdiction`: state, county, place, CD, SLDU or SLDL. Each has a lean, demographics, turnout baseline and issue weights.
- `Office`: type, jurisdiction, number of seats, term length, election years, partisan or nonpartisan, primary type (open, closed or top-two by state), and term limits.
- `Politician`: generated name, age, party, a vector of policy positions, and stats.
- `Player`: a Politician plus resources.
- `GameState`: date, national environment, economy, the player, and only the offices that have changed.

**Lazy, deterministic world:** There are roughly 120,000 offices once councils are counted, so incumbents are generated from `seed + officeId` the first time they're needed. Unviewed local races are settled by a fast aggregate model. Saves store only the changes, which keeps them small.

**Policy space (`issues.ts`):** About 12 issues, each scored from −1 to 1: taxes, spending, healthcare, immigration, guns, abortion, energy and climate, crime and policing, education, trade, housing, and labor. Each jurisdiction weights these issues differently based on its demographics.

**Vote model (`vote.ts`):** For each jurisdiction, voters are split into 6–10 demographic groups. Each group has its own policy positions and party loyalty. A candidate's appeal to a group is the sum of:
- negative issue distance, weighted by how much the group cares about each issue
- party identification
- incumbency
- name recognition in that area
- favorability
- spending and ad pressure
- endorsements
- scandals
- the national environment (scaled down for local races)
- seeded random noise

Votes are counted by town or county, then rolled up. Primaries use only that party's voters, who sit further from the center. Top-two and nonpartisan races are handled separately.

**Calendar (`calendar.ts`):** One turn equals one month.
- Jan–Feb: governing and budget.
- Filing deadlines.
- Primaries on approximate real state dates.
- General election on the first Tuesday after the first Monday in November.
- Swearing-in in January.
- Odd-year local elections happen in the states that hold them.

**Economy and environment (`world.ts`):** The game starts from real values for unemployment, inflation, GDP growth, presidential approval and the generic ballot. These drift over time and react to random events and to the player's decisions as President or Governor.

**Governing (`governing.ts`):** Each office comes with a pool of decisions sized to its level. Examples: a council zoning vote, a county budget, a state bill, a federal bill or veto. Each decision moves:
- the player's approval with each voter group
- local metrics (budget balance, crime index, jobs, schools)
- standing with party leadership and interest groups
- the chance of scandals

As a legislator, the player votes on bills. As an executive, the player signs or vetoes them.

**Player campaign actions (`campaign.ts`):** Each month the player gets an action budget (time and energy) plus cash. Options:
- fundraise (by donor type, which affects policy perception)
- hold events in specific counties or towns (raises local name recognition)
- buy ads by media market
- seek endorsements
- debate
- take a policy stance
- hire staff
- opposition research

## UI (`src/ui/`)
- **Character creation wizard:** name, age, gender, home town (search or pick on the map), background or profession, party, and policy sliders.
- **Main screen:**
  - Full-screen map with a layer switcher: State, County, CD, State Senate, State House, Town dots.
  - Color modes: real results by year, partisan lean, simulated current holder, demographics, and the player's name recognition or approval.
  - Search for any place.
- **Inspector panel:** for the selected area, shows results history charts, demographics, current officeholders, and the next election with the candidate field.
- **Top bar:** date, phase, cash, approval, name recognition, and an "End Turn" button.
- **HQ dashboard:** polls (with simulated noise and margin of error), fundraising, spending, approval by voter group, issue alignment radar chart, and endorsements.
- **Governing desk:** pending decisions, and a preview of each option's effects (fuzzed by staff quality).
- **Election night:** results come in county by county on the map, with a live tally and a projected winner.
- **News feed:** events, other races, and scandals.
- **Career timeline.**
- **Design:** responsive (map and panels stack on mobile), dark and light themes, and the simulation in a worker keeps the UI at 60fps.

## Build phases (this round delivers 0–5)
0. **Scaffold:** Vite/React/TS, Tailwind, ESLint, Vitest, and `.gitlab-ci.yml` (Pages job: `npm ci && npm run build`, copy `dist` to `public`, `base` set to the project path). Deploy a map with only states drawn.
1. **Data pipeline:** download, clean, simplify, compute lean, and write `public/data`. Includes validation checks (3,143-ish counties, 435 CDs, vote totals that match published state totals).
2. **Map and inspector:** all layers load lazily (state legislative districts load per state on zoom), town dots appear from zoom ≥6, plus color modes and real results history charts.
3. **Simulation core:** entities, office catalog, name generator, lazy incumbents, vote model, calendar, and national environment, all in the worker.
4. **Player loop:** character creation, filing for office, monthly campaign actions, primary, general, election night, and taking office.
5. **Governing and dashboards:** decision pools for council, county, state legislature, Governor, Congress and President, plus approval and metric effects, the HQ charts, saves (IndexedDB, plus export and import as JSON), and the news feed.

**Later phases:** town shapes via PMTiles; more offices (sheriff, school board, Attorney General, judges, Lieutenant Governor); redistricting after the census; party leadership and caucus roles; scripted crises; AI rivals who climb the ladder too; and difficulty settings.

## Key files
- `pipeline/build.ts`, `pipeline/sources.ts`, `pipeline/lean.ts`, `pipeline/validate.ts`
- `src/sim/{model,issues,vote,calendar,world,governing,campaign,names,offices,rng}.ts`
- `src/workers/sim.worker.ts`
- `src/ui/map/MapView.tsx`, `src/ui/panels/Inspector.tsx`, `src/ui/hq/*`, `src/ui/creation/*`, `src/ui/election/ElectionNight.tsx`
- `.gitlab-ci.yml`, `vite.config.ts`

## Verification
- **Pipeline:** `npm run data:validate` checks entity counts, that every place has a county and CD, and that real vote totals match MEDSL state totals.
- **Vote model (Vitest):** set the model up with 2016 lean and environment and run it on 2020. Check that it calls at least about 95% of counties and all but a few states correctly. Also check determinism: the same seed gives the same result.
- **Simulation tests:** the calendar produces the correct election dates. Primaries happen only where they should. The office catalog matches real seat counts (435 House seats, 100 Senate seats, 50 Governors, about 7,386 state legislators).
- **Manual:** `npm run dev`. Create a character in a small town, run for council, win, govern a year, run for state house, and watch election night. Check that the map stays smooth while the worker runs a full November election.
- **Deploy:** push to GitLab and confirm the Pages job publishes and that the data loads under the project's base path.

---

# Status (as of 2026-11-15)

Phases 0–5 and milestones M7 through M21 are built and working. M6 is committed locally; the push to GitHub is pending. Run `npm run lint`, then `npm test` (136 tests: sim, election-night playback and the decision desk, balance guard rails, governing, M10, M11, the golden replay, save migrations, M13 skip-ahead and save files, M14 incumbency and party backing, M15 scandals, M16 debates, polls, adaptive AI and get-out-the-vote, M17 legacy and retirement, M18 Congress rules, M19 ballot measures, M20 rivals and endorsements, and M21 Hawaii and DC home towns), `npm run balance` for the full balance table, and `npm run smoke` for a headless browser playthrough. Both pass, and the smoke run logs no console errors at desktop or mobile widths.

## Where things live
| Area | Files |
|---|---|
| Data pipeline | `pipeline/sources.ts` (downloads), `pipeline/lib.ts` (CSV/ACS/shapefile readers, point-in-polygon index, weighted least squares), `pipeline/build.ts` (everything else), `pipeline/places.ts` (which Census places are towns, incl. Hawaii CDPs and DC; `npm run data:places -- HI DC` rebuilds chosen states' place files without a full build), `pipeline/history.ts` (House and governor history, newer results), `pipeline/supplement.csv` (races missing from 538), `pipeline/redistrict.ts` (2030 apportionment and district plans), `pipeline/towns-geo.ts` (town boundary tiles and the PMTiles writer), `pipeline/validate.ts` |
| Game data (committed, 50 MB) | `public/data/{states,counties,districts,meta}.json`, `geo/*.json` TopoJSON, `geo/sldu|sldl/<ST>.json`, `places/<ST>.json`, `results/house.json`, `results/latest.json`, `redistrict/{apportion,<ST>}.json`, `geo/plans/<kind>/<ST>-<plan>.json` (15 MB), `geo/towns.pmtiles` (20 MB) |
| Sim engine | `src/sim/game.ts` (Engine class: state, politicians, offices, filing, the turn loop and swearing-in; one-line delegates for the rest), `actions.ts` (campaign actions), `races.ts` (the player's races, AI campaigns, debates, polls), `background.ts` (background elections, the 2027 prelude, national lawmaking), `summary.ts` (month summary), `upkeep.ts` (monthly upkeep and approval), `office.ts` (decisions, AI-bill votes, executive budget), `views.ts` (UI queries), `migrate.ts` (save versions), `advance.ts` (skip ahead), `util.ts`, `vote.ts`, `offices.ts`, `issues.ts`, `world.ts`, `campaign.ts`, `governing.ts`, `night.ts` (election-night playback, calls, the desk's noisy estimates and retracted calls), `legislature.ts` (chambers, committees, leadership, bills, cross-pressure, the filibuster, reconciliation, the nuclear option, cosponsors), `budget.ts` (executive budgets, metric targets, economic effects), `vacancies.ts` (vacancies, appointments, special elections, succession), `primaries.ts` (presidential calendar, delegates, running mates, conventions), `roles.ts` (decision pools for officials), `careers.ts` (the bench, AI careers, rivals, announced runs, primary challenges), `endorsements.ts` (officeholder endorsements), `redistricting.ts` (census, who draws the maps, court challenges, eliminated seats), `incumbency.ts` (incumbency strength, the incumbent's record, running against it, party backing), `scandals.ts` (scandal stories, responses, investigations, charges and trials, opponents' responses to oppo), `debates.ts` (debate questions, answers and scoring), `trail.ts` (adaptive AI messages, the AI's pivot to the center, get out the vote, poll crosstabs, media polls), `legacy.ts` (legacy score, achievements, race records, retirement), `measures.ts` (ballot measures: initiative states, generation, the issue-only vote, campaigning on a measure, referrals), `model.ts` (types), `names.ts`, `rng.ts`; the redistricting overlay on districts and towns lives in `src/data/store.ts` |
| Worker API | `src/workers/sim.worker.ts` (Comlink) |
| UI | `src/App.tsx` (title screen with save slots, hotkeys), `src/store/game.ts` (Zustand, autosave to the active slot), `src/store/saves.ts` (IndexedDB save slots, gzip save files, the hall of fame), `src/ui/map/*`, `src/ui/panels/Inspector.tsx`, `src/ui/hq/*` (incl. `Legislature.tsx`, `BudgetCard.tsx`, `Opportunities.tsx`, `DelegateRace.tsx`, `ScandalWatch.tsx`, `DebateCard.tsx`, `CareerEnd.tsx`, `MeasuresCard.tsx`), `src/ui/creation/Creation.tsx`, `src/ui/election/ElectionNight.tsx` + `nightStore.ts`, `src/ui/kit.tsx` |
| Tests | `test/golden.test.ts` (golden replay hashes; update with `-u` only for intended gameplay changes), `test/migrate.test.ts` + `test/fixtures/save-v1.json.gz` (save migrations, exact replay after reload), `test/sim.test.ts`, `test/night.test.ts` (playback invariants, calls, key units, precinct anchoring), `test/balance.test.ts` (balance guard rails, month summary, old-save loading), `test/governing.test.ts` (bill lifecycle, whipping, overrides, leadership, budgets, vacancies, specials, pre-M9 saves), `test/m10.test.ts` (new offices and schedules, officials, succession, delegates, conventions, history data, 2027 start), `test/m14.test.ts` (incumbency strength, record approval, running against the record, party backing, pre-M14 campaigns), `test/m16.test.ts` (debate questions, answers, game plans and unprepared debates, answer quality, crosstabs, media polls, pressed issues, the pivot to the center, get out the vote, pre-M16 campaigns), `test/m18.test.ts` (the filibuster against a 55-seat majority, reconciliation once a year, a senator's own reconciliation bill, the nuclear option once a term, national lawmaking by a trifecta without 60, swing-seat defections, cosponsors, pre-M18 saves), `test/m20.test.ts` (announcements on their own streams and honored in November, announced rivals in the player's race, primary challenges to the player and to AI incumbents, leaving office after a lost renomination, endorsement targets and bounded odds, pre-M20 saves), `test/m21.test.ts` (Hawaii's towns, offices and 2030 plans, a Hilo career; DC's one town, its offices and even-year schedule, a DC career and reload), `test/m19.test.ts` (ballot measures: deterministic generation, results that follow state lean, effects of a passed measure, campaigning, referrals and lapses, saves without measures), `test/m17.test.ts` (legacy score, race records, achievements once, months in office, retirement and reload, pre-M17 saves), `test/scandal.test.ts` (M15: each response, escalation only when true and severe, resigning and verdicts, unanswered stories, opponents' responses, saves without scandals), `test/m13.test.ts` (skip ahead matches ending months one by one, stop reasons, merged summaries, gzip and plain save files), `test/m11.test.ts` (rivals, the bench, presidential tickets, reapportionment, enacted maps, the governor's veto, eliminated seats, save reload, plan and tile data), `test/balance/harness.ts` + `report.ts` (`npm run balance`), `test/setup.ts` (stubs `fetch` to read `public/data`), `test/smoke.mjs` (playwright-core driving the installed Chrome) |

## Deviations from the original plan
- **Data sources:**
  - The MEDSL county presidential and House files on Dataverse require a guestbook form. County presidential results come from tonmcg's GitHub dataset (MIT license, 2008–2024) instead.
  - House and governor result history come from 538's election-results repo (CC BY 4.0), not MEDSL. Kentucky's and Mississippi's 2023 governor races are missing there and are added from `pipeline/supplement.csv`.
  - The Census ACS API now requires a key, so the pipeline uses the ACS table-based summary `.dat` files instead.
- **Geometry**: states, counties and districts are TopoJSON simplified with mapshaper and loaded as GeoJSON sources. Only town boundaries (M11) use PMTiles, written by our own small writer because tippecanoe doesn't run on Windows.
- **District lean and demographics** are aggregated from census tract centroids (about 83,600 tracts) using point-in-polygon.
- **Game start is January 2025.** Public data ends at the 2024 elections. Seat control comes from congress-legislators, Open States (97.5% of state legislative districts matched by name) and a hand-entered `GOVERNORS` table.
- **The project moved out of Box Drive** because Box kept locking files. Don't put this project back in Box.

## Known gaps and quirks
- **Floor votes are still mostly party-line** (M18 added cross-pressure). Members' issue positions cluster by party, so across all bill templates about 1% of members break ranks, about 2.5% in the quarter of seats that tilt most toward the other party, and almost none in the safest quarter. The drama is in narrow chambers, hostile second chambers, the Senate filibuster and whipping moderates.
- **Leadership is only simulated for chambers the player deals with.** Other chambers have no leaders until the player joins or faces them.
- **The filibuster applies to bills, not budgets** (M18). A President's or governor's budget still passes by the majority rule in `legislateBudget`. Bills that reach a player President's desk are assumed to have passed Congress; the filibuster isn't checked for them.
- **Beating a sitting governor or U.S. senator** (M14): a balanced climber wins about 21% in a wave year against the incumbent's party, about 5% in an ordinary year and 0% in a bad one (`vs-incumbent` rung, three seeds, n=40 each). The sample is small (about nine swing-state seats in the harness's 15 states), so single runs swing ±7 points.
- **Primaries against your own party's incumbent stay hard.** Overall primary losses for active climbers are still about 45% (US House about 60%), because the harness usually gives the player the seat's majority party, which usually holds the seat. Party backing can't clear a field with a sitting incumbent. In primaries without one, active climbers lose about 20% (fundraiser and balanced 5–20%, grassroots 20–45%). The harness player is a moderate (70% of the party line); more partisan players do better in primaries and worse in generals.
- **Opposition research** (reworked in M15) opens a story whose damage depends on the opponent's response: about 0.22 scandal on average, down from 0.275. It fades at ×0.88 a month for candidates in the player's race; background officeholders' scandals never fade. Opponents' stories don't escalate to investigations.
- **Legacy bonuses start at M17.** In saves from before M17, years in office and election results count in full (they come from the career log), but flips, beaten incumbents, underdog primaries, laws, leadership posts and average approval only count from the first month played after the upgrade.
- **The game ends only by retirement or health** (after 80). Losing every race, or a conviction, leaves the player free to run again.
- **Background officeholders' scandals** are still a single number (rivals' monthly scandals included); only the player and opponents hit by oppo get stories.
- **Unspent cash doesn't count at the polls.** This is intentional; the month summary warns about it in the last three months before an election.
- **Presidential primaries** run state by state (January–June, six monthly nights) with pledged delegates, but there are no superdelegates, no caucus/primary distinction, and every state in a month votes on the same night.
- **Joint tickets are background-only.** Lieutenant governors in joint-ticket states follow their governor in background races; a player running for one of those seats runs a normal separate race.
- **Row offices, sheriffs, prosecutors, county executives, school boards and justices start with simulated parties** (drawn from the area's lean), not their real holders. Wisconsin's April court races are held in November.
- **Real 2026 results aren't in the data yet** (there was no machine-readable source a week after the election, and none was added in M21). The 2027 start simulates the midterms until `pipeline/raw/results_2026.csv` is added. It does use the real 2025 NJ and VA governor winners.
- **Chamber votes** count only materialized members. Council and county bodies are fully materialized once the player joins them.
- **Background races** keep losers only if they held office or are rivals or other notables (to keep saves small, about 4–6 MB). AI officeholders keep their last six career entries. M11 fixed a leak: the would-be challenger in an uncontested seat used to stay in the save (about 700 extra people after six years).
- **Officeholder names** are random combinations of common names, so they could coincide with real people.
- **Election night precincts are synthetic.** District and county races report by synthetic precincts anchored to the district's largest towns (one dot per town). Unincorporated areas don't get their own dots, and ward races in a single town show one dot.
- **The decision desk knows the final result, plus noise** (M21). State and race calls are never wrong. Unit calls can be premature (about 0.3% of counties on a presidential night, none on nights under 67 units), and are retracted when the lead flips. There are no wrong race calls or "upsets" on the night itself.
- **Hawaii's towns are census-designated places** (M21). Hawaii has no municipal governments, so each CDP gets a simulated neighborhood board (council) and board chair (the town executive). Their leans come from the demographic model, which sees Filipino and Native Hawaiian communities only through its Asian and non-white shares. For example, Waipahu (majority Filipino) is modeled at 44% D.
- **DC is one town with nonpartisan offices** (M21). The real DC council and mayor are elected in partisan primaries; the game keeps them nonpartisan like every other town, on DC's real even-year schedule. DC has no state or congressional offices, so a DC career goes from council or mayor straight to the presidency.
- **Rivals are a handful, not a full cast.** The game follows up to 10 active rivals. Everyone else climbs too, but only rivals get detailed coverage and a stored ambition; others' ambition is derived from their id.
- **Rivals announce, but their races are still decided in November** (M20). Rivals announce runs from January to May, and AI incumbents can lose primaries, but background primaries are decided on general election night with a quick two-way vote (the news reports them in November). At most one rival per party announces for a given race, the player's included.
- **Sitting players face crowded primaries.** As before M20, a player running for re-election in a seat their party usually wins draws one to three generic same-party challengers (before any M20 challenger). In the golden governor script, a sitting governor loses renomination with 26%.
- **Redistricting plans are precomputed.** Each map has three plans (fair, D-drawn, R-drawn), so two D trifectas draw equally aggressive maps, and there are no partial deals or mid-decade redraws. Plans are built from current (2023) tract populations, not 2030 counts. Legislative districts can't be balanced below tract size, so their deviations are larger than the law allows. Six small-district state houses keep their old lines.
- **The new lines take effect when enacted (mid-2031),** not at the 2032 election, so members serve the last year of their term under the new district's lean. Seats a state loses stay on the books, held by their incumbents, until January 2033.
- **Commission and court plans use the same neutral plan.** There is no separate court-drawn map or commission politics. Court challenges are a coin flip (20% of gerrymanders are sued, 55% of those struck down).
- **Debates happen once per stage**, the month before the vote, at level 2 and up. A January vote (Iowa) gets none, and a presidential primary gets at most one before its next contest. Questions are about issues, not records or scandals.
- **The player's "Policy speech" works against them** (found in M16, not fixed). `Candidate.emphasis` scales only that candidate's own issue distance in `vote.ts`, so emphasizing any issue can only lower the player's utility. M16's AI emphasis uses race-wide salience instead. The fix is to route the player's emphasis the same way, but that changes the balance table.
- **The balance harness doesn't answer debates or read crosstabs,** so the M16 table understates what an attentive player can do.
- **Ballot measures are simplified** (M19). Each is a single yes-or-no move on one issue, built on a bill template, and voters judge it on that issue alone (plus the policy's own popularity and campaigning). There are no money campaigns, signature drives, supermajority rules (Florida's 60%), or constitutional versus statutory measures. Local measures exist only in the player's home state (other states' towns aren't loaded), at most eight a cycle.
- **Hosting moved to GitHub Pages** (`.github/workflows/pages.yml`, https://joedementri.github.io/ballot-ladder/). `.gitlab-ci.yml` is kept for a possible GitLab mirror.

# Next milestones (suggested order)

## M6: Ship it (committed; push pending)
Initial commit made; the remote is https://github.com/joedementri/ballot-ladder (GitHub, so deploys use `.github/workflows/pages.yml`). After pushing, set Settings → Pages → Source to GitHub Actions and check the site loads its data. Added `pipeline/validate.ts` (`npm run data:validate`, checks committed data only), empty place files for HI/DC, and a DC results fix in the pipeline.

1. Make the first commit and add the GitLab remote (ask the user for the URL). Push and confirm the Pages pipeline publishes and that data loads under the project base path.
2. Optionally commit `public/data` with Git LFS if repo size becomes a concern. At 11 MB, plain git is fine.

## M7: Balance and feel (done)
- **Balance harness** (`test/balance/`): plays seeded races at six rungs (council, mayor, state house, state senate, U.S. House, statewide) with four scripted strategies and two profiles (newcomer, and climber with a head start in recognition, cash and staff). Only seats within ±12 pts of even are used. `npm run balance [n=40 profile=both difficulty=normal rungs=council,mayor]` prints the table. `test/balance.test.ts` runs a small version with loose bands.
- **Tuning changes:**
  - repeats within a month have diminishing returns: fundraising ×0.8 per repeat, events in the same place ×0.5, ad flights ×0.75 (`FATIGUE` in `game.ts`)
  - event recognition scales with place size: `sqrt(8000 / population)`, clamped to 0.15–1.3
  - flat fundraising floors removed ($300/$1000/$500 → $100/$250/$150, and these taper too)
  - donor-dinner and small-dollar yields trimmed; TV and digital ads give slightly less recognition
  - starting campaign cash cut from 25% to 10% of background savings
  - AI candidates in level 1–2 races campaign twice as hard on recognition and have 1.3× budgets
  - council incumbents start better known (0.38)
  - incumbency bonus 0.28 → 0.35 (back-test unaffected: 98.1%)
- **Results (Normal, n=40 per cell, win %):**

  | Rung | Newcomer: passive / fundraiser / grassroots / balanced | Climber: passive / fundraiser / grassroots / balanced |
  |---|---|---|
  | Council | 5 / 57 / 70 / 88 | 5 / 85 / 75 / 98 |
  | Mayor | 0 / 35 / 45 / 75 | 3 / 53 / 55 / 83 |
  | State House | 0 / 33 / 8 / 38 | 3 / 63 / 35 / 68 |
  | State Senate | 0 / 5 / 0 / 10 | 0 / 33 / 10 / 43 |
  | U.S. House | 0 / 3 / 0 / 5 | 0 / 23 / 3 / 28 |
  | Statewide | 0 / 20 / 0 / 15 | 0 / 25 / 0 / 20 |

  Grassroots is competitive in local races; money matters more as races get bigger. Newcomers rarely win federal races.
- **Difficulty** (`src/sim/difficulty.ts`, chosen at character creation and stored in the save; old saves default to Normal): Story doubles starting cash, gives AI 0.7× budgets and 0.75× recognition growth, and uses 0.7× election noise; Hard is 0.6× cash, 1.3× AI budgets, 1.25× AI recognition and 1.3× noise. Newcomer balanced council: Story 97%, Normal 88%, Hard 63%; State House: 57 / 38 / 27%.
- **Month summary** after End Month (`MonthSummary.tsx`, built in `Engine.monthSummary`): cash, recognition, favorability or approval, party standing and poll moves, with plain-language reasons, a money breakdown that reconciles with the cash change, your actions, events, and what's coming up. It can be turned off and reopened from the menu.
- **Action log** (`PlayerState.log`, last 80): shown under Actions (this month, or history). Action cards show the repeat penalty before you click.
- **Onboarding:** a first-month checklist (`Onboarding.tsx`), and hover/tap help on every stat label via `HELP` in `src/ui/help.ts` (`Stat`, `Meter`, `Card` and the top bar look labels up automatically).
- **Mobile top bar** now uses two rows, so all stats stay visible at phone width.

Original M7 plan:
1. Write a headless balance harness (Vitest) that simulates 100 careers per office level with scripted strategies (passive, fundraiser, grassroots, balanced). Tune these until outcomes feel right:
   - action effects (`Engine.act` in `game.ts`)
   - AI budgets and recognition growth (`aiCampaign`)
   - `expectedSpend` per office (`offices.ts`)
   - the valence weights in `vote.ts`
2. Add difficulty settings (starting cash, AI quality, how strong the noise is).
3. Add onboarding: a first-month tutorial checklist and hover help on every stat.
4. Add recent-actions history and a "month summary" modal after End Month: what changed and why (polls, money, recognition).

## M8: Election night on the map (done)
- **The panel is docked, not modal** (right side on desktop, bottom half on mobile), so the map stays visible and interactive. A shared store (`src/ui/election/nightStore.ts`) passes the playback state from the panel to the map.
- **Playback model** (`src/sim/night.ts`, pure and seeded from the race, so replays are identical):
  - each unit starts reporting at its own time and comes in over 2–5 batches; bigger units take longer
  - early batches are skewed (a race-wide early-vote "mirage" plus local variation), so leads can shift
  - presidential nights follow poll-closing waves by time zone, shown on a 7 PM–2 AM ET clock; other races run 8 PM–1 AM
  - the header shows the share of expected vote counted and how many units are fully in
- **Calls:**
  - `callable()` calls safe margins early and close ones only once the outstanding vote can't overturn the lead
  - call times for units, states and the race are computed when the plan is built, so calls stick and never revert
  - presidential races are called at 270 called electoral votes; an electoral tie waits for every county
- **On the map** (`MapView` night layers):
  - statewide and presidential races color counties, and the presidential primary colors states, through their own feature-state keys on the shared sources
  - district, county and town races show town dots, sized by expected vote, inside the district outline
  - pale = leading, solid = called (stronger with margin), grey = not reporting
  - the base map dims and regular town dots hide during the night, then both are restored
  - hover tooltips show the live count and call status
  - presidential races have a Counties/Electoral map toggle
- **Precinct anchoring** (`anchorPrecincts` in `vote.ts`): synthetic precincts are matched to the jurisdiction's largest towns by lean rank and relabeled. Votes are unchanged (back-test still 98.1%). Results now carry `geo` (town id) per precinct; old saves without it simply show no dots.
- **Panel additions:**
  - key-unit callouts (biggest vote, bellwether, battleground, each finalist's base, home; for presidential races, the tipping-point state, closest state and biggest prize); each shows margin, share counted, call status and, in D-vs-R generals, the swing against the area's baseline lean, and clicking one flies the map there
  - a decision-desk feed of calls, with the race call pinned to the top
  - an EV bar split into called and leading
  - candidate names stay distinct when two candidates share a last name

## M9: Deeper governing (done)
- **Chambers** (`legislature.ts`) are keyed `council:{town}`, `county:{fips}`, `sldl:{ST}`, `sldu:{ST}`, `house`, `senate`; members are the materialized seats. Councils and county boards are "small" (no committees, one presiding officer). Nebraska's unicameral is nonpartisan, with no party leaders.
- **Player bills**: introduce one (2 AP, at most 3 active) by picking an issue and a direction. You can use a matching template from `governing.ts`, or a generic "{Issue} Act" whose interest-group effects come from `GROUPS`. The stages are:
  - committee: the chair grants a hearing with odds from the chair's support, party and your standing, and lobbying adds +30% for 2 favors. The committee then votes. A bill with no hearing in 3 months dies.
  - floor: you call the vote (1 AP). Leadership calls it after 3 months.
  - the other chamber votes at month end.
  - the executive signs or vetoes at month end.
  - after a veto, you can attempt an override, which needs two-thirds of both chambers. If you don't try within 2 months, the bill dies.
  - Speakers, majority leaders and the bill's committee chair fast-track it (a hearing is guaranteed).
- **Votes**: a member's support is `pos[issue]·dir` ± party loyalty to the sponsor's side (halved in nonpartisan bodies), plus a fixed quirk per member and bill, plus a pull from the player's leadership post. Support > 0 is a yes. Members between −0.3 and 0 are persuadable.
- **Whipping** (1 AP) tries up to 3 persuadable members, closest first. Each costs 1 favor, or 2 from the other party, and double in the other chamber; whips pay half. When you run out of favors, each one costs 3 party standing.
- **Favors**: legislators earn +1 a month (+1 whip or chair, +2 party leader, +3 Speaker), plus +0.5 for each party-line vote on an AI bill. They are capped at 40.
- **AI bills** (decisions):
  - After the player's chamber passes one, the other chamber votes and the executive decides (`billFate`). A veto of a bill the player voted for comes back as an override decision.
  - When the player is the executive and vetoes, the legislature overrides automatically if it has two-thirds in every chamber.
  - Speakers and majority leaders get a "Keep it off the floor" option, and chairs a "Bury it in committee" option for bills in their committee.
- **Leadership** (`ensureLeadership`, stored in `GameState.leadership` for chambers the player deals with):
  - Slots are filled from the majority (or minority) party by seniority and kept while the holder stays.
  - When control flips, the majority's posts are reassigned. The player's post converts: Speaker or majority leader becomes minority leader, and a chair loses the gavel.
  - The player bids from the Office tab, and the caucus votes at the end of January. The player's score is standing, seniority, favors and charisma, against the incumbent's seniority plus an incumbency bonus. The odds are shown before you bid.
  - A post raises recognition targets and favors, and party standing drifts up 0.5 a month.
  - Committee assignments (up to 2, defaulting by background) can be changed in January and February.
- **Budgets** (`budget.ts`, executives only):
  - Each year's budget sets five levers: tax (±20%) and schools, safety, infrastructure and health (±30%). It costs 2 AP.
  - If the executive's party holds under 50% of a chamber, the legislature pulls the levers 35% back toward baseline (60% if it holds under 42%).
  - With no budget by the end of March, a continuing resolution keeps last year's levels and costs −3 effectiveness.
  - Metrics now drift (8% a month) toward `base + budget targets + laws in force + economy` instead of toward base. Laws are stored in `PlayerState.policies` (×3 metric units, capped, halved for legislators), and the economy feeds jobs and cost.
  - Deficits count double in approval, so spending is a trade-off, not a free lunch.
  - `effectiveness` is clamped to 0–100, and its approval weight dropped from /200 to /250.
- **Economy** (`world.ts`): unemployment, inflation and GDP mean-revert to `baseline + policy + fiscal`.
  - `policy` comes from enacted state and federal laws (`lawEcon`, weighted 1 for federal and 1.5× population share for states). It decays about 1.5% a month.
  - `fiscal` comes from the President's (or a governor's, population-weighted) budget stance.
  - Without the player in Congress or the White House, Congress passes about one law every two years: a party-line bill under a trifecta, or a bipartisan infrastructure or trade deal.
- **Vacancies** (`vacancies.ts`):
  - About 0.06% of seats a month empty out, more for older or scandal-hit holders. The draw uses Poisson thinning, so it is cheap.
  - Seats are guarded while they are part of the player's race or a pending change.
  - President, governor and mayor are filled by succession. A U.S. House seat gets a special election 4 months out, with the primary 2 months before; none is held if the regular election comes first.
  - A U.S. Senate seat is appointed by the governor, followed by a special election the next even-year November. State legislature and county seats are appointed by the departed member's party, and council seats by the council, in each case one month later.
  - The player can seek an appointment (2 AP) in their area if it is a step up and they match the appointing party. The odds come from standing, favors, recognition and level gap.
  - As governor (Senate seats) or a council member or mayor (council seats), the player picks the appointee from a loyalist, a consensus pick and a caretaker. A governor can also appoint themselves, at a cost.
- **Special elections** are filed like any race (the Run tab shows "Special election"). `Campaign.generalMonth` replaces the hard-coded November, and the winner is seated right away (`Engine.installOffice`, which now handles all swearing-in).
- **Fixes along the way:**
  - The player's re-election now increments `terms` and keeps `since`, so governor term limits work. It no longer resets metrics or bloc approval.
  - Leaving an office now opens a real vacancy instead of silently installing a replacement.
- **Performance**: `national()` is about 100 ms (it loops over offices once per state), so national lawmaking counts Congress in one pass. Balance-test runtime is unchanged.
- **Save compatibility**: every new field is optional. Pre-M9 saves load (tested), and old player terms stay as they were.

## M10: More offices and realism (done)
- **New offices** (`offices.ts`). Officials have their own decision pools in `roles.ts` (no bills, no budget) and see only the metrics they answer for on the Office tab:
  - School board (`school:{town}:{seat}`): level 1, nonpartisan, 5 or 7 seats, odd years.
  - Sheriff and prosecutor (`sheriff:` / `da:{fips}`):
    - No elected sheriffs in AK, CT, HI and RI. No elected prosecutors in those states (except HI), NJ or DE.
    - Nonpartisan in CA and OR.
    - Titles follow the state (State's Attorney, Commonwealth's Attorney, Solicitor and so on), and so do election years.
  - County executive (`cexec:{fips}`, level 3): every county in TX (County Judge) and KY (County Judge/Executive), plus counties of 250k+ elsewhere. It's an executive with a budget that works with the county commission, and county bills now go to its desk (`executiveOf(key, e)`).
  - Lieutenant governor, attorney general, secretary of state and treasurer (level 5), in the states that elect them:
    - They're elected on the governor's cycle, except Pennsylvania's row offices, which come up in presidential years.
    - Lieutenant governors on a joint ticket follow their governor.
  - State supreme courts (`judge:{ST}:{seat}`) in the 22 states with contested elections:
    - Each state has its real seat count, term length and partisan or nonpartisan ballot.
    - Seats are staggered so each one is up once a term.
    - Justices must be lawyers and retire at 75.
  - Vice President (`vp`): elected on the President's ticket.
- **Succession**: when the governor or President leaves, a sitting Lt. Governor or VP moves up, and the player can inherit the office this way.
  - The new executive fills the empty seat. If that's the player, it comes up as an appointment decision.
  - The Governor appoints to row offices and courts, the President fills a VP vacancy, and school boards fill their own seats.
- **Presidential primaries** (`primaries.ts`) run on six monthly contest nights: Iowa and New Hampshire, the early states, Super Tuesday and March, April, May, and June.
  - **Delegates:** each state's delegates are weighted by electoral votes and party strength (about 3,949 D and 2,429 R in all), and a majority clinches.
  - **Allocation:** Democrats split each state proportionally above 15%. Republicans split proportionally above 20% until April (unless someone tops 50%), then winner-take-all.
  - **Dynamics:** night winners gain momentum, weak candidates drop out and AI candidates get a home-state boost. The player is out once mathematically eliminated. If nobody clinches, the delegate leader wins at the convention.
  - **UI:** election night shows the delegates won, and the Campaign tab has a delegate-race card with the calendar.
  - **Balance:** a strong, active, well-funded senator wins the nomination about half the time; a passive one never does.
- **Running mates**: the nominee picks a swing-state moderate, a party favorite or their top primary rival.
  - The pick gives a small bias and a recognition boost in the running mate's home state.
  - If the player never picks, a default is chosen.
  - The running mate becomes VP if the ticket wins.
- **Conventions**: in July of presidential years when the player isn't the nominee, both tickets are set (`GameState.tickets`). A well-placed player may be offered the VP slot; accepting withdraws them from any other race.
- **History**:
  - House margins by district (1998–2024) appear in the CD inspector.
  - Governor margins by state (including odd-year states and specials) appear in the state inspector.
  - Built by `npm run data:history`, and checked by `data:validate`.
- **2027 start**, chosen at character creation:
  - It plays out 2025–26 in the background: the economy, the 2025 off-year races (with the real NJ and VA winners) and the 2026 midterms. Then everyone is sworn in.
  - It switches to real 2026 seat control once results are added to `results/latest.json` (see the pipeline README).
- **Fix**: a seat whose primary the player lost is now still decided in the November background elections. Before, the incumbent silently kept it.
- **Save compatibility**: every new field is optional.
  - Old saves pick up the new statewide offices lazily, when viewed.
  - A pre-M10 presidential campaign already in progress finishes under the old single-primary rules.

## M11: Living world (done)
- **AI careers (the bench, `careers.ts`).** November background races now run in three passes:
  1. Who runs again.
  2. Open seats, highest office first, draw each party's nominee from ambitious officeholders whose turf overlaps the seat, at most three rungs down. Overlap comes from town memberships, so it follows redistricting.
  3. The vote.
  - Someone who files while their own seat is on the same ballot gives it up, which opens that seat for the next rung down. Otherwise it is a free shot.
  - In competitive seats (within 8 points), ambitious officeholders sometimes take free shots at incumbents.
  - Ambition is stored for rivals and otherwise derived from the politician's id (younger is hungrier). The score also weighs recognition, skills, age and scandal.
  - Winners move up in January, and their old seat is filled by its own rules. About 90 officeholders move up in a midterm.
  - Vacancy appointments at level 4 and up go to a sitting officeholder half the time.
  - Presidential nominees at the conventions, background presidential races and the player's presidential primary field come from sitting governors, senators, the VP and senior rivals.
- **Rivals.** At game start, the game follows an up-and-comer from each party in the player's town (or a newcomer, if no local officeholder fits) and a rising star from each party in the state.
  - Anyone who beats the player becomes a nemesis. Some strong losers (over 40%, under 58) come back for a rematch.
  - At most 10 rivals are active; the least relevant are dropped.
  - Rivals are kept in the save out of office (`Politician.notable`; `Engine.discard` replaces the old deletes). They can jump into the player's races (70% when one fits) and fill appointments.
  - They have monthly scandal odds and retire at 70 or after six years out of office.
  - News kind `rival` (with its own News filter) covers their races, scandals and exits.
  - On the Career tab, the Rivals card shows each rival's office, why they're a rival, the record against the player and their career, with "Show on map". Rival chips appear in the campaign field and the inspector.
- **Redistricting (`redistricting.ts`, `pipeline/redistrict.ts`).**
  - **Census (December 2030).** Huntington–Hill on projected 2030 populations moves seats (TX and FL +4; AZ, GA, ID, NC and UT +1; CA −4; IL and NY −2; MN, OR, PA, RI and WI −1). Electoral votes change for 2032 (`setApportionment` updates `EV` in place on both threads).
  - **New maps (2031).** States redraw in May (NJ, VA, LA and MS legislatures) or September. The drawer depends on the state:
    - Commissions draw the fair plan: CD in AZ, CA, CO, HI, ID, MI, MT, NJ, VA and WA; legislative maps in 13 states.
    - The AR and OH legislative boards follow the governor's party.
    - A trifecta, a veto-proof legislature, or NC's legislature (no veto) draws its party's plan.
    - Divided government deadlocks, and a court draws the fair plan.
    - NE's Unicameral draws fair maps.
  - **The player's say.** A governor signs or vetoes; a legislator in the majority votes, and in a thin majority a no vote sinks the map. Each option previews expected seats and the player's home-district lean.
  - **Courts.** 20% of gerrymanders are sued, and courts rule the next February.
  - **Seats.** New seats start vacant (open in 2032). Lost seats are off the 2032 ballot and removed in January 2033; a player who holds one is told to run in their home's new district.
  - **Geography overlay.** `DataStore.applyPlans` swaps district records, flags eliminated seats, remaps town memberships and bumps `planVersion`. The worker and the main thread both apply it, and saves store only the plan choices (`GameState.redistricting`).
  - **UI.** The map swaps in each redrawn state's shapes. The state inspector shows seat changes, who drew each map, expected seats and court cases (or, before 2031, who will draw it and the range of outcomes). District labels say "(2031 lines)".
- **Town boundaries.** A Dots/Shapes toggle sits next to Towns (remembered per browser). Shapes come from `geo/towns.pmtiles` through the `pmtiles` protocol. They are colored by lean from the tile, by recognition (feature state) or neutral for demographics, with hover, tooltips and click-to-select. Big-town dots stay until boundaries appear at zoom 6.5. Shapes hide on election night.
- **Fixes along the way:**
  - The worker now loads the home town's state when a save is loaded, so the top bar shows "Austin, TX" instead of a town id.
  - The uncontested-seat challenger leak is fixed.
  - Moving-up officeholders are no longer deleted when their old seat's successor is sworn in first.
- **Save compatibility.** Every new field is optional. Old saves get no rivals (they start following people who beat the player). A pre-M11 save loaded after December 2030 catches up on the census and maps.

Ideas for later: rivals who announce months ahead and challenge incumbents in primaries, more than one gerrymander per party (and commission politics), redistricting after 2040, and town boundaries in the town inspector.

## M12: Foundations (done)
- **Determinism.** `generateDecisions` (`governing.ts`) takes an id factory; `Engine.endTurn` passes `() => e.newId('d')`. The old `Date.now()` ids weren't just cosmetic: decision ids seed members' vote quirks in `support()`, so AI-bill votes could differ between runs.
- **Golden replay** (`test/golden.test.ts`): three seeded scripts on Story difficulty, snapshotted as a hash of `exportState()` without `version`:
  - a 36-month career (file → act → decide option 0 → end turn)
  - a 24-month PA state representative (bills, floor votes, overrides)
  - a 24-month PA governor (budgets, vetoes)

  The hash is identical across processes. Intentional snapshot updates are listed in the file header.
- **`game.ts` split** (2,260 → about 730 lines). Function modules take `e: Engine`, and `Engine` keeps one-line delegates, so the worker API and tests are unchanged:
  - `actions.ts`, `races.ts`, `background.ts`, `summary.ts`, `upkeep.ts`
  - `office.ts`: decisions, AI-bill votes, the executive budget
  - `views.ts`: UI queries
  - `util.ts`: shared helpers

  The golden hashes were unchanged. They caught a bug in the move: an automated `this` → `e` rewrite had also changed "this month" inside strings, which altered behavior.
- **One vote rule.** `chamberSupport` (`office.ts`) is now a thin wrapper over `aiChamberVote`, so player votes on AI bills use the same `support()` rule as everything else. "Skip the vote" now counts as present, not no. On 1,600 sample bills across eight chambers, 98.8% have the same outcome and the pass rate is 49.1% (was 50.0%). The balance harness rows are unchanged, since it plays races, not floor votes.
- **Save migrations** (`migrate.ts`, `SAVE_VERSION` 2):
  - `Engine.load` runs `migrate`, which upgrades one version at a time and refuses saves from a newer version.
  - Version 1 → 2 fills the M7–M11 fields: `difficulty`, `startYear`, `leadership`, `vacancies`, `specials`, `tickets`, `rivals`, the player's `log`, `favors`, `role`, `bid`, `committees`, `bills`, `budget` and `policies`, and `world.policy`.
  - Those fields are now required in `model.ts`, new games write them, and the `?? []` / `??= {}` fallbacks are gone.
  - `redistricting` stays optional on purpose: `restore()` uses its absence to catch up pre-M11 saves.
  - `test/migrate.test.ts` loads `test/fixtures/save-v1.json.gz`, a real pre-M12 save pruned to PA and stripped to the oldest v1 shape (see `test/fixtures/README.md`), and plays 12 months. It also checks that a save reloaded mid-career replays byte-for-byte through an election.
- **Lint.** ESLint 9 flat config (`eslint.config.js`: typescript-eslint recommended plus react-hooks). `npm run lint` runs before the tests in `.github/workflows/pages.yml` and `.gitlab-ci.yml`. It found 12 existing problems, all fixed: unused imports and variables, a dead `monthLabel`, and a stale disable comment. The one hooks warning that remains (`BudgetCard` resets its draft only when a new budget is enacted) is disabled with a comment.
- **Found, not fixed:** `npm run balance` with no arguments runs out of memory (4 GB heap) partway through the state senate climber rung, both before and after M12. Run it with `NODE_OPTIONS=--max-old-space-size=12288` or a `rungs=` subset until the harness frees memory between races.

## M13: Quality of life (done)
- **Save slots** (`src/store/saves.ts`, IndexedDB through idb-keyval):
  - The index lives under `ballot-ladder-slots` (`SlotMeta`: id, name, player, party, office, year, month, updated) and each slot under `ballot-ladder-slot:<id>`.
  - On first boot the old `ballot-ladder-autosave` key becomes a slot named "Autosave" and the old key is deleted.
  - A new career gets its own slot, named after the character. Autosave writes to the active slot after every month, skip, night and import.
  - The menu's "Save as new slot…" forks the game into a new slot, which becomes the active one.
  - Imports always go into a new slot, so they never overwrite the game in progress.
  - The title screen lists slots newest first, with Continue and Delete (with confirmation).
- **Save files.** Export writes gzipped JSON (`.json.gz`, `CompressionStream`; about 5× smaller on a real save), or plain JSON if the browser lacks it. Import checks for the gzip magic bytes and falls back to plain JSON, so old exports still load.
- **Skip ahead** (`src/sim/advance.ts`, `Engine.advance`, worker `advance(maxMonths)`):
  - It loops `endTurn()` (at most 24 months; the UI asks for 12) and always runs at least one month, so pressing it during a stop month still moves on.
  - It stops on, in priority order: game over, election night, a new decision, a campaign starting, ending or changing stage, the last three months before a vote, the last filing month for an eligible office above the player's current level, or the month limit.
  - `availableOffices()` now returns a `deadline` ({year, month}) next to the `filingBy` label.
  - The months' summaries are merged (`mergeSummaries` in `summary.ts`): start values from the first month, end values from the last, money lines summed (they still reconcile), events from every month, and the reasons deduplicated. `MonthSummary.span` (optional) carries the month count, start and stop reason, and the summary modal shows "N months passed. Stopped because: …".
  - The TopBar shows "Skip ahead" (an icon on phones) when the player isn't in a live race. If decisions are pending, it asks before letting them expire.
  - Skipping is exactly equivalent to ending the same months one by one (tested by hash). `endTurn` is untouched, so the golden hashes didn't change.
- **Keyboard shortcuts** (`useHotkeys` in `src/ui/kit.tsx`, registered in `App.tsx`, listed in the menu): `E` ends the month, `S` skips ahead, `1`–`6` switch tabs, `M` reopens the summary and `Esc` closes the summary and the menu. They are ignored while typing in a text field, with modifier keys, on key repeat, and (for `E` and `S`) while the summary is open.
- **Smoke test** now skips ahead, uses the `M`, `Esc` and `5` hotkeys, saves a second slot, goes back to the title screen, checks that both slots are listed and continues the second one. The rival-card selector is scoped to the side panel, since the menu button now has `aria-expanded` too.
- **Known limits:**
  - Officeholders get a decision most months, so for them a skip usually stops after one month.
  - Slots exist only in that browser's IndexedDB. Use Export to move a career between browsers.

## M14: Beatable incumbents and a fairer primary path (done)
- **Incumbency strength** (`incumbency.ts`). `Candidate.incumbent` is now a number from 0 to 1, and `vote.ts` adds `INCUMBENCY` (0.35) × strength. `Engine.candidate` computes it, so it applies to the player's races and to background, special and presidential races alike. Strength starts at 1 and loses:
  - (0.54 − last share) × 4 after a win under 54%
  - scandal × 0.5 (if over 0.05)
  - 0.1 per term beyond the second, up to 0.3
  - 0.15 in a midterm for a partisan level-5+ incumbent of the President's party

  The back-test is unchanged (98.1%): generic candidates aren't incumbents. The field card says "Vulnerable incumbent" under 0.6 and lists the reasons; the view carries `incStrength` and `incFactors`.
- **The incumbent's record.** Each month of the player's campaign (`judgeIncumbents`, called from `aiCampaign`), an AI incumbent in any of the race's fields moves 12% of the way toward `recordApproval`: 0.56, plus the President's approval (±, by party, × 0.3) and the generic ballot (/300), scaled by office level (1, 0.6 local, 0.3 for levels 1–2), plus integrity and charisma. Scandals aren't counted again here.
- **Scandals fade for AI candidates in the player's race** (×0.88 a month, like the player's). Without this, a single oppo hit decided most statewide races once a strategy used it.
- **Run against the record** (`record`, Media, 2 AP, 6% of expected spend). Needs an incumbent in the race and a successful oppo on them (`Campaign.oppoFound`). It lowers their favorability by (0.012 + 0.04 × gap) and adds (0.012 + 0.06 × gap) to the player's bias, where `recordGap` is the incumbent's bloc-weighted issue distance from the district minus 0.08. A comms director adds up to 45%. Each repeat in a race lands half as hard (`recordRuns`).
- **Seek the party's backing** (`party_backing`, Organization, 2 AP). Once per race, before the primary month, in partisan and top-two races with same-party challengers and no same-party incumbent. Odds: 0.12 + (standing − 40)/80 + 0.6 × recognition + 0.1 if the player holds an office within two levels − 0.04 per level above 2, clamped 3–90%.
  - Success: same-party challengers drop out except the strongest (all of them half the time when the odds were 50% or better), +2 endorsements, +3 standing.
  - Failure: −6 standing, and the race is marked so it can't be retried.
- **UI.** `Engine.actionNotes()` (worker `actionNotes`) gives each M14 action its lock reason, odds or freshness, and valid targets; locked cards show the reason and disable the button. The `The field` help entry explains incumbency.
- **Harness** (`test/balance/`):
  - a `vs-incumbent` rung: a 2026 governor or senator of the other party, picked at random among held seats within ±12, skipped if they retire
  - `env=neutral|good|bad` (the player's view: 'good' gives the other party a 39% President in a soft economy and a 7-point generic ballot against it)
  - `strategies=` and `seed=` filters
  - new columns: primary losses with no same-party incumbent in the primary ("open"), and how often party backing succeeded
  - active strategies seek party backing when it's available; balanced runs oppo on an incumbent until it lands, then runs against the record (up to four times)
- **Results** (climber, balanced, `vs-incumbent`, n=40 × 3 seeds): wave 13/30/20%, neutral 5/5/5%, bad 0/0%. The rest of the climber table moves a few points (state house balanced 65 → 70%, state senate 40 → 53%, U.S. House and statewide within ±5).
- **Tests:** `test/m14.test.ts` (8), plus a wave-versus-bad-year guard rail and an open-primary bound in `test/balance.test.ts`. The golden snapshot was updated for this change (noted in its header).
- **Save compatibility:** the new `Campaign` fields (`oppoFound`, `recordRuns`, `backing`) are optional; a campaign saved before M14 keeps playing (tested). No save-version bump.

## M15: Scandals and crisis response (done)
- **Stories** (`scandals.ts`, `GameState.scandals`). Each has a hidden `truth`, a `severity` (Minor / Moderate / Serious / Major), a stage (`story` → `investigation` → `charges`), the response and a short log.
  - The monthly roll is unchanged (main RNG stream, same odds; risky decisions still raise `scandalRisk`). Severity and truth come from the story's own seeded stream, skewed by integrity: severity `0.2–0.85 + (50 − integrity)/400`, truth odds `0.55 − (integrity − 50)/150` (15–85%).
  - Opening hit: +0.1 + 0.25 × severity scandal and −(0.02 + 0.03 × severity) favorability. The big-donor dinner's 4% pay-to-play report is now a full story too (severity 0.15–0.6).
- **The response decision** (`meta.kind: 'scandal'`, due the month the story breaks):
  - **Apologize:** −(0.01 + 0.02 × sev) favorability, scandal halved, −1 party standing, and the story ends, unless it is true and severe. Then it stays open with 0.4× escalation odds.
  - **Deny:** no hit now (scandal ×0.85). A false story is "vindicated" after two months (+0.02 favorability, scandal halved). A true one is exposed with 45% + 30% × sev odds the next month, then 20% a month: +0.15 + 0.2 × sev scandal, −(0.04 + 0.04 × sev) favorability, −3 standing, and severity +0.2.
  - **Attack the press:** +4 party standing, −0.01 favorability, swing blocs down (white college −3, Asian and under-30 −2.1, Hispanic −1.2 points; white non-college +0.9); 1.2× escalation odds.
  - **Lawyer up:** costs 6% of the race's or office's expected spend (at least $3,000, from campaign cash, then savings). Scandal ×0.75, 0.5× escalation odds, half the investigation drain and lower conviction odds, but the story lasts two months longer.
  - **Unanswered** means "no comment" (1× escalation). It is not a missed vote, so there is no effectiveness or approval penalty.
- **Escalation.** Only true stories with severity ≥ 0.55 escalate:
  - A story escalates to an investigation at 30% a month × the response multiplier, and otherwise fades after 3 months.
  - An investigation drains favorability (0.01 × sev), bloc approval (0.005 × sev) and 1 party standing a month, and holds scandal at ≥ 0.15 + 0.2 × sev. From the second month it becomes charges at 15% × multiplier; otherwise it closes after 8 months ("cleared", +0.02 favorability).
- **Charges.** −0.05 favorability and −5 standing, scandal held at ≥ 0.35 + 0.2 × sev, and a decision due the next month:
  - **Resign** (in office): `vacate` fills the seat by its own rules, the player's campaign ends, and the career entry is `resigned`. Out of office, the option is **Plead and step back** (−8 standing, scandal ≥ 0.5).
  - **Fight** (also the default when unanswered): −6 standing, then −2 a month in office. The verdict comes 5 months later, with conviction odds 0.5 + 0.3 × sev (−0.15 with lawyers, 20–85%).
  - A conviction removes the player from office (`removed`) and ends the campaign: scandal ≥ 0.6, −0.1 favorability, −15 standing. An acquittal cuts scandal to 40%, +0.03 favorability, +3 standing.
  - Leaving office keeps pending scandal decisions (they follow the person, not the seat).
- **Opponents** (`openOppoScandal`). A successful oppo opens a story (truth 80%) with a base hit of `0.12 + 0.36 × severity`. The opponent answers by integrity: 65+ apologizes, under 40 denies or attacks the press, and the rest lawyer up. The response scales the hit:
  - apologize 0.65×, deny 0.45×, attack 0.9× (plus a small rally bias), lawyer 0.75× (and a 5% smaller budget)
  - a true denial is exposed 60% of the time the next month (+0.1 + 0.25 × sev)
  - the average hit is about 0.22 (was 0.275)
- **UI.**
  - A **Scandal watch** card (`ScandalWatch.tsx`) sits on the Office tab (including the not-in-office view) and the Campaign tab. It shows each story's severity, stage track, response, verdict date and log, and the response buttons. The Office decision list leaves scandal decisions out.
  - The month summary explains what each story did this month (`scandalWhy`).
  - Career entries show "Resigned in scandal" and "Removed after conviction".
  - There is a HELP entry, and the view never sends `truth`.
- **Saves.** `SAVE_VERSION` 3: the v2 → v3 step fills `scandals: []`. A scandal score already in progress keeps fading as before.
- **Balance** (climber, balanced, `vs-incumbent`, n=40 × seeds 1–3): wave 8/18/15% (M14: 13/30/20), neutral 0/0/5%, bad 0/0/0%, all within the M14 targets. Statewide climber: fundraiser 33%, balanced 33% (pre-M15 on the same seed: 30 and 25; n=40 noise is about ±7). The harness never answers decisions, so its scandals are all "no comment".
- **Golden snapshot** updated (noted in its header).

## M16: Campaign trail depth (done)
- **Interactive debates** (`debates.ts`, `DebateCard.tsx` on the Campaign tab).
  - When a month ends and the next one is the debate month (the month before a vote, races at level 2+), `scheduleDebate` draws three questions from the six issues the race's audience cares most about, weighted by salience². It puts a `meta.kind: 'debate'` decision on the desk, due that month. The plan lives in `Campaign.debate` and records the audience's position, the player's, the leading opponent's, and the player's best "pivot" issue.
  - Each question takes a **policy answer** (0.3 − 0.6 × gap to the audience + (policy − 50)/500), a **pivot** (0.1 − 0.4 × gap on the pivot issue + (charisma − 50)/500) or an **attack** (0.4 × the opponent's gap − 0.1 + (debate − 50)/400, +0.08 with oppo on them, ± its own luck). Attacks cost the opponent 0.008 and the player 0.003 favorability each, and 1 party standing each against a fellow partisan in a primary.
  - Answers can be changed until the debate (`Engine.answerDebate`, worker `answerDebate`). The decision's three options are game plans that fill every unanswered question, so `decide(id, 0)` still works. A policy director shows how each answer is likely to land (strong / fair / risky).
  - `holdDebate` keeps the old score and adds the answers' average quality, with noise 0.2 instead of 0.25. An unanswered question counts −0.05. An unprepared debate uses the old roll with the same main-stream draws. Answers are kept in `Campaign.debates[].answers` and shown on the Debates card. An unanswered debate decision lapses with no penalty, and debate decisions survive leaving office, like scandal decisions.
  - In a test general, a skilled lawyer won 72% of debates unprepared, 85% with aligned policy answers, 83% pivoting and 88% attacking a far-out-of-step incumbent.
- **Poll crosstabs.** With a campaign manager (tier 1+), each internal poll stores `PollPoint.blocs`: each bloc's shares among decided voters, with its own margin of error (1/√(n × bloc weight)), drawn from a separate seeded stream. The Campaign tab shows a Crosstabs card. Margins still shrink with the manager tier (n = 400 + 200 × tier).
- **Adaptive AI** (`trail.ts`).
  - Each month (`adaptMessages`, from `aiCampaign`), every AI candidate in the player's stage presses the issue that maximizes salience × (player's gap − their own gap) against the race's audience (`audience()` in `vote.ts`). The choice is stored in `Campaign.aiEmphasis` and makes the news when it changes.
  - **Deviation from PLAN_2:** a pressed issue feeds the **race-wide** emphasis (`raceCtx` adds `PRESS` = 0.5 salience on top of the national emphasis for every candidate), not `Candidate.emphasis`. In `vote.ts` a candidate's own emphasis only scales *their own* issue distance, so it could only ever hurt the AI. The field card says "hitting you on …", the Polling card lists the issues the race is fought on, and AI attack ads name the issue.
  - **AI nominees pivot** toward the general electorate's ideal once the general starts (`pivotToCenter`, `PIVOT` = 0.05, after the primary, top-two included). PLAN_2 said about 30%, but in this model 0.3 cut balanced climbers' state-house wins from 70% to 45%, so it was turned down. The pivot is permanent: a winner governs from the new positions.
- **Get out the vote** (`gotv`, Organization, 3 AP, 5% of expected spend). It is available only in the vote month, and not in presidential primaries (the action card says why).
  - Each drive adds 0.05 × (1 + 0.4 × field tier) extra turnout to each bloc in proportion to how far it runs ahead of the player's overall share (full at +15 points). That goes in `Campaign.gotv.blocs`, then `RaceCtx.turnoutBoost`, applied in `blocWeights`. It also adds 0.01 × (1 + 0.3 × field) election-day bias. Repeats in the month land at 0.6×.
  - It is worth about 0.7 points per drive with no field director, and about 1.4 with an elite one. Three drives with an elite director reach about 2.7 points (PA governor test race). It counts only for the stage it was bought in.
- **Media polls.** Every other month (even month numbers) in races at level 3+, `mediaPoll` runs a public poll on its own stream: a pollster with a fixed partisan house effect (σ 1.2 points), n = 500–900, and slightly more undecided. It is stored in `Campaign.mediaPolls`, posted as a `Poll: …` news item and drawn as diamonds on the poll chart.
- **Balance** (`npm run balance`, n=40). The harness's grassroots and balanced strategies now run two GOTV drives in the final month. The harness never answers debate decisions, so its debates use the old roll.
  - The full table (seed 1, with the pivot at 0.1) stayed within ±5 points of the pre-M16 run on the same seed in all but four cells: state house climber grassroots −13 and fundraiser −6, state senate climber balanced −10, U.S. House newcomer balanced −10.
  - A second seed showed the drop was consistent only for balanced, mostly from the pivot. At 0.05, balanced cells across seeds 1–2 and the state house, state senate, U.S. House and statewide rungs average −0.9 points against baseline (single cells −10 to +8, within n=40 noise).
  - Local rungs moved at most ±5, and `vs-incumbent` is unchanged (0–3%). The back-test is still 98.1%.
- **Tests:** `test/m16.test.ts` (12). The golden snapshot was updated (noted in its header): all three hashes changed. The later pivot tuning didn't move them, because no scripted run reaches an AI nominee's general.
- **Save compatibility:** the new `Campaign` fields (`debate`, `aiEmphasis`, `gotv`, `pivoted`, `mediaPolls`), `PollPoint.blocs` / `pollster` and the debate-history fields are optional. A campaign saved before M16 keeps playing (tested). No save-version bump.

## M17: Legacy, achievements and a real ending (done)
- **Legacy score** (`legacy.ts`, computed on demand; `view().legacy`). Level weights `LEVEL_WEIGHT` = 1, 2, 4, 6, 10, 16, 30 for levels 1–7. The parts:
  - **Years in office** × weight × 2. The spans are rebuilt from the career log (took office or appointed → left, resigned, removed or retired), so they work for any save.
  - **Elections won:** each general win is 4 × weight, plus 50% for a flip and 50% with an incumbent on the ballot. Primary wins are 1 × weight, doubled from behind in the last poll and 1.5× against an incumbent.
  - **Laws:** 3 + weight each (bills that become law and bills the player signs as an executive), and 4 per successful veto override.
  - **Leadership:** Speaker 8, floor leader 5, whip 3, chair 2, each × the chamber's weight.
  - **Approval in office:** (average − 50%) × 200, phased in over the first 48 months (6+ months needed).
  - **Scandals:** −(3 + 10 × severity) per story, −10 more if it reached an investigation, −20 more for charges, −30 per resignation and −50 per conviction.
  - **Races lost:** −3 for a general, −2 for a primary.
  - **Achievements:** +5 each.

  The total is floored at 0. Ranks: Footnote, Local fixture (25), Statehouse name (75), Power broker (160), National figure (300), Statesman (550), Historic (900).
- **What the engine records** (`GameState.stats`, new in save version 4):
  - Months in office and their summed approval, counted in `legacyMonth` at the end of each `endTurn`.
  - Laws (`noteLaw`, from `enact` in `legislature.ts` and the executive's signature in `office.ts`) and overrides (`noteOverride`).
  - Leadership posts: a new post is noted when it first appears.
  - Race records (`recordPlayerRace`, from every player primary, presidential nomination and general): share, margin, flip, an incumbent on the ballot, underdog (behind in the last internal poll), and electoral votes.
- **Achievements** (`ACHIEVEMENTS`, 15). They are checked at the end of every month and on retirement, stored in `GameState.achievements` once each, and announced with a news item and a toast:
  - first victory, flipped it, giant killer, underdog, landslide (60%+ in a contested general)
  - lawmaker, overruled (a veto override), in leadership, the gavel (Speaker or presiding officer)
  - Capitol Hill, Governor, 270, survivor (an investigation or charges ending in cleared or acquitted)
  - mapmaker (the player's call on a map was enacted and not struck down), decade of service
- **Retirement.** The menu's "Retire from politics…" (with a confirmation) calls `Engine.retire()` (worker `retire`):
  - It drops a live campaign (`withdrew`) and gives up a seat won but not yet taken.
  - It vacates the player's office with `vacate`, so the seat is filled by its usual rules.
  - It adds a `retired` career entry, sets `PlayerState.retired`, checks achievements and sets `gameOver`.
  - Party switching is out of scope.
- **Career-end screen** (`CareerEnd.tsx`) replaces the old game-over modal for any ending. It shows the score and rank, peak office, years in office, the win–loss record, the legacy breakdown, the biggest wins and toughest losses, rivals with the record against them, achievements earned and the timeline.
  - "Export career card" draws a 1200×630 PNG on a canvas.
  - "Look around the map" closes it; the top bar's "Career recap" brings it back. End month is hidden once the game is over.
- **Hall of fame** (`saves.ts`, IndexedDB key `ballot-ladder-hall`, top 50 by score). A finished career is added the first time its ending is seen, keyed by seed and player id so reopening the save doesn't duplicate it. Each entry has name, party, peak office, score, rank, years in office, the year it ended, the achievement count and the seed. The title screen lists the top ten.
- **Career tab:** Legacy (score, rank, progress to the next rank, breakdown) and Achievements (earned and locked) cards, with HELP entries.
- **Saves.** `SAVE_VERSION` 4: the v3 → v4 step fills `achievements: []` and empty `stats`. An upgraded save awards whatever its career already qualifies for at the next End Month.
- **Tests:** `test/m17.test.ts` (8):
  - the score is monotonic for clear cases (wins, years, laws, posts, a higher office, losses, scandals, flip and incumbent bonuses)
  - race records note flips, incumbents and underdogs
  - achievements fire exactly once, including their news
  - months in office and posts are counted
  - retiring ends the game, frees the seat, and reloads with the same score
  - v3 saves migrate
- **Smoke test** now retires the second-slot career, exports the career card (saved as a screenshot), returns to the title screen and finds the career in the hall of fame.
- **Golden snapshot** updated (noted in its header): achievement news items take ids from the shared counter, so later ids shift. The scripted career's results are unchanged. No balance change: nothing here touches votes or campaigns.

## M18: Congress and legislature realism (done)
- **Cross-pressure** (`crossPressure` and `support()` in `legislature.ts`).
  - Each member's seat lean (D share) is compared with the median seat their party holds in the chamber. Leans are cached per `OfficeDef` in a `WeakMap`, so redistricting refreshes them.
  - `support()` adds `(partyMedian − seatLean) × CROSS_K × partisanship(issue) × dir`. Partisanship is half the gap between the party bases on that issue; `CROSS_K` = 3.5.
  - So a Democrat in a redder-than-usual seat leans right, a Republican in a bluer-than-usual seat leans left, and members in the safest seats lean further in. Councils and at-large boards have no spread, so nothing changes there.
  - Measured over all bill templates (two seeds; the U.S. House and the PA and TX state houses): the quarter of members whose seats tilt most toward the other party break ranks about 2.5% of the time, and the safest quarter almost never (0–0.1%).
  - At `CROSS_K` 1.5 the swing quarter barely moved, because the party gap on most issues is about 0.6 and seat-lean spreads are small, so it was raised.
- **One vote rule for every path.** `passThreshold(e, key, bill, total, opts)` sets the votes needed for player bills (`countVotes`), AI bills (`aiChamberVote`, used by `chamberSupport` and `billFate`) and national laws. Overrides need two-thirds; committees, the House and state legislatures need a majority.
- **Senate filibuster.** On the U.S. Senate floor a bill needs `ceil(0.6 × voting members)` (60 of 100) to end debate.
  - A majority short of that is "filibustered": the bill log, news and decision outcome say so, and the WhipBar shows "need 60 to end a filibuster".
  - Senators' AI-bill decisions say what the bill needs.
- **Reconciliation** (`GameState.reconciliation?`, once a calendar year). A tax or spending bill can pass the Senate by simple majority.
  - AI bills use it automatically when they have a majority but not 60, the sponsor's party holds the Senate, and this year's reconciliation is unused.
  - Player bills use the new `billAction` `'reconcile'` (1 AP) while a Senate vote is still ahead and the player's party holds the Senate. Leaders (Speaker, Majority Leader) and the Finance chair pay nothing; other members pay 6 favors.
  - The year's reconciliation is used up when a bill is designated.
- **Nuclear option** (`GameState.filibuster?`).
  - A player who is U.S. Senate Majority Leader gets a `meta.kind: 'nuclear'` decision when a majority-backed bill is filibustered (their own bill, or an AI bill they voted for). It comes at most once every six years.
  - "Go nuclear" abolishes the filibuster for good: party standing −10, swing blocs −1.5 to −2 points, and a news item.
  - "Keep the filibuster" costs 1 party standing. An unanswered decision lapses with no penalty.
- **Bipartisan cosponsors** (`billAction` `'cosponsor'`: 1 AP, plus 3 favors on success).
  - The player asks the two other-party members of the chamber who vote no but are closest to yes (support between −0.3 and 0). Odds are 0.45 + 1.5 × support + (charisma − 50)/250, plus 0.1 with a leadership post.
  - A cosponsor votes yes. Other-party members with support between −0.3 and 0 get +0.06 (`COSPONSOR_PULL`) in every vote on the bill.
  - One cosponsor per bill, recruited before the floor vote, in partisan chambers only.
- **National lawmaking** (`background.ts`) now holds real votes.
  - A trifecta's party bill goes to `aiChamberVote` in the House and then the Senate, with cross-pressure and the filibuster.
  - Without 60 senators (and with the filibuster in place), the trifecta can only draw a tax or spending bill, through reconciliation, and only if this year's reconciliation is unused.
  - Bills that fail post a "dies in the House" or "dies to a Senate filibuster" news item. Divided-government bipartisan deals are unchanged.
- **UI.**
  - The chamber card and the executive's legislature card show the filibuster and this year's reconciliation for members of Congress and the President.
  - Bills show their cosponsor and reconciliation status, with "Find a cosponsor" and "Use reconciliation" buttons.
  - New HELP entries: Filibuster, Reconciliation, Cosponsor.
- **Saves.** `Bill.cosponsor`, `Bill.reconcile`, `GameState.filibuster` and `GameState.reconciliation` are optional; undefined means the usual rules. No save-version bump (tested).
- **Tests:** `test/m18.test.ts` (8). PLAN_2 suggested extending `test/governing.test.ts`; the milestone got its own file, like M14–M17.
- **Golden snapshot** updated (noted in its header): all three hashes changed, and the scripted career's results are the same. The state representative's run now wins its 2026 primary and loses the general 49.3–50.7. Before, it lost the primary and, because of the bug listed under Known gaps, kept the seat.
- **Balance** (`npm run balance`, n=40, seed 1, compared with the same run at M17).
  - 53 of 56 cells are identical. Three move by one race: mayor newcomer fundraiser +3, mayor climber grassroots −2, statewide newcomer fundraiser −2.
  - Campaigns don't use chamber votes, so only the economy (national laws) moves outcomes. `vs-incumbent` is unchanged, and the back-test is unaffected.
  - The full run still needs `NODE_OPTIONS=--max-old-space-size=12288` (see M12).

## M19: Ballot measures (done)
- **Data** (`measures.ts`). `INITIATIVE_STATES` lists the 23 states where citizens can put measures on the ballot, with each one's ballot word: Proposition, Question, Issue, Amendment and so on. Mississippi is left out because its process was struck down in 2021.
  - `STATE_MEASURES` (21) and `LOCAL_MEASURES` (11) are templates built on the bill templates in `governing.ts`. Each takes its issue, direction, metric effects and interest groups from the bill, and adds a ballot title, a frequency and the policy's own popularity. For example, the minimum wage gets +0.45 logit, Medicaid +0.4, vouchers −0.25.
- **Generation** (end of June, even years; `generateMeasures` from `Engine.endTurn`).
  - Each initiative state draws 0–2 measures (30/45/25%). The eleven states that use initiatives most (CA, CO, OR, WA, AZ, OH, MI, FL, MA, MO, NV) always get at least one.
  - Draws are weighted by frequency × (0.25 + the issue's national salience) × fit with the state's lean. Progressive measures are likelier in bluer states and conservative ones in redder states.
  - Towns of 50k+ in the player's home state get a local measure 20% of the time (the home town 50%), at most eight a cycle, labeled "Measure A".
  - A template used in a state or town in the last two cycles isn't drawn again. Saves keep the current cycle and the two before it.
  - Every state and town draws from its own seeded stream (`seed|measures|<place>|<year>`), so the main RNG is untouched. This is tested.
- **The vote** (November, right after the background elections; `resolveMeasures`). `unitShares` runs with two pseudo-candidates, Yes and No.
  - They sit at ±0.8 on the measure's issue and are identical everywhere else, with independent party and equal valence, so party and the other issues cancel. Both get emphasis 6 on the issue, so it dominates.
  - The race is nonpartisan, with no national environment.
  - Yes gets the template's popularity plus campaigning (`push`), minus a 0.08 status-quo lean toward No. Each measure has its own election-day swing (σ 0.15 logit).
  - Statewide measures count over the state's counties with general-election turnout; local measures count the town alone.
  - Tuning (ARM 0.8, FOCUS 6) puts Medicaid expansion at 56% in Missouri and 50% in Oklahoma, and abortion-rights amendments at 55–61% in Michigan, Ohio, Missouri and Montana, close to the real results. Across states the yes share spreads about ±11 points from 50%, and the progressive side's share correlates 0.66 with state lean.
- **Effects of a passed measure.**
  - Statewide: `lawEcon` weighted by the state's population share × 1.5 (the same weight as a state law), and +0.015 salience on its issue.
  - If the player is the area's executive (the governor for a statewide measure, the mayor for a town's), it joins their laws in force (`enactPolicy`, so it moves metric targets).
  - A measure the player referred counts as one of their laws for the legacy score (`noteLaw`).
- **Campaign on a ballot measure** (`measure`, Outreach, 2 AP, 2% of expected spend; target `<id>|1` for yes or `<id>|-1` for no). Available for statewide measures in the home state, and for local measures in the home town or in a town inside the office or race the player holds or is running for. The action card says why it's locked otherwise.
  - Each use moves yes utility by side × (0.025 + 0.08 × the player's recognition there) × (1 + 0.15 × comms tier) × (0.7 + charisma/170). Repeats on the same measure in a month land at 0.6×, and the push is capped at ±0.4.
  - It also raises recognition in the area, moves standing with the template's groups by ±3, and changes party standing: +1 on the party's side, −2 against it. It shifts the player's position on the issue (0.025 toward their side).
  - Switching sides costs 1.5 points of favorability and makes the news.
  - When the measure is decided, being on the winning side is worth +0.5 favorability, and +1 standing if that side was the party's.
- **Referrals** (`offerReferral`, `meta.kind: 'measure'`). At the start of May in even years, a governor or state legislator gets a decision, due at the end of June, with up to two measures that move their party's way, or "Not this year".
  - Referring one goes to `aiChamberVote` in both chambers (the player votes yes in their own). If it passes, the measure goes on the ballot as `referred`, with the player as sponsor: a 0.05 head-start push, +2 party standing, the template's groups and a small position shift. If it fails, it makes the news.
  - States without an initiative process label referrals "Question N". An unanswered referral lapses with no penalty, and the decision is dropped if the player leaves office.
- **News** (`kind: 'measure'`, with a Measures filter on the News tab).
  - June: one national item ("N statewide ballot measures qualify in M states"), an item for each statewide and home-town measure in the player's state, and one line covering other local measures.
  - November: the national tally with the closest races, plus the same breakdown for the player's state. An item is tinted good or bad when the player picked a side.
- **UI.**
  - A **Ballot measures** card on the Office tab, also shown when not in office: this cycle's measures in the player's state, statewide first, then the home town's. It shows each one's origin, issue, the groups it pleases or angers, projected support (or the result) and the player's side.
  - The **state inspector** lists statewide measures by cycle, and the **town inspector** lists the town's local measures (worker `stateMeasures`).
  - **Election night** shows the player's state's measures as a side card once the count finishes.
  - There is a HELP entry.
- **Saves.** `GameState.measures` is optional (no save-version bump). A save without it loads and plays through a June and a November (tested), and a save with it round-trips.
- **Tests:** `test/m19.test.ts` (7):
  - generation is deterministic, uses only initiative states and big home-state towns, and leaves the main RNG alone
  - the three-cycle window and no repeats
  - results follow state lean (correlation above 0.4 over six seeds; progressive measures pass more often in blue states and conservative ones in red states)
  - a passed measure moves the economy and becomes the governor's law, and a measure isn't decided twice
  - campaigning (reach, push, cap, fatigue, flip-flops)
  - a legislator's referral, and a lapsed one
  - saves without measures
- **Smoke test** now plays from February to July 2026 on the second slot and finds the measures in the news. A separate run from Fresno, CA checked the card, the action, the inspector and the November results by eye.
- **Golden snapshot** updated (noted in its header). All three hashes changed because measure news items take ids from the shared counter and the officeholder scripts answer May referrals. The career run's results and politician count are the same.
- **Balance.** `npm run balance` (climber, n=40, seed 1, the state house and statewide rungs) is identical, cell for cell, to the same run at M18. The 2026 races are decided the same night as the measures, so measures can only affect later races (through the economy and salience). Nothing here touches the vote model for candidates, and the back-test is unchanged (98.1%).
- **Deviations from PLAN_2:**
  - Local measures exist only in the player's home state, since other states' towns aren't loaded.
  - The heavy-initiative states always get at least one measure.
  - The yes and no sides carry a strong issue emphasis (and a per-template popularity), because pure ±dir candidates gave results within a few points of 50% everywhere.

## M20: Rivals 2.0 and officeholder endorsements (done)
- **Announcements** (`announceRuns` in `careers.ts`, called at the end of `monthlyRivals`, which is now async).
  - From January to May (6–10 months before November), each active rival with ambition 0.6+ announces with monthly odds 0.2 + 0.3 × ambition (`ANNOUNCE`), from their own seeded stream (`seed|announce|<id>|<year>|<month>`), so the main RNG is untouched. Rivals aged 70+, rivals who took office this January, and rivals already in the player's race don't announce.
  - `bestTarget` scores the materialized offices up that November that are a step up (one to three rungs, the bench's rules), overlap the rival's turf (`cover()`) and suit their age. The kinds (`PlanKind`):
    - `open`: the holder won't run (predicted with the same seeded `willRunAgain` draw `backgroundElections` uses) or the seat is vacant, if the seat is at least 35% their party's
    - `challenge`: the other party's incumbent in a seat within 10 points of even, level 3+
    - `primary`: their own party's incumbent in a safe seat (58%+) who is vulnerable (scandal over 0.15, four or more terms, 72 or older, or more than 0.35 from the party base)
    - `you`: the player's seat (the other party's rival if the seat is at least 40% theirs; the player's own party only when the player is under a primary threat, below) or the race the player is running, while it can still be joined. Against their own party's incumbent in the player's race, only a vulnerable one (kind `primary`).
  - Score: 0.1 × level + a drive bonus (open 0.25; the player 0.15, or 0.4 for a nemesis or comeback rival; challenge 0.05) + (party share − 0.5) × 0.6 − 0.03 per rung + noise. Someone whose own seat is up only gives it up for an open seat or the player. At most one rival per party announces for a race.
  - The plan is stored in `RivalInfo.plan` (`{officeId, year, kind, month}`), posted as a `rival` news item, and cleared after November.
- **Announced rivals run.**
  - In the player's race: `announcedFor` is checked first in `startCampaign` and always files (instead of `rivalFor`'s 70% coin). A rival who announces after the player filed joins the race under way (`joinCampaign`) while it can still be joined: before the primary month, or before the last month of a nonpartisan race. `rivalFor` skips rivals who announced a different race that year.
  - In background races: `draftCandidates` files announced rivals first: for the open seat (their party's slot), a free shot at the other party's incumbent, or a primary challenge (`Draft.primary`). They give up their own seat if it is on the same ballot. The bench draft and the free-shot pass don't overwrite them.
- **Primary challenges.**
  - **The player.** When the player runs for re-election (`startCampaign` with the player as holder, partisan or top-two, not President), `primaryThreat` checks party standing below 35 and ideology more than 0.35 from the party base (`THREAT`). A threatened player draws a same-party rival who fits, or else an insurgent from the party base (`insurgent`: positions pulled toward the base, quality 0.9–1.25, recognition 15–30%, a 1.1–1.5× budget, and 2 endorsements when standing is low). `Campaign.challenge` stores who and why; the field card and the news say so. An announced same-party rival counts as the challenge too.
  - **AI incumbents** (`primaryChallenges`, between the drafts and the vote in `backgroundElections`). An incumbent running in a seat at least 58% their party's draws an insurgent with odds 3%, or 15% when vulnerable (`CHALLENGE`), on a separate stream (`seed|pchal|<office>|<year>`); an announced rival always challenges. The primary is a two-way `unitShares` vote in the party's electorate with incumbency, 0.06 noise and a smaller budget for an unknown insurgent. A loser gets a `lost-primary` career entry. If the incumbent loses, the challenger is the party's nominee and the incumbent leaves in January. About 100–140 incumbents are challenged in a midterm and 5–7% of them lose (three test states). News: one national tally, plus items for rivals, Congress and statewide seats, and the player's state (level 3+).
- **Officeholder endorsements** (`endorsements.ts`; action `officeholder`, "Seek an officeholder's endorsement", Organization, 2 AP, needs a campaign; target kind `endorser`).
  - Targets: sitting officeholders of the player's party whose turf overlaps the race (`cover()`; statewide officials in their state; for statewide races, level 3+ only; the President and VP only for level 5+ races; for a presidential race, level 5+ only). They must be between two levels below and three above the race. Judges, rivals, anyone in the race, and anyone already asked this race are left out. The list shows the eight highest offices first, with their odds (`actionNotes().officeholder.options`).
  - Odds: 0.35 + (standing − 50)/150 + min(0.15, 0.03 × favors) + 0.2 × the player's recognition in the race − 0.4 × the ideology gap − 0.025 per level the endorser sits above the race + (charisma − 50)/400 − 0.08 in a contested primary + 0.1 for a sitting incumbent, clamped to 5–85% (`ENDORSE`). A newcomer at the starting standing of 40 sees about 10–30%.
  - A yes adds `endorserWeight` (level 1–2: 0.5, 3–4: 1, 5–6: 1.5, 7: 2) to the player's `c.endorse` (worth 0.06 logit each in the vote, capped at 8) and costs one favor if the player has one. Either way the officeholder is added to `Campaign.asked`. Endorsers are listed on the field card (`Campaign.endorsers`).
  - Renamed the group action to "Seek a group's endorsement" so the two cards don't read alike.
- **Fix: a player who loses renomination now leaves office** (the M18 known gap). `backgroundElections` puts the player's seat on the November ballot after a lost primary, with the primary winner as that party's nominee. The player leaves in January. Before, the seat was skipped and the player stayed past their term.
- **UI.**
  - The Rivals card shows "Running for X in 2026 · open seat / against … / primary challenge to … / against you", the month they announced, and "Show the race" next to "Show on map".
  - The campaign's field card shows a primary challenger and why they're running, and who has endorsed the player.
  - The endorsement card has a target picker.
  - The "The field" and "Rivals" HELP entries explain primary challenges, endorsements and announcements.
- **Saves.** `RivalInfo.plan` and `Campaign.challenge`, `asked` and `endorsers` are optional, with no save-version bump. A save without them plays on (tested). `restore()` now warms `cover()` for the campaign's state, so endorsement targets are complete right after a load.
- **Tests:** `test/m20.test.ts` (9):
  - announcements happen January to May, leave the main RNG alone, at most one per party per race, show on the Rivals card, are honored in November and are cleared after it
  - an announced rival always files in the player's race and isn't pulled into another one
  - a rival who announces after the player filed joins the race under way
  - a player with low standing or far from the base draws a challenger, and a loyal one doesn't
  - a player who loses renomination leaves office, and the primary winner is the nominee
  - AI incumbents are challenged more often when vulnerable, and an announced challenge always happens
  - endorsement targets (party, never rivals, not in the race, once each), odds bounded and rising with standing and favors, and the effect of a yes
  - pre-M20 saves
- `test/migrate.test.ts`: the v1 fixture player loses their 2026 primary, which before M20 left them in office. The test now checks governing in December and that they leave in January.
- **Smoke test** checks the endorsement card's target list after filing and logs the rival announcements in the news by July 2026 (seed-dependent, 2–5 per run).
- **Golden snapshot** updated (noted in its header). All three hashes changed. The career run's results are the same. The state representative now loses the 2026 primary by one vote (it won by one before) and leaves office. The governor lost the 2026 primary before and after, but now actually leaves office.
- **Balance** (`npm run balance`, climber, n=40, seed 1, against the same run at M19):
  - Wins: state house 3/60/33/68% (passive/fundraiser/grassroots/balanced; M19 3/60/33/65), state senate 0/30/8/57 (0/28/5/55), U.S. House 0/13/3/25 (0/18/3/28), statewide 0/25/3/28 (0/30/3/33).
  - `vs-incumbent`: 0% in a neutral year, as before. Wave year, balanced: 3%, as at M19 on this seed.
  - Open-primary losses rose statewide (fundraiser 12 → 28%, balanced 12 → 20%, grassroots 44 → 60%). With announcements off the statewide rung matches M19 exactly. So this comes from rival stars (often U.S. Representatives) announcing for the open governor or Senate seat the player is running for, and now always filing. Balanced stays inside PLAN_2's 20–35% band for open primaries. Capping announcements at one rival per party per race didn't change the table.
  - The back-test is unchanged (98.1%).
- **Deviations from PLAN_2:**
  - Background primaries are decided on general election night with a quick two-way vote, not in the spring.
  - Rivals also announce primary challenges to vulnerable AI incumbents of their own party, and other-party rivals can announce against the player's seat.
  - The player's primary threat adds a challenger on top of the field the seat already draws (see Known gaps).

## M21: Data and map refresh (done)
- **2026 results: not added.** No machine-readable source was in hand (538's results repo stopped updating when 538 closed, and MEDSL usually publishes months after certification); M21 didn't search for a new one. The path is unchanged (`pipeline/README.md`). `npm run data:validate` now checks that `meta.json` lists the cycles in `results/latest.json`, and once `pipeline/raw/results_2026.csv` exists, that those cycles include 2026 and at least 400 House districts have a 2026 result.
- **Hawaii and DC home towns** (`pipeline/places.ts`, shared by `pipeline/build.ts`).
  - `townKind` decides which Gazetteer rows become towns: functioning governments as before, plus Hawaii's 163 census-designated places (flagged `'cdp'` as a 12th element of the town row, `Town.cdp`), plus the Census place "Washington city", named "District of Columbia". DC's town sits in county 11001 and in no district.
  - `npm run data:places -- HI DC` rebuilds just those place files. A full `data:build` would wipe `public/data` and re-download seat control (congress-legislators, Open States), which would change the committed world. The targeted rebuild reads `counties.json` and the lean model in `meta.json`, and anchors each town's lean to its county: logit(lean) = logit(county lean) + (features(town) − features(county)) · β. That equals the full build's formula, since the state fixed effect and the county residual cancel (β is rounded to three decimals in `meta.json`). Populations come from the 2024 estimates where they exist (DC) and ACS otherwise (CDPs).
  - Result: Hawaii's 163 towns run from Urban Honolulu (345k) down. Every one has a congressional, state senate and state house district. Their population-weighted lean is 66.1% D against the state's 65.1%. DC is one town of 702k at 94.7% D.
  - `npm run data:redistrict -- HI` filled in each town's district in Hawaii's 2030 plans. The plans themselves came out byte-identical apart from the town lists, and `apportion.json` is unchanged. `npm run data:towns` rebuilt `geo/towns.pmtiles` (35,779 towns, all with a boundary, 20.2 MB).
  - Validate checks: Hawaii has 100+ towns, all CDPs with districts, CDPs appear nowhere else, and DC is one town outside any district. The town count is 35,779 (the old floor of 30,000 still holds).
- **Offices** (`offices.ts`).
  - Hawaii: CDP towns get a "Neighborhood Board" (council) and "Neighborhood Board Chair" (the town executive), modeled on Honolulu's elected neighborhood boards. County seats are "County Council". Every Hawaii county of 10k+ has an elected "Mayor" (`cexec`, level 3), so Hawaii, Maui and Kauai counties gain one alongside Honolulu (Kalawao, run by the state, doesn't).
  - DC: "Council of the District of Columbia" (13 seats by population, like the real council), "Mayor of the District of Columbia" and the "DC State Board of Education". DC joins `NO_COUNTY_GOV`, so a DC town has no county commission. It still has no state or congressional offices, so a DC career goes from council or mayor to the presidency. DC votes in even Novembers: the mayor in midterm years (2026, 2030), council and board seats staggered (even seats 2026, odd seats 2028). The offices stay nonpartisan like every other town's (see Known gaps).
- **Character creation.** The state list includes DC and HI. Town results say "census-designated place" or "federal district", and the home card explains what's unusual about each. The state picker is now labeled "Home state" for screen readers (and the smoke test).
- **Holder map mode.** Areas with no simulated officeholder are shaded by lean at half opacity, with a diagonal hatch (a `fill-pattern` layer per map layer, switched on per feature through feature state `hatch`). The legend and tooltip say so. Hatching is hidden during election night and follows the dark theme.
- **Town inspector boundary.** Selecting a town outlines its PMTiles boundary in the accent colour, with a light fill, through feature state `sel` on the town tiles. It shows in dots mode too (the tiles start at zoom 6), survives colour-mode changes (which reset the town tiles' feature state), and hides on election night.
- **Decision desk realism** (`night.ts`).
  - The desk's estimate of each margin carries a seeded error (σ 5 points, `DESK.noise`) for every unit, state and race, drawn from its own stream (`desk|…`), so the reporting timeline is unchanged and similar contests are called at different times.
  - Premature calls: a unit whose early count leader (20%+ in, a 2+ point lead) goes on to lose it, with the lead flipping before the count ends, can draw a premature call (60% chance). At most 1.5% of a night's units can get one, so nights under 67 units never do. The call is retracted when the lead flips, and the right call follows at least one batch later. States reported as a single unit are never called wrong, and state and race calls are always right.
  - Leads that later flip are thin (the early-vote skew fades as the count goes on), so the bar is low: the desk is trusting its own estimate of the area over the count. On a presidential night about 0.3% of counties see a retraction (41 of 12,576 over four test nights).
  - `UnitFrame.callFor` (who the call is for) and `retracted` are new. The map, the unit grid, key cards and tooltips colour calls by `callFor`. The call feed reports every retraction ("Call retracted: X is too close to call after all"), notable unit or not.
  - `test/night.test.ts`: the invariants now allow exactly one revert per retracted unit; every call is for the unit's real winner outside its premature window; states are never called wrong. Two new tests: retractions are rare (under 2%, more than zero over four national nights, none on a small night), each call goes premature → retracted → right; and the noisy estimate moves call times both earlier and later on the same timeline.
- **Tests:** `test/m21.test.ts` (6):
  - Hawaii: towns are CDPs inside real districts, with the right titles and offices
  - a Hilo career plays through its first election
  - every Hawaii town has a district in each 2030 plan
  - DC: one town and its offices, the even-year schedule, a DC career through its 2026 council race, and a reload
- **Smoke test:** switches the county map to holder colouring (`8b-holder-hatch`), selects a town after "Show on map" on desktop (`11b-town-selected`), and picks Hilo and DC as home towns in a new career (`14-hilo`, `15-dc`). There are no console errors at either width.
- **Golden snapshot** updated (noted in its header). Only the career run's hash changed: one fewer background politician kept, and the career results are the same. Before M21, Hawaii had no towns, so its districts and counties overlapped nothing, and AI careers there couldn't draw on the bench. With its towns in, they can. Setting `places/HI.json` back to empty restores the old hash. The officeholder runs are identical.
- **Not run:** `npm run balance`. Nothing here touches the vote model, campaigns or AI candidates outside Hawaii and DC, and the back-test is unchanged (98.1%).
- **Deviations from PLAN_2:**
  - The places are rebuilt with a targeted script, not a full `data:build` (see above). `build.ts` follows the same rules for the next full build.
  - DC's offices stay nonpartisan, and Hawaii's CDPs get neighborhood boards rather than city councils.
  - Hawaii's counties gain elected mayors.
  - Retractions are capped by a share of units and need a visible lead flip, so local races (a few precincts) never see one.

## Verification to keep running
- `npm run lint && npm test`: keep the 2016→2020 back-test at 95% or higher. Keep the engine determinism and golden replay tests passing (update the golden snapshot only for intended gameplay changes, in its own commit).
- `npm run build && npx vite preview --port 4173`, then `npm run smoke -- ./smoke-out`. Review the screenshots, and expect zero console errors. A failed step saves `<tag>-failed.png`.
