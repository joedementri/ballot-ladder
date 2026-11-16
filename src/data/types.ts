export type Party = 'D' | 'R' | 'I';
/** [dem votes, rep votes, total votes] */
export type Res = [number, number, number];

export interface Demo {
  pop: number;
  age: number;
  income: number;
  white: number;
  black: number;
  asian: number;
  hispanic: number;
  college: number;
  density: number;
}

export interface StateData {
  fips: string;
  n: string;
  pop: number;
  d: (number | null)[];
  lean: number;
  pres: Record<string, Res>;
  senate: Record<string, Res>;
  /** Governor results by year ("<year>s" for specials); total 0 = uncontested. */
  gov?: Record<string, Res>;
  senators: { party: Party; cls: number }[];
  houseSeats: number;
}

export interface CountyData {
  n: string;
  st: string;
  d: (number | null)[];
  pres: Record<string, Res> | null;
  lean: number;
  leanSrc: 'real' | 'model';
}

export interface DistrictData {
  n: string;
  st: string;
  kind: 'cd' | 'sldu' | 'sldl';
  pop: number;
  d: (number | null)[];
  lean: number;
  county: string;
  party: Party | null;
  partySrc?: 'real' | 'model';
  /** Eliminated by reapportionment (its seat lasts until the new Congress is sworn in). */
  retired?: boolean;
}

/**
 * The plans drawn for each map (M11, M22): the neutral (commission) plan, each party's aggressive and milder
 * gerrymander, and a court-drawn plan.
 */
export type PlanVariant = 'fair' | 'D' | 'R' | 'D-lean' | 'R-lean' | 'court';
/** Censuses with precomputed plans. */
export const CENSUSES = [2030, 2040] as const;
/** Where a census's plan files live under redistrict/ and geo/plans/ (2030 at the top level, as in M11). */
export const censusDir = (census: number) => (census === 2030 ? '' : `${census}/`);
/** A plan reference as DataStore.activePlans holds it: '<plan>' for the 2030 census, '<census>/<plan>' after. */
export const planRef = (census: number | undefined, plan: string) => (!census || census === 2030 ? plan : `${census}/${plan}`);
export function parsePlanRef(ref: string): { census: number; plan: string } {
  const i = ref.indexOf('/');
  return i < 0 ? { census: 2030, plan: ref } : { census: +ref.slice(0, i), plan: ref.slice(i + 1) };
}
/** The shapes of a plan (TopoJSON under geo/). */
export const planGeoPath = (kind: string, st: string, ref: string) => {
  const { census, plan } = parsePlanRef(ref);
  return `plans/${censusDir(census)}${kind}/${st}-${plan}.json`;
};

/** A map's plans after the census (public/data/redistrict/[<census>/]<ST>.json, built by pipeline/redistrict.ts). */
export interface MapPlans {
  seats: number;
  /** Too few census tracts per district to redraw: the current lines are kept. */
  keep?: boolean;
  /** District codes (GEOIDs); plan town indexes point into this list. */
  codes?: string[];
  /** Congressional districts on today's map, and the ones reapportionment eliminates. */
  before?: number;
  retired?: string[];
  plans?: Partial<Record<PlanVariant, {
    d: Record<string, { n: string; pop: number; d: number[]; lean: number; county: string }>;
    /** Each town's district (index into `codes`), aligned with places/<ST>.json. */
    towns: number[];
    /** Expected seats by party. */
    seats: { D: number; R: number };
  }>>;
}
export type StatePlans = Partial<Record<'cd' | 'sldu' | 'sldl', MapPlans>>;
export interface Apportionment {
  census: number;
  pop: Record<string, number>;
  seats: Record<string, number>;
  before: Record<string, number>;
  ev: Record<string, number>;
}

/**
 * [id, name, lat, lon, pop, county, cd, sldu, sldl, lean, demo(age,income,white,black,asian,hispanic,college,density), flag?]
 * flag 'cdp': a census-designated place standing in for a town (Hawaii has no municipal governments).
 */
export type TownRow = [string, string, number, number, number, string, string | null, string | null, string | null, number, (number | null)[], 'cdp'?];

export interface Town {
  id: string;
  name: string;
  st: string;
  lat: number;
  lon: number;
  pop: number;
  county: string;
  cd: string | null;
  sldu: string | null;
  sldl: string | null;
  lean: number;
  demo: Demo;
  /** A census-designated place (Hawaii), not an incorporated town: its council and executive are simulated. */
  cdp?: boolean;
}

/** The District of Columbia's single town (Census place "Washington city"). */
export const DC_TOWN = 'P1150000';

const NAT: Demo = { pop: 0, age: 39, income: 75000, white: 0.58, black: 0.12, asian: 0.06, hispanic: 0.19, college: 0.35, density: 1000 };

export function demoFrom(arr: (number | null)[], withPop = true): Demo {
  const a = withPop ? arr : [0, ...arr];
  const v = (i: number, fb: number) => (a[i] == null || !Number.isFinite(a[i] as number) ? fb : (a[i] as number));
  return {
    pop: v(0, 0),
    age: v(1, NAT.age),
    income: v(2, NAT.income),
    white: v(3, NAT.white),
    black: v(4, NAT.black),
    asian: v(5, NAT.asian),
    hispanic: v(6, NAT.hispanic),
    college: v(7, NAT.college),
    density: v(8, NAT.density),
  };
}

export function townFrom(st: string, r: TownRow): Town {
  const demo = demoFrom(r[10], false);
  demo.pop = r[4];
  const t: Town = { id: r[0], name: r[1], st, lat: r[2], lon: r[3], pop: r[4], county: r[5], cd: r[6], sldu: r[7], sldl: r[8], lean: r[9], demo };
  if (r[11] === 'cdp') t.cdp = true;
  return t;
}

export const STATE_LIST = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'] as const;
