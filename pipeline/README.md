# Data pipeline

`npm run data:build` downloads the sources below into `pipeline/raw/` (skipping any already present) and writes the compact game data to `public/data/`. It takes about a minute after the downloads finish.

## Sources

| Data | Source | License |
|---|---|---|
| State, county, 119th CD, state legislative (SLDU/SLDL) shapes | US Census Bureau cartographic boundary files 2024 | Public domain |
| Places and county subdivisions (towns, townships), tract centroids | Census Gazetteer files 2024 | Public domain |
| Town population | Census population estimates (SUB-EST2024) | Public domain |
| Demographics | ACS 5-year 2019–2023, table-based summary files (B01003, B01002, B19013, B03002, B15003) | Public domain |
| County presidential results 2008–2024 | [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24) | MIT |
| State presidential 1976–2024, U.S. Senate 1976–2024 | MIT Election Data + Science Lab (Harvard Dataverse) | CC0 |
| Current Congress members' party | [unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators) | CC0 |
| Current state legislators' party | [Open States](https://open.pluralpolicy.com/data/) bulk CSV | CC0 |
| U.S. House results by district and Governor results, 1998–2024 | [538 election-results](https://github.com/fivethirtyeight/election-results) | CC BY 4.0 |
| Kentucky and Mississippi 2023 governor races (missing from 538) | `pipeline/supplement.csv`, from the Kentucky certification and the published Mississippi canvass (sources in the file) | Public record |
| Town boundaries (places and county subdivisions), census tract shapes | US Census Bureau cartographic boundary files 2024 (1:500k) | Public domain |
| State population estimates 2020–2024 (for the 2030 projection) | Census population estimates (NST-EST2024) | Public domain |

## Redistricting: `npm run data:redistrict`

`pipeline/redistrict.ts` (about two minutes) prepares the maps that follow the 2030 census. It reads the committed game data plus tract shapes, tract centroids and tract demographics, and writes:

- `redistrict/apportion.json`: 2030 populations projected from the 2020–2024 estimates, the 435 seats apportioned with the Huntington–Hill method, and the new electoral votes.
- `redistrict/<ST>.json`: for each map (Congress, state senate, state house), three plans with every district's population, demographics and lean, every town's district (aligned with `places/<ST>.json`), and the expected seats for each party.
- `geo/plans/<kind>/<ST>-<plan>.json`: each plan's district shapes (TopoJSON), dissolved from census tracts with mapshaper.

How the plans are drawn:

- **Building blocks** are census tracts. Their lean comes from the same model as everything else: the county's lean plus the difference between the tract's and the county's demographics, times the model coefficients.
- **Fair**: twelve neutral plans by recursive population bisection along random directions, repaired for contiguity and balanced by moving boundary tracts. The plan with the median expected seats (and the fewest cut edges among those) is the fair plan.
- **D and R**: simulated annealing from the ensemble plan that already favors the party. Moves flip boundary tracts between districts while keeping districts contiguous and within the population tolerance, maximizing the party's expected seats with a small penalty on ragged borders.
- **Tolerance**: congressional districts stay within 1% of the ideal population. Legislative districts aim for 5% but are limited by tract size, since a tract holds about 4,000 people. Maps with fewer than four tracts per district (the NH, VT, ME, MT, RI and WY state houses) keep their current lines.
- **District numbers**: each new district takes the number of the old district it overlaps most, so incumbents carry over. A state that loses seats loses its highest numbers.

## Town boundaries: `npm run data:towns`

`pipeline/towns-geo.ts` (about a minute) matches every town in `places/*.json` to its Census boundary (all 35,615 have one). It cuts Mapbox Vector Tiles for zooms 6–10 with geojson-vt (the map overzooms past 10), encodes them with vt-pbf, and writes a single PMTiles v3 archive, `geo/towns.pmtiles` (about 20 MB). The writer follows the PMTiles spec: a 127-byte header, gzip'd root and leaf directories, metadata, and deduplicated tile data in tile-id order. The browser reads it with HTTP range requests (the `pmtiles` protocol for MapLibre), so only the tiles in view are downloaded.

## Result history: `npm run data:history`

`pipeline/history.ts` runs at the end of `data:build`, or on its own (it only needs `raw/538_house.csv` and `raw/538_gov.csv`, about 5 MB). It writes:

- `public/data/results/house.json`: `[dem, rep, total]` per district and year, keyed by today's district number. Lines changed after each census and mid-decade in some states, so older rows describe the district that had that number. Fusion lines (NY, CT) count for the candidate's major party, ranked-choice races use the final round, Georgia/Louisiana runoffs replace the first round, and unopposed races without a count are `[1,0,0]` / `[0,1,0]`.
- `gov` added to each state in `states.json` (specials keyed `"<year>s"`, like Senate).
- `results/latest.json` and `meta.json.latest`: see below.

### Adding the 2026 midterm results

When results are published, save them as `pipeline/raw/results_2026.csv` in the same column layout as 538's files (`state_abbrev, office_name` = `U.S. House` / `U.S. Senate` / `Governor`, `office_seat_name` = `District 7` or `Class II`, `cycle, stage, special, politician_id, candidate_name, ballot_party, votes, ranked_choice_round, unopposed, winner`). Then run `npm run data:history && npm run data:validate`. The 2026 races join the House and Governor history, and the winners' parties go into `results/latest.json`, which the **January 2027 start** uses for seat control. Until then, that start simulates the 2026 midterms (and says so).

## Modeling notes

- **Partisan lean** is the Democratic two-party share, blended as 0.6×2024 + 0.3×2020 + 0.1×2016 presidential results at the county level.
- **Sub-county lean** (tracts, towns, districts) comes from a vote-weighted regression: logit(D share) ~ race/ethnicity + college + income + density + age + state fixed effects. The parent county's residual is added back, so local political culture carries through. Without the county residual, the regression's error is about 6 points.
- **District demographics and lean** are population-weighted sums over the census tracts whose centroids fall inside each district (about 83,600 tracts).
- **Towns** are functioning governments only: incorporated places plus active minor civil divisions (townships, New England towns). A township whose name matches a place is dropped to avoid duplicates.
- **Seat control at game start (Jan 2025):**
  - Congress comes from congress-legislators.
  - Governors are a hand-entered table in `src/sim/offices.ts`.
  - State legislators come from Open States; 97.5% of districts are matched by name. The rest are drawn from the district's lean.
- **Counties without matched results** (Alaska boroughs, Kalawao HI; 28 in total) get their lean from the demographic model plus the state's average residual.
