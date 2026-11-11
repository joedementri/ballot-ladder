/**
 * Data pipeline: raw public data -> compact game data in public/data.
 *   npm run data:build
 * Steps: geometry (TopoJSON), demographics (ACS), real results, partisan lean model,
 * point-in-polygon assignment of towns/tracts to districts, current seat control.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import type { Feature } from 'geojson';
import { download, RAW, STATES } from './sources.ts';
import {
  OUT, writeJson, parseCsv, readRaw, readZipText, readAcs, readShapefile, shpPath,
  PipIndex, wls, logit, expit, r3,
} from './lib.ts';

const FIPS: Record<string, string> = {};
const ABBR: Record<string, string> = {};

// ------------------------------------------------------------------ demographics

/** Demo vector: [pop, medAge, medIncome, white, black, asian, hispanic, college, density] */
export type Demo = [number, number, number, number, number, number, number, number, number];

function loadAcs() {
  const prefixes = ['0400000US', '0500000US', '1600000US', '0600000US', '1400000US', '5001800US', '610U800US', '620L800US'];
  const pop = readAcs('b01003', prefixes, ['B01003_E001']);
  const age = readAcs('b01002', prefixes, ['B01002_E001']);
  const inc = readAcs('b19013', prefixes, ['B19013_E001']);
  const race = readAcs('b03002', prefixes, ['B03002_E001', 'B03002_E003', 'B03002_E004', 'B03002_E006', 'B03002_E012']);
  const edu = readAcs('b15003', prefixes, ['B15003_E001', 'B15003_E022', 'B15003_E023', 'B15003_E024', 'B15003_E025']);
  const demo = new Map<string, Omit<Demo, 8> & number[]>();
  for (const [id, [p]] of pop) {
    const r = race.get(id), e = edu.get(id);
    const tot = r?.[0] || 1, e25 = e?.[0] || 1;
    const a = age.get(id)?.[0], i = inc.get(id)?.[0];
    demo.set(id, [
      p,
      a && a > 0 ? a : NaN,
      i && i > 0 ? i : NaN,
      r ? r[1] / tot : NaN, r ? r[2] / tot : NaN, r ? r[3] / tot : NaN, r ? r[4] / tot : NaN,
      e ? (e[1] + e[2] + e[3] + e[4]) / e25 : NaN,
    ]);
  }
  return demo;
}

// ------------------------------------------------------------------ elections

type Res = [number, number, number]; // dem, rep, total

function loadCountyPres() {
  const out = new Map<string, Record<number, Res>>();
  const put = (f: string, y: number, r: Res) => {
    if (!f || !(r[2] > 0)) return;
    const id = f.padStart(5, '0');
    (out.get(id) ?? out.set(id, {}).get(id)!)[y] = r;
  };
  for (const row of parseCsv(readRaw('cty_08_16.csv')))
    for (const y of [2008, 2012]) put(row.fips_code, y, [+row[`dem_${y}`], +row[`gop_${y}`], +row[`total_${y}`]]);
  for (const row of parseCsv(readRaw('cty_2016.csv')))
    put(row.combined_fips, 2016, [+row.votes_dem, +row.votes_gop, +row.total_votes]);
  for (const y of [2020, 2024])
    for (const row of parseCsv(readRaw(`cty_${y}.csv`)))
      put(row.county_fips, y, [+row.votes_dem, +row.votes_gop, +row.total_votes]);
  return out;
}

/** MEDSL statewide results -> st -> year -> Res (general, all specials kept under year+'s'). */
function loadStatewide(file: string) {
  const out: Record<string, Record<string, Res>> = {};
  for (const row of parseCsv(readRaw(file))) {
    if (row.stage && row.stage !== 'gen') continue;
    if (row.writein === 'True' || row.writein === 'TRUE') continue;
    const st = row.state_po;
    const key = row.year + (row.special === 'True' || row.special === 'TRUE' ? 's' : '');
    const r = ((out[st] ??= {})[key] ??= [0, 0, +row.totalvotes]);
    const v = +row.candidatevotes || 0;
    if (row.party_simplified === 'DEMOCRAT') r[0] += v;
    else if (row.party_simplified === 'REPUBLICAN') r[1] += v;
  }
  return out;
}

// ------------------------------------------------------------------ geometry

