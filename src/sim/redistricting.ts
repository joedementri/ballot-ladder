/**
 * Redistricting after the 2030 census (M11).
 *
 * December 2030: census results. House seats are reapportioned (Huntington–Hill on projected 2030 populations,
 * computed by pipeline/redistrict.ts) and electoral votes change from the 2032 election on.
 *
 * 2031: every state redraws its congressional and legislative maps (May for the states with 2031 legislative
 * elections, September for the rest). Who holds the pen decides the map:
 *   - independent or bipartisan commissions (CA, AZ, MI, ...) draw the neutral plan
 *   - one party's trifecta, or a veto-proof legislature (or NC's, where the governor has no veto), draws its own
 *     party's gerrymander
 *   - divided government deadlocks and a court draws the neutral plan
 * Each plan was drawn ahead of time from census tracts (fair, D-drawn, R-drawn), so new districts have real
 * shapes, populations, demographics and leans. A governor gets to sign or veto; a legislator in a narrow
 * majority can sink their party's map. About one in five gerrymanders is struck down in court the next February.
 *
 * Seats a state loses are eliminated when the new Congress is sworn in (January 2033); new seats are open in 2032.
 */
import type { Engine } from './game';
import type { Decision, DecisionOption, MapKind, PlanChoice, PlanKey, Redistricting } from './model';
import type { Party, StatePlans } from '../data/types';
import { setApportionment } from './offices';
import { members } from './legislature';
import { Rng } from './rng';

export const CENSUS = 2030;
const KINDS: MapKind[] = ['cd', 'sldu', 'sldl'];
const COMMISSION_CD = new Set(['AZ', 'CA', 'CO', 'HI', 'ID', 'MI', 'MT', 'NJ', 'VA', 'WA']);
const COMMISSION_SLD = new Set(['AK', 'AZ', 'CA', 'CO', 'HI', 'ID', 'MI', 'MO', 'MT', 'NJ', 'PA', 'VA', 'WA']);
/** Legislative maps drawn by a board of statewide officials (the governor's party runs it). */
const BOARD_SLD = new Set(['AR', 'OH']);
/** The governor can't veto maps. */
const NO_VETO = new Set(['NC']);
/** Legislatures elected in November 2031 redraw first. */
const EARLY = new Set(['NJ', 'VA', 'LA', 'MS']);
export const enactMonth = (st: string, kind: MapKind) => (kind !== 'cd' && EARLY.has(st) ? 5 : 9);
const MAP_LABEL: Record<MapKind, string> = { cd: 'congressional', sldu: 'state senate', sldl: 'state house' };
const adj = (p: Party) => (p === 'D' ? 'Democratic' : p === 'R' ? 'Republican' : 'independent');
const pname = (p: Party) => (p === 'D' ? 'Democrats' : 'Republicans');
const monthIndex = (y: number, m: number) => y * 12 + m;

/** Census results: new seat counts and electoral votes. */
export async function census(e: Engine) {
  const a = await e.data.apportionment();
  e.s.redistricting = { census: CENSUS, apportioned: true, plans: {}, challenges: {}, retired: [] };
  setApportionment(a.ev);
  const ch = Object.entries(a.seats).map(([st, n]) => [st, n - (a.before[st] ?? n)] as const).filter(([, d]) => d).sort((x, y) => y[1] - x[1]);
  const fmt = ([st, d]: readonly [string, number]) => `${e.data.states[st]?.n ?? st} ${d > 0 ? '+' : ''}${d}`;
  const gain = ch.filter(([, d]) => d > 0), lose = ch.filter(([, d]) => d < 0);
  const home = e.data.townSync(e.player.home)?.st;
  const mine = ch.find(([st]) => st === home);
  e.news({
    kind: 'national',
    title: `Census ${CENSUS}: ${gain.slice(0, 2).map(fmt).join(', ')} gain House seats; ${lose.slice(-1).map(fmt).join('')} loses the most`,
    body: `Gaining: ${gain.map(fmt).join(', ')}. Losing: ${lose.map(fmt).join(', ')}. Electoral votes change from the ${CENSUS + 2} election, and every state redraws its maps in ${CENSUS + 1}.`,
  });
  if (home) e.news({ kind: 'player', title: mine ? `${e.data.states[home].n} ${mine[1] > 0 ? 'gains' : 'loses'} ${Math.abs(mine[1])} House seat${Math.abs(mine[1]) > 1 ? 's' : ''}` : `${e.data.states[home].n} keeps ${a.seats[home]} House seat${a.seats[home] > 1 ? 's' : ''}`, body: `New district lines come in ${CENSUS + 1}, drawn by ${who(e, home, 'cd').by}.`, tone: 'neutral' });
}

