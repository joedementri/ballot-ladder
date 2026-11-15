/**
 * Election-night playback: turns a finished ResultSummary into a reporting timeline.
 *
 * Every unit (county, state or precinct) starts reporting at its own time and comes in over a few batches.
 * Early batches are skewed (early/mail vote differs from election-day vote), so leads can shift.
 * A "decision desk" calls each unit, each group (state) and the race when the lead is safe given the vote
 * still outstanding. The desk works from the final result plus a seeded error in its estimate of the margin
 * (M21), so similar contests are called at different times. State and race calls are never wrong. Rarely (at
 * most 1.5% of units, so only on nights with 67+ units), the desk calls a unit for a candidate who is ahead early
 * but goes on to lose it; the call is retracted when the lead flips, and the right call follows later.
 *
 * Pure and deterministic (seeded from the race), so replays play out exactly the same way.
 */
import type { ResultSummary } from './model';
import { Rng, clamp } from './rng';

export interface NightPlan {
  n: number;
  k: number;
  start: number[];
  dur: number[];
  batches: number[];
  /** Per unit, per candidate: relative skew of the early count (0 = counts in proportion). */
  skew: number[][];
  tot: number[];
  finalTotals: number[];
  finalTot: number;
  winnerIdx: number;
  /** Group key per unit (state code for presidential generals), or null. */
  groupOf: (string | null)[] | null;
  groupUnits: Record<string, number[]>;
  ev: Record<string, number> | null;
  /** When each unit is called (playback time); calls never revert. */
  unitCallAt: number[];
  /** When each group (state) is called. */
  groupCallAt: Record<string, number>;
  /** When the race is called. */
  raceCallAt: number;
  /** Premature unit calls that are later retracted, by unit index (M21). */
  retractions: Record<number, Retraction>;
}

/** A unit called for the wrong candidate at `at` and retracted at `retractAt`; the right call comes at unitCallAt. */
export interface Retraction {
  cand: number;
  at: number;
  retractAt: number;
}

/** Decision desk (M21): σ of its error on the final margin, and how often a premature call is made and retracted. */
export const DESK = {
  noise: 0.05,
  /** At most this share of a night's units can see a retracted call (nights under 67 units see none). */
  maxRetractShare: 0.015,
  /** Chance that an eligible early lead (one that flips later) draws a premature call. */
  wrongP: 0.6,
  /** An early lead that can draw one: at least this share of the expected vote in, and this lead over second place. */
  minIn: 0.2,
  minLead: 0.02,
};

export interface UnitFrame {
  /** Fraction of the expected vote counted (0..1). */
  f: number;
  votes: number[];
  counted: number;
  leader: number;
  /** Leader's margin over second place as a share of the counted vote. */
  margin: number;
  called: boolean;
  /** Who the desk has called it for (−1 if not called); can differ from the leader of the count. */
  callFor: number;
  /** A premature call was retracted and no new call has been made yet. */
  retracted?: boolean;
}

export interface GroupFrame extends UnitFrame {
  id: string;
  ev: number;
  allIn: boolean;
}

export interface NightFrame {
  t: number;
  units: UnitFrame[];
  tally: number[];
  counted: number;
  /** Share of the expected vote counted. */
  pctIn: number;
  unitsIn: number;
  unitsReporting: number;
  allIn: boolean;
  leader: number;
  called: boolean;
  groups: Record<string, GroupFrame> | null;
  /** Electoral votes from called states, per candidate. */
  evCalled: number[] | null;
  /** Electoral votes from states where the candidate leads but no call yet. */
  evLeading: number[] | null;
}

