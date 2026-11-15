/**
 * Ballot measures (M19): statewide citizen initiatives, measures the legislature refers to the ballot, and local
 * measures in the player's state.
 *
 * - **Generation.** At the end of June in even years, each initiative state draws 0–2 measures (at least one in the
 *   states that use initiatives most) from templates built on the bill templates in governing.ts, weighted by issue
 *   salience, the template's frequency and how well the measure fits the state's lean. Towns of 50k+ in the player's home state sometimes get a local measure. Each
 *   state and town draws from its own seeded stream, so generation never touches the main RNG.
 * - **The vote** (November, after the background elections). An issue-only model: `unitShares` with two
 *   pseudo-candidates sitting at ±dir on the measure's issue and identical everywhere else (so party, valence and
 *   the other issues cancel), over the state's counties (or the town). A template's own popularity, campaigning
 *   (`push`) and a small status-quo lean toward No move the yes side's utility, and each measure gets its own
 *   election-day swing.
 * - **Effects.** A statewide measure that passes shifts the national economy like a state law (`lawEcon`, weighted
 *   by population) and raises its issue's salience. If the player is the executive of the area (the governor, or the
 *   mayor for a local measure) it becomes one of their laws in force (metric targets).
 * - **The player** can campaign for or against a measure in their state (the `measure` action), and governors and
 *   state legislators get a decision each May of an even year to refer a measure to the ballot.
 */
import { demoFrom } from '../data/types';
import { ISSUES, N_ISSUES, PARTY_BASE } from './issues';
import type { Decision, Measure } from './model';
import { Rng, clamp, expit, logit } from './rng';
import { turnoutRate, unitShares, type Candidate, type RaceCtx, type Unit } from './vote';
import { billTemplate, describeGroupEffects } from './governing';
import { addShift, lawEcon } from './budget';
import { aiChamberVote, chamberKey, chamberLabel, execChambers, otherChamber } from './legislature';
import { enactPolicy, shiftPositions } from './office';
import { noteLaw } from './legacy';
import { shortTownName, type OfficeDef } from './offices';
import { round3 } from './util';
import type { ActionResult, Engine } from './game';

/**
 * States where citizens can put a statute or constitutional amendment on the ballot, with the name their ballots use.
 * Mississippi's process was struck down by its supreme court in 2021, so it is left out.
 */
export const INITIATIVE_STATES: Record<string, string> = {
  AK: 'Ballot Measure', AZ: 'Proposition', AR: 'Issue', CA: 'Proposition', CO: 'Proposition', FL: 'Amendment', ID: 'Proposition', IL: 'Question',
  ME: 'Question', MA: 'Question', MI: 'Proposal', MO: 'Amendment', MT: 'Initiative', NE: 'Initiative', NV: 'Question', ND: 'Measure',
  OH: 'Issue', OK: 'State Question', OR: 'Measure', SD: 'Initiated Measure', UT: 'Proposition', WA: 'Initiative', WY: 'Initiative',
};
/** States whose ballots almost always carry an initiative (they always get at least one). */
const FREQUENT = new Set(['CA', 'CO', 'OR', 'WA', 'AZ', 'OH', 'MI', 'FL', 'MA', 'MO', 'NV']);
/** Ballot label for measures the legislature refers in a state without an initiative process. */
const REFERRAL_LABEL = 'Question';

/** Towns this big can have local measures. */
export const LOCAL_MIN_POP = 50000;
/** Most local measures per cycle in the player's state. */
const LOCAL_MAX = 8;

interface MeasureTemplate {
  /** Bill template (governing.ts) the measure is built on: its issue, direction, metric effects and interest groups. */
  bill: string;
  title: string;
  /** How often measures like this make the ballot (relative). */
  freq: number;
  /** The policy's own popularity with voters beyond its issue (logit units for yes). */
  pop: number;
}

