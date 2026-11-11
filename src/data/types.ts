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
}

/** [id, name, lat, lon, pop, county, cd, sldu, sldl, lean, demo(age,income,white,black,asian,hispanic,college,density)] */
export type TownRow = [string, string, number, number, number, string, string | null, string | null, string | null, number, (number | null)[]];

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
}

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
  return { id: r[0], name: r[1], st, lat: r[2], lon: r[3], pop: r[4], county: r[5], cd: r[6], sldu: r[7], sldl: r[8], lean: r[9], demo };
}

export const STATE_LIST = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'] as const;
