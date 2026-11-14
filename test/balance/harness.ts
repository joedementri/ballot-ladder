/**
 * Headless balance harness: plays single races with a scripted player strategy and reports the outcome.
 * Used by test/balance.test.ts (small guard-rail run) and test/balance/report.ts (npm run balance).
 */
import { Engine } from '../../src/sim/game';
import { PARTY_BASE } from '../../src/sim/issues';
import { expectedSpend, type OfficeType } from '../../src/sim/offices';
import { GROUPS, groupAlignment } from '../../src/sim/campaign';
import { Rng, clamp } from '../../src/sim/rng';
import type { Town, Party } from '../../src/data/types';
import type { Difficulty } from '../../src/sim/model';

/** National environment for the race year, from the player's side: a wave for their party, against it, or as the game starts. */
export type Env = 'neutral' | 'good' | 'bad';

export type Strategy = 'passive' | 'fundraiser' | 'grassroots' | 'balanced';
export const STRATEGIES: Strategy[] = ['passive', 'fundraiser', 'grassroots', 'balanced'];

/** Office rungs the harness tests, with the id prefix used to find the seat and the year its race is run. */
export const RUNGS: { key: string; type: OfficeType; prefix: string[]; year: number; vsIncumbent?: boolean }[] = [
  { key: 'council', type: 'council', prefix: ['council:'], year: 2025 },
  { key: 'mayor', type: 'mayor', prefix: ['mayor:'], year: 2025 },
  { key: 'state house', type: 'sldl', prefix: ['sldl:'], year: 2026 },
  { key: 'state senate', type: 'sldu', prefix: ['sldu:'], year: 2026 },
  { key: 'us house', type: 'house', prefix: ['house:'], year: 2026 },
  { key: 'statewide', type: 'senate', prefix: ['gov:', 'sen:'], year: 2026 },
  // M14: a sitting governor or senator of the other party (skipped when they retire)
  { key: 'vs-incumbent', type: 'senate', prefix: ['gov:', 'sen:'], year: 2026, vsIncumbent: true },
];

export interface RaceResult {
  rung: string;
  strategy: Strategy;
  profile: 'newcomer' | 'climber';
  officeId: string;
  lean: number; // player's party two-party baseline in the jurisdiction
  vsIncumbent: boolean;
  /** The player's own primary included their party's sitting incumbent (party backing can't clear that field). */
  primaryVsIncumbent: boolean;
  /** Party leaders cleared the primary field (M14). */
  backed: boolean;
  won: boolean;
  lostAt: 'primary' | 'general' | null;
  share: number; // player's share of the last race they were in
  raised: number;
  spent: number;
  expected: number;
  rec: number;
  months: number;
}

/** A pool of candidate home towns: varied size and lean, drawn from a spread of states. */
export async function townPool(e: Engine, states = ['PA', 'OH', 'GA', 'AZ', 'WI', 'NC', 'MI', 'TX', 'CA', 'NY', 'FL', 'CO', 'MN', 'VA', 'IA']) {
  const out: Town[] = [];
  for (const st of states) for (const t of await e.data.townsOf(st)) if (t.pop >= 2500 && t.pop <= 400000) out.push(t);
  return out;
}

const char = (home: string, party: Party, seed: number, rng: Rng) => ({
  first: 'Sim', last: 'Player', gender: 'F' as const, age: 42, party, homeTown: home,
  background: rng.pick(['teacher', 'lawyer', 'business', 'veteran', 'union', 'activist'] as const),
  pos: PARTY_BASE[party].map((x) => x * 0.7),
  skills: { charisma: 55, debate: 55, fundraising: 55, policy: 55, integrity: 60, organization: 55 },
  seed,
});

/**
 * Play one race. Returns null if the town has no seat of this rung (or the player is ineligible).
 * Partisan races give the player the party favored in the seat's area, but only seats within
 * `maxLean` of even are used so the general election is genuinely contested.
 */