/** Statewide measures. Popularity reflects how such measures tend to fare (minimum wage and Medicaid often pass in red states). */
export const STATE_MEASURES: MeasureTemplate[] = [
  { bill: 'min_wage', title: 'Raise the state minimum wage to $17 an hour', freq: 1.3, pop: 0.45 },
  { bill: 'rtw', title: 'Right-to-work amendment', freq: 0.4, pop: -0.25 },
  { bill: 'tax_cut', title: 'Cut the state income tax rate', freq: 0.9, pop: 0.15 },
  { bill: 'millionaire', title: 'Millionaire surtax for schools and transit', freq: 0.8, pop: 0.2 },
  { bill: 'police_budget', title: 'Fund more police and state troopers', freq: 0.5, pop: 0.1 },
  { bill: 'police_reform', title: 'Police accountability and body cameras', freq: 0.5, pop: 0.1 },
  { bill: 'zoning', title: 'Allow apartments near transit statewide', freq: 0.5, pop: -0.1 },
  { bill: 'rent', title: 'Let cities adopt rent stabilization', freq: 0.5, pop: -0.15 },
  { bill: 'vouchers', title: 'Education savings accounts for every child', freq: 0.6, pop: -0.25 },
  { bill: 'teacher_pay', title: 'Raise teacher pay to $55,000', freq: 0.5, pop: 0.2 },
  { bill: 'red_flag', title: 'Universal background checks for gun sales', freq: 0.6, pop: 0.3 },
  { bill: 'carry', title: 'Permitless carry amendment', freq: 0.3, pop: -0.3 },
  { bill: 'abortion_protect', title: 'Reproductive freedom amendment', freq: 1.2, pop: 0.3 },
  { bill: 'abortion_ban', title: 'Six-week abortion limit amendment', freq: 0.5, pop: -0.3 },
  { bill: 'clean_energy', title: '80% clean electricity by 2040', freq: 0.6, pop: 0 },
  { bill: 'drilling', title: 'Open state lands to oil and gas leasing', freq: 0.3, pop: -0.1 },
  { bill: 'medicaid', title: 'Expand Medicaid', freq: 0.9, pop: 0.4 },
  { bill: 'work_req', title: 'Work requirements for public assistance', freq: 0.5, pop: 0.15 },
  { bill: 'everify', title: 'Require E-Verify for every employer', freq: 0.5, pop: 0.1 },
  { bill: 'budget_cut', title: 'State spending cap amendment', freq: 0.5, pop: -0.05 },
  { bill: 'infra', title: 'Roads and water infrastructure bond', freq: 0.9, pop: 0.3 },
];

/** Local measures (towns of 50k+): levies, bonds, charter amendments. */
export const LOCAL_MEASURES: MeasureTemplate[] = [
  { bill: 'prop_tax', title: 'Property tax levy for roads and services', freq: 1.3, pop: -0.1 },
  { bill: 'prop_tax_cut', title: 'Roll back the property tax levy', freq: 0.6, pop: 0.1 },
  { bill: 'infra', title: 'Roads, parks and water bond', freq: 1.2, pop: 0.3 },
  { bill: 'police_budget', title: 'Public safety levy to hire 40 officers', freq: 0.8, pop: 0.15 },
  { bill: 'police_reform', title: 'Charter amendment: civilian police review board', freq: 0.5, pop: 0.05 },
  { bill: 'zoning', title: 'Allow apartments near transit and main streets', freq: 0.6, pop: -0.1 },
  { bill: 'zoning_local', title: 'Limit new building in residential neighborhoods', freq: 0.4, pop: 0 },
  { bill: 'rent', title: 'Rent stabilization charter amendment', freq: 0.6, pop: -0.05 },
  { bill: 'teacher_pay', title: 'School levy for teacher pay', freq: 0.8, pop: 0.15 },
  { bill: 'min_wage', title: 'City minimum wage of $17 an hour', freq: 0.5, pop: 0.35 },
  { bill: 'clean_energy', title: 'Clean energy for city buildings and buses', freq: 0.4, pop: 0.05 },
];

const TEMPLATES = new Map<string, MeasureTemplate>([...STATE_MEASURES, ...LOCAL_MEASURES].map((t) => [`${LOCAL_MEASURES.includes(t) ? 'local' : 'state'}:${t.bill}`, t]));
const templateOf = (m: Pick<Measure, 'town' | 'templateId'>) => TEMPLATES.get(`${m.town ? 'local' : 'state'}:${m.templateId}`);

// ------------------------------------------------------------------ the vote model