/** Poll-closing waves for a national night, as a fraction of the night (7 PM to 2 AM Eastern). */
const PACIFIC = new Set(['CA', 'OR', 'WA', 'NV']);
const MOUNTAIN = new Set(['AZ', 'CO', 'ID', 'MT', 'NM', 'UT', 'WY']);
const CENTRAL = new Set(['AL', 'AR', 'IL', 'IA', 'KS', 'LA', 'MN', 'MS', 'MO', 'NE', 'ND', 'OK', 'SD', 'TN', 'TX', 'WI']);
export function pollWave(st: string): number {
  if (st === 'AK' || st === 'HI') return 0.64;
  if (PACIFIC.has(st)) return 0.57;
  if (MOUNTAIN.has(st)) return 0.28;
  if (CENTRAL.has(st)) return 0.14;
  return 0.03;
}

const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

/** Indices of first and second place (second is −1 with one candidate). */
export function top2(v: number[]): [number, number] {
  let a = 0, b = -1;
  for (let i = 1; i < v.length; i++) {
    if (v[i] > v[a]) {
      b = a;
      a = i;
    } else if (b < 0 || v[i] > v[b]) b = i;
  }
  return [a, b];
}

/**
 * Whether a contest can be called from the counted vote.
 * Safe margins (by the final result) are called early; close ones wait until the outstanding vote can't
 * overturn the lead even if it breaks heavily against the leader. `noise` is the desk's error on the final margin.
 */
export function callable(votes: number[], final: number[], expected: number, allIn: boolean, minFrac = 0.12, noise = 0): boolean {
  if (allIn) return true;
  const counted = sum(votes);
  if (counted <= 0 || counted < expected * minFrac) return false;
  const [l, s] = top2(votes);
  const [fl, fs] = top2(final);
  if (l !== fl) return false;
  const finalMargin = (final[fl] - (fs >= 0 ? final[fs] : 0)) / (expected || 1) + noise;
  const k = finalMargin >= 0.3 ? 0.08 : finalMargin >= 0.15 ? 0.3 : 0.6;
  const rem = Math.max(0, expected - counted);
  return votes[l] - (s >= 0 ? votes[s] : 0) >= rem * k;
}

export interface PlanOpts {
  /** Group key for a unit id (e.g. its state), used for electoral votes and poll-closing waves. */
  groupOf?: (unitId: string) => string | null;
  /** Use poll-closing waves by time zone (national races). */
  waves?: boolean;
  /** Electoral votes per group (presidential generals). */
  ev?: Record<string, number>;
}