export async function playRace(e: Engine, o: { town: Town; rung: (typeof RUNGS)[number]; strategy: Strategy; profile: 'newcomer' | 'climber'; seed: number; difficulty?: Difficulty; maxLean?: number; env?: Env }): Promise<RaceResult | null> {
  const rng = new Rng(`harness|${o.seed}`);
  const leanParty: Party = o.town.lean >= 0.5 ? 'D' : 'R';
  let party: Party = rng.chance(0.75) ? leanParty : leanParty === 'D' ? 'R' : 'D';
  const ch = char(o.town.id, party, o.seed, rng);
  const setup = async () => {
    await e.newGame({ ...ch, party, pos: PARTY_BASE[party].map((x) => x * 0.7), difficulty: o.difficulty });
    if (o.rung.year > e.s.year) {
      // jump to January of the election year (a standard ~10-month campaign)
      e.s.year = o.rung.year;
      e.s.month = 1;
    }
    return (await e.availableOffices()).filter((x) => o.rung.prefix.some((p) => x.id.startsWith(p)) && x.year === o.rung.year && x.eligible);
  };
  let seats = await setup();
  if (o.rung.vsIncumbent) {
    // challenge a sitting officeholder of the other party, in a seat within maxLean of even for the challenger
    const held = rng.pick([null, ...seats.filter((x) => (x.holderParty === 'D' || x.holderParty === 'R') && Math.abs(x.lean - 0.5) <= (o.maxLean ?? 0.12))]);
    if (!held) return null;
    const want: Party = held.holderParty === 'D' ? 'R' : 'D';
    if (want !== party) {
      party = want;
      seats = await setup();
    }
    seats = seats.filter((x) => x.id === held.id);
  }
  const seat = seats[0];
  if (!seat) return null;
  setEnv(e, o.env ?? 'neutral', party);
  const def = e.def(seat.id)!;
  const myLean = party === 'D' ? seat.lean : 1 - seat.lean;
  if (def.partisan && Math.abs(myLean - 0.5) > (o.maxLean ?? 0.12)) return null;
  if (o.profile === 'climber') giveClimberHeadStart(e, seat.id);
  const filed = await e.file(seat.id);
  if (!filed.ok) return null;
  const c0 = e.s.campaign!;
  const vsIncumbent = [...c0.primaryField, ...c0.generalField, ...c0.otherField].some((id) => e.s.politicians[id]?.officeId === seat.id);
  if (o.rung.vsIncumbent && !vsIncumbent) return null; // the incumbent retired: an open seat, not this rung
  const primaryVsIncumbent = c0.stage === 'primary' && c0.primaryField.some((id) => id !== e.player.id && e.s.politicians[id]?.officeId === seat.id && e.s.politicians[id]?.party === party);
  const exp = expectedSpend(def.type, def.pop);
  let months = 0;
  for (; months < 30; months++) {
    const c = e.s.campaign;
    if (!c || c.stage === 'done') break;
    if (e.s.pendingNight) e.ackNight();
    await playMonth(e, o.strategy, months, rng);
    await e.endTurn();
    if (e.s.pendingNight) e.ackNight();
  }
  const me = e.player;
  const last = [...me.career].reverse().find((x) => x.officeId === seat.id && x.result !== 'took-office');
  const c = e.s.campaign ?? c0;
  return {
    rung: o.rung.key, strategy: o.strategy, profile: o.profile, officeId: seat.id, lean: myLean, vsIncumbent, primaryVsIncumbent, backed: c.backing === 'won',
    won: last?.result === 'won', lostAt: last?.result === 'lost-primary' ? 'primary' : last?.result === 'lost' ? 'general' : null,
    share: last?.share ?? 0, raised: c.raised, spent: c.spend[me.id] ?? 0, expected: exp, rec: e.recIn(e.jurKey(def)), months,
  };
}

/**
 * The race year's national mood. 'good' is a wave for the player's party: the other party holds the White House
 * with a 39% approval in a soft economy, so the midterm swings hard against it. 'bad' is the mirror image.
 */
export function setEnv(e: Engine, env: Env, party: Party) {
  if (env === 'neutral') return;
  const w = e.s.world;
  const other: Party = party === 'D' ? 'R' : 'D';
  w.presParty = env === 'good' ? other : party;
  w.presApproval = 0.39;
  w.honeymoon = 18;
  w.unemployment = 5.5;
  w.inflation = 4;
  // D-positive generic ballot: about 7 points against the President's party
  w.genericBallot = w.presParty === 'D' ? -7 : 7;
}

/** Someone who already held the rung below: some recognition in the area, a modest war chest, party ties, a volunteer staff. */
function giveClimberHeadStart(e: Engine, officeId: string) {
  const def = e.def(officeId)!;
  const P = e.s.player;
  e.bumpRec(e.player.home, 0.3);
  const k = e.jurKey(def);
  P.rec[k] = Math.max(P.rec[k] ?? 0, def.level >= 6 ? 0.18 : 0.25);
  if (def.jur.kind === 'state') for (const [f, c] of Object.entries(e.data.counties)) if (c.st === def.st) P.rec[f] = Math.max(P.rec[f] ?? 0, 0.15);
  P.cash += Math.round(expectedSpend(def.type, def.pop) * 0.15);
  P.partyStanding = 60;
  P.staff = { manager: 1, comms: 1, finance: 1, field: 1, policy: 0 };
}

