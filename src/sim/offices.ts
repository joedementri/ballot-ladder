/**
 * Office catalog: every elected office in the game, its jurisdiction, term and election schedule.
 * Schedules approximate real practice (staggered senates, odd-year states, governor cycles).
 *
 * Office id formats:
 *   council:{townId}:{seat}  mayor:{townId}  county:{countyFips}:{seat}
 *   sldl:{geoid}  sldu:{geoid}  house:{cdGeoid}  gov:{ST}  sen:{ST}:{class}  pres
 *   school:{townId}:{seat}  sheriff:{countyFips}  da:{countyFips}  cexec:{countyFips}
 *   ltgov:{ST}  ag:{ST}  sos:{ST}  treas:{ST}  judge:{ST}:{seat}  vp
 *
 * "Officials" (sheriff, prosecutor, row offices, judges, school board, VP) are neither legislators nor chief
 * executives: they have their own decision pools, no bills and no budget.
 */
import type { DataStore } from '../data/store';
import type { Town } from '../data/types';

export type OfficeType =
  | 'council' | 'mayor' | 'county' | 'sldl' | 'sldu' | 'house' | 'governor' | 'senate' | 'president'
  | 'school' | 'sheriff' | 'da' | 'cexec' | 'ltgov' | 'ag' | 'sos' | 'treas' | 'judge' | 'vp';
export type JurKind = 'town' | 'county' | 'sldl' | 'sldu' | 'cd' | 'state' | 'nation';

export interface OfficeDef {
  id: string;
  type: OfficeType;
  title: string;
  jurName: string;
  jur: { kind: JurKind; id: string };
  st: string | null;
  term: number;
  partisan: boolean;
  level: number;
  minAge: number;
  executive: boolean;
  /** Independent elected official (no chamber, no budget): sheriff, prosecutor, row offices, judges, school board, VP. */
  official?: boolean;
  /** Not on the ballot on its own (the Vice President is elected with the President). */
  ticket?: boolean;
  pop: number;
}

export const LEVEL: Record<OfficeType, number> = {
  council: 1, school: 1, mayor: 2, county: 2, sheriff: 2, da: 3, cexec: 3, sldl: 3, sldu: 4,
  house: 5, ltgov: 5, ag: 5, sos: 5, treas: 5, judge: 5, governor: 6, senate: 6, vp: 6, president: 7,
};
export const TYPE_LABEL: Record<OfficeType, string> = {
  council: 'Local Council', mayor: 'Mayor / Executive', county: 'County Commission', sldl: 'State House', sldu: 'State Senate',
  house: 'U.S. House', governor: 'Governor', senate: 'U.S. Senate', president: 'President',
  school: 'School Board', sheriff: 'Sheriff', da: 'Prosecutor', cexec: 'County Executive', ltgov: 'Lieutenant Governor',
  ag: 'Attorney General', sos: 'Secretary of State', treas: 'State Treasurer', judge: 'State Supreme Court', vp: 'Vice President',
};
/** Offices with their own decision pools instead of bills or budgets. */
export const OFFICIALS = new Set<OfficeType>(['school', 'sheriff', 'da', 'ltgov', 'ag', 'sos', 'treas', 'judge', 'vp']);

/** Expected campaign spending per resident by office type (scales "money matters" effects). */
const SPEND_PER_CAP: Record<OfficeType, number> = {
  council: 0.6, mayor: 1.2, county: 0.35, sldl: 1.6, sldu: 1.3, house: 3.2, governor: 2.2, senate: 2.6, president: 3.0,
  school: 0.25, sheriff: 0.3, da: 0.35, cexec: 0.8, ltgov: 0.6, ag: 0.9, sos: 0.6, treas: 0.45, judge: 0.5, vp: 3.0,
};
export const expectedSpend = (type: OfficeType, pop: number) => Math.max(3000, SPEND_PER_CAP[type] * pop);
export const SALARY: Record<OfficeType, number> = {
  council: 12000, mayor: 60000, county: 55000, sldl: 45000, sldu: 55000, house: 174000, governor: 150000, senate: 174000, president: 400000,
  school: 6000, sheriff: 110000, da: 140000, cexec: 150000, ltgov: 110000, ag: 140000, sos: 120000, treas: 120000, judge: 180000, vp: 235000,
};

