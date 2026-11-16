/**
 * Redistricting after the 2030 and 2040 censuses (M11, M22).
 *
 * December of a census year (2030, 2040): census results. House seats are reapportioned (Huntington–Hill on
 * projected populations, computed by pipeline/redistrict.ts) and electoral votes change from the next presidential
 * election on.
 *
 * The year after: every state redraws its congressional and legislative maps (May for the states with legislative
 * elections that year, September for the rest). Who holds the pen decides the map:
 *   - independent or bipartisan commissions (CA, AZ, MI, ...) draw the neutral plan. Bipartisan commissions can
 *     deadlock, and a court draws the map; NJ's tiebreaker member picks one party's (milder) map
 *   - one party's trifecta, or a veto-proof legislature (or NC's, where the governor has no veto), draws its own
 *     party's gerrymander: an aggressive one with a comfortable majority, a milder one with a thin majority
 *   - divided government deadlocks and a court draws its own map
 * Each plan was drawn ahead of time from census tracts (fair, each party's aggressive and milder gerrymander, and a
 * court plan), so new districts have real shapes, populations, demographics and leans. A governor gets to sign,
 * veto or ask for a milder map; a legislator in a narrow majority can sink their party's map. Gerrymanders can be
 * sued (the next February), and struck maps are replaced by a court's map or the legislature's milder remedial map.
 *
 * Mid-decade (M22): new suits against gerrymanders in odd Januaries, and in odd Marches a trifecta can redraw a
 * congressional map it didn't draw (or upgrade its own milder map, Texas style). Ohio's partisan maps expire after
 * two elections and are redrawn. A redraw is announced in March and enacted in June, with the player's say in May.
 *
 * Seats a state loses are eliminated when the new Congress is sworn in (January, census + 3); new seats are open
 * at the census + 2 election.
 */
import type { Engine } from './game';
import type { Decision, DecisionOption, MapKind, PlanChoice, PlanKey, Redistricting } from './model';
import { CENSUSES, planRef, type Party, type PlanVariant, type StatePlans } from '../data/types';
import { setApportionment } from './offices';
import { members } from './legislature';
import { Rng } from './rng';

/** The first census with new maps (pre-M11 saves past it catch up on load). */
export const CENSUS = CENSUSES[0];
const KINDS: MapKind[] = ['cd', 'sldu', 'sldl'];
const COMMISSION_CD = new Set(['AZ', 'CA', 'CO', 'HI', 'ID', 'MI', 'MT', 'NJ', 'VA', 'WA']);
const COMMISSION_SLD = new Set(['AK', 'AZ', 'CA', 'CO', 'HI', 'ID', 'MI', 'MO', 'MT', 'NJ', 'PA', 'VA', 'WA']);
/** Citizen commissions (members aren't chosen by party leaders) rarely deadlock. */
const CITIZEN = new Set(['AZ', 'CA', 'CO', 'MI']);
/** Commissions with a tiebreaker member, who picks one party's map instead of deadlocking (NJ; PA's legislative commission chair). */
const TIEBREAK = (st: string, kind: MapKind) => st === 'NJ' || (st === 'PA' && kind !== 'cd');
const DEADLOCK = { citizen: 0.04, bipartisan: 0.25 };
/** Legislative maps drawn by a board of statewide officials (the governor's party runs it). */
const BOARD_SLD = new Set(['AR', 'OH']);
/** The governor can't veto maps. */
const NO_VETO = new Set(['NC']);
/** Partisan congressional maps expire after two elections and are redrawn (Ohio's 2018 amendment). */
const SUNSET = new Set(['OH']);
/** Legislatures elected in November of the redraw year redraw first. */
const EARLY = new Set(['NJ', 'VA', 'LA', 'MS']);
export const enactMonth = (st: string, kind: MapKind) => (kind !== 'cd' && EARLY.has(st) ? 5 : 9);
/** A majority this big (in its thinner chamber) draws an aggressive gerrymander; thinner majorities draw a milder one. */
const AGGRESSIVE_SHARE = 0.58;
/** Odds a gerrymander is sued when enacted, and that a court strikes it down (by intensity). */
const SUE = { aggressive: 0.2, lean: 0.08, mid: 0.35, late: { aggressive: 0.06, lean: 0.025 } };
const STRIKE = { aggressive: 0.55, lean: 0.3 };
/** Mid-decade redraw odds: a trifecta replacing a map it didn't draw, or upgrading its own milder map. */
const REDRAW = { flip: 0.3, upgrade: 0.1, narrowHouse: 0.1, armsRace: 0.1 };
const MAP_LABEL: Record<MapKind, string> = { cd: 'congressional', sldu: 'state senate', sldl: 'state house' };
const adj = (p: Party) => (p === 'D' ? 'Democratic' : p === 'R' ? 'Republican' : 'independent');
const pname = (p: Party) => (p === 'D' ? 'Democrats' : 'Republicans');
const monthIndex = (y: number, m: number) => y * 12 + m;

