/**
 * Redistricting after the 2030 census:  npm run data:redistrict
 *
 * 1. Apportionment: the 435 House seats are divided with the Huntington–Hill method (the method Congress uses)
 *    on 2030 state populations projected from the 2020–2024 Census estimates.
 * 2. Plans: for every state and map (Congress, state senate, state house) three plans are drawn from census tracts:
 *      fair  the median plan (by expected seats) of an ensemble of neutral, compact plans
 *      D, R  a partisan gerrymander: simulated annealing from the ensemble plan that already favours that party,
 *            maximizing the party's expected seats under population and contiguity limits
 *    State legislative maps whose districts are too small for tracts (fewer than 4 tracts per district: NH, VT and
 *    a few others) keep their current lines.
 * 3. Outputs (public/data/redistrict/ and public/data/geo/plans/):
 *      apportion.json   projected populations, seats and electoral votes by state
 *      <ST>.json        per map: district codes, and per plan the districts' population, demographics and lean,
 *                       each town's district (aligned with places/<ST>.json) and expected seats
 *      geo/plans/<kind>/<ST>-<plan>.json  TopoJSON of each plan's districts (GEOID per district)
 *
 * New districts keep the number of the old district they overlap most, so incumbents carry over.
 * Inputs: tract shapes (cb_2024_us_tract_500k), tract centroids (Gazetteer), ACS 5-year tract demographics,
 * state population estimates (NST-EST2024) and the committed game data (lean model, counties, current districts).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { feature } from 'topojson-client';
import { download, RAW, STATES } from './sources.ts';
import { OUT, PipIndex, expit, logit, parseCsv, r3, readAcs, readRaw, readZipText, shpPath, writeJson } from './lib.ts';

const CENSUS = 2030;
const KINDS = ['cd', 'sldu', 'sldl'] as const;
type Kind = (typeof KINDS)[number];
const PLANS = ['fair', 'D', 'R'] as const;
type PlanKey = (typeof PLANS)[number];
/** Allowed population deviation from the ideal district. */
const TOL: Record<Kind, number> = { cd: 0.01, sldu: 0.05, sldl: 0.05 };
const ENSEMBLE = 12;
const SWEEPS: Record<Kind, number> = { cd: 60, sldu: 40, sldl: 30 };
/** Seat probability around an even district: P(win) = expit(1.7 · (share − 0.5) / σ). */
const SIGMA = 0.04;
const seatP = (s: number) => 1 / (1 + Math.exp((-1.7 * (s - 0.5)) / SIGMA));

const readOut = <T>(rel: string): T => JSON.parse(readFileSync(join(OUT, rel), 'utf8'));
const log = (...a: unknown[]) => console.log(...a);