/** Party control of the state legislature: the majority party, and whether it can override a veto. */
type Side = 'D' | 'R';
const side = (p: Party | null | undefined): Side | null => (p === 'D' || p === 'R' ? p : null);
function legislature(e: Engine, st: string): { party: Side | null; veto: boolean; narrow: boolean } {
  let party: Side | null = null, veto = true, narrow = false;
  for (const k of st === 'NE' ? ['sldu'] : ['sldu', 'sldl']) {
    const ms = members(e, `${k}:${st}`);
    const d = ms.filter((p) => p.party === 'D').length, r = ms.filter((p) => p.party === 'R').length;
    const maj: Side | null = d > r ? 'D' : r > d ? 'R' : null;
    if (!maj || (party && maj !== party)) return { party: null, veto: false, narrow: false };
    party = maj;
    const share = Math.max(d, r) / (ms.length || 1);
    if (share < 2 / 3) veto = false;
    if (share < 0.54) narrow = true;
  }
  return { party, veto, narrow };
}

/** Who draws a map without the player's input, and whether the process runs through the legislature. */
export function who(e: Engine, st: string, kind: MapKind): { plan: PlanKey; by: string; partisan: boolean; legis?: Side | null; gov?: Side | null; veto?: boolean; narrow?: boolean } {
  if (kind !== 'cd' && st === 'NE') return { plan: 'fair', by: 'the nonpartisan Unicameral', partisan: false };
  if (kind === 'cd' ? COMMISSION_CD.has(st) : COMMISSION_SLD.has(st)) return { plan: 'fair', by: 'an independent commission', partisan: false };
  const gov = side(e.pol(e.s.offices[`gov:${st}`]?.holder)?.party);
  if (kind !== 'cd' && BOARD_SLD.has(st) && gov) return { plan: gov, by: `the ${adj(gov)}-led apportionment board`, partisan: false, gov };
  const L = legislature(e, st);
  const base = { partisan: true, legis: L.party, gov, veto: L.veto || NO_VETO.has(st), narrow: L.narrow };
  if (L.party && L.party === gov) return { ...base, plan: L.party, by: `the ${adj(L.party)} legislature and governor` };
  if (L.party && (L.veto || NO_VETO.has(st))) return { ...base, plan: L.party, by: `the ${adj(L.party)} legislature${NO_VETO.has(st) ? '' : ', over the governor’s veto'}` };
  return { ...base, plan: 'fair', by: 'a court, after the legislature and governor deadlocked' };
}

const planKey = (kind: MapKind, st: string) => `${kind}:${st}`;
export const planMap = (R?: Redistricting | null) => Object.fromEntries(Object.entries(R?.plans ?? {}).map(([k, v]) => [k, v.plan]));

/** Apply the enacted plans to the game's geography (districts, town memberships) and refresh caches. */
export async function applyGeography(e: Engine) {
  await e.data.applyPlans(planMap(e.s.redistricting));
  e.geographyChanged();
}