type Side = 'D' | 'R';
const side = (p: Party | null | undefined): Side | null => (p === 'D' || p === 'R' ? p : null);
/** The party a plan favors, if it's a gerrymander. */
export const planParty = (p: PlanKey | null | undefined): Side | null => (p === 'D' || p === 'D-lean' ? 'D' : p === 'R' || p === 'R-lean' ? 'R' : null);
const isAggressive = (p: PlanKey | null | undefined) => p === 'D' || p === 'R';
const leanOf = (s: Side): PlanKey => (s === 'D' ? 'D-lean' : 'R-lean');
/** The census a plan choice belongs to. */
const censusOf = (c: PlanChoice | undefined) => c?.census ?? CENSUS;

/** The latest census whose results are in by this month. */
function censusDue(y: number, m: number): number | null {
  let out: number | null = null;
  for (const c of CENSUSES) if (y > c || (y === c && m === 12)) out = c;
  return out;
}

/** Census results: new seat counts and electoral votes. */
export async function census(e: Engine, year: number = CENSUS) {
  const a = await e.data.apportionment(year);
  const prev = e.s.redistricting;
  // the old maps stay in force until the new ones are enacted; old lawsuits and redraws lapse
  e.s.redistricting = { census: year, apportioned: true, plans: prev?.plans ?? {}, challenges: {}, retired: prev?.retired ?? [] };
  setApportionment(a.ev);
  const ch = Object.entries(a.seats).map(([st, n]) => [st, n - (a.before[st] ?? n)] as const).filter(([, d]) => d).sort((x, y) => y[1] - x[1]);
  const fmt = ([st, d]: readonly [string, number]) => `${e.data.states[st]?.n ?? st} ${d > 0 ? '+' : ''}${d}`;
  const gain = ch.filter(([, d]) => d > 0), lose = ch.filter(([, d]) => d < 0);
  const home = e.data.townSync(e.player.home)?.st;
  const mine = ch.find(([st]) => st === home);
  e.news({
    kind: 'national',
    title: gain.length ? `Census ${year}: ${gain.slice(0, 2).map(fmt).join(', ')} gain House seats${lose.length ? `; ${lose.slice(-1).map(fmt).join('')} loses the most` : ''}` : `Census ${year}: no state gains or loses a House seat`,
    body: `Gaining: ${gain.map(fmt).join(', ') || 'none'}. Losing: ${lose.map(fmt).join(', ') || 'none'}. Electoral votes change from the ${year + 4} election, and every state redraws its maps in ${year + 1}.`,
  });
  if (home && home !== 'DC') e.news({ kind: 'player', title: mine ? `${e.data.states[home].n} ${mine[1] > 0 ? 'gains' : 'loses'} ${Math.abs(mine[1])} House seat${Math.abs(mine[1]) > 1 ? 's' : ''}` : `${e.data.states[home].n} keeps ${a.seats[home]} House seat${a.seats[home] > 1 ? 's' : ''}`, body: `New district lines come in ${year + 1}, drawn by ${who(e, home, 'cd').by}.`, tone: 'neutral' });
}

/** Party control of the state legislature: the majority party, whether it can override a veto, and its majority in the thinner chamber. */
function legislature(e: Engine, st: string): { party: Side | null; veto: boolean; narrow: boolean; share: number } {
  let party: Side | null = null, veto = true, narrow = false, share = 1;
  for (const k of st === 'NE' ? ['sldu'] : ['sldu', 'sldl']) {
    const ms = members(e, `${k}:${st}`);
    const d = ms.filter((p) => p.party === 'D').length, r = ms.filter((p) => p.party === 'R').length;
    const maj: Side | null = d > r ? 'D' : r > d ? 'R' : null;
    if (!maj || (party && maj !== party)) return { party: null, veto: false, narrow: false, share: 0.5 };
    party = maj;
    const sh = Math.max(d, r) / (ms.length || 1);
    share = Math.min(share, sh);
    if (sh < 2 / 3) veto = false;
    if (sh < 0.54) narrow = true;
  }
  return { party, veto, narrow, share };
}

export interface Drawer {
  plan: PlanKey;
  by: string;
  /** Runs through the legislature (the player can have a say). */
  partisan: boolean;
  legis?: Side | null;
  gov?: Side | null;
  veto?: boolean;
  narrow?: boolean;
  /** The map the legislature's majority would pass (by the size of its majority). */
  drafted?: PlanKey | null;
  /** A commission that deadlocked, or whose tiebreaker picked a side. */
  deadlock?: boolean;
}

/** The map a majority passes: aggressive with room to spare, milder when it can't lose many votes. */
const drafted = (party: Side, share: number, veto: boolean): PlanKey => (veto || share >= AGGRESSIVE_SHARE ? party : leanOf(party));

/**
 * Who draws a map without the player's input, and whether the process runs through the legislature.
 * `final` decides commission deadlocks (seeded per state, map and census, so it doesn't touch the game's stream);
 * previews leave them out.
 */