class Rng {
  private s: number;
  constructor(seed: string) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    this.s = h >>> 0 || 1;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// ------------------------------------------------------------------ apportionment

function apportion(byFips: Record<string, string>) {
  const pop: Record<string, number> = {};
  for (const r of parseCsv(readRaw('nst_est.csv'))) {
    const st = byFips[r.STATE];
    if (r.SUMLEV !== '040' || !st || st === 'DC') continue;
    const p20 = +r.POPESTIMATE2020, p24 = +r.POPESTIMATE2024;
    // census day 2030 is ~5.75 years after the July 2024 estimate
    pop[st] = Math.round(p24 + ((p24 - p20) / 4) * 5.75);
  }
  const seats: Record<string, number> = Object.fromEntries(Object.keys(pop).map((s) => [s, 1]));
  for (let k = 50; k < 435; k++) {
    let best = '', bv = -1;
    for (const [st, p] of Object.entries(pop)) {
      const v = p / Math.sqrt(seats[st] * (seats[st] + 1));
      if (v > bv) { bv = v; best = st; }
    }
    seats[best]++;
  }
  const ev: Record<string, number> = { DC: 3 };
  for (const [st, n] of Object.entries(seats)) ev[st] = n + 2;
  return { pop, seats, ev };
}

// ------------------------------------------------------------------ tracts

interface Graph {
  n: number;
  ids: string[];
  pop: Float64Array;
  /** Democratic two-party share. */
  lean: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Longitude (x is longitude scaled for the state's latitude). */
  lon: Float64Array;
  nb: number[][];
  county: string[];
  demo: number[][];
}

/** Lean model features (same as pipeline/build.ts). */
const feat = (d: number[]) => {
  const [, age, inc, w, b, a, h, col, density] = d;
  return [1, w || 0, b || 0, a || 0, h || 0, col || 0, Math.log((inc || 60000) / 60000), Math.log1p(density || 0) / 5, ((age || 39) - 39) / 10];
};

function loadTractDemo() {
  const P = ['1400000US'];
  const pop = readAcs('b01003', P, ['B01003_E001']);
  const age = readAcs('b01002', P, ['B01002_E001']);
  const inc = readAcs('b19013', P, ['B19013_E001']);
  const race = readAcs('b03002', P, ['B03002_E001', 'B03002_E003', 'B03002_E004', 'B03002_E006', 'B03002_E012']);
  const edu = readAcs('b15003', P, ['B15003_E001', 'B15003_E022', 'B15003_E023', 'B15003_E024', 'B15003_E025']);
  const out = new Map<string, number[]>();
  for (const [key, [p]] of pop) {
    const r = race.get(key), e = edu.get(key);
    const a = age.get(key)?.[0], i = inc.get(key)?.[0];
    out.set(key.slice(9), [
      p, a && a > 0 ? a : NaN, i && i > 0 ? i : NaN,
      r && r[0] ? r[1] / r[0] : NaN, r && r[0] ? r[2] / r[0] : NaN, r && r[0] ? r[3] / r[0] : NaN, r && r[0] ? r[4] / r[0] : NaN,
      e && e[0] ? (e[1] + e[2] + e[3] + e[4]) / e[0] : NaN,
    ]);
  }
  return out;
}

function buildGraph(fc: FeatureCollection, demo: Map<string, number[]>, gaz: Map<string, { lat: number; lon: number; sqmi: number }>, counties: Record<string, any>, beta: number[]): Graph {
  const feats = fc.features.filter((f) => f.geometry);
  const n = feats.length;
  const g: Graph = { n, ids: [], pop: new Float64Array(n), lean: new Float64Array(n), x: new Float64Array(n), y: new Float64Array(n), lon: new Float64Array(n), nb: [], county: [], demo: [] };
  let lat0 = 0;
  for (const f of feats) lat0 += gaz.get(f.properties!.GEOID)?.lat ?? 0;
  lat0 /= n || 1;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const vert = new Map<string, number | number[]>();
  const edges = Array.from({ length: n }, () => new Set<number>());
  feats.forEach((f, i) => {
    const id = f.properties!.GEOID as string;
    g.ids.push(id);
    const cty = id.slice(0, 5);
    g.county.push(cty);
    const z = gaz.get(id);
    const d = demo.get(id);
    const c = counties[cty];
    const pop = d?.[0] ?? 0;
    const density = pop / Math.max(z?.sqmi ?? 1, 0.01);
    const dd = d ? [...d, density] : [0, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 0];
    g.demo.push(dd);
    g.pop[i] = pop;
    // tract logit = county logit + (tract features − county features) · β  (the county's residual carries through)
    const cl = logit(Math.min(0.98, Math.max(0.02, c?.lean ?? 0.5)));
    const cf = c ? feat(c.d.map((v: number | null) => (v == null ? NaN : v))) : null;
    const tf = feat(dd);
    g.lean[i] = d && cf ? expit(cl + tf.reduce((s, v, k) => s + (v - cf[k]) * beta[k], 0)) : c?.lean ?? 0.5;
    let lon = z?.lon, lat = z?.lat;
    if (lon == null || lat == null) {
      // centroid of the first ring
      const ring = (f.geometry!.type === 'Polygon' ? (f.geometry as any).coordinates[0] : (f.geometry as any).coordinates[0][0]) as number[][];
      lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    }
    g.x[i] = lon * kx;
    g.lon[i] = lon;
    g.y[i] = lat;
    const polys = f.geometry!.type === 'Polygon' ? [(f.geometry as any).coordinates] : (f.geometry as any).coordinates;
    for (const poly of polys)
      for (const ring of poly)
        for (const p of ring) {
          const k = `${p[0]},${p[1]}`;
          const have = vert.get(k);
          if (have == null) vert.set(k, i);
          else if (typeof have === 'number') {
            if (have !== i) { edges[i].add(have); edges[have].add(i); vert.set(k, [have, i]); }
          } else if (!have.includes(i)) {
            for (const j of have) { edges[i].add(j); edges[j].add(i); }
            have.push(i);
          }
        }
  });
  g.nb = edges.map((s) => [...s]);
  connect(g);
  return g;
}

/** Islands and water-separated tracts: link each smaller component to the nearest tract outside it. */
function connect(g: Graph) {
  for (let pass = 0; pass < 50; pass++) {
    const comp = new Int32Array(g.n).fill(-1);
    const sizes: number[] = [];
    for (let s = 0; s < g.n; s++) {
      if (comp[s] >= 0) continue;
      const id = sizes.length;
      let size = 0;
      const q = [s];
      comp[s] = id;
      while (q.length) {
        const v = q.pop()!;
        size++;
        for (const u of g.nb[v]) if (comp[u] < 0) { comp[u] = id; q.push(u); }
      }
      sizes.push(size);
    }
    if (sizes.length <= 1) return;
    const main = sizes.indexOf(Math.max(...sizes));
    for (let c = 0; c < sizes.length; c++) {
      if (c === main) continue;
      let best = [-1, -1], bd = Infinity;
      for (let v = 0; v < g.n; v++) {
        if (comp[v] !== c) continue;
        for (let u = 0; u < g.n; u++) {
          if (comp[u] === c) continue;
          const d = (g.x[u] - g.x[v]) ** 2 + (g.y[u] - g.y[v]) ** 2;
          if (d < bd) { bd = d; best = [v, u]; }
        }
      }
      if (best[0] >= 0) { g.nb[best[0]].push(best[1]); g.nb[best[1]].push(best[0]); }
    }
  }
}

// ------------------------------------------------------------------ districting

interface Plan { a: Int32Array; pop: Float64Array; dem: Float64Array; size: Int32Array }

function stats(g: Graph, a: Int32Array, N: number): Plan {
  const p: Plan = { a, pop: new Float64Array(N), dem: new Float64Array(N), size: new Int32Array(N) };
  for (let i = 0; i < g.n; i++) { p.pop[a[i]] += g.pop[i]; p.dem[a[i]] += g.pop[i] * g.lean[i]; p.size[a[i]]++; }
  return p;
}
const share = (p: Plan, d: number) => (p.pop[d] > 0 ? p.dem[d] / p.pop[d] : 0.5);
const expSeats = (p: Plan, N: number) => { let s = 0; for (let d = 0; d < N; d++) s += seatP(share(p, d)); return s; };
function cutEdges(g: Graph, a: Int32Array) {
  let c = 0;
  for (let i = 0; i < g.n; i++) for (const j of g.nb[i]) if (j > i && a[i] !== a[j]) c++;
  return c;
}

/** Recursive bisection along random directions, split at population quantiles. */
function bisect(g: Graph, idx: number[], k: number, rng: Rng, a: Int32Array, next: { v: number }) {
  if (k === 1 || idx.length <= 1) {
    const d = next.v++;
    for (const i of idx) a[i] = d;
    for (let r = 1; r < k; r++) next.v++; // (degenerate: more districts than tracts)
    return;
  }
  const k1 = Math.floor(k / 2);
  const th = rng.next() * Math.PI;
  const cx = Math.cos(th), cy = Math.sin(th);
  const order = idx.map((i) => [g.x[i] * cx + g.y[i] * cy, i] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const total = order.reduce((s, i) => s + g.pop[i], 0);
  const target = (total * k1) / k;
  let acc = 0, cut = 0;
  while (cut < order.length && acc + g.pop[order[cut]] / 2 < target) acc += g.pop[order[cut++]];
  cut = Math.max(k1, Math.min(order.length - (k - k1), cut));
  bisect(g, order.slice(0, cut), k1, rng, a, next);
  bisect(g, order.slice(cut), k - k1, rng, a, next);
}

/** Merge stray pieces of a district into the neighbouring district they touch most. */
function repairContiguity(g: Graph, p: Plan, N: number) {
  for (let iter = 0; iter < 30; iter++) {
    const comp = new Int32Array(g.n).fill(-1);
    const comps: { d: number; members: number[]; pop: number }[] = [];
    for (let s = 0; s < g.n; s++) {
      if (comp[s] >= 0) continue;
      const d = p.a[s];
      const c = { d, members: [] as number[], pop: 0 };
      const q = [s];
      comp[s] = comps.length;
      while (q.length) {
        const v = q.pop()!;
        c.members.push(v);
        c.pop += g.pop[v];
        for (const u of g.nb[v]) if (comp[u] < 0 && p.a[u] === d) { comp[u] = comps.length; q.push(u); }
      }
      comps.push(c);
    }
    const best = new Map<number, number>();
    comps.forEach((c, i) => {
      const b = best.get(c.d);
      if (b == null || c.pop > comps[b].pop || (c.pop === comps[b].pop && c.members.length > comps[b].members.length)) best.set(c.d, i);
    });
    let moved = 0;
    comps.forEach((c, i) => {
      if (best.get(c.d) === i) return;
      const votes = new Map<number, number>();
      for (const v of c.members) for (const u of g.nb[v]) if (p.a[u] !== c.d) votes.set(p.a[u], (votes.get(p.a[u]) ?? 0) + 1);
      if (!votes.size) return;
      const to = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];
      for (const v of c.members) move(g, p, v, to);
      moved++;
    });
    if (!moved) return;
  }
  void N;
}

function move(g: Graph, p: Plan, v: number, to: number) {
  const from = p.a[v];
  p.pop[from] -= g.pop[v]; p.dem[from] -= g.pop[v] * g.lean[v]; p.size[from]--;
  p.pop[to] += g.pop[v]; p.dem[to] += g.pop[v] * g.lean[v]; p.size[to]++;
  p.a[v] = to;
}

/** Can `v` leave its district without splitting it? (bounded search; unsure counts as no) */
function canRemove(g: Graph, p: Plan, v: number, limit = 3000): boolean {
  const d = p.a[v];
  if (p.size[d] <= 1) return false;
  const same = g.nb[v].filter((u) => p.a[u] === d);
  if (same.length <= 1) return same.length === 1;
  const want = new Set(same.slice(1));
  const seen = new Set<number>([v, same[0]]);
  const q = [same[0]];
  while (q.length && want.size) {
    const x = q.pop()!;
    for (const u of g.nb[x]) {
      if (seen.has(u) || p.a[u] !== d) continue;
      seen.add(u);
      want.delete(u);
      q.push(u);
      if (seen.size > limit) return false;
    }
  }
  return want.size === 0;
}

/**
 * Balance populations by diffusion: move a boundary tract from a district to a smaller neighbour whenever the gap
 * between them exceeds the tract's population (this always lowers the sum of squared deviations).
 */
function rebalance(g: Graph, p: Plan, N: number, tol: number, rng: Rng) {
  const ideal = p.pop.reduce((s, x) => s + x, 0) / N;
  for (let sweep = 0; sweep < 300; sweep++) {
    if (maxDev(p, N) <= tol) return;
    let moved = 0;
    for (const v of shuffled(g.n, rng)) {
      const d = p.a[v];
      const pv = g.pop[v];
      if (pv <= 0) continue;
      let best = -1, gap = pv;
      for (const u of g.nb[v]) {
        const e = p.a[u];
        if (e !== d && p.pop[d] - p.pop[e] > gap) { gap = p.pop[d] - p.pop[e]; best = e; }
      }
      if (best >= 0 && canRemove(g, p, v)) { move(g, p, v, best); moved++; }
    }
    if (!moved) return;
  }
  void ideal;
}
function maxDev(p: Plan, N: number) {
  const ideal = p.pop.reduce((s, x) => s + x, 0) / N;
  let w = 0;
  for (let d = 0; d < N; d++) w = Math.max(w, Math.abs(p.pop[d] - ideal) / ideal);
  return w;
}

function shuffled(n: number, rng: Rng) {
  const o = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
  return o;
}

function neutralPlan(g: Graph, N: number, kind: Kind, rng: Rng): Plan {
  const a = new Int32Array(g.n);
  bisect(g, Array.from({ length: g.n }, (_, i) => i), N, rng, a, { v: 0 });
  const p = stats(g, a, N);
  repairContiguity(g, p, N);
  rebalance(g, p, N, TOL[kind], rng);
  return p;
}

/**
 * Partisan gerrymander by simulated annealing: maximize the drawing party's expected seats, with a small
 * penalty on cut edges so districts stay recognizable, within the population tolerance and contiguity.
 */
function gerrymander(g: Graph, start: Plan, N: number, kind: Kind, party: 'D' | 'R', rng: Rng, tol: number): Plan {
  const p: Plan = { a: new Int32Array(start.a), pop: new Float64Array(start.pop), dem: new Float64Array(start.dem), size: new Int32Array(start.size) };
  const ideal = p.pop.reduce((s, x) => s + x, 0) / N;
  const lo = ideal * (1 - tol), hi = ideal * (1 + tol);
  const sign = party === 'D' ? 1 : -1;
  const val = (pop: number, dem: number) => { const s = pop > 0 ? dem / pop : 0.5; const q = seatP(s); return sign > 0 ? q : 1 - q; };
  const lambda = 0.0015;
  const sweeps = SWEEPS[kind];
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const T = 0.02 * (1 - sweep / sweeps) + 0.0005;
    for (const v of shuffled(g.n, rng)) {
      const d = p.a[v];
      const pv = g.pop[v], dv = pv * g.lean[v];
      if (p.pop[d] - pv < lo) continue;
      for (const u of g.nb[v]) {
        const e = p.a[u];
        if (e === d || p.pop[e] + pv > hi) continue;
        let inD = 0, inE = 0;
        for (const w of g.nb[v]) { if (p.a[w] === d) inD++; else if (p.a[w] === e) inE++; }
        const delta = val(p.pop[d] - pv, p.dem[d] - dv) + val(p.pop[e] + pv, p.dem[e] + dv) - val(p.pop[d], p.dem[d]) - val(p.pop[e], p.dem[e]) - lambda * (inD - inE);
        if (delta > 0 || rng.next() < Math.exp(delta / T)) {
          if (canRemove(g, p, v, 1500)) move(g, p, v, e);
        }
        break;
      }
    }
  }
  return p;
}

// ------------------------------------------------------------------ geoids

/** Give each new district the code of the old district it overlaps most (codes in `target`). */
function matchCodes(g: Graph, p: Plan, N: number, cur: (string | null)[], target: string[]): string[] {
  const ov = new Map<string, number>();
  for (let i = 0; i < g.n; i++) if (cur[i]) ov.set(`${p.a[i]}|${cur[i]}`, (ov.get(`${p.a[i]}|${cur[i]}`) ?? 0) + g.pop[i] + 1e-3);
  const allowed = new Set(target);
  const pairs = [...ov.entries()].map(([k, v]) => { const [d, c] = k.split('|'); return { d: +d, c, v }; }).filter((x) => allowed.has(x.c)).sort((a, b) => b.v - a.v);
  const out: string[] = new Array(N).fill('');
  const used = new Set<string>();
  for (const { d, c } of pairs) if (!out[d] && !used.has(c)) { out[d] = c; used.add(c); }
  const rest = target.filter((c) => !used.has(c));
  for (let d = 0; d < N; d++) if (!out[d]) out[d] = rest.shift()!;
  return out;
}

// ------------------------------------------------------------------ main

async function main() {
  await download(false, ['tract.zip', 'gaz_tract.zip', 'nst_est.csv', 'acs_b01003.dat', 'acs_b01002.dat', 'acs_b19013.dat', 'acs_b03002.dat', 'acs_b15003.dat']);
  const only = process.argv.slice(2).filter((x) => /^[A-Z]{2}$/.test(x));
  const states = readOut<Record<string, any>>('states.json');
  const counties = readOut<Record<string, any>>('counties.json');
  const districts = readOut<Record<string, any>>('districts.json');
  const beta: number[] = readOut<any>('meta.json').leanModel.beta;
  const byFips = Object.fromEntries(Object.entries(states).map(([st, s]) => [s.fips, st]));

  log('apportionment ...');
  const app = apportion(byFips);
  // current seats = districts on today's map (states.json houseSeats skips vacant seats)
  const seatsNow: Record<string, number> = {};
  for (const d of Object.values(districts)) if (d.kind === 'cd') seatsNow[d.st] = (seatsNow[d.st] ?? 0) + 1;
  const changes = Object.entries(app.seats).map(([st, n]) => [st, n - (seatsNow[st] ?? 1)] as const).filter(([, d]) => d !== 0).sort((a, b) => b[1] - a[1]);
  log('  ' + changes.map(([st, d]) => `${st} ${d > 0 ? '+' : ''}${d}`).join(', '));
  writeJson('redistrict/apportion.json', { census: CENSUS, pop: app.pop, seats: app.seats, ev: app.ev, before: Object.fromEntries(Object.keys(app.seats).map((st) => [st, seatsNow[st] ?? 1])) });

  // per-state tract GeoJSON (split once with mapshaper)
  const tractDir = join(RAW, 'tracts');
  if (!existsSync(join(tractDir, '01.json'))) {
    mkdirSync(tractDir, { recursive: true });
    execFileSync(process.execPath, [join('node_modules', 'mapshaper', 'bin', 'mapshaper'), '-i', shpPath('tract.zip'), 'encoding=utf8', '-filter-fields', 'GEOID,STATEFP', '-split', 'STATEFP', '-o', `${tractDir}/`, 'format=geojson', 'precision=0.000001'], { stdio: 'pipe' });
  }
  log('tract demographics ...');
  const demo = loadTractDemo();
  const gaz = new Map<string, { lat: number; lon: number; sqmi: number }>();
  for (const row of parseCsv(readZipText('gaz_tract.zip'), '\t')) gaz.set(row.GEOID, { lat: +row.INTPTLAT, lon: +row.INTPTLONG, sqmi: +row.ALAND_SQMI });

  const tmp = join(RAW, 'plans_tmp');
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(OUT, 'geo', 'plans'), { recursive: true });
  const summary: string[] = [];