export function planNight(night: ResultSummary, opts: PlanOpts = {}): NightPlan {
  const rng = new Rng(`night|${night.officeId}|${night.year}|${night.stage}`);
  const n = night.units.length;
  const k = night.cands.length;
  const tot = night.units.map((u) => sum(u.votes));
  const maxTot = Math.max(1, ...tot);
  const finalTotals = new Array(k).fill(0);
  for (const u of night.units) u.votes.forEach((x, j) => (finalTotals[j] += x));
  const finalTot = sum(finalTotals);
  let winnerIdx = night.cands.findIndex((c) => c.id === night.winnerId);
  if (winnerIdx < 0) winnerIdx = top2(finalTotals)[0];

  const groupOf = opts.groupOf ? night.units.map((u) => opts.groupOf!(u.id)) : null;
  const groupUnits: Record<string, number[]> = {};
  groupOf?.forEach((g, i) => g && (groupUnits[g] ??= []).push(i));

  // Early votes lean one way across the whole race (a "mirage"), plus local variation.
  const global = Array.from({ length: k }, () => rng.normal(0, 0.08));
  const start: number[] = [], dur: number[] = [], batches: number[] = [], skew: number[][] = [];
  for (let i = 0; i < n; i++) {
    const wave = opts.waves && groupOf?.[i] ? pollWave(groupOf[i]!) : 0;
    const u = (i + rng.next()) / Math.max(1, n);
    const s = wave + (0.68 - wave) * Math.pow(u, 1.15);
    const d = Math.min(0.99 - s, 0.05 + 0.2 * Math.sqrt(tot[i] / maxTot) * rng.range(0.6, 1.2));
    start.push(s);
    dur.push(Math.max(0.02, d));
    batches.push(rng.int(2, 5));
    skew.push(global.map((g) => clamp(g + rng.normal(0, 0.1), -0.6, 0.6)));
  }
  const plan: NightPlan = {
    n, k, start, dur, batches, skew, tot, finalTotals, finalTot, winnerIdx, groupOf, groupUnits,
    ev: night.electoral && opts.ev && groupOf ? opts.ev : null,
    unitCallAt: [], groupCallAt: {}, raceCallAt: 1, retractions: {},
  };

  // The desk's errors come from their own stream, so the reporting timeline is the same as before M21.
  const desk = new Rng(`desk|${night.officeId}|${night.year}|${night.stage}`);
  const groupNoise: Record<string, number> = {};
  for (const g of Object.keys(groupUnits)) groupNoise[g] = desk.normal(0, DESK.noise);
  const raceNoise = desk.normal(0, DESK.noise);

  // Unit calls: the first batch at which the count is callable. Calls stick once made, except a premature call
  // (below), which is retracted when the lead flips.
  const eligible: { i: number; cand: number; bt: number; flip: number }[] = [];
  for (let i = 0; i < n; i++) {
    const b = batches[i], final = night.units[i].votes;
    const fl = top2(final)[0];
    const noise = desk.normal(0, DESK.noise);
    let callBt = b;
    let early: { cand: number; bt: number } | null = null, flip = -1;
    for (let bt = 1; bt < b; bt++) {
      const votes = partial(final, bt / b, skew[i]);
      const l = top2(votes)[0];
      if (early && flip < 0 && l === fl) flip = bt;
      if (callable(votes, final, tot[i], false, 0.12, noise)) {
        callBt = bt;
        break;
      }
      if (!early && l !== fl && looksSafe(votes, tot[i])) early = { cand: l, bt };
    }
    // A state reported as a single unit is never called wrong: its call is the state's call.
    const alone = groupOf?.[i] != null && groupUnits[groupOf[i]!].length === 1;
    if (early && flip > 0 && !alone) eligible.push({ i, cand: early.cand, bt: early.bt, flip });
    plan.unitCallAt.push(start[i] + (dur[i] * callBt) / b);
  }
  const cap = Math.floor(n * DESK.maxRetractShare);
  for (let j = eligible.length - 1; j > 0; j--) {
    const r = desk.int(0, j);
    [eligible[j], eligible[r]] = [eligible[r], eligible[j]];
  }
  for (const c of eligible) {
    if (Object.keys(plan.retractions).length >= cap) break;
    if (desk.next() >= DESK.wrongP) continue;
    const b = batches[c.i];
    const retractAt = start[c.i] + (dur[c.i] * c.flip) / b;
    plan.retractions[c.i] = { cand: c.cand, at: start[c.i] + (dur[c.i] * c.bt) / b, retractAt };
    // the right call waits at least one batch after the retraction
    if (plan.unitCallAt[c.i] <= retractAt) plan.unitCallAt[c.i] = start[c.i] + (dur[c.i] * Math.min(b, c.flip + 1)) / b;
  }

  // State and race calls: scan the night on a fine grid; each call is made at the first moment it's safe.
  const pending = new Set(Object.keys(groupUnits));
  let raceDone = false;
  for (let step = 0; step <= SAMPLES && (!raceDone || pending.size); step++) {
    const t = step / SAMPLES;
    const units = night.units.map((_, i) => unitFrame(night, plan, i, t));
    for (const g of [...pending]) {
      const gf = groupFrame(night, plan, { units }, groupUnits[g], g, true, groupNoise[g]);
      if (gf.called) {
        plan.groupCallAt[g] = t;
        pending.delete(g);
      }
    }
    if (!raceDone) {
      let called: boolean;
      const allIn = units.every((u) => u.f >= 1);
      if (plan.ev) {
        let ev = 0;
        for (const [g, at] of Object.entries(plan.groupCallAt)) {
          if (at > t) continue;
          const gv = groupFrame(night, plan, { units }, groupUnits[g], g);
          if (gv.leader === winnerIdx) ev += plan.ev[g] ?? 0;
        }
        called = allIn || ev >= 270;
      } else {
        const tally = new Array(k).fill(0);
        for (const u of units) u.votes.forEach((x, j) => (tally[j] += x));
        called = top2(tally)[0] === winnerIdx && callable(tally, finalTotals, finalTot, allIn, 0.25, raceNoise);
      }
      if (called) {
        plan.raceCallAt = t;
        raceDone = true;
      }
    }
  }
  for (const g of pending) plan.groupCallAt[g] = 1;
  return plan;
}
const SAMPLES = 200;

