/**
 * Vote model.
 *
 * Each voting unit (county, town, synthetic precinct) has a real partisan lean and demographics.
 * The electorate is split into blocs (BLOCS) with their own partisanship, issue ideal points and salience.
 * A per-unit offset δ is calibrated so that two *generic* party candidates reproduce the unit's real lean.
 * Real candidates then deviate from that baseline through issue distance, name recognition,
 * favorability, money, endorsements, incumbency, scandal, the national environment and noise.
 */
import type { Demo, Party } from '../data/types';
import { BLOCS, N_BLOCS, PARTY_BASE, blocIdeal, blocSalience, blocShares, issueDistance, type Positions } from './issues';
import { Rng, clamp, expit, logit } from './rng';

export interface Unit {
  id: string;
  label: string;
  pop: number;
  lean: number; // D two-party share baseline
  demo: Demo;
  /** Optional per-unit candidate recognition override (by candidate id). */
  rec?: Record<string, number>;
  /** Map anchor for synthetic precincts: the town id the precinct is drawn at on election night. */
  geo?: string;
}

export interface Candidate {
  id: string;
  name: string;
  party: Party;
  pos: Positions;
  rec: number; // name recognition 0..1 (jurisdiction-wide)
  fav: number; // favorability among those who know them, 0..1
  /** Incumbency strength 0..1 (0 = not the incumbent; see incumbency.ts). */
  incumbent: number;
  spend: number;
  endorse: number; // count-ish, 0..10
  scandal: number; // 0..1
  skill: number; // campaign skill 0..1 (charisma/debate blend)
  emphasis?: Positions; // issues the candidate has made salient (0..1 each)
  bias?: number; // extra utility from events (debates, gaffes), logit units
}

export type RaceKind = 'general' | 'primary' | 'nonpartisan';

export interface RaceCtx {
  kind: RaceKind;
  /** Party holding the primary (kind === 'primary'). */
  party?: Party;
  /** National environment, D-positive, logit units. */
  env: number;
  /** How strongly national environment applies (1 federal, ~0.5 local). */
  envWeight: number;
  /** National issue salience emphasis 0..1 per issue. */
  natEmphasis?: Positions;
  /** Expected spending for this office — spending effects are relative to it. */
  expectedSpend: number;
  /** Per-candidate election-wide noise (logit), keyed by candidate id. */
  noise?: Record<string, number>;
  /** Scales the election-wide random swing (difficulty). Default 1. */
  noiseScale?: number;
}

/** Logit utility of full incumbency, scaled by the candidate's incumbency strength. */
export const INCUMBENCY = 0.35;
const ISSUE_W = { general: 2.4, primary: 4.0, nonpartisan: 3.0 };
const PARTISAN_W = { general: 1, primary: 0, nonpartisan: 0.35 };
const BLOC_D = BLOCS.map((b) => logit(b.dShare));

const genericCands = (): Candidate[] =>
  (['D', 'R'] as Party[]).map((p) => ({ id: p, name: p, party: p, pos: PARTY_BASE[p], rec: 0.5, fav: 0.5, incumbent: 0, spend: 1, endorse: 0, scandal: 0, skill: 0.5 }));

function partyTerm(party: Party, blocP: number) {
  if (party === 'D') return blocP / 2;
  if (party === 'R') return -blocP / 2;
  return -0.9 + -Math.abs(blocP) * 0.15; // independents: structural penalty
}

/** Utility of candidate c for bloc b given unit offset δ. */
function utility(c: Candidate, b: number, delta: number, ctx: RaceCtx, unit: Unit, includeValence: boolean): number {
  const blocP = BLOC_D[b] + delta;
  let u = PARTISAN_W[ctx.kind] * partyTerm(c.party, blocP);
  // Ideal point shifts with local partisanship (δ<0 → more conservative area). Primary voters lean to their party base.
  let ideal = blocIdeal(BLOCS[b].key);
  if (ctx.kind === 'primary' && ctx.party) ideal = ideal.map((x, i) => x * 0.35 + PARTY_BASE[ctx.party!][i] * 0.65);
  const shift = clamp(-delta * 0.22, -0.6, 0.6);
  u -= ISSUE_W[ctx.kind] * issueDistance(c.pos, ideal, blocSalience(BLOCS[b].key), shift, mergeEmphasis(c.emphasis, ctx.natEmphasis));
  if (ctx.kind === 'general') u += ctx.env * ctx.envWeight * (c.party === 'D' ? 0.5 : c.party === 'R' ? -0.5 : 0);
  if (includeValence) {
    const rec = unit.rec?.[c.id] ?? c.rec;
    u += 1.5 * (rec - 0.5) * (0.6 + 0.8 * c.fav); // being known helps if you are liked
    u += 2.0 * (c.fav - 0.5) * rec;
    u += INCUMBENCY * c.incumbent;
    u += 0.32 * Math.log((c.spend + ctx.expectedSpend * 0.15) / (ctx.expectedSpend * 0.6));
    u += 0.06 * Math.min(c.endorse, 8);
    u -= 1.8 * c.scandal;
    u += 0.4 * (c.skill - 0.5);
    u += c.bias ?? 0;
    u += ctx.noise?.[c.id] ?? 0;
  }
  return u;
}