/** Spend this month's action points according to the strategy. */
export async function playMonth(e: Engine, strategy: Strategy, month: number, rng: Rng) {
  if (strategy === 'passive') return;
  const P = e.s.player;
  const me = e.player;
  const targets = (await e.targets()).slice(0, 12);
  const pickTarget = () => {
    // most populous places where recognition is still low
    const t = [...targets].sort((a, b) => b.pop * (1 - e.recIn(b.id)) - a.pop * (1 - e.recIn(a.id)))[0];
    return t?.id ?? me.home;
  };
  const bestGroup = () => [...GROUPS].filter((g) => !P.endorsements.includes(g.key)).sort((a, b) => groupAlignment(me.pos, b) - groupAlignment(me.pos, a))[0]?.key;
  const c = e.s.campaign;
  const opp = c ? (c.stage === 'primary' ? c.primaryField : c.generalField).find((id) => id !== me.id) : undefined;
  const debateSoon = c && c.year === e.s.year && e.s.month === (c.stage === 'primary' ? c.primaryMonth : 11) - 1;
  const tryAct = async (id: string, target?: string) => {
    const cost = e.actionCost(id);
    if (P.ap < cost.ap || P.cash < cost.cash) return false;
    return (await e.act(id, target)).ok;
  };
  // staff hires in the first months
  const hires: Record<Strategy, string[]> = { passive: [], fundraiser: ['finance', 'comms', 'manager'], grassroots: ['field', 'manager'], balanced: ['manager', 'finance', 'field', 'comms'] };
  if (month < 3) for (const role of hires[strategy]) if ((P.staff as any)[role] < 1) await tryAct('hire', role);
  // M14: ask party leaders to clear a crowded primary
  const notes = e.actionNotes();
  if (!notes.party_backing.blocked) await tryAct('party_backing');
  // balanced campaigns dig into a sitting incumbent, then run against the record
  const inc = c && strategy === 'balanced' ? [...c.primaryField, ...c.generalField, ...c.otherField].find((id) => id !== me.id && e.s.politicians[id]?.officeId === c.officeId) : undefined;
  const incPlan: [string, string?][] = !inc ? [] : !(c!.oppoFound ?? []).includes(inc) ? [['oppo', inc]] : (c!.recordRuns ?? 0) < 4 ? [['record', inc]] : [];
  // M16: ground-game strategies run two get-out-the-vote drives in the final month
  if ((strategy === 'grassroots' || strategy === 'balanced') && !notes.gotv.blocked) for (let i = 0; i < 2; i++) await tryAct('gotv');
  let guard = 0;
  while (P.ap > 0 && guard++ < 20) {
    if (P.energy < 30 && (await tryAct('rest'))) continue;
    const plan: [string, string?][] =
      strategy === 'fundraiser'
        ? [['fund_big'], ['fund_pac', bestGroup()], ['ads_tv'], ['ads_digital'], ['fund_small']]
        : strategy === 'grassroots'
          ? [['canvass', pickTarget()], ['town_hall', pickTarget()], ['fund_small'], ['rally', pickTarget()], ['ads_digital'], ['community', pickTarget()]]
          : [
              ...(debateSoon ? ([['debate_prep']] as [string, string?][]) : []),
              ...incPlan,
              ...((month % 3 === 1 ? [['endorse', bestGroup()]] : []) as [string, string?][]),
              ['fund_small'], ['canvass', pickTarget()], ['ads_digital'], ['town_hall', pickTarget()], ['fund_big'],
              ...((opp && month % 4 === 3 ? [['attack_ad', opp]] : []) as [string, string?][]),
              ['ads_tv'],
            ];
    let did = false;
    for (const [id, t] of rotate(plan, guard + month)) if (await tryAct(id, t)) { did = true; break; }
    if (!did) break;
  }
  void rng;
  void clamp;
}

const rotate = <T,>(a: T[], k: number) => (a.length ? [...a.slice(k % a.length), ...a.slice(0, k % a.length)] : a);

export interface Summary {
  n: number;
  win: number;
  primaryLoss: number;
  /** Primary losses in races without a same-party incumbent in the player's primary. */
  openPrimaryLoss: number;
  backed: number;
  share: number;
  spendRatio: number;
  rec: number;
}
export function summarize(rs: RaceResult[]): Summary {
  const n = rs.length || 1;
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  return {
    n: rs.length,
    win: rs.filter((r) => r.won).length / n,
    primaryLoss: rs.filter((r) => r.lostAt === 'primary').length / n,
    openPrimaryLoss: rs.filter((r) => r.lostAt === 'primary' && !r.primaryVsIncumbent).length / (rs.filter((r) => !r.primaryVsIncumbent).length || 1),
    backed: rs.filter((r) => r.backed).length / n,
    share: med(rs.map((r) => r.share)),
    spendRatio: med(rs.map((r) => r.spent / r.expected)),
    rec: med(rs.map((r) => r.rec)),
  };
}

/** Run `n` races per strategy for one rung, cycling through home towns. */
export async function runRung(e: Engine, pool: Town[], rung: (typeof RUNGS)[number], o: { n: number; strategies?: Strategy[]; profile: 'newcomer' | 'climber'; difficulty?: Difficulty; seed?: number; env?: Env }) {
  const out: RaceResult[] = [];
  const order = new Rng(`pool|${rung.key}|${o.seed ?? 1}`);
  const towns = [...pool].sort(() => order.next() - 0.5);
  for (const strategy of o.strategies ?? STRATEGIES) {
    let got = 0;
    for (let i = 0; got < o.n && i < towns.length; i++) {
      const r = await playRace(e, { town: towns[i], rung, strategy, profile: o.profile, seed: (o.seed ?? 1) * 100000 + i, difficulty: o.difficulty, env: o.env });
      if (r) { out.push(r); got++; }
    }
  }
  return out;
}