/** Where the two sides sit on the measure's issue, and how much the measure makes that issue the whole campaign. */
const ARM = 0.8;
const FOCUS = 6;
/** Voters lean No on measures they're unsure about (logit). */
const STATUS_QUO = 0.08;
/** Election-day swing per measure (logit). */
const NOISE = 0.15;

const issueIdx = (issue: string) => ISSUES.findIndex((x) => x.key === issue);

/** The yes and no sides as pseudo-candidates: identical except on the measure's issue. */
function sides(m: Pick<Measure, 'issue' | 'dir'>, yesBias: number): Candidate[] {
  const i = issueIdx(m.issue);
  const side = (id: 'yes' | 'no', at: number, bias: number): Candidate => {
    const pos = new Array(N_ISSUES).fill(0);
    pos[i] = at;
    const emphasis = new Array(N_ISSUES).fill(0);
    emphasis[i] = FOCUS;
    return { id, name: id === 'yes' ? 'Yes' : 'No', party: 'I', pos, rec: 0.5, fav: 0.5, incumbent: 0, spend: 1, endorse: 0, scandal: 0, skill: 0.5, emphasis, bias };
  };
  return [side('yes', m.dir * ARM, yesBias), side('no', -m.dir * ARM, 0)];
}

function ctxFor(e: Engine, noise = 0): RaceCtx {
  return { kind: 'nonpartisan', env: 0, envWeight: 0, expectedSpend: 1, natEmphasis: e.s.world.salience.map((x) => (x - 0.3) * 0.8), noise: { yes: noise } };
}

/** Voting units for a measure: the state's counties, or the town. */
async function unitsFor(e: Engine, m: Pick<Measure, 'st' | 'town'>): Promise<Unit[]> {
  if (m.town) {
    const t = e.data.townSync(m.town) ?? (await e.data.town(m.town));
    return t ? [{ id: t.id, label: shortTownName(t.name), pop: t.pop, lean: t.lean, demo: t.demo }] : [];
  }
  return Object.entries(e.data.counties)
    .filter(([, c]) => c.st === m.st)
    .map(([id, c]) => ({ id, label: c.n, pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d) }));
}

function yesBias(m: Pick<Measure, 'templateId' | 'town' | 'push'>) {
  return (templateOf(m)?.pop ?? 0) + (m.push ?? 0) - STATUS_QUO;
}

/** Yes and no votes over the units (turnout like a general election at the state level; local races at level 2). */
function count(e: Engine, m: Pick<Measure, 'issue' | 'dir' | 'templateId' | 'town' | 'push' | 'year'>, units: Unit[], noise: number) {
  const cands = sides(m, yesBias(m));
  const ctx = ctxFor(e, noise);
  let yes = 0, no = 0;
  for (const u of units) {
    const turnout = u.pop * turnoutRate('general', m.town ? 2 : 5, m.year % 4 === 0, u.demo) * 0.95;
    const { shares } = unitShares(u, cands, ctx);
    yes += shares[0] * turnout;
    no += shares[1] * turnout;
  }
  return { yes: Math.round(yes), no: Math.round(no) };
}

/** Projected yes share (no election-day noise). */
export async function projectSupport(e: Engine, m: Measure): Promise<number> {
  const r = count(e, m, await unitsFor(e, m), 0);
  return round3(r.yes / (r.yes + r.no || 1));
}
/** Same, when the units are already at hand (or the town is loaded): the share moves by the push since the last projection. */
function nudgeSupport(m: Measure, dPush: number) {
  m.support = round3(expit(logit(clamp(m.support, 0.01, 0.99)) + dPush * 0.9));
}

// ------------------------------------------------------------------ generation

function weightFor(e: Engine, t: MeasureTemplate, lean: number) {
  const b = billTemplate(t.bill);
  if (!b) return 0;
  const sal = e.s.world.salience[issueIdx(b.issue)] ?? 0.3;
  // proponents go where they can win: progressive measures in bluer places, conservative ones in redder places
  const fit = clamp(0.5 + (b.dir < 0 ? lean - 0.5 : 0.5 - lean) * 1.5, 0.15, 1);
  return t.freq * (0.25 + sal) * fit;
}