export function who(e: Engine, st: string, kind: MapKind, final = false): Drawer {
  if (kind !== 'cd' && st === 'NE') return { plan: 'fair', by: 'the nonpartisan Unicameral', partisan: false };
  if (kind === 'cd' ? COMMISSION_CD.has(st) : COMMISSION_SLD.has(st)) {
    const census = e.s.redistricting?.census ?? CENSUS;
    const rng = new Rng(`${e.s.seed}|commission|${census}|${kind}|${st}`);
    if (TIEBREAK(st, kind)) {
      // each party's members submit a map; the tiebreaker usually picks the milder of the two, sometimes neither
      if (!final) return { plan: 'fair', by: 'a bipartisan commission with a tiebreaking chair', partisan: false };
      if (rng.chance(0.4)) return { plan: 'fair', by: 'a bipartisan commission, after its members agreed on a map', partisan: false };
      const lean = e.data.states[st]?.lean ?? 0.5;
      const pick: Side = rng.chance(lean) ? 'D' : 'R';
      return { plan: leanOf(pick), by: `a bipartisan commission, whose tiebreaker chose the ${adj(pick)} members’ map`, partisan: false, deadlock: true };
    }
    const odds = CITIZEN.has(st) ? DEADLOCK.citizen : DEADLOCK.bipartisan;
    if (final && rng.chance(odds)) return { plan: 'court', by: 'a court, after the commission deadlocked', partisan: false, deadlock: true };
    return { plan: 'fair', by: CITIZEN.has(st) ? 'an independent citizens’ commission' : 'a bipartisan commission', partisan: false };
  }
  const gov = side(e.pol(e.s.offices[`gov:${st}`]?.holder)?.party);
  const L = legislature(e, st);
  if (kind !== 'cd' && BOARD_SLD.has(st) && gov) return { plan: L.party === gov ? drafted(gov, L.share, L.veto) : leanOf(gov), by: `the ${adj(gov)}-led apportionment board`, partisan: false, gov };
  const draft = L.party ? drafted(L.party, L.share, L.veto) : null;
  const base = { partisan: true, legis: L.party, gov, veto: L.veto || NO_VETO.has(st), narrow: L.narrow, drafted: draft };
  if (L.party && L.party === gov) return { ...base, plan: draft!, by: `the ${adj(L.party)} legislature and governor` };
  if (L.party && (L.veto || NO_VETO.has(st))) return { ...base, plan: draft!, by: `the ${adj(L.party)} legislature${NO_VETO.has(st) ? '' : ', over the governor’s veto'}` };
  return { ...base, plan: 'court', by: 'a court, after the legislature and governor deadlocked' };
}

const planKey = (kind: MapKind, st: string) => `${kind}:${st}`;
/** Enacted plans as DataStore plan references ('R', '2040/court', ...). */
export const planMap = (R?: Redistricting | null) => Object.fromEntries(Object.entries(R?.plans ?? {}).map(([k, v]) => [k, planRef(v.census, v.plan)]));

/** Apply the enacted plans to the game's geography (districts, town memberships) and refresh caches. */
export async function applyGeography(e: Engine) {
  await e.data.applyPlans(planMap(e.s.redistricting));
  e.geographyChanged();
}

/** Called at the end of every month (after the elections). */
export async function redistrictingMonth(e: Engine) {
  const { year, month } = e.s;
  const due0 = censusDue(year, month);
  if (due0 == null) return;
  for (const c of CENSUSES) if (c <= due0 && (!e.s.redistricting || e.s.redistricting.census < c)) await census(e, c);
  const R = e.s.redistricting!;
  const C = R.census;
  // the player's say, a month ahead of each state's deadline
  for (const st of states(e)) {
    if (KINDS.some((k) => enactMonth(st, k) === month + 1 && year === C + 1)) await offerDecision(e, st);
  }
  // maps due this month (or overdue, for saves that skipped ahead)
  const now = monthIndex(year, month);
  const due: [string, MapKind][] = [];
  for (const st of states(e)) for (const k of KINDS) {
    const c = R.plans[planKey(k, st)];
    if ((!c || censusOf(c) < C) && monthIndex(C + 1, enactMonth(st, k)) <= now) due.push([st, k]);
  }
  if (due.length) await enact(e, due);
  // court rulings on gerrymanders
  for (const [key, when] of Object.entries(R.challenges ?? {})) if (when <= now) await rule(e, key);
  // later in the decade: new lawsuits, and mid-decade redraws
  if (year % 2 === 1 && year >= C + 3 && year <= C + 9) {
    if (month === 1) lateSuits(e);
    if (month === 3 && year <= C + 7) planRedraws(e);
    if (month === 5) for (const st of Object.keys(R.pending ?? {})) await offerDecision(e, st, true);
    if (month === 6 && R.pending && Object.keys(R.pending).length) await enactRedraws(e);
  }
}

const states = (e: Engine) => Object.keys(e.data.states).filter((s) => s !== 'DC');

