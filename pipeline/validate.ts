/**
 * Sanity checks on the committed game data in public/data (no downloads).
 *   npm run data:validate
 * Exits non-zero if any hard check fails.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Apportionment, CountyData, DistrictData, StateData, StatePlans, TownRow } from '../src/data/types';

const DIR = join(process.cwd(), 'public', 'data');
const read = <T>(p: string): T => JSON.parse(readFileSync(join(DIR, p), 'utf8'));
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

const states = read<Record<string, StateData>>('states.json');
const counties = read<Record<string, CountyData>>('counties.json');
const districts = read<Record<string, DistrictData>>('districts.json');

const nStates = Object.keys(states).length;
check(nStates === 51, `51 states + DC (${nStates})`);
const nCounties = Object.keys(counties).length;
check(nCounties >= 3100 && nCounties <= 3250, `~3,143 counties (${nCounties})`);
const kinds: Record<string, number> = {};
for (const d of Object.values(districts)) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
check(kinds.cd === 435, `435 congressional districts (${kinds.cd})`);
check(kinds.sldu > 1900 && kinds.sldl > 4700, `state legislative districts (SLDU ${kinds.sldu}, SLDL ${kinds.sldl})`);
// houseSeats counts seats with a sitting member at build time, so vacancies make it smaller than the CD count
const cdBySt: Record<string, number> = {};
for (const d of Object.values(districts)) if (d.kind === 'cd') cdBySt[d.st] = (cdBySt[d.st] ?? 0) + 1;
const badSeats = Object.entries(states).filter(([st, s]) => s.houseSeats > (cdBySt[st] ?? 0) || (cdBySt[st] ?? 0) - s.houseSeats > 1);
check(!badSeats.length, `filled House seats match each state's CD count, allowing one vacancy (${badSeats.map(([st]) => st).join(', ') || 'all match'})`);
const senators = Object.values(states).reduce((a, s) => a + s.senators.length, 0);
check(senators === 100, `100 senators (${senators})`);

const leanOk = (x: number) => Number.isFinite(x) && x > 0 && x < 1;
check(Object.values(counties).every((c) => leanOk(c.lean) && states[c.st]), 'every county has a lean in (0,1) and a known state');
check(Object.values(districts).every((d) => leanOk(d.lean) && states[d.st]), 'every district has a lean in (0,1) and a known state');
const realLean = Object.values(counties).filter((c) => c.leanSrc === 'real').length;
check(realLean / nCounties > 0.98, `counties with real results (${realLean}/${nCounties})`);

// Real vote totals: county 2024 presidential sums vs state totals (where both exist)
let worst = 0, worstSt = '';
for (const [st, s] of Object.entries(states)) {
  const sRes = s.pres['2024'];
  if (!sRes) continue;
  const all = Object.values(counties).filter((c) => c.st === st);
  const cs = all.filter((c) => c.pres?.['2024']);
  if (cs.length < all.length) continue; // AK reports by election district, not borough
  const tot = cs.reduce((a, c) => a + c.pres!['2024'][2], 0);
  const err = Math.abs(tot - sRes[2]) / sRes[2];
  if (err > worst) { worst = err; worstSt = st; }
}
check(worst < 0.03, `county 2024 presidential totals match state totals within 3% (worst ${worstSt} ${(worst * 100).toFixed(2)}%)`);

// Towns: every town has a county; most have a CD
let towns = 0, noCounty = 0, noCd = 0;
for (const st of Object.keys(states)) {
  const f = join(DIR, 'places', `${st}.json`);
  if (!existsSync(f)) { check(false, `places/${st}.json exists`); continue; }
  const rows: TownRow[] = JSON.parse(readFileSync(f, 'utf8'));
  for (const r of rows) {
    towns++;
    if (!counties[r[5]]) noCounty++;
    if (!r[6]) noCd++;
  }
}
check(towns > 30000, `towns (${towns})`);
// M21: Hawaii's towns are census-designated places (it has no municipal governments); DC is one town
const placesOf = (st: string): TownRow[] => JSON.parse(readFileSync(join(DIR, 'places', `${st}.json`), 'utf8'));
const hi = placesOf('HI');
check(hi.length >= 100 && hi.every((r) => r[11] === 'cdp' && r[6] && r[7] && r[8]), `Hawaii has playable towns, all census-designated places with districts (${hi.length})`);
const cdpElsewhere = Object.keys(states).filter((st) => st !== 'HI' && placesOf(st).some((r) => r[11] === 'cdp'));
check(!cdpElsewhere.length, `census-designated places only in Hawaii (${cdpElsewhere.join(', ') || 'none elsewhere'})`);
const dc = placesOf('DC');
check(dc.length === 1 && dc[0][1] === 'District of Columbia' && dc[0][5] === '11001' && !dc[0][6], `DC is one town, "District of Columbia", outside any district (${dc.map((r) => r[1]).join(', ') || 'none'})`);
check(noCounty === 0, `every town maps to a known county (${noCounty} missing)`);
check(noCd / towns < 0.005, `towns with a congressional district (${noCd} missing)`);

for (const layer of ['sldu', 'sldl']) {
  const n = readdirSync(join(DIR, 'geo', layer)).length;
  check(n >= 49, `geo/${layer} has per-state files (${n})`);
}

// Result history (pipeline/history.ts)
const housePath = join(DIR, 'results', 'house.json');
if (!existsSync(housePath)) check(false, 'results/house.json exists (npm run data:history)');
else {
  const house: Record<string, Record<string, number[]>> = JSON.parse(readFileSync(housePath, 'utf8'));
  const cds = Object.keys(districts).filter((k) => k.startsWith('cd:')).map((k) => k.slice(3));
  check(cds.every((id) => house[id]?.['2024']), `every CD has a 2024 House result (${cds.filter((id) => house[id]?.['2024']).length}/${cds.length})`);
  const bad = Object.values(house).flatMap((h) => Object.values(h)).filter((r) => r[2] && r[0] + r[1] > r[2] * 1.001).length;
  check(!bad, `House results: D + R never exceed the total (${bad} bad)`);
}
// Newer results (pipeline/history.ts): results/latest.json always exists; once pipeline/raw/results_2026.csv is
// present its cycles must include 2026 and the 2026 House results must be in the history
const latestPath = join(DIR, 'results', 'latest.json');
if (!existsSync(latestPath)) check(false, 'results/latest.json exists (npm run data:history)');
else {
  const latest: { cycles: number[]; house: Record<string, string>; senate: Record<string, string>; gov: Record<string, string> } = read('results/latest.json');
  const meta = read<{ latest?: number[] }>('meta.json');
  check(JSON.stringify(meta.latest ?? []) === JSON.stringify(latest.cycles), `meta.json lists the cycles in results/latest.json (${latest.cycles.join(', ') || 'none'})`);
  if (existsSync(join(process.cwd(), 'pipeline', 'raw', 'results_2026.csv'))) {
    const house: Record<string, Record<string, number[]>> = existsSync(housePath) ? JSON.parse(readFileSync(housePath, 'utf8')) : {};
    const with26 = Object.values(house).filter((h) => h['2026']).length;
    check(latest.cycles.includes(2026), `results/latest.json includes the 2026 cycle (${latest.cycles.join(', ') || 'none'})`);
    check(Object.keys(latest.house).length >= 400 && with26 >= 400, `2026 House results: ${Object.keys(latest.house).length} winners, ${with26} districts in the history (expect ~435)`);
  } else console.log('note  pipeline/raw/results_2026.csv not present: 2026 results not checked (the 2027 start simulates the midterms)');
}
const govStates = Object.entries(states).filter(([st, s]) => st !== 'DC' && Object.keys((s as any).gov ?? {}).some((y) => +y.slice(0, 4) >= 2020)).length;
check(govStates === 50, `every state has a governor result since 2020 (${govStates}/50)`);

// Redistricting after the 2030 census (pipeline/redistrict.ts)
const appPath = join(DIR, 'redistrict', 'apportion.json');
if (!existsSync(appPath)) check(false, 'redistrict/apportion.json exists (npm run data:redistrict)');
else {
  const app = read<Apportionment>('redistrict/apportion.json');
  const seats = Object.values(app.seats).reduce((a, b) => a + b, 0);
  check(seats === 435 && Object.values(app.seats).every((n) => n >= 1), `2030 apportionment: 435 seats, at least one per state (${seats})`);
  check(Object.values(app.ev).reduce((a, b) => a + b, 0) === 538, '2030 electoral votes total 538');
  let maps = 0, kept = 0;
  const problems: string[] = [];
  for (const st of Object.keys(states)) {
    if (st === 'DC') continue;
    const f = join(DIR, 'redistrict', `${st}.json`);
    if (!existsSync(f)) { problems.push(`${st}: missing`); continue; }
    const plans: StatePlans = JSON.parse(readFileSync(f, 'utf8'));
    const nTowns = (JSON.parse(readFileSync(join(DIR, 'places', `${st}.json`), 'utf8')) as unknown[]).length;
    if (plans.cd?.seats !== app.seats[st]) problems.push(`${st}: cd seats`);
    for (const [kind, m] of Object.entries(plans)) {
      if (m.keep) { kept++; continue; }
      maps++;
      for (const [pk, p] of Object.entries(m.plans ?? {})) {
        const d = Object.values(p.d);
        if (d.length !== m.seats) problems.push(`${st} ${kind} ${pk}: ${d.length} districts`);
        if (!d.every((x) => leanOk(x.lean) && x.pop > 0)) problems.push(`${st} ${kind} ${pk}: bad district`);
        if (p.towns.length !== nTowns) problems.push(`${st} ${kind} ${pk}: towns not aligned`);
        if (!existsSync(join(DIR, 'geo', 'plans', kind, `${st}-${pk}.json`))) problems.push(`${st} ${kind} ${pk}: no shapes`);
      }
    }
  }
  check(!problems.length, `redistricting plans for every state (${maps} maps redrawn, ${kept} keep their lines)${problems.length ? `: ${problems.slice(0, 8).join('; ')}` : ''}`);
}
// Town boundaries (pipeline/towns-geo.ts)
const pm = join(DIR, 'geo', 'towns.pmtiles');
if (!existsSync(pm)) check(false, 'geo/towns.pmtiles exists (npm run data:towns)');
else {
  const head = readFileSync(pm).subarray(0, 8);
  check(head.toString('ascii', 0, 7) === 'PMTiles' && head[7] === 3, 'geo/towns.pmtiles is a PMTiles v3 archive');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