function mergeEmphasis(a?: Positions, b?: Positions): Positions | undefined {
  if (!a && !b) return undefined;
  return Array.from({ length: (a ?? b)!.length }, (_, i) => (a?.[i] ?? 0) + (b?.[i] ?? 0));
}

/** Bloc weights for this unit and race (primaries reweight by party share). */
function blocWeights(unit: Unit, ctx: RaceCtx, delta: number): number[] {
  const w = blocShares(unit.demo);
  if (ctx.kind !== 'primary' || !ctx.party || ctx.party === 'I') return w;
  return w.map((x, b) => {
    const pD = expit(BLOC_D[b] + delta);
    return x * (ctx.party === 'D' ? pD : 1 - pD);
  });
}

/** Two-party D share for generic candidates given δ (no valence). */
function genericShare(unit: Unit, delta: number, ctx: RaceCtx): number {
  const [d, r] = genericCands();
  const gctx: RaceCtx = { ...ctx, kind: 'general', env: 0 };
  const w = blocShares(unit.demo);
  let dv = 0, tot = 0;
  for (let b = 0; b < N_BLOCS; b++) {
    const ud = utility(d, b, delta, gctx, unit, false), ur = utility(r, b, delta, gctx, unit, false);
    dv += w[b] * expit(ud - ur);
    tot += w[b];
  }
  return dv / tot;
}

const deltaCache = new Map<string, number>();
/** Solve δ so generic D vs R reproduces the unit's real lean (bisection). */
export function calibrate(unit: Unit): number {
  const key = `${unit.id}|${unit.lean}`;
  const hit = deltaCache.get(key);
  if (hit != null) return hit;
  const target = clamp(unit.lean, 0.02, 0.98);
  let lo = -8, hi = 8;
  const ctx: RaceCtx = { kind: 'general', env: 0, envWeight: 0, expectedSpend: 1 };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (genericShare(unit, mid, ctx) < target) lo = mid;
    else hi = mid;
  }
  const delta = (lo + hi) / 2;
  if (deltaCache.size > 50000) deltaCache.clear();
  deltaCache.set(key, delta);
  return delta;
}

/** Vote shares for each candidate in one unit, plus per-bloc breakdown and turnout. */
export function unitShares(unit: Unit, cands: Candidate[], ctx: RaceCtx) {
  const delta = calibrate(unit);
  const w = blocWeights(unit, ctx, delta);
  const shares = new Array(cands.length).fill(0);
  const byBloc: number[][] = [];
  let tot = 0;
  for (let b = 0; b < N_BLOCS; b++) {
    const us = cands.map((c) => utility(c, b, delta, ctx, unit, true));
    const m = Math.max(...us);
    const ex = us.map((u) => Math.exp(u - m));
    const s = ex.reduce((a, x) => a + x, 0);
    const p = ex.map((x) => x / s);
    byBloc.push(p);
    for (let i = 0; i < cands.length; i++) shares[i] += w[b] * p[i];
    tot += w[b];
  }
  return { shares: shares.map((x) => x / tot), byBloc, blocWeights: w.map((x) => x / tot) };
}

/** Turnout rate of adult population by race type (enthusiasm adjusts it slightly). */
export function turnoutRate(kind: RaceKind, level: number, presidentialYear: boolean, d: Demo) {
  const base = kind === 'primary' ? 0.16 : level <= 2 ? (presidentialYear ? 0.5 : 0.2) : presidentialYear ? 0.63 : 0.47;
  const adj = (d.college - 0.35) * 0.25 + (d.age - 39) * 0.004 - (d.hispanic - 0.19) * 0.15;
  return clamp(base + adj, 0.05, 0.85) * 0.77; // ~77% of residents are adults
}

export interface UnitResult {
  id: string;
  label: string;
  votes: number[];
  geo?: string;
}