  for (const st of STATES) {
    if (st === 'DC' || (only.length && !only.includes(st))) continue;
    const t0 = Date.now();
    const fips = states[st].fips;
    const fc = JSON.parse(readFileSync(join(tractDir, `${fips}.json`), 'utf8')) as FeatureCollection;
    const g = buildGraph(fc, demo, gaz, counties, beta);
    const tractFeats = fc.features.filter((f) => f.geometry);
    // towns -> tract
    const towns: any[] = readOut(`places/${st}.json`);
    const tractIdx = new PipIndex({ type: 'FeatureCollection', features: tractFeats }, (f) => f.properties!.GEOID);
    const pos = new Map(g.ids.map((id, i) => [id, i]));
    const townTract = towns.map((t) => pos.get(tractIdx.locate(t[3], t[2]) ?? '') ?? -1);

    const out: Record<string, any> = {};
    const fields: Record<string, string[]> = {};
    for (const kind of KINDS) {
      if (kind === 'sldl' && st === 'NE') continue;
      const curKeys = Object.keys(districts).filter((k) => k.startsWith(`${kind}:`) && districts[k].st === st).map((k) => k.slice(kind.length + 1)).sort();
      const N = kind === 'cd' ? app.seats[st] : curKeys.length;
      if (!N) continue;
      if (kind !== 'cd' && g.n / N < 4) {
        out[kind] = { seats: N, keep: true };
        summary.push(`${st} ${kind}: kept (${(g.n / N).toFixed(1)} tracts per district)`);
        continue;
      }
      // current district of each tract (from the game's own shapes)
      const curFc = kind === 'cd'
        ? geoFc('cd.json', (f) => String(f.properties!.GEOID).startsWith(fips))
        : geoFc(`${kind}/${st}.json`, () => true);
      const curIdx = new PipIndex(curFc, (f) => f.properties!.GEOID);
      const cur = g.ids.map((_, i) => curIdx.locate(g.lon[i], g.y[i]));
      const target = kind === 'cd'
        ? N === 1 ? [`${fips}00`] : Array.from({ length: N }, (_, i) => `${fips}${String(i + 1).padStart(2, '0')}`)
        : curKeys;
      const rng = new Rng(`${st}|${kind}|${CENSUS}`);
      const plans: Partial<Record<PlanKey, Plan>> = {};
      if (N === 1) plans.fair = stats(g, new Int32Array(g.n), 1);
      else {
        const ens = Array.from({ length: ENSEMBLE }, () => neutralPlan(g, N, kind, rng));
        const seatsOf = ens.map((p) => expSeats(p, N));
        const sorted = [...seatsOf].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const fairIdx = ens.map((p, i) => ({ i, s: Math.abs(seatsOf[i] - med) * 1000 + cutEdges(g, p.a) / g.n })).sort((a, b) => a.s - b.s)[0].i;
        plans.fair = ens[fairIdx];
        const bestD = seatsOf.indexOf(Math.max(...seatsOf));
        const bestR = seatsOf.indexOf(Math.min(...seatsOf));
        // with only a handful of tracts per district the legal tolerance can't be met; gerrymanders may not exceed
        // what the neutral plans achieved
        const tol = (start: Plan) => Math.max(TOL[kind], maxDev(plans.fair!, N), maxDev(start, N));
        plans.D = gerrymander(g, ens[bestD], N, kind, 'D', rng, tol(ens[bestD]));
        plans.R = gerrymander(g, ens[bestR], N, kind, 'R', rng, tol(ens[bestR]));
      }
      const k: Record<string, any> = { seats: N, codes: target, plans: {} };
      if (kind === 'cd') {
        k.before = curKeys.length;
        k.retired = curKeys.filter((c) => !target.includes(c));
      }
      for (const pk of PLANS) {
        const p = plans[pk];
        if (!p) continue;
        const codes = matchCodes(g, p, N, cur, target);
        const codeIdx = new Map(target.map((c, i) => [c, i]));
        const dists: Record<string, any> = {};
        for (let d = 0; d < N; d++) {
          const agg = { pop: 0, w: new Array(9).fill(0), lean: 0, counties: {} as Record<string, number> };
          for (let i = 0; i < g.n; i++) {
            if (p.a[i] !== d) continue;
            const pp = g.pop[i];
            agg.pop += pp;
            for (let j = 1; j < 9; j++) agg.w[j] += pp * (Number.isFinite(g.demo[i][j]) ? g.demo[i][j] : 0);
            agg.lean += pp * g.lean[i];
            agg.counties[g.county[i]] = (agg.counties[g.county[i]] ?? 0) + pp;
          }
          const code = codes[d];
          const name = kind === 'cd' ? `${st}-${N === 1 ? 'AL' : +code.slice(2)}` : districts[`${kind}:${code}`]?.n ?? code;
          dists[code] = {
            n: name, pop: agg.pop, d: agg.w.map((x, j) => (j === 0 ? agg.pop : r3(x / (agg.pop || 1)))),
            lean: r3(agg.lean / (agg.pop || 1)), county: Object.entries(agg.counties).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
          };
        }
        const dSeats = Object.values(dists).reduce((s, x: any) => s + seatP(x.lean), 0);
        k.plans[pk] = {
          d: dists,
          towns: townTract.map((ti) => (ti < 0 ? -1 : codeIdx.get(codes[p.a[ti]]) ?? -1)),
          seats: { D: +dSeats.toFixed(1), R: +(N - dSeats).toFixed(1) },
        };
        (fields[`${kind}_${pk}`] = g.ids.map((_, i) => codes[p.a[i]]));
      }
      out[kind] = k;
      const s = (pk: PlanKey) => (k.plans[pk] ? `${k.plans[pk].seats.D}D` : '-');
      summary.push(`${st} ${kind}: ${N} seats · fair ${s('fair')} · D map ${s('D')} · R map ${s('R')}`);
    }
    writeJson(`redistrict/${st}.json`, out);
    // dissolve tracts into districts for every plan
    const layers = Object.keys(fields);
    if (layers.length) {
      const src = join(tmp, `${st}.json`);
      const feats = tractFeats.map((f, i) => ({ type: 'Feature', geometry: f.geometry, properties: Object.fromEntries(layers.map((l) => [l, fields[l][i]])) }));
      writeFileSync(src, JSON.stringify({ type: 'FeatureCollection', features: feats }));
      const args = ['-i', src, 'name=t'];
      for (const l of layers) args.push('-dissolve', l, '+', `name=${l}`, 'target=t', '-rename-fields', `GEOID=${l}`, `target=${l}`);
      args.push('-simplify', '4%', 'keep-shapes', 'target=*');
      // one file per map and plan (a game only ever loads the plan that was enacted)
      for (const l of layers) {
        const [kind, pk] = l.split('_');
        mkdirSync(join(OUT, 'geo', 'plans', kind), { recursive: true });
        args.push('-o', join(OUT, 'geo', 'plans', kind, `${st}-${pk}.json`), 'format=topojson', 'quantization=1e5', 'precision=0.0001', `target=${l}`, 'force');
      }
      execFileSync(process.execPath, [join('node_modules', 'mapshaper', 'bin', 'mapshaper'), ...args], { stdio: 'pipe' });
    }
    log(`${st}: ${g.n} tracts, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  rmSync(tmp, { recursive: true, force: true });
  log(summary.join('\n'));
}

function geoFc(rel: string, keep: (f: any) => boolean): FeatureCollection {
  const topo = readOut<any>(`geo/${rel}`);
  const fc = feature(topo, topo.objects[Object.keys(topo.objects)[0]]) as unknown as FeatureCollection;
  return { type: 'FeatureCollection', features: fc.features.filter(keep) };
}

main().catch((e) => { console.error(e); process.exit(1); });
