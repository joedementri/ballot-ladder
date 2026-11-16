/**
 * M22: Redistricting 2.0. Milder gerrymanders chosen by the size of the majority, commission deadlocks and
 * court-drawn maps, lawsuits with remedial maps, mid-decade redraws (a new trifecta, Texas-style upgrades, Ohio's
 * sunset), and a 2040 census on the same machinery.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { EV, isUp } from '../src/sim/offices';
import { members } from '../src/sim/legislature';
import { applyGeography, who } from '../src/sim/redistricting';
import { STATE_LIST, type Apportionment, type Party, type StatePlans, type Town } from '../src/data/types';

const DATA = join(import.meta.dirname, '..', 'public', 'data');
const read = <T,>(rel: string): T => JSON.parse(readFileSync(join(DATA, rel), 'utf8'));
let e: Engine;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
});

async function start(st: string, prefix: string, party: Party, seed = 7): Promise<Town> {
  const town = (await e.data.townsOf(st)).find((t) => t.name.startsWith(prefix))!;
  await e.newGame({
    first: 'Test', last: 'Player', gender: 'F', age: 45, party, homeTown: town.id, background: 'lawyer',
    pos: PARTY_BASE[party].map((x) => x * 0.8), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed,
  });
  return town;
}
async function advance(n: number) {
  for (let i = 0; i < n; i++) {
    if (e.s.pendingNight) e.ackNight();
    await e.endTurn();
  }
  if (e.s.pendingNight) e.ackNight();
}
/** The 2030 census and every 2031 map (overdue ones are enacted together in September). */
async function afterCensus() {
  e.s.year = 2030;
  e.s.month = 12;
  await advance(1);
  e.s.year = 2031;
  e.s.month = 9;
  await advance(1);
}
/** Set a chamber's majority to a share of seats (the rest go to the other party). */
function setChamber(key: string, party: 'D' | 'R', share: number) {
  const ms = members(e, key);
  const n = Math.round(ms.length * share);
  ms.forEach((p, i) => (p.party = i < n ? party : party === 'D' ? 'R' : 'D'));
}
const at = (y: number, m: number) => { e.s.year = y; e.s.month = m; };

describe('M22 data', () => {
  it('ships milder gerrymanders between the fair and aggressive maps, and a court map, for both censuses', () => {
    let courtDiffers = 0, maps = 0;
    for (const census of [2030, 2040]) {
      const dir = census === 2030 ? '' : `${census}/`;
      for (const st of STATE_LIST) {
        if (st === 'DC') continue;
        const f = read<StatePlans>(`redistrict/${dir}${st}.json`);
        for (const [kind, m] of Object.entries(f)) {
          if (m.keep || !m.plans?.D) continue;
          maps++;
          const s = (p: keyof NonNullable<typeof m.plans>) => m.plans![p]!.seats.D;
          const tag = `${census} ${st} ${kind}`;
          expect(s('D-lean'), tag).toBeGreaterThanOrEqual(s('fair') - 0.15);
          expect(s('D-lean'), tag).toBeLessThanOrEqual(Math.max(s('D'), s('fair')) + 0.15);
          expect(s('R-lean'), tag).toBeLessThanOrEqual(s('fair') + 0.15);
          expect(s('R-lean'), tag).toBeGreaterThanOrEqual(Math.min(s('R'), s('fair')) - 0.15);
          for (const pk of Object.keys(m.plans)) expect(existsSync(join(DATA, 'geo', 'plans', ...dir.split('/').filter(Boolean), kind, `${st}-${pk}.json`)), `${tag} ${pk}`).toBe(true);
          if (JSON.stringify(m.plans.court!.towns) !== JSON.stringify(m.plans.fair!.towns)) courtDiffers++;
        }
      }
    }
    expect(maps).toBeGreaterThan(200);
    // the court draws its own map, not the commission's
    expect(courtDiffers / maps).toBeGreaterThan(0.9);
  });

  it('apportions 2040 from the 2030 seats, and numbers its districts against them', () => {
    const a30 = read<Apportionment>('redistrict/apportion.json');
    const a40 = read<Apportionment>('redistrict/2040/apportion.json');
    expect(a40.census).toBe(2040);
    expect(Object.values(a40.seats).reduce((x, y) => x + y, 0)).toBe(435);
    expect(Object.values(a40.ev).reduce((x, y) => x + y, 0)).toBe(538);
    expect(a40.before).toEqual(a30.seats);
    expect(a40.seats.TX).toBeGreaterThan(a30.seats.TX);
    for (const st of ['CA', 'TX', 'NY', 'FL']) {
      const f30 = read<StatePlans>(`redistrict/${st}.json`).cd!;
      const f40 = read<StatePlans>(`redistrict/2040/${st}.json`).cd!;
      expect(f40.before).toBe(f30.seats);
      expect(f40.retired).toEqual(f30.codes!.filter((c) => !f40.codes!.includes(c)));
    }
  });
});

