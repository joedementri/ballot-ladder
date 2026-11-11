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

### Optional: U.S. House results

The MEDSL House (1976–2024) and county-presidential files on Dataverse sit behind a guestbook form, so the pipeline can't download them automatically. To add House results history, download `1976-2024-house.tab` from [doi:10.7910/DVN/IG0UN2](https://doi.org/10.7910/DVN/IG0UN2) and save it as `pipeline/raw/house.tab`. The pipeline doesn't consume this file yet; it's the next data addition.

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