/**
 * An early lead the desk could wrongly call: a fifth of the vote in and a visible lead. Leads that later flip are
 * thin (the early-vote skew fades as the count goes on), so a premature call is the desk trusting its own estimate
 * of the area over the count.
 */
function looksSafe(votes: number[], expected: number): boolean {
  const counted = sum(votes);
  if (counted < expected * DESK.minIn) return false;
  const [l, s] = top2(votes);
  return votes[l] - (s >= 0 ? votes[s] : 0) >= counted * DESK.minLead;
}

/** Early count for one unit: f of the final vote, distorted by the unit's early-vote skew (gone at f = 1). */
function partial(final: number[], f: number, skew: number[]): number[] {
  return f >= 1 ? final.slice() : final.map((x, j) => Math.round(x * f * (1 + skew[j] * (1 - f))));
}

function unitFrame(night: ResultSummary, plan: NightPlan, i: number, t: number): UnitFrame {
  const raw = (t - plan.start[i]) / plan.dur[i];
  const b = plan.batches[i];
  const f = raw >= 1 ? 1 : raw <= 0 ? 0 : Math.floor(raw * b) / b;
  const votes = partial(night.units[i].votes, f, plan.skew[i]);
  const counted = sum(votes);
  const [l, s] = top2(votes);
  const margin = counted > 0 ? (votes[l] - (s >= 0 ? votes[s] : 0)) / counted : 0;
  const called = f >= 1 || (plan.unitCallAt.length > 0 && counted > 0 && t >= plan.unitCallAt[i]);
  if (called) return { f, votes, counted, leader: l, margin, called, callFor: f >= 1 ? l : top2(night.units[i].votes)[0] };
  const r = plan.retractions?.[i];
  if (r && counted > 0 && t >= r.at) {
    if (t < r.retractAt) return { f, votes, counted, leader: l, margin, called: true, callFor: r.cand };
    return { f, votes, counted, leader: l, margin, called: false, callFor: -1, retracted: true };
  }
  return { f, votes, counted, leader: l, margin, called: false, callFor: -1 };
}

/**
 * Aggregate a set of units (a state, or the precincts of one town) into one contest.
 * States use the latched call time from the plan; other groups are judged from the current count.
 */
export function groupFrame(night: ResultSummary, plan: NightPlan, frame: { units: UnitFrame[] }, idxs: number[], id = '', judge = false, noise = 0): GroupFrame {
  const k = plan.k;
  const votes = new Array(k).fill(0), final = new Array(k).fill(0);
  let expected = 0, allIn = true, allCalled = true;
  for (const i of idxs) {
    const u = frame.units[i];
    u.votes.forEach((x, j) => (votes[j] += x));
    night.units[i].votes.forEach((x, j) => (final[j] += x));
    expected += plan.tot[i];
    if (u.f < 1) allIn = false;
    if (!u.called) allCalled = false;
  }
  const counted = sum(votes);
  const [l, s] = top2(votes);
  const latched = !judge && id && plan.groupCallAt[id] != null ? (frame as { t?: number }).t : undefined;
  // outside planning, one unit's call stands for its group (a town with a single precinct), premature calls included
  const one = idxs.length === 1 && !judge && latched == null ? frame.units[idxs[0]] : null;
  const called = counted > 0 && (latched != null ? latched >= plan.groupCallAt[id] : one ? one.called : allIn || callable(votes, final, expected, allIn, 0.12, noise) || (allCalled && idxs.length === 1));
  return {
    id, ev: plan.ev?.[id] ?? 0, allIn,
    f: expected ? Math.min(1, counted / expected) : 0,
    votes, counted, leader: l,
    margin: counted > 0 ? (votes[l] - (s >= 0 ? votes[s] : 0)) / counted : 0,
    called,
    callFor: !called ? -1 : one ? one.callFor : allIn ? l : top2(final)[0],
    retracted: one?.retracted,
  };
}

