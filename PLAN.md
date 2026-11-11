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

# Status (as of 2026-11-11)

Phases 0–5 and milestones M7 and M8 are built and working. M6 is committed locally; the push to GitHub is pending. Run `npm test` (19 tests: sim, election-night playback and balance guard rails), `npm run balance` for the full balance table, and `npm run smoke` for a headless browser playthrough. Both pass, and the smoke run logs no console errors at desktop or mobile widths.

## Where things live
| Area | Files |
|---|---|
| Data pipeline | `pipeline/sources.ts` (downloads), `pipeline/lib.ts` (CSV/ACS/shapefile readers, point-in-polygon index, weighted least squares), `pipeline/build.ts` (everything else) |
| Game data (committed, 11 MB) | `public/data/{states,counties,districts,meta}.json`, `geo/*.json` TopoJSON, `geo/sldu|sldl/<ST>.json`, `places/<ST>.json` |
| Sim engine | `src/sim/game.ts` (Engine class), `vote.ts`, `offices.ts`, `issues.ts`, `world.ts`, `campaign.ts`, `governing.ts`, `night.ts` (election-night playback and calls), `model.ts` (types), `names.ts`, `rng.ts` |
| Worker API | `src/workers/sim.worker.ts` (Comlink) |
| UI | `src/App.tsx`, `src/store/game.ts` (Zustand, autosave), `src/ui/map/*`, `src/ui/panels/Inspector.tsx`, `src/ui/hq/*`, `src/ui/creation/Creation.tsx`, `src/ui/election/ElectionNight.tsx` + `nightStore.ts`, `src/ui/kit.tsx` |
| Tests | `test/sim.test.ts`, `test/night.test.ts` (playback invariants, calls, key units, precinct anchoring), `test/balance.test.ts` (balance guard rails, month summary, old-save loading), `test/balance/harness.ts` + `report.ts` (`npm run balance`), `test/setup.ts` (stubs `fetch` to read `public/data`), `test/smoke.mjs` (playwright-core driving the installed Chrome) |

## Deviations from the original plan
- **Data sources:**
  - The MEDSL county presidential and House files on Dataverse require a guestbook form. County presidential results come from tonmcg's GitHub dataset (MIT license, 2008–2024) instead.
  - The House results history isn't included yet. The pipeline README explains how to add the file manually.
  - Governor result history isn't included.
  - The Census ACS API now requires a key, so the pipeline uses the ACS table-based summary `.dat` files instead.
- **Geometry** is TopoJSON simplified with mapshaper and loaded as GeoJSON sources, not PMTiles.
- **District lean and demographics** are aggregated from census tract centroids (about 83,600 tracts) using point-in-polygon.
- **Game start is January 2025.** Public data ends at the 2024 elections. Seat control comes from congress-legislators, Open States (97.5% of state legislative districts matched by name) and a hand-entered `GOVERNORS` table.
- **The project moved out of Box Drive** because Box kept locking files. Don't put this project back in Box.

## Known gaps and quirks
- **Beating a sitting governor or U.S. senator is close to impossible** (0 of 26 harness races, even for a climber). Statewide wins come from open seats. Consider stronger challenger mechanics (incumbent scandals, bad-year waves, retirements) in M9/M11.
- **Primaries are the main hurdle above local office:** 30–50% of climbers running active campaigns lose the primary. The harness player is a moderate (70% of the party line); more partisan players do better in primaries and worse in generals.
- **Unspent cash doesn't count at the polls.** This is intentional; the month summary warns about it in the last three months before an election.
- **Presidential primaries** are one nationwide contest modeled as a single primary month (March). The plan calls for a January–June state-by-state calendar with delegates.
- **Chamber votes** count only materialized members. Council and county bodies are fully materialized once the player joins them.
- **Background races** keep losers only if they held office (to keep saves small, about 4 MB).
- **Officeholder names** are random combinations of common names, so they could coincide with real people.
- **The map's "holder" color mode** shows nothing for counties that aren't materialized yet.
- **Election night precincts are synthetic.** District and county races report by synthetic precincts anchored to the district's largest towns (one dot per town). Unincorporated areas don't get their own dots, and ward races in a single town show one dot.
- **The decision desk knows the final result,** so it never makes a wrong call; it waits until a call would look justified from the counted vote. There are no projected-winner "upsets" on the night itself.
- **Hawaii and DC have no playable home towns.** Hawaii has no incorporated places or active MCDs (Honolulu is a census-designated place), and DC isn't a town. Their `places/*.json` files are empty. Adding CDPs for HI would fix it.
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

## M9: Deeper governing
1. Add a legislative session flow: bill introduction by the player (pick an issue and direction), committee, floor vote whipping (spend party standing or favors), and a veto override.
2. Let executive budgets drive metrics over time. Have state and federal policy affect the economy model in `world.ts`.
3. Add leadership roles: caucus leader, Speaker and committee chairs, based on seniority and party standing.
4. Add appointments and vacancies (special elections, and appointment to a vacated seat).

## M10: More offices and realism
1. Add more offices: sheriff, county executive, school board, district attorney, state row offices (attorney general, secretary of state, treasurer), lieutenant governor, and judges where elected.
2. Replace the single presidential primary with a state-by-state primary calendar and delegates. Add a VP pick.
3. Add House result history. Read `pipeline/raw/house.tab` if present and show it in the CD inspector.
4. Add governor result history from a public source.
5. Add the real 2026 midterm results once MEDSL or other sources publish them, and optionally a "start in 2027" scenario.

## M11: Living world
1. Make AI rivals ambitious politicians who also climb the ladder, with persistent careers and news coverage.
2. Add redistricting after the 2030 census (the plan's stretch goal).
3. Add town polygons via PMTiles (the plan's later phase), and a toggle between dots and shapes.

## Verification to keep running
- `npm test`: keep the 2016→2020 back-test at 95% or higher. Keep the engine determinism test passing.
- `npm run build && npx vite preview --port 4173`, then `npm run smoke -- ./smoke-out`. Review the screenshots, and expect zero console errors. A failed step saves `<tag>-failed.png`.