/** Called at the end of every month (after the elections). */
export async function redistrictingMonth(e: Engine) {
  const { year, month } = e.s;
  if (year < CENSUS || (year === CENSUS && month < 12)) return;
  if (!e.s.redistricting) await census(e);
  const R = e.s.redistricting!;
  // the player's say, a month ahead of each state's deadline
  for (const st of states(e)) {
    if (KINDS.some((k) => enactMonth(st, k) === month + 1 && year === CENSUS + 1)) await offerDecision(e, st);
  }
  // maps due this month (or overdue, for saves that skipped ahead)
  const now = monthIndex(year, month);
  const due: [string, MapKind][] = [];
  for (const st of states(e)) for (const k of KINDS) if (!R.plans[planKey(k, st)] && monthIndex(CENSUS + 1, enactMonth(st, k)) <= now) due.push([st, k]);
  if (due.length) await enact(e, due);
  // court rulings on gerrymanders
  for (const [key, when] of Object.entries(R.challenges ?? {})) if (when <= now) await rule(e, key);
}

const states = (e: Engine) => Object.keys(e.data.states).filter((s) => s !== 'DC');

async function enact(e: Engine, due: [string, MapKind][]) {
  const R = e.s.redistricting!;
  const rng = new Rng(`${e.s.seed}|maps|${e.s.year}|${e.s.month}`);
  const home = e.data.townSync(e.player.home)?.st;
  const before = snapshotMine(e);
  const drawnBy: Record<string, string[]> = {};
  for (const [st, kind] of due) {
    const file = await e.data.statePlans(st);
    const m = file[kind];
    const key = planKey(kind, st);
    let c: PlanChoice;
    if (!m) continue;
    if (m.keep) c = { plan: 'keep', by: 'minor adjustments to the old lines', year: e.s.year, month: e.s.month };
    else if (kind === 'cd' && m.seats === 1) c = { plan: 'fair', by: 'a single at-large seat', year: e.s.year, month: e.s.month };
    else {
      const w = who(e, st, kind);
      const call = R.calls?.[st];
      const plan = w.partisan && call ? call : w.plan;
      c = { plan, by: w.partisan && call ? playerBy(e, st, call) : w.by, year: e.s.year, month: e.s.month };
      if ((plan === 'D' || plan === 'R') && rng.chance(0.2)) (R.challenges ??= {})[key] = monthIndex(e.s.year + 1, 2);
    }
    R.plans[key] = c;
    if (kind === 'cd' && m.codes) {
      for (const code of m.codes) if (!e.s.offices[`house:${code}`]) e.s.offices[`house:${code}`] = { id: `house:${code}`, holder: null, since: e.s.year };
      for (const code of m.retired ?? []) if (!(R.retired ??= []).includes(`house:${code}`)) R.retired.push(`house:${code}`);
    }
    if (kind === 'cd' && (c.plan === 'D' || c.plan === 'R')) (drawnBy[c.plan] ??= []).push(e.data.states[st]?.n ?? st);
  }
  await applyGeography(e);
  // coverage: the player's state in detail, the rest of the country in one line
  for (const [st, kind] of due) {
    if (st !== home) continue;
    const c = R.plans[planKey(kind, st)];
    const m = (await e.data.statePlans(st))[kind];
    if (!c || !m) continue;
    const seats = c.plan !== 'keep' ? m.plans?.[c.plan as 'fair']?.seats : null;
    e.news({
      kind: 'office',
      title: `${e.data.states[st].n}’s new ${MAP_LABEL[kind]} map${c.plan === 'D' || c.plan === 'R' ? ` favors ${pname(c.plan)}` : c.plan === 'keep' ? ' keeps the old lines' : ' is drawn to be fair'}`,
      body: `Drawn by ${c.by}.${seats ? ` Expected seats: ${Math.round(seats.D)} D, ${Math.round(seats.R)} R.` : ''}${R.challenges?.[planKey(kind, st)] ? ' Opponents have sued; a court rules in February.' : ''}`,
      tone: 'neutral',
    });
  }
  const parts = (['R', 'D'] as const).filter((p) => drawnBy[p]?.length).map((p) => `${pname(p)} drew the maps in ${drawnBy[p].join(', ')}`);
  if (due.some(([, k]) => k === 'cd')) e.news({ kind: 'national', title: `Redistricting: ${due.filter(([, k]) => k === 'cd').length} states finish new congressional maps`, body: parts.length ? `${parts.join('; ')}. Commissions, courts and at-large states drew the rest.` : 'Commissions, courts and at-large states drew them.' });
  reportMine(e, before);
}