function make(e: Engine, o: { st: string; town?: string; label: string; t: MeasureTemplate; year: number; origin: Measure['origin'] }): Measure | null {
  const b = billTemplate(o.t.bill);
  if (!b) return null;
  return {
    id: `m:${o.town ?? o.st}:${o.year}:${o.t.bill}`, st: o.st, town: o.town, label: o.label, title: o.t.title, templateId: o.t.bill,
    issue: b.issue, dir: b.dir, year: o.year, origin: o.origin, support: 0.5,
  };
}

/** Templates used in this state (or town) in the last two cycles are left out, and so is anything on this year's ballot. */
function recentIn(e: Engine, where: string, year: number) {
  return new Set((e.s.measures ?? []).filter((m) => (m.town ?? m.st) === where && m.year >= year - 4).map((m) => m.templateId));
}

function draw(rng: Rng, e: Engine, pool: MeasureTemplate[], lean: number, used: Set<string>, n: number) {
  const out: MeasureTemplate[] = [];
  let avail = pool.filter((t) => !used.has(t.bill));
  for (let k = 0; k < n && avail.length; k++) {
    const t = rng.weighted(avail, avail.map((x) => weightFor(e, x, lean)));
    out.push(t);
    avail = avail.filter((x) => x !== t);
  }
  return out;
}

const LETTERS = 'ABCDEFGH';

/** End of June in an even year: initiatives qualify for the November ballot, and some big towns in the player's state add local measures. */
export async function generateMeasures(e: Engine, year: number) {
  const all = (e.s.measures ??= []);
  // keep the current cycle and the two before it
  e.s.measures = all.filter((m) => m.year >= year - 4);
  const fresh: Measure[] = [];
  for (const [st, word] of Object.entries(INITIATIVE_STATES)) {
    const S = e.data.states[st];
    if (!S) continue;
    const rng = new Rng(`${e.s.seed}|measures|${st}|${year}`);
    const r = rng.next();
    const n = Math.max(r < 0.3 ? 0 : r < 0.75 ? 1 : 2, FREQUENT.has(st) ? 1 : 0);
    const onBallot = e.s.measures.filter((m) => m.st === st && !m.town && m.year === year);
    for (const t of draw(rng, e, STATE_MEASURES, S.lean, recentIn(e, st, year), n)) {
      const m = make(e, { st, label: `${word} ${onBallot.length + 1}`, t, year, origin: 'initiative' });
      if (!m) continue;
      onBallot.push(m);
      fresh.push(m);
    }
  }
  // local measures in the player's home state
  const homeSt = e.data.townSync(e.player.home)?.st;
  if (homeSt) {
    const towns = (await e.data.townsOf(homeSt)).filter((t) => t.pop >= LOCAL_MIN_POP).sort((a, b) => b.pop - a.pop);
    let nLocal = 0;
    for (const t of towns) {
      if (nLocal >= LOCAL_MAX) break;
      const rng = new Rng(`${e.s.seed}|measures|${t.id}|${year}`);
      if (!rng.chance(t.id === e.player.home ? 0.5 : 0.2)) continue;
      const [tmpl] = draw(rng, e, LOCAL_MEASURES, t.lean, recentIn(e, t.id, year), 1);
      const m = tmpl && make(e, { st: homeSt, town: t.id, label: `Measure ${LETTERS[0]}`, t: tmpl, year, origin: 'local' });
      if (!m) continue;
      fresh.push(m);
      nLocal++;
    }
  }
  for (const m of fresh) m.support = await projectSupport(e, m);
  e.s.measures.push(...fresh);
  const statewide = e.s.measures.filter((m) => m.year === year && !m.town);
  if (statewide.length) {
    const states = new Set(statewide.map((m) => m.st)).size;
    e.news({ kind: 'measure', title: `${statewide.length} statewide ballot measures qualify in ${states} states`, body: statewide.slice(0, 6).map((m) => `${m.st}: ${m.title}`).join(' · ') });
  }
  const ours = fresh.filter((x) => x.st === homeSt);
  for (const m of ours.filter((x) => close(e, x))) {
    e.news({ kind: 'measure', title: `${placeOf(e, m)} ${m.label} qualifies: ${m.title}`, body: `Early polling: ${Math.round(m.support * 100)}% yes. You can campaign for or against it until the November vote.` });
  }
  const others = ours.filter((x) => !close(e, x));
  if (others.length) e.news({ kind: 'measure', title: `${others.length} local measure${others.length > 1 ? 's' : ''} on the ballot around ${e.data.states[homeSt!]?.n ?? homeSt}`, body: others.map((m) => `${placeOf(e, m)}: ${m.title}`).join(' · ') });
}