const NEW_ENGLAND = new Set(['CT', 'MA', 'ME', 'NH', 'VT', 'RI']);
export const NO_COUNTY_GOV = new Set(['CT', 'RI']);

/** Electoral votes in effect: the 2020 census until the 2030 apportionment replaces them (see setApportionment). */
export const EV: Record<string, number> = { AL: 9, AK: 3, AZ: 11, AR: 6, CA: 54, CO: 10, CT: 7, DE: 3, DC: 3, FL: 30, GA: 16, HI: 4, ID: 4, IL: 19, IN: 11, IA: 6, KS: 6, KY: 8, LA: 8, ME: 4, MD: 10, MA: 11, MI: 15, MN: 10, MS: 6, MO: 10, MT: 4, NE: 5, NV: 6, NH: 4, NJ: 14, NM: 5, NY: 28, NC: 16, ND: 3, OH: 17, OK: 7, OR: 8, PA: 19, RI: 4, SC: 9, SD: 3, TN: 11, TX: 40, UT: 6, VT: 3, VA: 13, WA: 12, WV: 4, WI: 10, WY: 3 };

/** Governors at game start (Jan 2025): party and the next regular election year. */
export const GOVERNORS: Record<string, { party: 'D' | 'R'; next: number }> = {
  AL: { party: 'R', next: 2026 }, AK: { party: 'R', next: 2026 }, AZ: { party: 'D', next: 2026 }, AR: { party: 'R', next: 2026 },
  CA: { party: 'D', next: 2026 }, CO: { party: 'D', next: 2026 }, CT: { party: 'D', next: 2026 }, DE: { party: 'D', next: 2028 },
  FL: { party: 'R', next: 2026 }, GA: { party: 'R', next: 2026 }, HI: { party: 'D', next: 2026 }, ID: { party: 'R', next: 2026 },
  IL: { party: 'D', next: 2026 }, IN: { party: 'R', next: 2028 }, IA: { party: 'R', next: 2026 }, KS: { party: 'D', next: 2026 },
  KY: { party: 'D', next: 2027 }, LA: { party: 'R', next: 2027 }, ME: { party: 'D', next: 2026 }, MD: { party: 'D', next: 2026 },
  MA: { party: 'D', next: 2026 }, MI: { party: 'D', next: 2026 }, MN: { party: 'D', next: 2026 }, MS: { party: 'R', next: 2027 },
  MO: { party: 'R', next: 2028 }, MT: { party: 'R', next: 2028 }, NE: { party: 'R', next: 2026 }, NV: { party: 'R', next: 2026 },
  NH: { party: 'R', next: 2026 }, NJ: { party: 'D', next: 2025 }, NM: { party: 'D', next: 2026 }, NY: { party: 'D', next: 2026 },
  NC: { party: 'D', next: 2028 }, ND: { party: 'R', next: 2028 }, OH: { party: 'R', next: 2026 }, OK: { party: 'R', next: 2026 },
  OR: { party: 'D', next: 2026 }, PA: { party: 'D', next: 2026 }, RI: { party: 'D', next: 2026 }, SC: { party: 'R', next: 2026 },
  SD: { party: 'R', next: 2026 }, TN: { party: 'R', next: 2026 }, TX: { party: 'R', next: 2026 }, UT: { party: 'R', next: 2028 },
  VT: { party: 'R', next: 2026 }, VA: { party: 'R', next: 2025 }, WA: { party: 'D', next: 2028 }, WV: { party: 'R', next: 2028 },
  WI: { party: 'D', next: 2026 }, WY: { party: 'R', next: 2026 },
};
const BASE_EV = { ...EV };
/** Switch electoral votes to a new census apportionment (null restores the 2020 numbers). Mutates EV in place. */
export function setApportionment(ev: Record<string, number> | null) {
  for (const k of Object.keys(EV)) delete EV[k];
  Object.assign(EV, ev ?? BASE_EV);
}
const GOV_TERM = (st: string) => (st === 'NH' || st === 'VT' ? 2 : 4);
/** Consecutive-term limits for governors (0 = none). */
export const GOV_LIMIT = (st: string) => (['CT', 'ID', 'IL', 'IA', 'MA', 'MN', 'NY', 'TX', 'UT', 'VT', 'WA', 'WI', 'NH'].includes(st) ? 0 : st === 'VA' ? 1 : 2);