/** How the player's call changed who drew it. */
function playerBy(e: Engine, st: string, plan: PlanKey) {
  const def = e.player.officeId ? e.def(e.player.officeId) : null;
  if (plan === 'fair') return def?.type === 'governor' ? 'a court, after Governor ' + e.name(e.player) + ' vetoed the legislature’s map' : 'a court, after the legislature’s map failed by one vote';
  return `the ${adj(plan as Party)} legislature, with Governor ${e.name(e.pol(e.s.offices[`gov:${st}`]?.holder))}’s signature`;
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
  for (const [k, lean0] of Object.entries(before)) {
    const d = e.data.districts[k];
    if (!d) continue;
    if (d.retired) {
      e.news({ kind: 'player', title: 'The new map eliminates your district', body: `${d.n} disappears when the new Congress meets in January ${CENSUS + 3}. To stay in Congress, run in your home's new district in ${CENSUS + 2} (Run tab).`, tone: 'bad' });
      continue;
    }
    const delta = Math.round((d.lean - lean0) * 200);
    if (Math.abs(delta) < 2) continue;
    const good = (e.player.party === 'D') === (delta > 0);
    e.news({ kind: 'player', title: `The new map makes your district ${delta > 0 ? 'bluer' : 'redder'}`, body: `${d.n} moves ${Math.abs(delta)} points toward ${delta > 0 ? 'Democrats' : 'Republicans'} (now ${lean(d.lean)}).`, tone: good ? 'good' : 'bad' });
  }
}
const lean = (x: number) => { const m = Math.round((x - 0.5) * 200); return m === 0 ? 'even' : m > 0 ? `D+${m}` : `R+${-m}`; };

/** A court rules on a challenged gerrymander: about half are struck down and replaced with the neutral plan. */
async function rule(e: Engine, key: string) {
  const R = e.s.redistricting!;
  delete R.challenges![key];
  const c = R.plans[key];
  if (!c || (c.plan !== 'D' && c.plan !== 'R')) return;
  const [kind, st] = key.split(':') as [MapKind, string];
  const rng = new Rng(`${e.s.seed}|court|${key}`);
  const struck = rng.chance(0.55);
  const home = e.data.townSync(e.player.home)?.st;
  const show = st === home || kind === 'cd';
  if (!struck) {
    if (show) e.news({ kind: st === home ? 'office' : 'national', title: `Court upholds ${e.data.states[st].n}’s ${MAP_LABEL[kind]} map`, tone: 'neutral' });
    return;
  }
  const before = snapshotMine(e);
  R.plans[key] = { plan: 'fair', by: 'a court, which struck down the legislature’s gerrymander', year: e.s.year, month: e.s.month, struck: true, was: c.plan };
  await applyGeography(e);
  if (show) e.news({ kind: st === home ? 'office' : 'national', title: `Court strikes down ${e.data.states[st].n}’s ${MAP_LABEL[kind]} map as a partisan gerrymander`, body: 'A court-drawn map takes its place for the next election.', tone: 'neutral' });
  reportMine(e, before);
}

