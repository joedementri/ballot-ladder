/**
 * Which Census places become playable towns, shared by the full build (pipeline/build.ts) and a targeted
 * rebuild of a few states' place files:
 *   npm run data:places -- HI DC
 *
 * Towns are functioning local governments: incorporated places and active county subdivisions (FUNCSTAT A).
 * Two exceptions (M21):
 *   - Hawaii has no municipal governments (its four counties are the local governments), so its
 *     census-designated places become towns, flagged 'cdp' in the town row.
 *   - The District of Columbia becomes one town, "District of Columbia" (the Census place "Washington city").
 *
 * The targeted rebuild exists because `data:build` starts from scratch: it wipes public/data and re-downloads
 * seat control (congress-legislators, Open States), which would change the committed world. It reads the committed
 * counties.json and the lean model in meta.json instead of refitting the model. A town's lean is anchored to its
 * county: logit(lean) = logit(county lean) + (features(town) − features(county)) · β. In the full build the same
 * quantity is computed with the state fixed effect and the county residual, which cancel to the same thing
 * (up to β being rounded to three decimals in meta.json).
 *
 * After a rebuild, run `npm run data:redistrict -- <ST>` (the plans list every town's district) and
 * `npm run data:towns` (boundary tiles), then `npm run data:validate`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { download, STATES } from './sources.ts';
import { OUT, PipIndex, expit, logit, parseCsv, r3, readAcs, readRaw, readShapefile, readZipText, writeJson } from './lib.ts';

/** Model features of an area (the lean model's design row without the state fixed effects). */
export function leanFeatures(d: number[], density: number): number[] {
  const [, age, inc, w, b, a, h, col] = d;
  return [1, w || 0, b || 0, a || 0, h || 0, col || 0, Math.log((inc || 60000) / 60000), Math.log1p(density) / 5, ((age || 39) - 39) / 10];
}

/** The Census place GEOID of Washington, DC. */
export const DC_PLACE = '1150000';

/**
 * Is this Gazetteer row a playable town? 'town' for a functioning government, 'cdp' for a Hawaii
 * census-designated place, null otherwise. `kind` is P (place file) or M (county subdivision file).
 */
export function townKind(kind: 'P' | 'M', row: Record<string, string>): 'town' | 'cdp' | null {
  if (row.FUNCSTAT === 'A') return 'town';
  if (kind !== 'P') return null;
  if (row.USPS === 'DC' && row.GEOID === DC_PLACE) return 'town';
  if (row.USPS === 'HI' && row.LSAD === '57') return 'cdp';
  return null;
}

/** Display name of a town row. */
export function townName(row: Record<string, string>): string {
  if (row.USPS === 'DC' && row.GEOID === DC_PLACE) return 'District of Columbia';
  return row.NAME.replace(/ (CDP|city and borough)$/, '');
}

const DEMO_PREFIX = '1600000US';