function topo(zip: string, outRel: string, opts: { simplify: string; where?: string; fields: string }) {
  const out = join(OUT, outRel);
  mkdirSync(join(out, '..'), { recursive: true });
  const args = [
    '-i', shpPath(zip), 'encoding=utf8',
    ...(opts.where ? ['-filter', opts.where] : []),
    '-filter-fields', opts.fields,
    '-simplify', opts.simplify, 'keep-shapes',
    '-o', out, 'format=topojson', 'quantization=1e5', 'precision=0.0001', 'force',
  ];
  execFileSync(process.execPath, [join('node_modules', 'mapshaper', 'bin', 'mapshaper'), ...args], { stdio: 'pipe' });
}

// ------------------------------------------------------------------ main

async function main() {
  await download();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log('geometry ...');
  const stateFc = await readShapefile('state.zip');
  for (const f of stateFc.features) {
    FIPS[f.properties!.STUSPS] = f.properties!.STATEFP;
    ABBR[f.properties!.STATEFP] = f.properties!.STUSPS;
  }
  const validFips = new Set(STATES.map((s) => FIPS[s]));
  const inUS = `${JSON.stringify([...validFips])}.indexOf(STATEFP) > -1`;
  topo('state.zip', 'geo/states.json', { simplify: '8%', where: inUS, fields: 'GEOID,STUSPS,NAME' });
  topo('county.zip', 'geo/counties.json', { simplify: '12%', where: inUS, fields: 'GEOID,NAME,STUSPS' });
  topo('cd.zip', 'geo/cd.json', { simplify: '12%', where: inUS, fields: 'GEOID,STATEFP,CD119FP' });
  for (const st of STATES) {
    if (st === 'DC') continue;
    const where = `STATEFP == '${FIPS[st]}'`;
    topo('sldu.zip', `geo/sldu/${st}.json`, { simplify: '6%', where, fields: 'GEOID,NAME,NAMELSAD' });
    if (st !== 'NE') topo('sldl.zip', `geo/sldl/${st}.json`, { simplify: '6%', where, fields: 'GEOID,NAME,NAMELSAD' });
  }

  console.log('demographics ...');
  const acs = loadAcs();

  // Counties
  const countyFc = await readShapefile('county.zip');
  const countyIdx = new PipIndex(countyFc, (f) => f.properties!.GEOID);
  const cdFc = await readShapefile('cd.zip');
  const cdIdx = new PipIndex(cdFc, (f) => f.properties!.GEOID);
  const slduFc = await readShapefile('sldu.zip');
  const slduIdx = new PipIndex(slduFc, (f) => f.properties!.GEOID);
  const sldlFc = await readShapefile('sldl.zip');
  const sldlIdx = new PipIndex(sldlFc, (f) => f.properties!.GEOID);

  console.log('elections ...');
  const countyPres = loadCountyPres();
  const statePres = loadStatewide('statepres.csv');
  const senate = loadStatewide('senate.csv');
  // Known source errors: MEDSL's DC 2020 row has no D/R votes, and the county file's DC 2024 row covers ~12% of the vote.
  // DC is a single county, so each source can fill in for the other.
  const dc = countyPres.get('11001');
  if (dc && statePres.DC) {
    for (const [y, r] of Object.entries(statePres.DC)) if (r[0] + r[1] === 0 && dc[+y]) statePres.DC[y] = [...dc[+y]] as Res;
    for (const [y, r] of Object.entries(dc)) {
      const s = statePres.DC[y];
      if (s && r[2] < s[2] * 0.9) dc[+y] = [...s] as Res;
    }
  }

  // ---- Lean model: logit(dem two-party share) ~ demographics + state fixed effects (county level, vote weighted)
  const feat = (d: number[], density: number) => {
    const [, age, inc, w, b, a, h, col] = d;
    return [1, w || 0, b || 0, a || 0, h || 0, col || 0, Math.log((inc || 60000) / 60000), Math.log1p(density) / 5, ((age || 39) - 39) / 10];
  };
  const stIndex = STATES.map((s) => FIPS[s]);
  const designRow = (d: number[], density: number, stf: string) => {
    const fe = stIndex.map((s) => (s === stf ? 1 : 0));
    return [...feat(d, density), ...fe.slice(1)];
  };
  const blended = (h: Record<number, Res> | undefined) => {
    if (!h) return null;
    const share = (r?: Res) => (r && r[0] + r[1] > 0 ? r[0] / (r[0] + r[1]) : null);
    const s24 = share(h[2024]), s20 = share(h[2020]), s16 = share(h[2016]);
    if (s24 == null) return null;
    return 0.6 * s24 + 0.3 * (s20 ?? s24) + 0.1 * (s16 ?? s20 ?? s24);
  };

  const counties: Record<string, any> = {};
  const X: number[][] = [], Y: number[] = [], W: number[] = [], rowIds: string[] = [];
  for (const f of countyFc.features) {
    const p = f.properties!;
    if (!validFips.has(p.STATEFP)) continue;
    const d = acs.get(`0500000US${p.GEOID}`);
    if (!d) continue;
    const density = d[0] / Math.max(p.ALAND / 2.59e6, 0.01);
    const lean = blended(countyPres.get(p.GEOID));
    counties[p.GEOID] = { n: p.NAMELSAD ?? p.NAME, st: p.STUSPS, d: [...d, density], pres: countyPres.get(p.GEOID) ?? null };
    if (lean != null) {
      X.push(designRow(d, density, p.STATEFP));
      Y.push(logit(Math.min(0.98, Math.max(0.02, lean))));
      W.push(Math.sqrt(countyPres.get(p.GEOID)![2024][2]));
      rowIds.push(p.GEOID);
    }
  }
  const beta = wls(X, Y, W, 1e-3);
  const predict = (d: number[], density: number, stf: string) =>
    designRow(d, density, stf).reduce((s, x, i) => s + x * beta[i], 0);
  // residual per county (logit space), so sub-units inherit local political culture
  const resid: Record<string, number> = {};
  let sse = 0, sw = 0;
  rowIds.forEach((id, n) => {
    const yhat = X[n].reduce((s, x, i) => s + x * beta[i], 0);
    resid[id] = Y[n] - yhat;
    sse += W[n] * (expit(Y[n]) - expit(yhat)) ** 2; sw += W[n];
  });
  console.log(`  lean model: ${rowIds.length} counties with results, RMSE (share, demo-only) ${(Math.sqrt(sse / sw) * 100).toFixed(1)} pts`);
  const missingResults = Object.keys(counties).filter((id) => !(id in resid));
  console.log(`  counties without matched results (lean imputed from demographics): ${missingResults.length} ${missingResults.slice(0, 12).join(' ')}`);
  // Imputed county residual: average residual of same-state counties
  const stResid: Record<string, number[]> = {};
  for (const [id, r] of Object.entries(resid)) (stResid[id.slice(0, 2)] ??= []).push(r);
  const countyResid = (id: string) =>
    resid[id] ?? (stResid[id.slice(0, 2)] ? stResid[id.slice(0, 2)].reduce((a, b) => a + b, 0) / stResid[id.slice(0, 2)].length : 0);
  const leanOf = (d: number[], density: number, countyId: string) =>
    r3(expit(predict(d, density, countyId.slice(0, 2)) + countyResid(countyId)));
  for (const [id, c] of Object.entries(counties)) {
    const real = blended(c.pres ?? undefined);
    c.lean = r3(real ?? leanOf(c.d, c.d[8], id));
    c.leanSrc = real != null ? 'real' : 'model';
    c.d = c.d.map((x: number) => (Number.isFinite(x) ? r3(x) : null));
  }

  // ---- Tracts -> district aggregation (population weighted demographics + lean)
  console.log('tracts ...');
  type Agg = { pop: number; w: number[]; lean: number; counties: Record<string, number> };
  const aggs: Record<string, Agg> = {};
  const add = (key: string, pop: number, d: number[], lean: number, county: string) => {
    const a = (aggs[key] ??= { pop: 0, w: new Array(9).fill(0), lean: 0, counties: {} });
    a.pop += pop;
    for (let i = 1; i < 9; i++) a.w[i] += pop * (Number.isFinite(d[i]) ? d[i] : 0);
    a.lean += pop * lean;
    a.counties[county] = (a.counties[county] ?? 0) + pop;
  };
  const tractText = readZipText('gaz_tract.zip');
  let tracts = 0;
  for (const row of parseCsv(tractText, '\t')) {
    const st = row.USPS;
    if (!STATES.includes(st)) continue;
    const d = acs.get(`1400000US${row.GEOID}`);
    if (!d || !d[0]) continue;
    const lon = +row.INTPTLONG, lat = +row.INTPTLAT;
    const density = d[0] / Math.max(+row.ALAND_SQMI, 0.01);
    const county = row.GEOID.slice(0, 5);
    const lean = leanOf(d, density, county);
    const dd = [...d, density];
    const cd = cdIdx.locate(lon, lat), su = slduIdx.locate(lon, lat), sl = sldlIdx.locate(lon, lat);
    if (cd) add(`cd:${cd}`, d[0], dd, lean, county);
    if (su) add(`sldu:${su}`, d[0], dd, lean, county);
    if (sl) add(`sldl:${sl}`, d[0], dd, lean, county);
    add(`st:${st}`, d[0], dd, lean, county);
    tracts++;
  }
  console.log(`  ${tracts} tracts assigned`);

  // ---- Current seat control
  console.log('seats ...');
  const legislators = JSON.parse(readRaw('legislators.json'));
  const houseHolder: Record<string, string> = {};
  const senators: Record<string, { party: string; cls: number }[]> = {};
  const partyCode = (p: string) => (p?.startsWith('Democrat') ? 'D' : p?.startsWith('Republican') ? 'R' : 'I');
  for (const l of legislators) {
    const t = l.terms[l.terms.length - 1];
    if (t.type === 'rep') {
      const fips = FIPS[t.state];
      if (!fips || t.state === 'DC') continue;
      houseHolder[`${fips}${String(t.district).padStart(2, '0')}`] = partyCode(t.party);
    } else if (t.type === 'sen') (senators[t.state] ??= []).push({ party: partyCode(t.party), cls: t.class });
  }
  // State legislators (Open States): party by district name, majority party for multi-member districts.
  const norm = (s: string) => s.toLowerCase().replace(/state (senate|house|assembly|legislative)|district|county|no\.|[^a-z0-9]/g, '').replace(/^0+/, '');
  const osParty: Record<string, Record<string, string>> = {}; // "ST:upper" -> normDistrict -> party
  for (const st of STATES) {
    if (st === 'DC') continue;
    const counts: Record<string, Record<string, Record<string, number>>> = {};
    for (const row of parseCsv(readRaw(`os_${st}.csv`))) {
      const ch = row.current_chamber === 'legislature' ? 'upper' : row.current_chamber;
      const p = partyCode(row.current_party);
      const k = norm(row.current_district);
      ((counts[ch] ??= {})[k] ??= {})[p] = (counts[ch][k][p] ?? 0) + 1;
    }
    for (const [ch, ds] of Object.entries(counts))
      osParty[`${st}:${ch}`] = Object.fromEntries(
        Object.entries(ds).map(([k, c]) => [k, Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]]),
      );
  }

  // ---- Districts output
  const finish = (a: Agg | undefined) => {
    if (!a || !a.pop) return null;
    const d = a.w.map((x, i) => (i === 0 ? a.pop : r3(x / a.pop)));
    const topCounty = Object.entries(a.counties).sort((x, y) => y[1] - x[1])[0][0];
    return { pop: a.pop, d, lean: r3(a.lean / a.pop), county: topCounty };
  };
  const districts: Record<string, any> = {};
  let osMatched = 0, osTotal = 0;
  for (const f of cdFc.features) {
    const p = f.properties!;
    if (!validFips.has(p.STATEFP) || p.STATEFP === '11') continue;
    const st = ABBR[p.STATEFP];
    const code = p.CD119FP === '00' ? 'AL' : String(+p.CD119FP);
    districts[`cd:${p.GEOID}`] = { n: `${st}-${code}`, st, kind: 'cd', ...finish(aggs[`cd:${p.GEOID}`]), party: houseHolder[p.GEOID] ?? null };
  }
  for (const [kind, fc, ch] of [['sldu', slduFc, 'upper'], ['sldl', sldlFc, 'lower']] as const) {
    for (const f of fc.features) {
      const p = f.properties!;
      if (!validFips.has(p.STATEFP) || p.STATEFP === '11') continue;
      if (/ZZZ$/.test(p.GEOID)) continue; // undefined areas
      const st = ABBR[p.STATEFP];
      const agg = finish(aggs[`${kind}:${p.GEOID}`]);
      if (!agg) continue;
      const map = osParty[`${st}:${ch}`] ?? {};
      const party = map[norm(p.NAME)] ?? map[norm(p.NAMELSAD)] ?? null;
      osTotal++; if (party) osMatched++;
      districts[`${kind}:${p.GEOID}`] = { n: p.NAMELSAD, st, kind, ...agg, party, partySrc: party ? 'real' : 'model' };
    }
  }
  console.log(`  state legislative seats matched to Open States party: ${osMatched}/${osTotal}`);
  writeJson('districts.json', districts);

  // ---- Towns: functioning local governments (incorporated places + active MCDs)
  console.log('towns ...');
  const subPop = new Map<string, number>();
  for (const row of parseCsv(readRaw('subest.csv'))) {
    if (row.SUMLEV === '162') subPop.set(`P${row.STATE}${row.PLACE}`, +row.POPESTIMATE2024);
    if (row.SUMLEV === '061') subPop.set(`M${row.STATE}${row.COUNTY}${row.COUSUB}`, +row.POPESTIMATE2024);
  }
  const towns: Record<string, any[]> = {};
  const seenNames = new Set<string>();
  const addTown = (kind: 'P' | 'M', row: Record<string, string>, acsKey: string) => {
    const st = row.USPS;
    if (!STATES.includes(st) || row.FUNCSTAT !== 'A') return;
    const lon = +row.INTPTLONG, lat = +row.INTPTLAT;
    const d = acs.get(acsKey);
    const pop = subPop.get(`${kind}${row.GEOID}`) ?? d?.[0] ?? 0;
    if (!pop) return;
    const county = kind === 'M' ? row.GEOID.slice(0, 5) : countyIdx.locate(lon, lat);
    if (!county) return;
    const density = (d?.[0] ?? pop) / Math.max(+row.ALAND_SQMI, 0.01);
    const demo = d ? [...d, density] : [...(counties[county]?.d ?? []).slice(0, 8), density];
    const lean = d ? leanOf(d, density, county) : counties[county]?.lean ?? 0.5;
    towns[st] ??= [];
    towns[st].push([
      `${kind}${row.GEOID}`, row.NAME.replace(/ (CDP|city and borough)$/, ''), +lat.toFixed(4), +lon.toFixed(4), pop, county,
      cdIdx.locate(lon, lat), slduIdx.locate(lon, lat), sldlIdx.locate(lon, lat), lean,
      demo.slice(1).map((x: number) => (Number.isFinite(x) ? r3(x) : null)),
    ]);
  };
  for (const row of parseCsv(readZipText('gaz_place.zip'), '\t')) {
    addTown('P', row, `1600000US${row.GEOID}`);
    seenNames.add(`${row.USPS}:${row.NAME}`);
  }
  for (const row of parseCsv(readZipText('gaz_cousub.zip'), '\t')) {
    if (seenNames.has(`${row.USPS}:${row.NAME}`)) continue; // coextensive city already listed as a place
    addTown('M', row, `0600000US${row.GEOID}`);
  }
  let townCount = 0;
  // Every state gets a file, even with no towns (HI has no incorporated places or active MCDs; DC isn't a town),
  // so the client never requests a missing file.
  for (const st of STATES) {
    const list = (towns[st] ??= []);
    list.sort((a, b) => b[4] - a[4]);
    townCount += list.length;
    writeJson(`places/${st}.json`, list);
  }
  console.log(`  ${townCount} towns`);

  // ---- Counties output (with town lists for quick lookup)
  writeJson('counties.json', counties);

  // ---- States output
  const states: Record<string, any> = {};
  for (const st of STATES) {
    const agg = finish(aggs[`st:${st}`]);
    states[st] = {
      fips: FIPS[st],
      n: stateFc.features.find((f) => f.properties!.STUSPS === st)!.properties!.NAME,
      ...agg,
      pres: statePres[st] ?? {},
      senate: senate[st] ?? {},
      senators: senators[st] ?? [],
      houseSeats: Object.keys(houseHolder).filter((k) => k.startsWith(FIPS[st])).length,
    };
  }
  writeJson('states.json', states);
  writeJson('meta.json', {
    built: new Date().toISOString(),
    startYear: 2025,
    leanModel: { beta: beta.slice(0, 9).map(r3), note: 'logit(D 2-party) ~ demographics + state FE; county residual applied to sub-units' },
    sources: 'US Census Bureau (TIGER cartographic boundaries 2024, Gazetteer 2024, ACS 5-yr 2023, PopEst 2024); MIT Election Data + Science Lab (state presidential & senate 1976-2024); tonmcg/US_County_Level_Election_Results_08-24 (MIT); unitedstates/congress-legislators (CC0); Open States (CC0)',
  });
  console.log('done ->', OUT, RAW ? '' : '');
}

main().catch((e) => { console.error(e); process.exit(1); });
