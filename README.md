# Ballot Ladder

A browser-based American political career simulator. Create a candidate, pick a home town, and climb from town council to President on a data-driven map of the United States. Static site, built for GitLab Pages.

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # vote-model, calendar and engine tests (uses public/data)
npm run build        # production build -> dist/
```

Browser smoke test (drives the built site in headless Chrome/Edge, saves screenshots):

```bash
npm run build && npx vite preview --port 4173 &
npm run smoke -- ./smoke-out
```

## Deploy

Live at **https://joedementri.github.io/ballot-ladder/** (GitHub Pages).

Push to `main`. [.github/workflows/pages.yml](.github/workflows/pages.yml) installs, tests, builds and publishes `dist/`. One-time setup: repo Settings → Pages → Source: **GitHub Actions**. The build uses a relative base path, so it works under any project path. `.gitlab-ci.yml` does the same for GitLab Pages if the repo is ever mirrored there.

The game data in `public/data` (~11 MB) is committed. CI does not rebuild it.

## Game data pipeline

```bash
npm run data:build   # downloads ~300 MB of raw public data to pipeline/raw/ (gitignored), writes public/data/
```

See [pipeline/README.md](pipeline/README.md) for the sources, licenses and modeling notes.

## Architecture

| Path | What |
|---|---|
| `pipeline/` | Node scripts: Census shapes, ACS demographics, election results, lean model, point-in-polygon assignment → `public/data` |
| `src/sim/` | Pure TypeScript simulation: offices & calendar, vote model, world/economy, campaigns, governing, engine |
| `src/workers/sim.worker.ts` | Engine runs in a Web Worker via Comlink so the UI never blocks |
| `src/ui/` | React UI: MapLibre map with layers, inspector, HQ panels, election night |
| `src/store/game.ts` | Zustand store, worker client, IndexedDB autosave |

### Vote model, in brief

Each voting unit (county, town, synthetic precinct) has a real partisan lean and Census demographics. Voters are split into seven blocs (white college, white non-college, Black, Hispanic, Asian, under-30, 65+). Each bloc has its own partisanship, issue positions and issue priorities. The model calibrates a per-unit offset so that two generic party candidates reproduce the real lean exactly. Real candidates then gain or lose against that baseline through:

- distance on 12 issues
- name recognition × favorability
- money relative to what the race normally costs
- endorsements
- incumbency
- scandal
- the national environment
- debates
- seeded noise

Primaries use only that party's voters, who sit further toward the party base. Local races are nonpartisan.

Back-test (`npm test`): calibrated on 2016 county results with a uniform national swing, the model calls **98.1%** of 2020 county winners.