/** Approximate primary month by state (midterm-cycle calendar). LA uses a November jungle primary (modeled as top-two). */
export const PRIMARY_MONTH: Record<string, number> = {
  TX: 3, NC: 3, AR: 3, IL: 3, MS: 3, CA: 6, OH: 5, IN: 5, WV: 5, NE: 5, KY: 5, PA: 5, OR: 5, ID: 5, GA: 5, AL: 5,
  NM: 6, IA: 6, MT: 6, NJ: 6, SD: 6, ME: 6, NV: 6, ND: 6, SC: 6, VA: 6, NY: 6, CO: 6, OK: 6, UT: 6, MD: 6, DC: 6,
  AZ: 7, TN: 8, KS: 8, MI: 8, MO: 8, WA: 8, HI: 8, CT: 8, MN: 8, VT: 8, WI: 8, WY: 8, AK: 8, FL: 8, NH: 9, MA: 9, DE: 9, RI: 9, LA: 10,
};
export const TOP_TWO = new Set(['CA', 'WA', 'AK', 'LA']);

// ------------------------------------------------------------------ M10 offices

/** States without elected sheriffs (no county government, or state-run law enforcement). */
const NO_SHERIFF = new Set(['AK', 'CT', 'HI', 'RI', 'DC']);
/** States whose local prosecutors are appointed or state-run. */
const NO_DA = new Set(['AK', 'CT', 'DE', 'NJ', 'RI', 'DC']);
/** Local law enforcement and prosecutors are nonpartisan here. */
const NONPARTISAN_LOCAL = new Set(['CA', 'OR']);
const DA_TITLE: Record<string, string> = {
  IL: "State's Attorney", MD: "State's Attorney", ND: "State's Attorney", VT: "State's Attorney", FL: 'State Attorney',
  IN: 'Prosecuting Attorney', MI: 'Prosecuting Attorney', MO: 'Prosecuting Attorney', OH: 'Prosecuting Attorney', WA: 'Prosecuting Attorney', WV: 'Prosecuting Attorney', AR: 'Prosecuting Attorney',
  AZ: 'County Attorney', MN: 'County Attorney', MT: 'County Attorney', NE: 'County Attorney', IA: 'County Attorney', UT: 'County Attorney',
  VA: "Commonwealth's Attorney", KY: "Commonwealth's Attorney", SC: 'Solicitor',
};
/** Year (mod 4) that county sheriffs and prosecutors are elected (default: sheriff in midterm years, prosecutor in presidential years). */
const SHERIFF_M4: Record<string, number> = { FL: 0, TX: 0, GA: 0, SC: 0, VA: 3, MS: 3, LA: 3, PA: 1, NY: 1 };
const DA_M4: Record<string, number> = { CA: 2, NY: 1, PA: 1, VA: 3, MS: 3, LA: 2, KY: 2, NC: 2, TN: 2 };
/** Counties with an elected chief executive: every county in TX and KY, elsewhere counties of 250k+. */
export function hasCountyExec(st: string, pop: number) {
  if (NO_COUNTY_GOV.has(st) || st === 'AK' || st === 'DC') return false;
  return st === 'TX' || st === 'KY' || pop >= 250000;
}
const cexecTitle = (st: string) => (st === 'TX' ? 'County Judge' : st === 'KY' ? 'County Judge/Executive' : st === 'LA' ? 'Parish President' : 'County Executive');