async function enact(e: Engine, due: [string, MapKind][]) {
  const R = e.s.redistricting!;
  const C = R.census;
  const rng = new Rng(`${e.s.seed}|maps|${e.s.year}|${e.s.month}`);
  const home = e.data.townSync(e.player.home)?.st;
  const before = snapshotMine(e);
  const drawnBy: Record<string, string[]> = {};
  const deadlocked: string[] = [];
  for (const [st, kind] of due) {
    const file = await e.data.statePlans(st, C);
    const m = file[kind];
    const key = planKey(kind, st);
    let c: PlanChoice;
    if (!m) continue;
    const at = { year: e.s.year, month: e.s.month, ...(C !== CENSUS ? { census: C } : {}) };
    if (m.keep) c = { plan: 'keep', by: 'minor adjustments to the old lines', ...at };
    else if (kind === 'cd' && m.seats === 1) c = { plan: 'fair', by: 'a single at-large seat', ...at };
    else {
      const w = who(e, st, kind, true);
      const call = R.calls?.[st];
      const plan = w.partisan && call ? call : w.plan;
      c = { plan, by: w.partisan && call ? playerBy(e, st, call) : w.by, ...at };
      if (w.deadlock && kind === 'cd') deadlocked.push(e.data.states[st]?.n ?? st);
      if (w.deadlock && st === home && kind !== 'cd') deadlocked.push(`${e.data.states[st]?.n ?? st} (${MAP_LABEL[kind]})`);
      if (planParty(plan) && rng.chance(isAggressive(plan) ? SUE.aggressive : SUE.lean)) (R.challenges ??= {})[key] = monthIndex(e.s.year + 1, 2);
    }
    R.plans[key] = c;
    if (kind === 'cd' && m.codes) {
      for (const code of m.codes) if (!e.s.offices[`house:${code}`]) e.s.offices[`house:${code}`] = { id: `house:${code}`, holder: null, since: e.s.year };
      for (const code of m.retired ?? []) if (e.s.offices[`house:${code}`] && !(R.retired ??= []).includes(`house:${code}`)) R.retired.push(`house:${code}`);
    }
    const party = planParty(c.plan);
    if (kind === 'cd' && party) (drawnBy[party] ??= []).push(`${e.data.states[st]?.n ?? st}${isAggressive(c.plan) ? '' : ' (mildly)'}`);
  }
  await applyGeography(e);
  // coverage: the player's state in detail, the rest of the country in one line
  for (const [st, kind] of due) {
    if (st !== home) continue;
    const c = R.plans[planKey(kind, st)];
    const m = (await e.data.statePlans(st, C))[kind];
    if (!c || !m) continue;
    const seats = c.plan !== 'keep' ? m.plans?.[c.plan]?.seats : null;
    e.news({
      kind: 'office',
      title: `${e.data.states[st].n}’s new ${MAP_LABEL[kind]} map${headline(c.plan)}`,
      body: `Drawn by ${c.by}.${seats ? ` Expected seats: ${Math.round(seats.D)} D, ${Math.round(seats.R)} R.` : ''}${R.challenges?.[planKey(kind, st)] ? ' Opponents have sued; a court rules in February.' : ''}`,
      tone: 'neutral',
    });
  }
  const parts = (['R', 'D'] as const).filter((p) => drawnBy[p]?.length).map((p) => `${pname(p)} drew the maps in ${drawnBy[p].join(', ')}`);
  if (deadlocked.length) parts.push(`Commissions deadlocked or split in ${deadlocked.join(', ')}`);
  if (due.some(([, k]) => k === 'cd')) e.news({ kind: 'national', title: `Redistricting: ${due.filter(([, k]) => k === 'cd').length} states finish new congressional maps`, body: parts.length ? `${parts.join('; ')}. Commissions, courts and at-large states drew the rest.` : 'Commissions, courts and at-large states drew them.' });
  reportMine(e, before);
}

const headline = (p: PlanKey) => {
  const party = planParty(p);
  if (party) return isAggressive(p) ? ` favors ${pname(party)}` : ` tilts toward ${pname(party)}`;
  return p === 'keep' ? ' keeps the old lines' : p === 'court' ? ' is drawn by a court' : ' is drawn to be fair';
};

/** How the player's call changed who drew it. */
function playerBy(e: Engine, st: string, plan: PlanKey) {
  const def = e.player.officeId ? e.def(e.player.officeId) : null;
  const gov = e.name(e.pol(e.s.offices[`gov:${st}`]?.holder));
  if (plan === 'court' || plan === 'fair') return def?.type === 'governor' ? `a court, after Governor ${e.name(e.player)} vetoed the legislature’s map` : 'a court, after the legislature’s map failed by one vote';
  const party = planParty(plan)!;
  if (!isAggressive(plan) && def?.type === 'governor' && party === side(e.player.party)) return `the ${adj(party)} legislature, which toned down its map at Governor ${gov}’s insistence`;
  return `the ${adj(party)} legislature, with Governor ${gov}’s signature`;
}