/** Everything the panel and map need at playback time t (0..1). */
export function frameAt(night: ResultSummary, plan: NightPlan, t: number): NightFrame {
  const units: UnitFrame[] = [];
  const tally = new Array(plan.k).fill(0);
  let unitsIn = 0, unitsReporting = 0;
  for (let i = 0; i < plan.n; i++) {
    const u = unitFrame(night, plan, i, t);
    units.push(u);
    u.votes.forEach((x, j) => (tally[j] += x));
    if (u.f >= 1) unitsIn++;
    if (u.f > 0) unitsReporting++;
  }
  const counted = sum(tally);
  const allIn = unitsIn === plan.n;
  let groups: Record<string, GroupFrame> | null = null;
  let evCalled: number[] | null = null, evLeading: number[] | null = null;
  if (plan.groupOf) {
    groups = {};
    for (const [g, idxs] of Object.entries(plan.groupUnits)) groups[g] = groupFrame(night, plan, { units, t } as NightFrame, idxs, g);
  }
  if (plan.ev && groups) {
    evCalled = new Array(plan.k).fill(0);
    evLeading = new Array(plan.k).fill(0);
    for (const g of Object.values(groups)) if (g.counted > 0) (g.called ? evCalled : evLeading)[g.leader] += g.ev;
  }
  return { t, units, tally, counted, pctIn: plan.finalTot ? counted / plan.finalTot : 0, unitsIn, unitsReporting, allIn, leader: top2(tally)[0], called: allIn || t >= plan.raceCallAt, groups, evCalled, evLeading };
}

