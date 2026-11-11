/**
 * Sanity checks on the committed game data in public/data (no downloads).
 *   npm run data:validate
 * Exits non-zero if any hard check fails.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CountyData, DistrictData, StateData, TownRow } from '../src/data/types';

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
check(noCounty === 0, `every town maps to a known county (${noCounty} missing)`);
check(noCd / towns < 0.005, `towns with a congressional district (${noCd} missing)`);

for (const layer of ['sldu', 'sldl']) {
  const n = readdirSync(join(DIR, 'geo', layer)).length;
  check(n >= 49, `geo/${layer} has per-state files (${n})`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