export interface ElectionOutcome {
  cands: { id: string; name: string; party: Party }[];
  units: UnitResult[];
  totals: number[];
  winner: number;
  /** Exit-poll style: share for each candidate within each bloc (jurisdiction-wide). */
  blocs: { key: string; label: string; weight: number; shares: number[] }[];
}

/** Run an election over units. Noise per candidate is drawn once (shared swing) plus per-unit jitter. */
export function runElection(units: Unit[], cands: Candidate[], ctx: RaceCtx, rng: Rng, opts: { level: number; presYear: boolean }): ElectionOutcome {
  const noise: Record<string, number> = { ...(ctx.noise ?? {}) };
  for (const c of cands) noise[c.id] = (noise[c.id] ?? 0) + rng.normal(0, (ctx.kind === 'primary' ? 0.22 : 0.1) * (ctx.noiseScale ?? 1));
  const totals = new Array(cands.length).fill(0);
  const blocAgg = Array.from({ length: N_BLOCS }, () => ({ w: 0, s: new Array(cands.length).fill(0) }));
  const out: UnitResult[] = [];
  for (const u of units) {
    const local: Record<string, number> = {};
    for (const c of cands) local[c.id] = noise[c.id] + rng.normal(0, 0.05);
    const { shares, byBloc, blocWeights: bw } = unitShares(u, cands, { ...ctx, noise: local });
    const turnout = Math.round(u.pop * turnoutRate(ctx.kind, opts.level, opts.presYear, u.demo));
    const votes = shares.map((s) => Math.round(s * turnout));
    votes.forEach((v, i) => (totals[i] += v));
    for (let b = 0; b < N_BLOCS; b++) {
      blocAgg[b].w += bw[b] * turnout;
      for (let i = 0; i < cands.length; i++) blocAgg[b].s[i] += bw[b] * turnout * byBloc[b][i];
    }
    out.push(u.geo ? { id: u.id, label: u.label, votes, geo: u.geo } : { id: u.id, label: u.label, votes });
  }
  let winner = 0;
  totals.forEach((v, i) => { if (v > totals[winner]) winner = i; });
  return {
    cands: cands.map((c) => ({ id: c.id, name: c.name, party: c.party })),
    units: out,
    totals,
    winner,
    blocs: blocAgg.map((b, i) => ({ key: BLOCS[i].key, label: BLOCS[i].label, weight: b.w, shares: b.s.map((x) => x / (b.w || 1)) })),
  };
}

/** Fast single-unit two-party estimate used for the thousands of background races. */
export function quickDShare(unit: Unit, d: Candidate, r: Candidate, ctx: RaceCtx): number {
  const { shares } = unitShares(unit, [d, r], ctx);
  return shares[0] / (shares[0] + shares[1]);
}

/** Split one aggregate unit into synthetic precincts (for election-night reporting) preserving pop-weighted lean. */
export function syntheticPrecincts(base: Unit, n: number, rng: Rng, labels: string[]): Unit[] {
  const pops = Array.from({ length: n }, () => rng.range(0.5, 1.5));
  const sp = pops.reduce((a, b) => a + b, 0);
  const z0 = logit(base.lean);
  const offs = pops.map(() => rng.normal(0, 0.35));
  const mean = offs.reduce((a, o, i) => a + o * pops[i], 0) / sp;
  return pops.map((p, i) => ({
    id: `${base.id}#${i}`,
    label: labels[i % labels.length] + (i >= labels.length ? ` (${Math.floor(i / labels.length) + 1})` : ''),
    pop: Math.round((base.pop * p) / sp),
    lean: expit(z0 + offs[i] - mean),
    demo: base.demo,
    rec: base.rec,
  }));
}

/**
 * Anchor synthetic precincts to real towns so election night can draw them on the map.
 * Precincts are matched to the jurisdiction's largest towns by lean rank (the most Democratic precinct goes to
 * the most Democratic town), and relabeled with the town's name. Votes are unchanged.
 */
export function anchorPrecincts(units: Unit[], towns: { id: string; label: string; lean: number; pop: number }[]) {
  if (!units.length || !towns.length) return;
  const k = Math.min(units.length, towns.length);
  const picks = [...towns].sort((a, b) => b.pop - a.pop).slice(0, k).sort((a, b) => a.lean - b.lean);
  const order = units.map((_, i) => i).sort((a, b) => units[a].lean - units[b].lean);
  const seen: Record<string, number> = {};
  order.forEach((ui, r) => {
    const t = picks[Math.min(k - 1, Math.floor((r * k) / units.length))];
    const c = (seen[t.id] = (seen[t.id] ?? 0) + 1);
    units[ui].geo = t.id;
    units[ui].label = c > 1 ? `${t.label} (${c})` : t.label;
  });
}
