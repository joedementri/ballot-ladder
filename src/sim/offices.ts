/**
 * Office catalog: every elected office in the game, its jurisdiction, term and election schedule.
 * Schedules approximate real practice (staggered senates, odd-year states, governor cycles).
 *
 * Office id formats:
 *   council:{townId}:{seat}  mayor:{townId}  county:{countyFips}:{seat}
 *   sldl:{geoid}  sldu:{geoid}  house:{cdGeoid}  gov:{ST}  sen:{ST}:{class}  pres
 */
import type { DataStore } from '../data/store';
import type { Town } from '../data/types';

export type OfficeType = 'council' | 'mayor' | 'county' | 'sldl' | 'sldu' | 'house' | 'governor' | 'senate' | 'president';
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
  pop: number;
}

export const LEVEL: Record<OfficeType, number> = { council: 1, mayor: 2, county: 2, sldl: 3, sldu: 4, house: 5, governor: 6, senate: 6, president: 7 };
export const TYPE_LABEL: Record<OfficeType, string> = {
  council: 'Local Council', mayor: 'Mayor / Executive', county: 'County Commission', sldl: 'State House', sldu: 'State Senate',
  house: 'U.S. House', governor: 'Governor', senate: 'U.S. Senate', president: 'President',
};

/** Expected campaign spending per resident by office type (scales "money matters" effects). */
const SPEND_PER_CAP: Record<OfficeType, number> = { council: 0.6, mayor: 1.2, county: 0.35, sldl: 1.6, sldu: 1.3, house: 3.2, governor: 2.2, senate: 2.6, president: 3.0 };
export const expectedSpend = (type: OfficeType, pop: number) => Math.max(3000, SPEND_PER_CAP[type] * pop);
export const SALARY: Record<OfficeType, number> = { council: 12000, mayor: 60000, county: 55000, sldl: 45000, sldu: 55000, house: 174000, governor: 150000, senate: 174000, president: 400000 };

const NEW_ENGLAND = new Set(['CT', 'MA', 'ME', 'NH', 'VT', 'RI']);
export const NO_COUNTY_GOV = new Set(['CT', 'RI']);

/** 2020-census electoral votes. */
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
    case 'house': return year % 2 === 0;
    case 'pres': return m4 === 0;
    case 'sen': return year % 6 === ({ 1: 2, 2: 4, 3: 0 } as Record<string, number>)[b];
    case 'gov': {
      const g = GOVERNORS[a];
      return !!g && year >= g.next && (year - g.next) % GOV_TERM(a) === 0;
    }
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
  if (def.type === 'president') return 3; // modeled as a Jan–Jun sequence; month the race is "decided" is computed in-game
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
  ids.push(`mayor:${t.id}`);
  if (!NO_COUNTY_GOV.has(t.st)) for (let i = 0; i < countySeats; i++) ids.push(`county:${t.county}:${i}`);
  if (t.sldl && t.st !== 'NE' && data.districts[`sldl:${t.sldl}`]) ids.push(`sldl:${t.sldl}`);
  if (t.sldu && data.districts[`sldu:${t.sldu}`]) ids.push(`sldu:${t.sldu}`);
  if (t.cd && data.districts[`cd:${t.cd}`]) ids.push(`house:${t.cd}`);
  if (t.st !== 'DC') {
    ids.push(`gov:${t.st}`);
    for (const s of data.states[t.st]?.senators ?? []) ids.push(`sen:${t.st}:${s.cls}`);
  }
  ids.push('pres');
  return ids;
}

/** All state + federal offices materialized at game start. */
export function seedOfficeIds(data: DataStore): string[] {
  const ids: string[] = ['pres'];
  for (const [st, s] of Object.entries(data.states)) {
    if (st === 'DC') continue;
    ids.push(`gov:${st}`);
    for (const sen of s.senators) ids.push(`sen:${st}:${sen.cls}`);
  }
  for (const [key, d] of Object.entries(data.districts)) {
    const [kind, geoid] = key.split(':');
    if (kind === 'cd') ids.push(`house:${geoid}`);
    else if (kind === 'sldl' && d.st !== 'NE') ids.push(`sldl:${geoid}`);
    else if (kind === 'sldu') ids.push(`sldu:${geoid}`);
  }
  return ids;
}