/** Lieutenant governors: none in AZ, ME, NH, OR, WY; in TN and WV the senate president holds the title. */
export const HAS_LTGOV = (st: string) => !['AZ', 'ME', 'NH', 'OR', 'WY', 'TN', 'WV', 'DC'].includes(st);
/** States where the lieutenant governor is elected on a joint ticket with the governor. */
export const LTGOV_TICKET = new Set(['AK', 'CO', 'CT', 'FL', 'HI', 'IL', 'IN', 'IA', 'KS', 'KY', 'MD', 'MA', 'MI', 'MN', 'MT', 'NE', 'NJ', 'NM', 'NY', 'ND', 'OH', 'PA', 'SC', 'SD', 'UT', 'WI']);
/** Elected attorneys general (appointed in AK, HI, NH, NJ, WY; chosen by the legislature or court in ME and TN). */
const ELECTED_AG = (st: string) => !['AK', 'HI', 'ME', 'NH', 'NJ', 'TN', 'WY', 'DC'].includes(st);
const ELECTED_SOS = new Set(['AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NM', 'NC', 'ND', 'OH', 'OR', 'RI', 'SC', 'SD', 'VT', 'WA', 'WV', 'WI', 'WY']);
const ELECTED_TREAS = new Set(['AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'MA', 'MS', 'MO', 'NE', 'NV', 'NM', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'UT', 'VT', 'WA', 'WV', 'WI', 'WY']);
/** Row offices elected off the governor's cycle (PA elects them in presidential years). */
const ROW_M4: Record<string, number> = { PA: 0 };
export function rowOfficeExists(type: 'ltgov' | 'ag' | 'sos' | 'treas', st: string) {
  return type === 'ltgov' ? HAS_LTGOV(st) : type === 'ag' ? ELECTED_AG(st) : type === 'sos' ? ELECTED_SOS.has(st) : ELECTED_TREAS.has(st);
}
const ROW_TITLE = { ltgov: 'Lieutenant Governor', ag: 'Attorney General', sos: 'Secretary of State', treas: 'State Treasurer' } as const;

/**
 * States that elect their supreme court in contested elections (retention-only states are left out):
 * seats, term in years, partisan ballot, and odd-year elections (PA in odd Novembers; WI votes in April, modeled as odd Novembers).
 */
export const COURTS: Record<string, { seats: number; term: number; partisan: boolean; odd?: boolean; name?: string }> = {
  AL: { seats: 9, term: 6, partisan: true }, AR: { seats: 7, term: 8, partisan: false }, GA: { seats: 9, term: 6, partisan: false },
  ID: { seats: 5, term: 6, partisan: false }, IL: { seats: 7, term: 10, partisan: true }, KY: { seats: 7, term: 8, partisan: false },
  LA: { seats: 7, term: 10, partisan: true }, MI: { seats: 7, term: 8, partisan: false }, MN: { seats: 7, term: 6, partisan: false },
  MS: { seats: 9, term: 8, partisan: false }, MT: { seats: 7, term: 8, partisan: false }, NV: { seats: 7, term: 6, partisan: false },
  NM: { seats: 5, term: 8, partisan: true }, NC: { seats: 7, term: 8, partisan: true }, ND: { seats: 5, term: 10, partisan: false },
  OH: { seats: 7, term: 6, partisan: true }, OR: { seats: 7, term: 6, partisan: false }, PA: { seats: 7, term: 10, partisan: true, odd: true },
  TX: { seats: 9, term: 6, partisan: true }, WA: { seats: 9, term: 6, partisan: false }, WV: { seats: 5, term: 12, partisan: false, name: 'Supreme Court of Appeals' },
  WI: { seats: 7, term: 10, partisan: false, odd: true },
};
/** Justices must be lawyers; most states force retirement around 70–75. */
export const JUDGE_RETIRE = 75;

/** Staggered court seats: each seat is up once a term, spread across the election years of the cycle. */
export function judgeUp(st: string, seat: number, year: number): boolean {
  const ct = COURTS[st];
  if (!ct || (((year % 2) + 2) % 2 === 1) !== !!ct.odd) return false;
  const cycles = Math.max(1, Math.round(ct.term / 2)); // elections per term
  return (Math.floor(year / 2) + seat) % cycles === 0;
}


const SLDU_TWO_YEAR = new Set(['AZ', 'CT', 'GA', 'ID', 'ME', 'MA', 'NH', 'NY', 'NC', 'RI', 'SD', 'VT']);
const SLDU_ALL_AT_ONCE: Record<string, number> = { AL: 2, MD: 2, MI: 2, MN: 2, KS: 0, NM: 0, SC: 0, NJ: 3, VA: 3, LA: 3, MS: 3 }; // value = year % 4
const SLDL_FOUR_YEAR: Record<string, number> = { AL: 2, MD: 2, LA: 3, MS: 3 };
const SLDL_ODD_TWO = new Set(['NJ', 'VA']);

function councilSeats(pop: number) {
  return pop < 2500 ? 5 : pop < 50000 ? 7 : pop < 500000 ? 9 : 13;
}
const countySeats = 5;

function townTitles(t: Town) {
  const isTwp = t.id.startsWith('M');
  const ne = NEW_ENGLAND.has(t.st);
  const nm = t.name.toLowerCase();
  if (isTwp && ne) return { council: 'Select Board', exec: 'First Selectman' };
  if (isTwp) return { council: 'Township Board', exec: 'Township Supervisor' };
  if (nm.endsWith(' village')) return { council: 'Village Board', exec: 'Village President' };
  if (nm.endsWith(' borough')) return { council: 'Borough Council', exec: 'Mayor' };
  if (nm.endsWith(' town')) return { council: 'Town Council', exec: 'Mayor' };
  return { council: 'City Council', exec: 'Mayor' };
}
export const shortTownName = (n: string) =>
  n.replace(/ (city|town|village|borough|township|charter township|municipality|city and borough|plantation|consolidated government \(balance\)|metro government \(balance\)|unified government \(balance\)|metropolitan government \(balance\)|urban county)$/i, '');

/** Build the definition of an office from its id. Requires core data, and town data for local offices. */
export function officeDef(id: string, data: DataStore): OfficeDef | null {
  const [type, a, b] = id.split(':');
  switch (type) {
    case 'council':
    case 'mayor': {
      const t = data.townSync(a);
      if (!t) return null;
      const titles = townTitles(t);
      const nm = shortTownName(t.name);
      return {
        id, type: type as OfficeType, st: t.st,
        title: type === 'mayor' ? `${titles.exec} of ${nm}` : `${titles.council}, Seat ${+b + 1}`,
        jurName: `${nm}, ${t.st}`, jur: { kind: 'town', id: t.id },
        term: 4, partisan: false, level: LEVEL[type as OfficeType], minAge: 18, executive: type === 'mayor', pop: t.pop,
      };
    }
    case 'county': {
      const c = data.counties[a];
      if (!c) return null;
      return {
        id, type: 'county', st: c.st, title: `${c.st === 'LA' ? 'Parish Council' : 'County Commission'}, District ${+b + 1}`,
        jurName: `${c.n}, ${c.st}`, jur: { kind: 'county', id: a }, term: 4, partisan: true, level: 2, minAge: 18, executive: false,
        pop: Math.round((c.d[0] ?? 0) / countySeats),
      };
    }
    case 'sldl':
    case 'sldu': {
      const d = data.districts[`${type}:${a}`];
      if (!d) return null;
      const chamberU = d.st === 'NE' ? 'Legislature' : 'State Senate';
      const chamberL = ['CA', 'NV', 'NY', 'WI'].includes(d.st) ? 'State Assembly' : d.st === 'NJ' ? 'General Assembly' : ['MD', 'VA', 'WV'].includes(d.st) ? 'House of Delegates' : 'State House';
      return {
        id, type: type as OfficeType, st: d.st, title: `${type === 'sldu' ? chamberU : chamberL}, ${d.n.replace(/^(State Senate|State House|Assembly|General Assembly|House of Delegates|Legislative) District /i, 'District ')}`,
        jurName: `${d.n} (${d.st})`, jur: { kind: type as JurKind, id: a },
        term: type === 'sldu' ? (SLDU_TWO_YEAR.has(d.st) ? 2 : 4) : SLDL_FOUR_YEAR[d.st] != null || d.st === 'ND' ? 4 : 2,
        partisan: d.st !== 'NE', level: LEVEL[type as OfficeType], minAge: type === 'sldu' ? 25 : 21, executive: false, pop: d.pop,
      };
    }
    case 'house': {
      const d = data.districts[`cd:${a}`];
      if (!d) return null;
      return {
        id, type: 'house', st: d.st, title: `U.S. Representative, ${d.n}`, jurName: d.n, jur: { kind: 'cd', id: a },
        term: 2, partisan: true, level: 5, minAge: 25, executive: false, pop: d.pop,
      };
    }
    case 'gov': {
      const s = data.states[a];
      return s ? { id, type: 'governor', st: a, title: `Governor of ${s.n}`, jurName: s.n, jur: { kind: 'state', id: a }, term: GOV_TERM(a), partisan: true, level: 6, minAge: 30, executive: true, pop: s.pop } : null;
    }
    case 'sen': {
      const s = data.states[a];
      return s ? { id, type: 'senate', st: a, title: `U.S. Senator from ${s.n} (Class ${b})`, jurName: s.n, jur: { kind: 'state', id: a }, term: 6, partisan: true, level: 6, minAge: 30, executive: false, pop: s.pop } : null;
    }
    case 'school': {
      const t = data.townSync(a);
      if (!t) return null;
      const nm = shortTownName(t.name);
      return {
        id, type: 'school', st: t.st, title: `${nm} School Board, Seat ${+b + 1}`, jurName: `${nm}, ${t.st}`, jur: { kind: 'town', id: t.id },
        term: 4, partisan: false, level: LEVEL.school, minAge: 18, executive: false, official: true, pop: t.pop,
      };
    }
    case 'sheriff':
    case 'da':
    case 'cexec': {
      const c = data.counties[a];
      if (!c) return null;
      const pop = c.d[0] ?? 0;
      if (type === 'sheriff' && NO_SHERIFF.has(c.st)) return null;
      if (type === 'da' && NO_DA.has(c.st)) return null;
      if (type === 'cexec' && !hasCountyExec(c.st, pop)) return null;
      const title = type === 'sheriff' ? `Sheriff of ${c.n}` : type === 'da' ? `${DA_TITLE[c.st] ?? 'District Attorney'}, ${c.n}` : `${cexecTitle(c.st)} of ${c.n}`;
      return {
        id, type, st: c.st, title, jurName: `${c.n}, ${c.st}`, jur: { kind: 'county', id: a }, term: 4,
        partisan: type === 'cexec' || !NONPARTISAN_LOCAL.has(c.st), level: LEVEL[type], minAge: type === 'sheriff' ? 21 : 25,
        executive: type === 'cexec', official: type !== 'cexec', pop,
      };
    }
    case 'ltgov':
    case 'ag':
    case 'sos':
    case 'treas': {
      const s = data.states[a];
      if (!s || !rowOfficeExists(type, a)) return null;
      const title = type === 'treas' && a === 'FL' ? 'Chief Financial Officer' : ROW_TITLE[type];
      return {
        id, type, st: a, title: `${title} of ${s.n}`, jurName: s.n, jur: { kind: 'state', id: a }, term: GOV_TERM(a),
        partisan: true, level: LEVEL[type], minAge: type === 'ltgov' || type === 'ag' ? 30 : 25, executive: false, official: true, pop: s.pop,
      };
    }
    case 'judge': {
      const s = data.states[a];
      const ct = COURTS[a];
      if (!s || !ct || +b >= ct.seats || +b < 0) return null;
      return {
        id, type: 'judge', st: a, title: `Justice, ${s.n} ${ct.name ?? 'Supreme Court'}, Seat ${+b + 1}`, jurName: s.n, jur: { kind: 'state', id: a },
        term: ct.term, partisan: ct.partisan, level: LEVEL.judge, minAge: 35, executive: false, official: true, pop: s.pop,
      };
    }
    case 'vp':
      return { id, type: 'vp', st: null, title: 'Vice President of the United States', jurName: 'United States', jur: { kind: 'nation', id: 'US' }, term: 4, partisan: true, level: LEVEL.vp, minAge: 35, executive: false, official: true, ticket: true, pop: 335_000_000 };
    case 'pres':
      return { id, type: 'president', st: null, title: 'President of the United States', jurName: 'United States', jur: { kind: 'nation', id: 'US' }, term: 4, partisan: true, level: 7, minAge: 35, executive: true, pop: 335_000_000 };
  }
  return null;
}

/** Is the office on the ballot in the November of `year`? */
export function isUp(id: string, year: number, data: DataStore): boolean {
  const [type, a, b] = id.split(':');
  const m4 = ((year % 4) + 4) % 4;
  switch (type) {
    case 'council': return year % 2 === 1 && m4 === (+b % 2 === 0 ? 1 : 3);
    case 'mayor': return m4 === 1;
    case 'county': return year % 2 === 0 && m4 === (+b < 3 ? 2 : 0);
    case 'house': return year % 2 === 0 && !data.districts[`cd:${a}`]?.retired;
    case 'pres': return m4 === 0;
    case 'sen': return year % 6 === ({ 1: 2, 2: 4, 3: 0 } as Record<string, number>)[b];
    case 'gov': {
      const g = GOVERNORS[a];
      return !!g && year >= g.next && (year - g.next) % GOV_TERM(a) === 0;
    }
    case 'school': return year % 2 === 1 && m4 === (+b % 2 === 0 ? 1 : 3);
    case 'sheriff':
    case 'da':
    case 'cexec': {
      const st = data.counties[a]?.st;
      if (!st) return false;
      const want = type === 'da' ? DA_M4[st] ?? 0 : type === 'sheriff' ? SHERIFF_M4[st] ?? 2 : 2;
      return m4 === want;
    }
    case 'ltgov':
    case 'ag':
    case 'sos':
    case 'treas': {
      if (ROW_M4[a] != null) return m4 === ROW_M4[a];
      const g = GOVERNORS[a];
      return !!g && year >= g.next && (year - g.next) % GOV_TERM(a) === 0;
    }
    case 'judge': return judgeUp(a, +b, year);
    case 'vp': return false;
    case 'sldl': {
      const st = data.districts[`sldl:${a}`]?.st;
      if (!st) return false;
      if (SLDL_FOUR_YEAR[st] != null) return m4 === SLDL_FOUR_YEAR[st];
      if (SLDL_ODD_TWO.has(st)) return year % 2 === 1;
      return year % 2 === 0;
    }
    case 'sldu': {
      const st = data.districts[`sldu:${a}`]?.st;
      if (!st) return false;
      if (SLDU_TWO_YEAR.has(st)) return year % 2 === 0;
      if (SLDU_ALL_AT_ONCE[st] != null) return m4 === SLDU_ALL_AT_ONCE[st];
      if (st === 'ND') return year % 2 === 0 && (parseInt(a.slice(2), 10) % 2 === 0 ? m4 === 2 : m4 === 0);
      const num = parseInt(a.slice(2), 10) || 0;
      return year % 2 === 0 && m4 === (num % 2 === 1 ? 2 : 0);
    }
  }
  return false;
}

export function nextElection(id: string, fromYear: number, data: DataStore): number {
  for (let y = fromYear; y < fromYear + 12; y++) if (isUp(id, y, data)) return y;
  return fromYear + 12;
}

/** Does this race have a party primary? Local nonpartisan offices go straight to November. */
export function hasPrimary(def: OfficeDef): boolean {
  return def.partisan;
}
export function primaryMonth(def: OfficeDef, year: number): number {
  if (def.type === 'president') return PRES_CALENDAR[0].month; // the first contests; later months follow PRES_CALENDAR
  const st = def.st ?? 'IA';
  if (year % 2 === 1) return 6; // odd-year states (NJ, VA, LA, MS, KY) — June-ish
  if (st === 'CA' && year % 4 === 0) return 3;
  return PRIMARY_MONTH[st] ?? 6;
}
export const filingMonth = (def: OfficeDef, year: number) => Math.max(1, primaryMonth(def, year) - 3);

/** Offices whose jurisdiction contains the given town. */
export function officesForTown(t: Town, data: DataStore): string[] {
  const ids: string[] = [];
  const seats = councilSeats(t.pop);
  for (let i = 0; i < seats; i++) ids.push(`council:${t.id}:${i}`);
  for (let i = 0; i < schoolSeats(t.pop); i++) ids.push(`school:${t.id}:${i}`);
  ids.push(`mayor:${t.id}`);
  if (!NO_COUNTY_GOV.has(t.st)) for (let i = 0; i < countySeats; i++) ids.push(`county:${t.county}:${i}`);
  for (const k of ['cexec', 'sheriff', 'da']) if (officeDef(`${k}:${t.county}`, data)) ids.push(`${k}:${t.county}`);
  if (t.sldl && t.st !== 'NE' && data.districts[`sldl:${t.sldl}`]) ids.push(`sldl:${t.sldl}`);
  if (t.sldu && data.districts[`sldu:${t.sldu}`]) ids.push(`sldu:${t.sldu}`);
  if (t.cd && data.districts[`cd:${t.cd}`]) ids.push(`house:${t.cd}`);
  if (t.st !== 'DC') {
    ids.push(...statewideIds(t.st, data));
    for (const s of data.states[t.st]?.senators ?? []) ids.push(`sen:${t.st}:${s.cls}`);
  }
  ids.push('pres');
  return ids;
}

export const schoolSeats = (pop: number) => (pop < 50000 ? 5 : 7);
export { councilSeats };

/** Statewide offices of a state: governor, row offices and elected supreme court seats. */
export function statewideIds(st: string, data: DataStore): string[] {
  const ids = [`gov:${st}`];
  for (const k of ['ltgov', 'ag', 'sos', 'treas'] as const) if (rowOfficeExists(k, st) && data.states[st]) ids.push(`${k}:${st}`);
  const ct = COURTS[st];
  if (ct) for (let i = 0; i < ct.seats; i++) ids.push(`judge:${st}:${i}`);
  return ids;
}

/**
 * Presidential primary calendar (modeled on recent cycles). Delegates are awarded state by state:
 * Democrats allocate proportionally (15% threshold); Republicans go winner-take-all once a candidate tops 50%,
 * or in any state from mid-March on.
 */
export const PRES_CALENDAR: { month: number; label: string; states: string[] }[] = [
  { month: 1, label: 'Iowa & New Hampshire', states: ['IA', 'NH'] },
  { month: 2, label: 'Early states', states: ['NV', 'SC', 'MI'] },
  { month: 3, label: 'Super Tuesday & March', states: ['AL', 'AR', 'CA', 'CO', 'ME', 'MA', 'MN', 'NC', 'OK', 'TN', 'TX', 'UT', 'VT', 'VA', 'GA', 'MS', 'WA', 'AZ', 'FL', 'IL', 'KS', 'OH', 'LA', 'MO', 'ID', 'ND', 'HI', 'AK'] },
  { month: 4, label: 'April primaries', states: ['NY', 'WI', 'PA', 'CT', 'DE', 'RI', 'WY'] },
  { month: 5, label: 'May primaries', states: ['IN', 'NE', 'WV', 'KY', 'OR', 'MD'] },
  { month: 6, label: 'Final primaries', states: ['NJ', 'NM', 'SD', 'MT', 'DC'] },
];


/** All state + federal offices materialized at game start. */
export function seedOfficeIds(data: DataStore): string[] {
  const ids: string[] = ['pres'];
  ids.push('vp');
  for (const [st, s] of Object.entries(data.states)) {
    if (st === 'DC') continue;
    ids.push(...statewideIds(st, data));
    for (const sen of s.senators) ids.push(`sen:${st}:${sen.cls}`);
  }
  for (const [key, d] of Object.entries(data.districts)) {
    const [kind, geoid] = key.split(':');
    if (kind === 'cd' && !d.retired) ids.push(`house:${geoid}`);
    else if (kind === 'sldl' && d.st !== 'NE') ids.push(`sldl:${geoid}`);
    else if (kind === 'sldu') ids.push(`sldu:${geoid}`);
  }
  return ids;
}