/** Measures that get their own news items: statewide ones in the player's state, the home town's, and any the player campaigned on. */
function close(e: Engine, m: Measure) {
  return !m.town || m.town === e.player.home || !!m.playerSide;
}

function placeOf(e: Engine, m: Measure) {
  if (m.town) {
    const t = e.data.townSync(m.town);
    return t ? shortTownName(t.name) : m.town;
  }
  return e.data.states[m.st]?.n ?? m.st;
}

// ------------------------------------------------------------------ the November vote

/** Executive of the measure's area (where a passed measure becomes one of the player's laws in force). */
function governsArea(e: Engine, m: Measure) {
  const def = e.player.officeId ? e.def(e.player.officeId) : null;
  if (!def?.executive) return false;
  if (m.town) return def.type === 'mayor' && def.jur.id === m.town;
  return def.type === 'governor' && def.st === m.st;
}

/** After the November background elections: every measure on this year's ballot is decided. */
export async function resolveMeasures(e: Engine, year: number) {
  const due = (e.s.measures ?? []).filter((m) => m.year === year && !m.result);
  if (!due.length) return;
  const homeSt = e.data.townSync(e.player.home)?.st;
  const us = Object.values(e.data.states).reduce((a, s) => a + s.pop, 0);
  for (const m of due) {
    const rng = new Rng(`${e.s.seed}|measure-vote|${m.id}`);
    const r = count(e, m, await unitsFor(e, m), rng.normal(0, NOISE));
    m.result = { ...r, passed: r.yes > r.no };
    if (!m.result.passed) continue;
    const b = billTemplate(m.templateId);
    if (!m.town) {
      addShift(e.s.world, lawEcon(m.issue, m.dir, ((e.data.states[m.st]?.pop ?? 0) / us) * 1.5));
      const i = issueIdx(m.issue);
      if (i >= 0) e.s.world.salience[i] = clamp(e.s.world.salience[i] + 0.015);
    }
    if (governsArea(e, m)) enactPolicy(e, m.id, `${m.label}: ${m.title}`, b?.metrics);
    if (m.sponsored) noteLaw(e, m.id, `${m.label}: ${m.title}`);
  }
  // the player's side
  const P = e.s.player;
  for (const m of due.filter((x) => x.playerSide)) {
    const won = (m.playerSide === 1) === m.result!.passed;
    if (won) e.player.fav = clamp(e.player.fav + 0.005);
    const partyDir = Math.sign(PARTY_BASE[e.player.party][issueIdx(m.issue)] || 0);
    if (won && m.playerSide! * m.dir === partyDir) P.partyStanding = clamp(P.partyStanding + 1, 0, 100);
  }
  const statewide = due.filter((m) => !m.town);
  if (statewide.length) {
    const passed = statewide.filter((m) => m.result!.passed);
    const tight = [...statewide].sort((a, b) => Math.abs(share(a) - 0.5) - Math.abs(share(b) - 0.5)).slice(0, 4);
    e.news({ kind: 'measure', title: `Ballot measures: ${passed.length} of ${statewide.length} pass`, body: tight.map((m) => `${m.st} ${m.title} ${m.result!.passed ? 'passes' : 'fails'} ${pctStr(share(m))}`).join(' · ') });
  }
  const ours = due.filter((x) => x.st === homeSt);
  const others = ours.filter((x) => !close(e, x));
  if (others.length) {
    const n = others.filter((m) => m.result!.passed).length;
    e.news({ kind: 'measure', title: `Local measures around ${e.data.states[homeSt!]?.n ?? homeSt}: ${n} of ${others.length} pass`, body: others.map((m) => `${placeOf(e, m)} ${m.title} ${m.result!.passed ? 'passes' : 'fails'} ${pctStr(share(m))}`).join(' · ') });
  }
  for (const m of ours.filter((x) => close(e, x))) {
    const tone = m.playerSide ? ((m.playerSide === 1) === m.result!.passed ? 'good' : 'bad') : 'neutral';
    const mine = m.playerSide ? ` You campaigned ${m.playerSide === 1 ? 'for' : 'against'} it.` : '';
    e.news({ kind: 'measure', title: `${placeOf(e, m)} ${m.label} ${m.result!.passed ? 'passes' : 'fails'}: ${m.title}`, body: `${pctStr(share(m))} yes.${mine}${m.result!.passed && governsArea(e, m) ? ' It is now one of the laws you carry out.' : ''}`, tone });
  }
}