/** January after the new Congress is sworn in: seats lost in reapportionment are gone. */
export function retireSeats(e: Engine) {
  const R = e.s.redistricting;
  if (!R?.retired?.length || e.s.year < CENSUS + 3) return;
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

/** Governors sign or veto; legislators in the majority vote (and can sink a map in a narrow chamber). */
async function offerDecision(e: Engine, st: string) {
  const me = e.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  const mine = side(me.party);
  if (!def || !mine || def.st !== st || e.s.decisions.some((d) => d.templateId === `map:${st}`)) return;
  const maps = KINDS.filter((k) => enactMonth(st, k) === e.s.month + 1).map((k) => ({ k, w: who(e, st, k) })).filter((x) => x.w.partisan);
  if (!maps.length) return;
  const w = maps[0].w;
  const file = await e.data.statePlans(st);
  const other: Side = mine === 'D' ? 'R' : 'D';
  const preview = (plan: PlanKey) => maps.map(({ k }) => {
    const s = file[k]?.plans?.[plan as 'fair']?.seats;
    return s ? `${MAP_LABEL[k]} ${Math.round(s.D)}D–${Math.round(s.R)}R` : null;
  }).filter(Boolean).join(', ') + homeDistrict(e, st, file, plan);
  let options: DecisionOption[] = [];
  let plans: PlanKey[] = [];
  let body = '';
  if (def.type === 'governor') {
    if (w.legis === mine) {
      body = `Your party controls the legislature, and its map maximizes ${pname(mine)}’ seats. You can sign it, or veto it and send the maps to a court.`;
      options = [
        { label: 'Sign the legislature’s map', detail: `Expected: ${preview(mine)}. Party leaders are thrilled; good-government groups cry foul.`, party: 10, bloc: { wcol: -0.02 } },
        { label: 'Veto it; let a court draw fair lines', detail: `Expected: ${preview('fair')}. Your party is furious, swing voters notice.`, party: -12, bloc: { wcol: 0.02, wnon: 0.01 } },
      ];
      plans = [mine, 'fair'];
    } else if (w.legis === other && !w.veto) {
      body = `The ${adj(other)} legislature passed a map that favors ${pname(other)}. Without enough votes to override you, it lives or dies on your desk.`;
      options = [
        { label: 'Veto it', detail: `A court will draw the lines. Expected: ${preview('fair')}.`, party: 8 },
        { label: 'Sign it as part of a budget deal', detail: `Expected: ${preview(other)}. Your party won't forget.`, party: -15, metrics: { effectiveness: 1.5 } },
      ];
      plans = ['fair', other];
    }
  } else if ((def.type === 'sldl' || def.type === 'sldu') && w.legis === mine && w.plan === mine) {
    body = `Your party’s leaders are moving maps that favor ${pname(mine)}.${w.narrow ? ' The majority is thin: your vote could decide it.' : ' They have votes to spare.'}`;
    options = [
      { label: 'Vote for the map', detail: `Expected: ${preview(mine)}.`, party: 4 },
      { label: 'Vote against it', detail: w.narrow ? `It would fail, and a court would draw the lines. Expected: ${preview('fair')}.` : 'A protest vote; it passes anyway.', party: -8, bloc: { wcol: 0.01 } },
    ];
    plans = [mine, w.narrow ? 'fair' : mine];
  }
  if (!options.length) return;
  const d: Decision = {
    id: e.newId('d'), templateId: `map:${st}`, title: `Redistricting: ${e.data.states[st].n}’s new maps`, body,
    options, deadline: { year: e.s.year, month: e.s.month + 1 }, meta: { kind: 'map', map: st, plans },
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
  const p = m?.plans?.[plan as 'fair'];
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
  if (!st || !plan || !e.s.redistricting) return;
  (e.s.redistricting.calls ??= {})[st] = plan;
}

/** Inspector rows for a state: enacted maps, or who will draw them. */
export async function stateMaps(e: Engine, st: string) {
  const R = e.s.redistricting;
  const file = await e.data.statePlans(st);
  const a = R?.apportioned ? await e.data.apportionment() : null;
  return {
    census: CENSUS,
    seats: a ? { now: a.seats[st] ?? null, before: a.before[st] ?? null } : null,
    maps: KINDS.filter((k) => file[k]).map((k) => {
      const c = R?.plans[planKey(k, st)];
      const m = file[k]!;
      const s = c && c.plan !== 'keep' ? m.plans?.[c.plan as 'fair']?.seats ?? null : null;
      return {
        kind: k, label: MAP_LABEL[k], enacted: !!c, plan: c?.plan ?? null, by: c?.by ?? who(e, st, k).by, struck: !!c?.struck,
        expected: s, keep: !!m.keep, when: enactMonth(st, k), challenged: !!R?.challenges?.[planKey(k, st)],
        range: m.plans?.D && m.plans?.R ? { D: m.plans.D.seats.D, fair: m.plans.fair?.seats.D ?? null, R: m.plans.R.seats.D } : null,
      };
    }),
  };
}