describe('who draws the map', () => {
  it('draws an aggressive gerrymander with a big majority and a milder one with a thin majority', async () => {
    await start('TX', 'Austin', 'D');
    expect(e.pol(e.s.offices['gov:TX'].holder)!.party).toBe('R');
    setChamber('sldu:TX', 'R', 0.7);
    setChamber('sldl:TX', 'R', 0.62);
    expect(who(e, 'TX', 'cd').plan).toBe('R');
    setChamber('sldl:TX', 'R', 0.53);
    const w = who(e, 'TX', 'cd');
    expect(w.plan).toBe('R-lean');
    expect(w.drafted).toBe('R-lean');
    // a veto-proof legislature goes all the way
    setChamber('sldu:TX', 'R', 0.7);
    setChamber('sldl:TX', 'R', 0.7);
    expect(who(e, 'TX', 'cd').plan).toBe('R');
    // divided government: a court draws its own map
    setChamber('sldl:TX', 'D', 0.55);
    expect(who(e, 'TX', 'cd')).toMatchObject({ plan: 'court', partisan: true });
  });

  it('bipartisan commissions deadlock often, citizen commissions rarely, and a tiebreaker picks a side', async () => {
    await start('VA', 'Richmond', 'D');
    const tally = (st: string) => {
      const n: Record<string, number> = {};
      for (let seed = 1; seed <= 300; seed++) {
        e.s.seed = seed;
        const p = who(e, st, 'cd', true).plan;
        n[p] = (n[p] ?? 0) + 1;
      }
      return n;
    };
    const va = tally('VA');
    expect(va.court).toBeGreaterThan(45);
    expect(va.court).toBeLessThan(110);
    expect((tally('CA').court ?? 0)).toBeLessThan(25);
    const nj = tally('NJ');
    expect(nj.court ?? 0).toBe(0);
    expect(nj.fair).toBeGreaterThan(80);
    expect(nj['D-lean']).toBeGreaterThan(nj['R-lean'] ?? 0); // a blue state's tiebreaker leans blue
    // previews never show a deadlock
    e.s.seed = 1;
    for (let i = 0; i < 5; i++) expect(who(e, 'VA', 'cd').plan).toBe('fair');
  });
});

describe('courts', () => {
  it('strikes down gerrymanders, replacing them with a court map or a milder remedial map', async () => {
    await start('TX', 'Austin', 'D', 5);
    await afterCensus();
    const R = e.s.redistricting!;
    const seen: Record<string, number> = {};
    for (let seed = 1; seed <= 14; seed++) {
      e.s.seed = seed;
      R.plans['cd:TX'] = { plan: 'R', by: 'the Republican legislature and governor', year: 2031, month: 9 };
      R.challenges = { 'cd:TX': 2032 * 12 + 2 };
      await applyGeography(e);
      at(2032, 2);
      await advance(1);
      const c = R.plans['cd:TX'];
      expect(R.challenges['cd:TX']).toBeUndefined();
      const k = c.struck ? (c.remedial ? 'remedial' : 'court') : 'upheld';
      seen[k] = (seen[k] ?? 0) + 1;
      if (c.remedial) expect(c.plan).toBe('R-lean');
      if (k === 'court') expect(c.plan).toBe('court');
      expect(e.data.activePlans['cd:TX']).toBe(c.plan);
    }
    console.log('court rulings on an aggressive map (14 seeds):', seen);
    expect(seen.upheld).toBeGreaterThan(0);
    expect((seen.court ?? 0) + (seen.remedial ?? 0)).toBeGreaterThan(2);
  }, 60000);
});