const share = (m: Measure) => (m.result ? m.result.yes / (m.result.yes + m.result.no || 1) : m.support);
const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;

// ------------------------------------------------------------------ the player: campaigning on a measure

/** Measures still ahead on this year's ballot. */
const open = (e: Engine, m: Measure) => m.year === e.s.year && !m.result && e.s.month <= 11;

/** Whether the player can campaign on this measure: one in their home state, or a local one at home or in the area they serve or are running in. */
function reachable(e: Engine, m: Measure) {
  const home = e.data.townSync(e.player.home);
  if (!home || m.st !== home.st) return false;
  if (!m.town) return true;
  if (m.town === home.id) return true;
  const t = e.data.townSync(m.town);
  if (!t) return false;
  const c = e.s.campaign && e.s.campaign.stage !== 'done' ? e.s.campaign : null;
  return [c && e.def(c.officeId), e.player.officeId && e.def(e.player.officeId)].some((def) => !!def && townIn(def, t));
}
function townIn(def: OfficeDef, t: { id: string; st: string; county: string; cd: string | null; sldu: string | null; sldl: string | null }) {
  const { kind, id } = def.jur;
  return kind === 'nation' || (kind === 'state' && t.st === id) || (kind === 'county' && t.county === id) || (kind === 'town' && t.id === id)
    || (kind === 'cd' && t.cd === id) || (kind === 'sldu' && t.sldu === id) || (kind === 'sldl' && t.sldl === id);
}

export function campaignableMeasures(e: Engine) {
  return (e.s.measures ?? []).filter((m) => open(e, m) && reachable(e, m));
}

export function measureBlocked(e: Engine): string | null {
  if (campaignableMeasures(e).length) return null;
  const even = e.s.year % 2 === 0;
  return even && e.s.month <= 6 ? 'No ballot measures yet: they qualify at the end of June.' : even ? 'No open ballot measures in your state this year.' : 'Ballot measures are on the ballot in even years (they qualify in June).';
}

/** Repeat fatigue for campaigning on the same measure this month. */
export const MEASURE_REPEAT = 0.6;
/** Most the player's campaigning can add to (or take from) a measure's yes utility. */
export const MEASURE_PUSH_CAP = 0.4;

/** "Campaign on a ballot measure": `target` is `<measure id>|1` (yes) or `<measure id>|-1` (no). */
export function campaignOnMeasure(e: Engine, target: string | undefined, fat: number): ActionResult {
  const [id, s] = (target ?? '').split('|');
  const side = s === '-1' ? -1 : 1;
  const m = campaignableMeasures(e).find((x) => x.id === id);
  if (!m) return { ok: false, msg: 'Pick a measure on the ballot in your state.' };
  const P = e.s.player;
  const me = e.player;
  const area = m.town ?? m.st;
  const rec = e.recIn(area);
  // how far one push moves the vote: being known in the area matters most; a comms director helps
  const dPush = side * (0.025 + 0.08 * rec) * (1 + P.staff.comms * 0.15) * (0.7 + me.skills.charisma / 170) * fat;
  const before = m.push ?? 0;
  m.push = clamp(before + dPush, -MEASURE_PUSH_CAP, MEASURE_PUSH_CAP);
  nudgeSupport(m, m.push - before);
  e.bumpRec(area, 0.025 * (0.6 + me.skills.charisma / 120) * fat);
  const b = billTemplate(m.templateId);
  for (const [g, v] of Object.entries(b?.groups ?? {})) P.groups[g] = clamp((P.groups[g] ?? 0) + Math.sign(v) * side * 3 * fat, -100, 100);
  const partyDir = Math.sign(PARTY_BASE[me.party][issueIdx(m.issue)] || 0);
  const withParty = side * m.dir === partyDir;
  P.partyStanding = clamp(P.partyStanding + (withParty ? 1 : -2) * fat, 0, 100);
  // campaigning for a measure is a stand on its issue
  shiftPositions(e, { [m.issue]: 0.025 * side * m.dir * fat });
  let msg = `You campaigned ${side === 1 ? 'for' : 'against'} ${m.label} (${m.title}). It now polls at ${Math.round(m.support * 100)}% yes.`;
  if (m.playerSide && m.playerSide !== side) {
    me.fav = clamp(me.fav - 0.015);
    e.news({ kind: 'player', title: `${e.name(me)} switches sides on ${m.label}`, body: `${m.title}: now campaigning ${side === 1 ? 'for' : 'against'} it.`, tone: 'bad' });
    msg += ' Switching sides drew flip-flop headlines.';
  }
  m.playerSide = side;
  return { ok: true, msg };
}