/** The lean of the player's district (their seat, or the one their home is in) before a map change. */
function snapshotMine(e: Engine) {
  const out: Record<string, number> = {};
  const id = e.player.officeId;
  const t = id?.split(':')[0];
  if (t === 'house' || t === 'sldu' || t === 'sldl') {
    const k = t === 'house' ? `cd:${id!.split(':')[1]}` : id!;
    const d = e.data.districts[k];
    if (d) out[k] = d.lean;
  }
  return out;
}
function reportMine(e: Engine, before: Record<string, number>) {
  const C = e.s.redistricting?.census ?? CENSUS;
  for (const [k, lean0] of Object.entries(before)) {
    const d = e.data.districts[k];
    if (!d) continue;
    if (d.retired) {
      e.news({ kind: 'player', title: 'The new map eliminates your district', body: `${d.n} disappears when the new Congress meets in January ${C + 3}. To stay in Congress, run in your home's new district in ${C + 2} (Run tab).`, tone: 'bad' });
      continue;
    }
    const delta = Math.round((d.lean - lean0) * 200);
    if (Math.abs(delta) < 2) continue;
    const good = (e.player.party === 'D') === (delta > 0);
    e.news({ kind: 'player', title: `The new map makes your district ${delta > 0 ? 'bluer' : 'redder'}`, body: `${d.n} moves ${Math.abs(delta)} points toward ${delta > 0 ? 'Democrats' : 'Republicans'} (now ${lean(d.lean)}).`, tone: good ? 'good' : 'bad' });
  }
}
const lean = (x: number) => { const m = Math.round((x - 0.5) * 200); return m === 0 ? 'even' : m > 0 ? `D+${m}` : `R+${-m}`; };

/**
 * A court rules on a challenged gerrymander. Aggressive maps are struck down more often than milder ones. A struck
 * map is replaced by the court's own map, or (half the time, when the party that drew it still controls the
 * state) by the legislature's milder remedial map.
 */
async function rule(e: Engine, key: string) {
  const R = e.s.redistricting!;
  delete R.challenges![key];
  const c = R.plans[key];
  const party = planParty(c?.plan);
  if (!c || !party) return;
  const [kind, st] = key.split(':') as [MapKind, string];
  const rng = new Rng(`${e.s.seed}|court|${key}|${e.s.year}`);
  const struck = rng.chance(isAggressive(c.plan) ? STRIKE.aggressive : STRIKE.lean);
  const home = e.data.townSync(e.player.home)?.st;
  const show = st === home || kind === 'cd';
  const where = `${e.data.states[st].n}’s ${MAP_LABEL[kind]} map`;
  if (!struck) {
    if (show) e.news({ kind: st === home ? 'office' : 'national', title: `Court upholds ${where}`, tone: 'neutral' });
    return;
  }
  const before = snapshotMine(e);
  const w = who(e, st, kind);
  const remedial = isAggressive(c.plan) && w.partisan && w.legis === party && (w.gov === party || w.veto) && rng.chance(0.5);
  const at = { year: e.s.year, month: e.s.month, ...(c.census ? { census: c.census } : {}), ...(c.mid ? { mid: true } : {}) };
  R.plans[key] = remedial
    ? { plan: leanOf(party), by: `the ${adj(party)} legislature’s remedial map, after a court struck down its gerrymander`, struck: true, was: c.plan, remedial: true, ...at }
    : { plan: 'court', by: 'a court, which struck down the legislature’s gerrymander', struck: true, was: c.plan, ...at };
  await applyGeography(e);
  if (show) e.news({
    kind: st === home ? 'office' : 'national',
    title: `Court strikes down ${where} as a partisan gerrymander`,
    body: remedial ? `The legislature redraws a milder map in its place for the next election.` : 'A court-drawn map takes its place for the next election.',
    tone: 'neutral',
  });
  reportMine(e, before);
}

/** January of odd years after the first election under a map: new lawsuits against gerrymanders (voting-rights suits and the like). */
function lateSuits(e: Engine) {
  const R = e.s.redistricting!;
  const rng = new Rng(`${e.s.seed}|suits|${e.s.year}`);
  const home = e.data.townSync(e.player.home)?.st;
  for (const [key, c] of Object.entries(R.plans)) {
    if (!planParty(c.plan) || R.challenges?.[key] || censusOf(c) !== R.census) continue;
    if (!rng.chance(isAggressive(c.plan) ? SUE.late.aggressive : SUE.late.lean)) continue;
    (R.challenges ??= {})[key] = monthIndex(e.s.year + 1, 2);
    const [kind, st] = key.split(':') as [MapKind, string];
    if (st === home || kind === 'cd') e.news({ kind: st === home ? 'office' : 'national', title: `Voting-rights groups sue over ${e.data.states[st].n}’s ${MAP_LABEL[kind]} map`, body: `A court rules in February ${e.s.year + 1}, in time for that year’s election.`, tone: 'neutral' });
  }
}

/** Seats each party holds in the U.S. House. */
function houseSeats(e: Engine) {
  const n = { D: 0, R: 0 };
  for (const o of Object.values(e.s.offices)) {
    if (!o.id.startsWith('house:') || !o.holder) continue;
    const p = side(e.pol(o.holder)?.party);
    if (p) n[p]++;
  }
  return n;
}