describe('mid-decade redraws', () => {
  it('a new trifecta redraws a map it didn’t draw, announced in March and enacted in June', async () => {
    await start('TX', 'Austin', 'D', 5);
    await afterCensus();
    const R = e.s.redistricting!;
    R.plans['cd:TX'] = { plan: 'court', by: 'a court', year: 2031, month: 9 };
    delete R.challenges!['cd:TX'];
    await applyGeography(e);
    for (let seed = 1; seed <= 20 && !R.pending?.TX; seed++) {
      e.s.seed = seed;
      at(2033, 3);
      await advance(1);
    }
    const p = R.pending!.TX;
    expect(p).toMatchObject({ why: 'flip', year: 2033 });
    expect(['R', 'R-lean']).toContain(p.plan);
    expect(e.s.news.some((n) => n.title.includes('redraw the congressional map mid-decade'))).toBe(true);
    // commissions can't be overridden mid-decade
    expect(R.pending?.CA).toBeUndefined();
    at(2033, 4);
    await advance(3);
    const c = R.plans['cd:TX'];
    expect(c).toMatchObject({ plan: p.plan, mid: true, year: 2033 });
    expect(e.data.activePlans['cd:TX']).toBe(p.plan);
    expect(R.pending?.TX).toBeUndefined();
    expect(e.s.news.some((n) => n.title.startsWith('Mid-decade redistricting:'))).toBe(true);
  }, 60000);

  it('a governor can veto a mid-decade redraw, and the current map stays', async () => {
    await start('TX', 'Austin', 'R', 5);
    await afterCensus();
    e.installOffice('gov:TX', e.player.id);
    const R = e.s.redistricting!;
    R.plans['cd:TX'] = { plan: 'court', by: 'a court', year: 2031, month: 9 };
    delete R.challenges!['cd:TX'];
    await applyGeography(e);
    R.pending = { TX: { plan: 'R', why: 'flip', by: 'the Republican legislature and governor', year: 2033 } };
    at(2033, 5);
    await advance(1);
    const d = e.s.decisions.find((x) => x.meta?.kind === 'map' && x.meta.mid);
    expect(d, 'mid-decade map decision').toBeDefined();
    expect(d!.options.map((o) => o.label)).toEqual(['Sign the legislature’s map', 'Insist on a milder map', 'Veto it; keep the current map']);
    expect(d!.meta!.plans).toEqual(['R', 'R-lean', 'court']);
    expect(e.decide(d!.id, 2).ok).toBe(true);
    await advance(1);
    expect(R.plans['cd:TX'].plan).toBe('court');
    expect(R.plans['cd:TX'].mid).toBeUndefined();
    expect(e.s.news.some((n) => n.title.includes('mid-decade redraw fails'))).toBe(true);
  }, 60000);

  it('Ohio’s partisan map expires after two elections and is redrawn once', async () => {
    await start('OH', 'Columbus', 'R', 5);
    await afterCensus();
    const R = e.s.redistricting!;
    R.plans['cd:OH'] = { plan: 'R', by: 'the Republican legislature and governor', year: 2031, month: 9 };
    delete R.challenges!['cd:OH'];
    at(2033, 3);
    await advance(1);
    expect(R.pending?.OH).toBeUndefined();
    at(2035, 3);
    await advance(1);
    expect(R.pending!.OH.why).toBe('sunset');
    at(2035, 4);
    await advance(3);
    expect(R.plans['cd:OH']).toMatchObject({ mid: true, year: 2035 });
    at(2037, 3);
    await advance(1);
    expect(R.pending?.OH?.why).not.toBe('sunset');
  }, 60000);
});