// ------------------------------------------------------------------ the player: referring a measure to the ballot

const REFER_TYPES = new Set(['governor', 'sldl', 'sldu']);

/**
 * Start of May in an even year: a governor or state legislator may ask the legislature to put a measure on the
 * November ballot (due by the end of June, before the initiatives qualify). Options are measures that move the
 * player's party's way.
 */
export function offerReferral(e: Engine) {
  const def = e.player.officeId ? e.def(e.player.officeId) : null;
  if (!def || !REFER_TYPES.has(def.type) || !def.st || e.s.month !== 5 || e.s.year % 2 !== 0) return;
  if (e.s.decisions.some((d) => d.meta?.kind === 'measure')) return;
  const year = e.s.year;
  const st = def.st;
  const used = recentIn(e, st, year);
  const party = e.player.party;
  const own = STATE_MEASURES.filter((t) => {
    const b = billTemplate(t.bill);
    return b && !used.has(t.bill) && b.dir === Math.sign(PARTY_BASE[party][issueIdx(b.issue)] || 1);
  });
  const rng = new Rng(`${e.s.seed}|refer|${st}|${year}`);
  const picks = draw(rng, e, own, e.data.states[st]?.lean ?? 0.5, new Set(), 2);
  if (!picks.length) return;
  const exec = def.type === 'governor';
  const d: Decision = {
    id: e.newId('d'), templateId: 'measure_refer', title: `Put a measure on the ${year} ballot?`,
    body: exec
      ? `You can ask the legislature to refer a measure to the voters this November. It needs a majority in ${def.st === 'NE' ? 'the legislature' : 'both chambers'}; if voters pass it, it becomes law.`
      : 'You can sponsor a referral: if both chambers pass it, the measure goes to the voters this November instead of the governor.',
    options: [
      ...picks.map((t) => {
        const b = billTemplate(t.bill)!;
        return { label: `Refer: ${t.title}`, detail: describeGroupEffects(b.groups) || b.body, pick: t.bill };
      }),
      { label: 'Not this year', detail: 'Leave the ballot to the initiatives.' },
    ],
    deadline: { year, month: 6 },
    meta: { kind: 'measure' },
  };
  e.s.decisions.push(d);
}