/**
 * March of odd years: trifectas decide whether to redraw their congressional maps mid-decade. A new trifecta may
 * replace a map it didn't draw; a trifecta with a milder map of its own may go all the way (Texas style). A narrow
 * national House majority, and the other party redrawing the same spring, make it likelier. Ohio's partisan maps
 * expire after two elections and must be redrawn.
 */
function planRedraws(e: Engine) {
  const R = e.s.redistricting!;
  const rng = new Rng(`${e.s.seed}|redraw|${e.s.year}`);
  const H = houseSeats(e);
  const narrow = Math.abs(H.D - H.R) <= 10;
  const launched: Record<Side, number> = { D: 0, R: 0 };
  const home = e.data.townSync(e.player.home)?.st;
  const seats: Record<string, number> = {};
  for (const d of Object.values(e.data.districts)) if (d.kind === 'cd' && !d.retired) seats[d.st] = (seats[d.st] ?? 0) + 1;
  for (const st of states(e)) {
    const key = planKey('cd', st);
    const c = R.plans[key];
    if (!c || c.plan === 'keep' || censusOf(c) !== R.census || R.pending?.[st] || R.challenges?.[key] || COMMISSION_CD.has(st)) continue;
    if ((seats[st] ?? 0) < 2) continue;
    const w = who(e, st, 'cd');
    const sunset = SUNSET.has(st) && !c.mid && planParty(c.plan) && e.s.year >= c.year + 4;
    let why: 'flip' | 'upgrade' | 'sunset' | null = null;
    if (sunset) why = 'sunset';
    else if (w.partisan && w.legis && planParty(w.plan) === w.legis) {
      const P = w.legis;
      const mine = planParty(c.plan) === P;
      const bonus = (narrow ? REDRAW.narrowHouse : 0) + (launched[P === 'D' ? 'R' : 'D'] ? REDRAW.armsRace : 0);
      if (!mine && rng.chance(REDRAW.flip + bonus)) why = 'flip';
      else if (mine && !isAggressive(c.plan) && isAggressive(w.plan) && rng.chance(REDRAW.upgrade + bonus)) why = 'upgrade';
    }
    if (!why) continue;
    const plan = w.plan;
    const P = planParty(plan);
    if (P) launched[P]++;
    (R.pending ??= {})[st] = { plan, why, by: w.by, year: e.s.year };
    const name = e.data.states[st].n;
    e.news({
      kind: st === home ? 'office' : 'national',
      title: why === 'sunset'
        ? `${name}’s congressional map expires; ${w.partisan ? `the ${w.legis ? adj(w.legis) : 'divided'} legislature` : 'the state'} must draw a new one`
        : `${name} ${P ? pname(P) : 'leaders'} move to redraw the congressional map mid-decade`,
      body: why === 'sunset'
        ? 'Maps passed without bipartisan support last only two elections. A new map is due in June.'
        : `${why === 'upgrade' ? 'The map they drew after the census was a cautious one; this one would go further.' : 'They didn’t draw the current map, and now they control the process.'} A vote is expected in June${narrow ? ', with control of the U.S. House on a knife’s edge' : ''}.`,
      tone: 'neutral',
    });
  }
}

/** June: mid-decade redraws are enacted (unless the player's veto or vote sank one). */
async function enactRedraws(e: Engine) {
  const R = e.s.redistricting!;
  const rng = new Rng(`${e.s.seed}|redraws|${e.s.year}`);
  const home = e.data.townSync(e.player.home)?.st;
  const before = snapshotMine(e);
  const done: string[] = [];
  for (const [st, p] of Object.entries(R.pending ?? {})) {
    const key = planKey('cd', st);
    const c = R.plans[key];
    const name = e.data.states[st].n;
    const plan = p.call ?? p.plan;
    if (!c || plan === c.plan) {
      if (p.why === 'sunset' && c) R.plans[key] = { ...c, by: `${c.by} (readopted when the old map expired)`, year: e.s.year, month: e.s.month, mid: true };
      else e.news({ kind: st === home ? 'office' : 'national', title: `${name}’s mid-decade redraw fails`, body: 'The current map stays in place.', tone: 'neutral' });
      continue;
    }
    R.plans[key] = { plan, by: p.call ? playerBy(e, st, plan) : p.by, year: e.s.year, month: e.s.month, mid: true, ...(R.census !== CENSUS ? { census: R.census } : {}) };
    if (planParty(plan) && rng.chance(SUE.mid)) (R.challenges ??= {})[key] = monthIndex(e.s.year + 1, 2);
    done.push(`${name} (${headline(plan).trim()})`);
    const file = await e.data.statePlans(st, R.census);
    const seats = plan === 'keep' ? null : file.cd?.plans?.[plan]?.seats;
    if (st === home) e.news({ kind: 'office', title: `${name}’s new mid-decade congressional map${headline(plan)}`, body: `Drawn by ${R.plans[key].by}.${seats ? ` Expected seats: ${Math.round(seats.D)} D, ${Math.round(seats.R)} R.` : ''}${R.challenges?.[key] ? ' Opponents have sued; a court rules in February.' : ''}`, tone: 'neutral' });
  }
  R.pending = {};
  if (!done.length) return;
  await applyGeography(e);
  e.news({ kind: 'national', title: `Mid-decade redistricting: ${done.length} state${done.length > 1 ? 's' : ''} redraw${done.length > 1 ? '' : 's'} congressional maps`, body: `${done.join('; ')}. The new lines are in place for the ${e.s.year + 1} election.` });
  reportMine(e, before);
}