async function main() {
  const only = process.argv.slice(2).map((s) => s.toUpperCase()).filter((s) => STATES.includes(s));
  if (!only.length) {
    console.log('usage: npm run data:places -- <ST> [<ST> ...]   (e.g. HI DC)');
    process.exit(1);
  }
  await download(false, ['county.zip', 'cd.zip', 'sldu.zip', 'sldl.zip', 'subest.csv', 'gaz_place.zip', 'acs_b01003.dat', 'acs_b01002.dat', 'acs_b19013.dat', 'acs_b03002.dat', 'acs_b15003.dat']);
  const states = JSON.parse(readFileSync(join(OUT, 'states.json'), 'utf8')) as Record<string, { fips: string }>;
  const counties = JSON.parse(readFileSync(join(OUT, 'counties.json'), 'utf8')) as Record<string, { st: string; lean: number; d: (number | null)[] }>;
  const beta: number[] = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8')).leanModel.beta;
  const fips = new Set(only.map((st) => states[st].fips));

  console.log('demographics ...');
  const pop = readAcs('b01003', [DEMO_PREFIX], ['B01003_E001']);
  const age = readAcs('b01002', [DEMO_PREFIX], ['B01002_E001']);
  const inc = readAcs('b19013', [DEMO_PREFIX], ['B19013_E001']);
  const race = readAcs('b03002', [DEMO_PREFIX], ['B03002_E001', 'B03002_E003', 'B03002_E004', 'B03002_E006', 'B03002_E012']);
  const edu = readAcs('b15003', [DEMO_PREFIX], ['B15003_E001', 'B15003_E022', 'B15003_E023', 'B15003_E024', 'B15003_E025']);
  const demoOf = (id: string): number[] | undefined => {
    const p = pop.get(id)?.[0];
    if (p == null) return undefined;
    const r = race.get(id), e = edu.get(id);
    const tot = r?.[0] || 1, e25 = e?.[0] || 1;
    const a = age.get(id)?.[0], i = inc.get(id)?.[0];
    return [
      p, a && a > 0 ? a : NaN, i && i > 0 ? i : NaN,
      r ? r[1] / tot : NaN, r ? r[2] / tot : NaN, r ? r[3] / tot : NaN, r ? r[4] / tot : NaN,
      e ? (e[1] + e[2] + e[3] + e[4]) / e25 : NaN,
    ];
  };
  const subPop = new Map<string, number>();
  for (const row of parseCsv(readRaw('subest.csv'))) if (row.SUMLEV === '162') subPop.set(`${row.STATE}${row.PLACE}`, +row.POPESTIMATE2024);

  console.log('shapes ...');
  const index = async (zip: string) => {
    const fc = await readShapefile(zip);
    fc.features = fc.features.filter((f) => fips.has(f.properties!.STATEFP));
    return new PipIndex(fc, (f) => f.properties!.GEOID);
  };
  const [countyIdx, cdIdx, slduIdx, sldlIdx] = [await index('county.zip'), await index('cd.zip'), await index('sldu.zip'), await index('sldl.zip')];
  const dot = (x: number[]) => x.reduce((s, v, i) => s + v * beta[i], 0);

  const towns: Record<string, unknown[][]> = Object.fromEntries(only.map((st) => [st, []]));
  for (const row of parseCsv(readZipText('gaz_place.zip'), '\t')) {
    const st = row.USPS;
    if (!towns[st]) continue;
    const kind = townKind('P', row);
    if (!kind) continue;
    const lon = +row.INTPTLONG, lat = +row.INTPTLAT;
    const d = demoOf(`${DEMO_PREFIX}${row.GEOID}`);
    const p = subPop.get(row.GEOID) ?? d?.[0] ?? 0;
    if (!p) continue;
    const county = st === 'DC' ? '11001' : countyIdx.locate(lon, lat);
    const c = county ? counties[county] : undefined;
    if (!county || !c) { console.log(`  skipped ${row.NAME}: no county`); continue; }
    const density = (d?.[0] ?? p) / Math.max(+row.ALAND_SQMI, 0.01);
    const cd = c.d.map((x) => (x == null ? NaN : x));
    const demo = d ? [...d, density] : [...cd.slice(0, 8), density];
    const lean = d ? r3(expit(logit(Math.min(0.98, Math.max(0.02, c.lean))) + dot(leanFeatures(d, density)) - dot(leanFeatures(cd, cd[8])))) : c.lean;
    // DC has no voting congressional district or state legislature: its town belongs to none
    const inDistricts = st !== 'DC';
    const out: unknown[] = [
      `P${row.GEOID}`, townName(row), +lat.toFixed(4), +lon.toFixed(4), p, county,
      inDistricts ? cdIdx.locate(lon, lat) : null, inDistricts ? slduIdx.locate(lon, lat) : null, inDistricts ? sldlIdx.locate(lon, lat) : null, lean,
      demo.slice(1).map((x) => (Number.isFinite(x) ? r3(x) : null)),
    ];
    if (kind === 'cdp') out.push('cdp');
    towns[st].push(out);
  }
  for (const st of only) {
    const list = towns[st];
    list.sort((a, b) => (b[4] as number) - (a[4] as number));
    writeJson(`places/${st}.json`, list);
    const noCd = list.filter((r) => !r[6]).length;
    console.log(`places/${st}.json: ${list.length} towns (${list.filter((r) => r[11] === 'cdp').length} CDPs, ${noCd} without a congressional district); largest: ${list.slice(0, 3).map((r) => `${r[1]} ${r[4]}`).join(', ')}`);
  }
}

if (process.argv[1]?.endsWith('places.ts')) main().catch((e) => { console.error(e); process.exit(1); });