describe('the 2040 census', () => {
  it('reapportions again, redraws in 2041 on the 2040 plans, retires lost seats in 2043, and reloads', async () => {
    const austin = await start('TX', 'Austin', 'D', 5);
    await afterCensus();
    at(2032, 12);
    await advance(1); // January 2033: seats lost in 2030 are gone
    const a40 = read<Apportionment>('redistrict/2040/apportion.json');
    at(2040, 12);
    await advance(1);
    const R = e.s.redistricting!;
    expect(R.census).toBe(2040);
    expect(EV.TX).toBe(a40.ev.TX);
    expect(Object.values(EV).reduce((a, b) => a + b, 0)).toBe(538);
    expect(e.s.news.some((n) => n.title.startsWith('Census 2040'))).toBe(true);
    // the 2030 maps stay until the new ones are drawn
    expect(e.data.activePlans['cd:TX'].startsWith('2040/')).toBe(false);

    at(2041, 9);
    await advance(1);
    expect(Object.values(R.plans).filter((c) => c.census === 2040).length).toBeGreaterThan(100);
    const ref = e.data.activePlans['cd:TX'];
    expect(ref.startsWith('2040/')).toBe(true);
    const live = (st: string) => Object.values(e.data.districts).filter((d) => d.kind === 'cd' && d.st === st && !d.retired).length;
    expect(live('TX')).toBe(a40.seats.TX);
    expect(live('CA')).toBe(a40.seats.CA);
    const f40 = read<StatePlans>('redistrict/2040/TX.json');
    const i = (await e.data.townsOf('TX')).findIndex((t) => t.id === austin.id);
    expect(austin.cd).toBe(f40.cd!.codes![f40.cd!.plans![ref.slice(5) as 'fair']!.towns[i]]);
    const lost = read<StatePlans>('redistrict/2040/CA.json').cd!.retired!;
    expect(lost.length).toBeGreaterThan(0);
    expect(R.retired).toEqual(expect.arrayContaining(lost.map((c) => `house:${c}`)));
    expect(isUp(`house:${lost[0]}`, 2042, e.data)).toBe(false);
    // the seats lost in 2030 don't come back with today's records
    expect(e.data.districts['cd:0652'].retired).toBe(true);
    expect(Object.keys(e.s.offices).filter((id) => id.startsWith('house:') && isUp(id, 2042, e.data)).length).toBe(435);

    // reload
    const st = JSON.parse(JSON.stringify(e.exportState()));
    await start('VT', 'Burlington', 'R');
    expect(e.data.activePlans['cd:TX']).toBeUndefined();
    e.load(st);
    await e.restore();
    expect(e.data.activePlans['cd:TX']).toBe(ref);
    expect(EV.TX).toBe(a40.ev.TX);

    at(2042, 12);
    await advance(1);
    const house = Object.keys(e.s.offices).filter((id) => id.startsWith('house:'));
    expect(house.length).toBe(435);
    expect(e.s.offices[`house:${lost[0]}`]).toBeUndefined();
  }, 180000);

  it('loads a pre-M22 redistricting save (2030 plans without a census tag)', async () => {
    await start('WI', 'Madison', 'D', 9);
    await afterCensus();
    const st = JSON.parse(JSON.stringify(e.exportState()));
    for (const c of Object.values(st.redistricting.plans) as any[]) {
      delete c.census;
      if (c.plan === 'court') c.plan = 'fair';
      if (c.plan === 'D-lean') c.plan = 'D';
      if (c.plan === 'R-lean') c.plan = 'R';
    }
    delete st.redistricting.pending;
    e.load(st);
    await e.restore();
    expect(e.data.activePlans['cd:WI']).toBe(st.redistricting.plans['cd:WI'].plan);
    at(2033, 2);
    await advance(2);
    expect(e.s.redistricting!.census).toBe(2030);
  }, 60000);
});