/** January after the new Congress is sworn in: seats lost in reapportionment are gone. */
export function retireSeats(e: Engine) {
  const R = e.s.redistricting;
  if (!R?.retired?.length || e.s.year < R.census + 3) return;
  for (const id of R.retired) {
    const o = e.s.offices[id];
    if (!o) continue;
    const p = e.pol(o.holder);
    if (p) {
      const def = e.def(id);
      p.officeId = undefined;
      p.career.push({ year: e.s.year, officeId: id, title: def?.title ?? id, result: 'left-office' });
      if (p.isPlayer) {
        e.news({ kind: 'player', title: `Your district is gone: you leave ${def?.title ?? 'Congress'}`, tone: 'bad' });
        e.playerLeftOffice();
      } else e.discard(p.id);
    }
    delete e.s.offices[id];
  }
  R.retired = [];
  e.geographyChanged();
}

// ------------------------------------------------------------------ the player's say

/**
 * Governors sign, veto or ask for a milder map; legislators in the majority vote (and can sink a map in a narrow
 * chamber). After a census (`mid` false) a failed map goes to a court; a failed mid-decade redraw (`mid` true)
 * leaves the current map in place.
 */
async function offerDecision(e: Engine, st: string, mid = false) {
  const me = e.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  const mine = side(me.party);
  const R = e.s.redistricting;
  const tid = mid ? `map:${st}:${e.s.year}` : R && R.census !== CENSUS ? `map:${st}:${R.census}` : `map:${st}`;
  if (!def || !mine || !R || def.st !== st || e.s.decisions.some((d) => d.templateId === tid)) return;
  const pending = mid ? R.pending?.[st] : null;
  if (mid && (!pending || pending.why === 'sunset' && !planParty(pending.plan))) return;
  const maps = mid
    ? [{ k: 'cd' as MapKind, w: who(e, st, 'cd') }]
    : KINDS.filter((k) => enactMonth(st, k) === e.s.month + 1).map((k) => ({ k, w: who(e, st, k) })).filter((x) => x.w.partisan);
  if (!maps.length || !maps[0].w.partisan) return;
  const w = maps[0].w;
  const file = await e.data.statePlans(st, R.census);
  const other: Side = mine === 'D' ? 'R' : 'D';
  const preview = (plan: PlanKey) => maps.map(({ k }) => {
    const s = file[k]?.plans?.[plan as 'fair']?.seats;
    return s ? `${MAP_LABEL[k]} ${Math.round(s.D)}D–${Math.round(s.R)}R` : null;
  }).filter(Boolean).join(', ') + homeDistrict(e, st, file, plan);
  // what failing means: the current map stays for a mid-decade redraw; a court draws the lines after a census (or
  // when Ohio's map has expired)
  const current = R.plans[planKey('cd', st)]?.plan;
  const stay = mid && current && pending!.why !== 'sunset';
  const fallback: PlanKey = stay ? current : 'court';
  const fallbackText = stay ? `The current map stays. Expected: ${preview(fallback)}.` : `A court will draw the lines. Expected: ${preview('court')}.`;
  const draft = mid ? pending!.plan : w.drafted ?? w.plan;
  const draftParty = planParty(draft);
  let options: DecisionOption[] = [];
  let plans: PlanKey[] = [];
  let body = '';
  const what = mid ? 'a mid-decade congressional map' : 'a map';
  if (def.type === 'governor') {
    if (w.legis === mine && draftParty === mine) {
      body = `Your party controls the legislature, and it has passed ${what} that ${isAggressive(draft) ? 'maximizes' : 'pads'} ${pname(mine)}’ seats. You can sign it, send it back for a milder version, or veto it.`;
      options = [
        { label: 'Sign the legislature’s map', detail: `Expected: ${preview(draft)}. Party leaders are thrilled; good-government groups cry foul.`, party: isAggressive(draft) ? 10 : 6, bloc: { wcol: isAggressive(draft) ? -0.02 : -0.01 } },
        ...(isAggressive(draft) ? [{ label: 'Insist on a milder map', detail: `Expected: ${preview(leanOf(mine))}. Fewer pickups, less exposure in court.`, party: 2 }] : []),
        { label: stay ? 'Veto it; keep the current map' : 'Veto it; let a court draw the lines', detail: `${fallbackText} Your party is furious, swing voters notice.`, party: -12, bloc: { wcol: 0.02, wnon: 0.01 } },
      ];
      plans = [draft, ...(isAggressive(draft) ? [leanOf(mine)] : []), fallback];
    } else if (w.legis === other && !w.veto && draftParty === other) {
      body = `The ${adj(other)} legislature passed ${what} that favors ${pname(other)}. Without enough votes to override you, it lives or dies on your desk.`;
      options = [
        { label: 'Veto it', detail: fallbackText, party: 8 },
        { label: 'Sign it as part of a budget deal', detail: `Expected: ${preview(draft)}. Your party won't forget.`, party: -15, metrics: { effectiveness: 1.5 } },
      ];
      plans = [fallback, draft];
    }
  } else if ((def.type === 'sldl' || def.type === 'sldu') && w.legis === mine && draftParty === mine && (mid || planParty(w.plan) === mine)) {
    body = `Your party’s leaders are moving ${mid ? 'a mid-decade congressional map' : 'maps'} that ${isAggressive(draft) ? 'favor' : 'tilt toward'} ${pname(mine)}.${w.narrow ? ' The majority is thin: your vote could decide it.' : ' They have votes to spare.'}`;
    options = [
      { label: 'Vote for the map', detail: `Expected: ${preview(draft)}.`, party: 4 },
      { label: 'Vote against it', detail: w.narrow ? `It would fail. ${fallbackText}` : 'A protest vote; it passes anyway.', party: -8, bloc: { wcol: 0.01 } },
    ];
    plans = [draft, w.narrow ? fallback : draft];
  }
  if (!options.length) return;
  const d: Decision = {
    id: e.newId('d'), templateId: tid, title: `Redistricting: ${e.data.states[st].n}’s ${mid ? 'mid-decade redraw' : 'new maps'}`, body,
    options, deadline: { year: e.s.year, month: e.s.month + 1 }, meta: { kind: 'map', map: st, plans, ...(mid ? { mid: true } : {}) },
  };
  e.s.decisions.push(d);
  e.news({ kind: 'office', title: `New maps reach your desk: ${e.data.states[st].n} redistricting`, body: 'Decide on the Office tab by next month.', tone: 'neutral' });
}