/** The player's answer to a referral decision: the legislature votes, and a measure that passes goes on the ballot. */
export function referMeasure(e: Engine, d: Decision, optionIdx: number): ActionResult {
  const opt = d.options[optionIdx];
  e.s.decisions = e.s.decisions.filter((x) => x.id !== d.id);
  const P = e.s.player;
  P.record.unshift({ year: e.s.year, month: e.s.month, title: d.title, choice: opt.label });
  const def = e.player.officeId ? e.def(e.player.officeId) : null;
  const t = opt.pick ? STATE_MEASURES.find((x) => x.bill === opt.pick) : null;
  const b = t && billTemplate(t.bill);
  if (!def || !t || !b || !def.st) return { ok: true, msg: 'No referral this year.' };
  const own = chamberKey(def);
  const chambers = own ? [own, otherChamber(own)].filter((k): k is string => !!k) : execChambers(def);
  const votes = chambers.map((k) => ({ k, v: aiChamberVote(e, k, b.issue, b.dir, d.id, k === own ? 'yes' : null) }));
  const tally = votes.map((x) => `${chamberLabel(e, x.k)} ${x.v.yes}–${x.v.no}`).join(', ');
  if (!votes.every((x) => x.v.passes)) {
    e.news({ kind: 'office', title: `The legislature won't send "${t.title}" to the ballot`, body: `${tally}.`, tone: 'bad' });
    return { ok: true, msg: `The referral failed (${tally}).` };
  }
  const year = e.s.year;
  const word = INITIATIVE_STATES[def.st] ?? REFERRAL_LABEL;
  const n = (e.s.measures ?? []).filter((m) => m.st === def.st && !m.town && m.year === year).length;
  const m = make(e, { st: def.st, label: `${word} ${n + 1}`, t, year, origin: 'referred' })!;
  // the sponsor's backing is the first push
  m.push = 0.05;
  m.playerSide = 1;
  m.sponsored = true;
  (e.s.measures ??= []).push(m);
  // the projection needs the counties only (synchronous data), so compute it here
  const units = Object.entries(e.data.counties).filter(([, c]) => c.st === m.st).map(([id, c]) => ({ id, label: c.n, pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d) }));
  const r = count(e, m, units, 0);
  m.support = round3(r.yes / (r.yes + r.no || 1));
  P.partyStanding = clamp(P.partyStanding + 2, 0, 100);
  for (const [g, v] of Object.entries(b.groups ?? {})) P.groups[g] = clamp((P.groups[g] ?? 0) + v * 0.3, -100, 100);
  shiftPositions(e, { [b.issue]: 0.04 * b.dir });
  e.news({ kind: 'measure', title: `${m.label} goes to the voters: ${t.title}`, body: `The legislature referred your measure (${tally}). Early polling: ${Math.round(m.support * 100)}% yes.`, tone: 'good' });
  return { ok: true, msg: `${m.label} is on the November ballot (${tally}).` };
}

// ------------------------------------------------------------------ views

function viewOf(e: Engine, m: Measure) {
  const b = billTemplate(m.templateId);
  return {
    id: m.id, st: m.st, town: m.town ?? null, place: placeOf(e, m), label: m.label, title: m.title, body: b?.body ?? '', year: m.year, origin: m.origin,
    issue: ISSUES[issueIdx(m.issue)]?.label ?? m.issue, dir: m.dir, support: m.support, result: m.result ?? null, share: m.result ? share(m) : null,
    playerSide: m.playerSide ?? null, sponsored: !!m.sponsored, groups: describeGroupEffects(b?.groups),
  };
}
export type MeasureView = ReturnType<typeof viewOf>;

/** The player's state: this cycle's measures (or the last cycle's results), statewide first. */
export function measuresView(e: Engine) {
  const st = e.data.townSync(e.player.home)?.st;
  const mine = (e.s.measures ?? []).filter((m) => m.st === st);
  if (!st || !mine.length) return null;
  const year = Math.max(...mine.map((m) => m.year));
  const can = new Set(campaignableMeasures(e).map((m) => m.id));
  const list = mine
    .filter((m) => m.year === year)
    .sort((a, b) => rank(e, a) - rank(e, b) || placeOf(e, a).localeCompare(placeOf(e, b)) || a.label.localeCompare(b.label, undefined, { numeric: true }))
    .map((m) => ({ ...viewOf(e, m), canCampaign: can.has(m.id) }));
  return { st, year, list };
}

/** Statewide first, then the home town's, then other towns'. */
const rank = (e: Engine, m: Measure) => (!m.town ? 0 : m.town === e.player.home ? 1 : 2);

/** Every measure kept in the save for a state (the inspector): this cycle and the two before it. */
export function stateMeasures(e: Engine, st: string) {
  return (e.s.measures ?? []).filter((m) => m.st === st).sort((a, b) => b.year - a.year || a.label.localeCompare(b.label, undefined, { numeric: true })).map((m) => viewOf(e, m));
}
