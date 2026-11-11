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

# Status (as of 2026-11-10)

Phases 0–5 are built and working. Run `npm test` (7 tests) for the sim and `npm run smoke` for a headless browser playthrough. Both pass, and the smoke run logs no console errors at desktop or mobile widths.

## Where things live
| Area | Files |
|---|---|
| Data pipeline | `pipeline/sources.ts` (downloads), `pipeline/lib.ts` (CSV/ACS/shapefile readers, point-in-polygon index, weighted least squares), `pipeline/build.ts` (everything else) |
| Game data (committed, 11 MB) | `public/data/{states,counties,districts,meta}.json`, `geo/*.json` TopoJSON, `geo/sldu|sldl/<ST>.json`, `places/<ST>.json` |
| Sim engine | `src/sim/game.ts` (Engine class), `vote.ts`, `offices.ts`, `issues.ts`, `world.ts`, `campaign.ts`, `governing.ts`, `model.ts` (types), `names.ts`, `rng.ts` |
| Worker API | `src/workers/sim.worker.ts` (Comlink) |
| UI | `src/App.tsx`, `src/store/game.ts` (Zustand, autosave), `src/ui/map/*`, `src/ui/panels/Inspector.tsx`, `src/ui/hq/*`, `src/ui/creation/Creation.tsx`, `src/ui/election/ElectionNight.tsx`, `src/ui/kit.tsx` |
| Tests | `test/sim.test.ts`, `test/setup.ts` (stubs `fetch` to read `public/data`), `test/smoke.mjs` (playwright-core driving the installed Chrome) |

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
- **Gameplay balance is barely tuned.** A player who campaigns actively each month wins a council seat with about 64%; a passive player loses badly. Money, recognition and AP costs need a pass at every office level.
- **Presidential primaries** are one nationwide contest modeled as a single primary month (March). The plan calls for a January–June state-by-state calendar with delegates.
- **Chamber votes** count only materialized members. Council and county bodies are fully materialized once the player joins them.
- **Background races** keep losers only if they held office (to keep saves small, about 4 MB).
- **Officeholder names** are random combinations of common names, so they could coincide with real people.
- **The map's "holder" color mode** shows nothing for counties that aren't materialized yet.
- **Election night** shows a precinct tile grid. It does not animate results on the main map.
- **Hawaii and DC have no playable home towns.** Hawaii has no incorporated places or active MCDs (Honolulu is a census-designated place), and DC isn't a town. Their `places/*.json` files are empty. Adding CDPs for HI would fix it.
- **Hosting moved to GitHub Pages** (`.github/workflows/pages.yml`, https://joedementri.github.io/ballot-ladder/). `.gitlab-ci.yml` is kept for a possible GitLab mirror.

# Next milestones (suggested order)

## M6: Ship it (done)
Deployed to GitHub Pages from https://github.com/joedementri/ballot-ladder. Added `pipeline/validate.ts` (`npm run data:validate`, checks committed data only), empty place files for HI/DC, and a DC results fix in the pipeline.

1. Make the first commit and add the GitLab remote (ask the user for the URL). Push and confirm the Pages pipeline publishes and that data loads under the project base path.
2. Optionally commit `public/data` with Git LFS if repo size becomes a concern. At 11 MB, plain git is fine.

## M7: Balance and feel
1. Write a headless balance harness (Vitest) that simulates 100 careers per office level with scripted strategies (passive, fundraiser, grassroots, balanced). Tune these until outcomes feel right:
   - action effects (`Engine.act` in `game.ts`)
   - AI budgets and recognition growth (`aiCampaign`)
   - `expectedSpend` per office (`offices.ts`)
   - the valence weights in `vote.ts`
2. Add difficulty settings (starting cash, AI quality, how strong the noise is).
3. Add onboarding: a first-month tutorial checklist and hover help on every stat.
4. Add recent-actions history and a "month summary" modal after End Month: what changed and why (polls, money, recognition).

## M8: Election night on the map
1. During election night, color the main map's counties (statewide races) or towns (district races) as results report. For presidential races, also show a state electoral map.
2. Add race-call logic per unit, plus "key counties" callouts.

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
- `npm run build && npx vite preview --port 4173`, then `npm run smoke -- ./smoke-out`. Review the screenshots, and expect zero console errors.