/** What the player's own district looks like under a plan. */
function homeDistrict(e: Engine, st: string, file: StatePlans, plan: PlanKey) {
  const t = e.data.townSync(e.player.home);
  const def = e.player.officeId ? e.def(e.player.officeId) : null;
  const kind = def?.type === 'sldl' ? 'sldl' : def?.type === 'sldu' ? 'sldu' : def?.type === 'house' ? 'cd' : null;
  const m = kind ? file[kind] : null;
  const p = plan === 'keep' ? null : m?.plans?.[plan];
  if (!t || !m?.codes || !p || t.st !== st) return '';
  const list = e.data.loadedTowns(st);
  const i = list?.findIndex((x) => x.id === t.id) ?? -1;
  const code = i >= 0 ? m.codes[p.towns[i]] : null;
  const dd = code ? p.d[code] : null;
  return dd ? `; your home district ${lean(dd.lean)}` : '';
}

/** Record the player's call on a map decision. */
export function answerMap(e: Engine, d: Decision, optionIdx: number) {
  const st = d.meta?.map;
  const plan = d.meta?.plans?.[optionIdx];
  const R = e.s.redistricting;
  if (!st || !plan || !R) return;
  if (d.meta?.mid) {
    const p = R.pending?.[st];
    if (p) p.call = plan;
    return;
  }
  (R.calls ??= {})[st] = plan;
}

/** Inspector rows for a state: enacted maps, or who will draw them. */
export async function stateMaps(e: Engine, st: string) {
  const R = e.s.redistricting;
  const C = R?.census ?? CENSUS;
  const file = await e.data.statePlans(st, C);
  const a = R?.apportioned ? await e.data.apportionment(C) : null;
  const pending = R?.pending?.[st] ?? null;
  return {
    census: C,
    seats: a ? { now: a.seats[st] ?? null, before: a.before[st] ?? null } : null,
    maps: KINDS.filter((k) => file[k]).map((k) => {
      const c0 = R?.plans[planKey(k, st)];
      // a map from the previous census is still in force, but this census's map isn't drawn yet
      const c = c0 && censusOf(c0) === C ? c0 : undefined;
      const m = file[k]!;
      const s = c && c.plan !== 'keep' ? m.plans?.[c.plan as PlanVariant]?.seats ?? null : null;
      const P = m.plans;
      return {
        kind: k, label: MAP_LABEL[k], enacted: !!c, plan: c?.plan ?? null, by: c?.by ?? who(e, st, k).by, struck: !!c?.struck,
        mid: !!c?.mid, year: c?.year ?? null,
        expected: s, keep: !!m.keep, when: enactMonth(st, k), challenged: !!R?.challenges?.[planKey(k, st)],
        redraw: k === 'cd' && pending ? { plan: pending.plan, why: pending.why } : null,
        range: P?.D && P?.R ? { D: P.D.seats.D, Dlean: P['D-lean']?.seats.D ?? null, fair: P.fair?.seats.D ?? null, court: P.court?.seats.D ?? null, Rlean: P['R-lean']?.seats.D ?? null, R: P.R.seats.D } : null,
      };
    }),
  };
}