/** Wall-clock label for playback time (local races: polls close 8 PM; national: 7 PM to 2 AM Eastern). */
export function clockAt(t: number, national: boolean): string {
  const startH = national ? 19 : 20;
  const mins = Math.round((startH + t * (national ? 7 : 5)) * 60);
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}${national ? ' ET' : ''}`;
}

export interface KeyItem {
  tag: string;
  why: string;
  unit?: number;
  group?: string;
}

/**
 * Units worth watching: the biggest vote prize, a bellwether that mirrors the overall margin, the closest
 * battleground, each finalist's base, and the player's home. For electoral races, also the tipping-point state.
 */
export function keyItems(night: ResultSummary, plan: NightPlan, opts: { home?: { unit?: number; group?: string }; unitWord: string }): KeyItem[] {
  const out: KeyItem[] = [];
  const used = new Set<string>();
  const add = (it: KeyItem) => {
    const key = it.unit != null ? `u${it.unit}` : `g${it.group}`;
    if (used.has(key)) return;
    used.add(key);
    out.push(it);
  };
  const a = plan.winnerIdx;
  const rest = plan.finalTotals.map((v, i) => [v, i] as const).filter(([, i]) => i !== a).sort((x, y) => y[0] - x[0]);
  const b = rest[0]?.[1] ?? -1;
  const last = (i: number) => shortName(night, i);

  // Electoral races: tipping point and closest states.
  if (plan.ev && b >= 0) {
    const ev = plan.ev;
    const states = Object.entries(plan.groupUnits).map(([g, idxs]) => {
      const f = [0, 0];
      let tot = 0;
      for (const i of idxs) {
        f[0] += night.units[i].votes[a];
        f[1] += night.units[i].votes[b];
        tot += plan.tot[i];
      }
      return { g, m: (f[0] - f[1]) / (tot || 1), ev: ev[g] ?? 0 };
    });
    const won = states.filter((s) => s.m > 0).sort((x, y) => y.m - x.m);
    let acc = 0;
    for (const s of won) {
      acc += s.ev;
      if (acc >= 270) {
        add({ tag: 'Tipping point', why: 'The state that puts the winner over 270', group: s.g });
        break;
      }
    }
    const close = [...states].filter((s) => s.ev >= 6).sort((x, y) => Math.abs(x.m) - Math.abs(y.m));
    if (close[0]) add({ tag: 'Closest state', why: 'Expected to be the tightest major contest', group: close[0].g });
    const bigClose = close.find((s) => s.ev >= 15 && !used.has(`g${s.g}`));
    if (bigClose) add({ tag: 'Big prize', why: `${bigClose.ev} electoral votes in play`, group: bigClose.g });
    if (opts.home?.group) add({ tag: 'Home state', why: 'Where your career started', group: opts.home.group });
  }

  const n = plan.n;
  if (!n) return out;
  const sortedTot = [...plan.tot].sort((x, y) => x - y);
  const floor = n <= 4 ? 0 : sortedTot[Math.floor(n * 0.4)];
  const eligible = plan.tot.map((t, i) => [t, i] as const).filter(([t]) => t >= floor).map(([, i]) => i);
  const margin = (i: number) => (b < 0 ? 1 : (night.units[i].votes[a] - night.units[i].votes[b]) / (plan.tot[i] || 1));
  const M = b < 0 ? 1 : (plan.finalTotals[a] - plan.finalTotals[b]) / (plan.finalTot || 1);
  const pick = (score: (i: number) => number) => {
    let best = -1, bs = Infinity;
    for (const i of eligible) {
      if (used.has(`u${i}`)) continue;
      const s = score(i);
      if (s < bs) {
        bs = s;
        best = i;
      }
    }
    return best;
  };

  if (!plan.ev) {
    const big = plan.tot.indexOf(Math.max(...plan.tot));
    add({ tag: 'Biggest vote', why: `Most votes of any ${opts.unitWord}`, unit: big });
  }
  if (b >= 0 && n > 2) {
    const bell = pick((i) => Math.abs(margin(i) - M));
    if (bell >= 0) add({ tag: 'Bellwether', why: 'Its margin tends to mirror the whole race', unit: bell });
    if (!plan.ev) {
      const close = pick((i) => Math.abs(margin(i)));
      if (close >= 0) add({ tag: 'Battleground', why: `The most closely divided large ${opts.unitWord}`, unit: close });
      const baseA = pick((i) => -margin(i));
      if (baseA >= 0) add({ tag: `${last(a)} base`, why: `${last(a)} needs big numbers here`, unit: baseA });
      const baseB = pick((i) => margin(i));
      if (baseB >= 0) add({ tag: `${last(b)} base`, why: `${last(b)} needs big numbers here`, unit: baseB });
    }
  }
  if (opts.home?.unit != null && opts.home.unit >= 0) add({ tag: 'Home', why: 'Your home turf', unit: opts.home.unit });
  return out.slice(0, 6);
}

const shortCache = new WeakMap<object, string[]>();
/** Short display names: last name, or "A. Quinn" when two candidates share a last name. */
export function shortName(night: Pick<ResultSummary, 'cands'>, i: number): string {
  let names = shortCache.get(night.cands);
  if (!names) {
    const parts = night.cands.map((c) => c.name.split(' '));
    const lasts = parts.map((p) => p[p.length - 1]);
    names = parts.map((p, j) => {
      if (lasts.filter((l) => l === lasts[j]).length === 1) return lasts[j];
      const ini = `${p[0][0]}. ${lasts[j]}`;
      return parts.filter((q, m) => m !== j && `${q[0][0]}. ${lasts[m]}` === ini).length ? night.cands[j].name : ini;
    });
    shortCache.set(night.cands, names);
  }
  return names[i];
}
