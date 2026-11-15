/**
 * M21: data and map refresh. Hawaii's census-designated places and the District of Columbia are playable home towns
 * (the decision desk's retractions and noisy calls are tested in night.test.ts; the data checks are in
 * `npm run data:validate`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { DataStore } from '../src/data/store';
import { DC_TOWN, type Party, type Town } from '../src/data/types';
import { PARTY_BASE } from '../src/sim/issues';
import { isUp, officeDef, officesForTown } from '../src/sim/offices';

let data: DataStore;
beforeAll(async () => {
  data = new DataStore(BASE);
  await data.loadCore();
});

async function start(e: Engine, town: Town, party: Party = 'D', seed = 21) {
  await e.newGame({
    first: 'Test', last: 'Player', gender: 'F', age: 40, party, homeTown: town.id, background: 'teacher', difficulty: 'story',
    pos: PARTY_BASE[party].map((x) => x * 0.8), skills: { charisma: 60, debate: 55, fundraising: 55, policy: 55, integrity: 70, organization: 55 }, seed,
  });
}

/** The golden script: file for the next step up, campaign, answer decisions, end the month. */
async function play(e: Engine, months: number, home: string) {
  for (let i = 0; i < months; i++) {
    if (e.s.pendingNight) e.ackNight();
    if (e.s.gameOver) break;
    const c = e.s.campaign;
    if (!c || c.stage === 'done') {
      const level = e.player.officeId ? e.def(e.player.officeId)!.level : 0;
      const opts = (await e.availableOffices()).filter((o) => o.eligible && o.level > level).sort((a, b) => a.year - b.year || a.level - b.level || (a.id < b.id ? -1 : 1));
      if (opts[0]) await e.file(opts[0].id);
    }
    const target = (await e.targets())[0]?.id ?? home;
    for (const [a, t] of [['fund_small'], ['canvass', target], ['town_hall', target], ['ads_digital']] as [string, string?][]) await e.act(a, t);
    for (const d of [...e.s.decisions]) e.decide(d.id, 0);
    await e.endTurn();
  }
  if (e.s.pendingNight) e.ackNight();
}

describe('Hawaii', () => {
  it('has census-designated places as towns, inside real districts, with neighborhood boards and county mayors', async () => {
    const towns = await data.townsOf('HI');
    expect(towns.length).toBeGreaterThan(100);
    expect(towns.every((t) => t.cdp && t.cd && t.sldu && t.sldl && data.counties[t.county]?.st === 'HI')).toBe(true);
    const hilo = towns.find((t) => t.name === 'Hilo')!;
    const ids = officesForTown(hilo, data);
    expect(officeDef(`council:${hilo.id}:0`, data)!.title).toBe('Neighborhood Board, Seat 1');
    expect(officeDef(`mayor:${hilo.id}`, data)!.title).toBe('Neighborhood Board Chair of Hilo');
    expect(officeDef(`county:${hilo.county}:0`, data)!.title).toMatch(/^County Council/);
    // Hawaii County (200k) has an elected mayor, like Honolulu; Kalawao (run by the state) doesn't
    expect(officeDef(`cexec:${hilo.county}`, data)!.title).toBe('Mayor of Hawaii County');
    expect(officeDef('cexec:15005', data)).toBeNull();
    for (const k of ['house:', 'sldu:', 'sldl:', 'gov:HI', 'sen:HI:', 'pres']) expect(ids.some((id) => id.startsWith(k))).toBe(true);
    expect(ids.some((id) => id.startsWith('sheriff:'))).toBe(false); // no elected sheriffs in Hawaii
  });

  it('a career starting in Hilo plays through its first election', async () => {
    const e = new Engine(BASE);
    await e.init();
    const hilo = (await e.data.townsOf('HI')).find((t) => t.name === 'Hilo')!;
    await start(e, hilo);
    await play(e, 13, hilo.id);
    expect(e.s.year).toBe(2026);
    console.log('Hilo career:', e.player.career.map((c) => `${c.year} ${c.title} ${c.result}`).join('; '));
    const first = e.player.career.find((c) => c.result === 'won' || c.result === 'lost');
    expect(first?.officeId).toMatch(/^council:P15/);
    expect(e.exportState().player).toBeTruthy();
  }, 120000);

  it('every town has a district in each of Hawaii\'s 2030 plans', async () => {
    const plans = await data.statePlans('HI');
    const towns = await data.townsOf('HI');
    for (const kind of ['cd', 'sldu', 'sldl'] as const)
      for (const p of Object.values(plans[kind]!.plans!)) {
        expect(p.towns).toHaveLength(towns.length);
        expect(p.towns.every((i) => i >= 0)).toBe(true);
      }
  });
});

describe('District of Columbia', () => {
  it('is one town with a council, a mayor and a board of education, and no state or congressional offices', async () => {
    const towns = await data.townsOf('DC');
    expect(towns).toHaveLength(1);
    const dc = towns[0];
    expect(dc.id).toBe(DC_TOWN);
    expect(dc.name).toBe('District of Columbia');
    expect(dc.cd ?? dc.sldu ?? dc.sldl).toBeNull();
    const ids = officesForTown(dc, data);
    expect(ids.filter((id) => id.startsWith('council:'))).toHaveLength(13);
    expect(ids).toContain(`mayor:${dc.id}`);
    expect(ids).toContain('pres');
    expect(ids.filter((id) => /^(county|cexec|sheriff|da|sldl|sldu|house|gov|sen|ltgov|ag|sos|treas|judge):/.test(id))).toEqual([]);
    expect(officeDef(`mayor:${dc.id}`, data)!.title).toBe('Mayor of the District of Columbia');
    expect(officeDef(`council:${dc.id}:4`, data)!.title).toBe('Council of the District of Columbia, Seat 5');
    expect(officeDef(`school:${dc.id}:0`, data)!.title).toBe('DC State Board of Education, Seat 1');
  });

  it('votes in even Novembers: the mayor in midterm years, council seats staggered', () => {
    const years = (id: string) => [2025, 2026, 2027, 2028, 2029, 2030].filter((y) => isUp(id, y, data));
    expect(years(`mayor:${DC_TOWN}`)).toEqual([2026, 2030]);
    expect(years(`council:${DC_TOWN}:0`)).toEqual([2026, 2030]);
    expect(years(`council:${DC_TOWN}:1`)).toEqual([2028]);
    expect(years(`school:${DC_TOWN}:1`)).toEqual([2028]);
    // other towns keep their odd-year schedule
    expect(isUp('mayor:P4241432', 2025, data)).toBe(true);
  });

  it('a DC career runs for council in 2026 and the save reloads', async () => {
    const e = new Engine(BASE);
    await e.init();
    const dc = (await e.data.townsOf('DC'))[0];
    await start(e, dc);
    const opts = await e.availableOffices();
    expect(opts.some((o) => o.id.startsWith('house:') || o.id.startsWith('gov:'))).toBe(false);
    await play(e, 23, dc.id);
    expect(e.s.year).toBe(2026);
    expect(e.s.month).toBe(12);
    console.log('DC career:', e.player.career.map((c) => `${c.year} ${c.title} ${c.result}`).join('; '));
    const race = e.player.career.find((c) => c.officeId.startsWith(`council:${DC_TOWN}`) && (c.result === 'won' || c.result === 'lost'));
    expect(race?.year).toBe(2026);
    const j = await e.jurisdiction('town', dc.id);
    expect(j.offices.length).toBeGreaterThan(13);
    const e2 = new Engine(BASE);
    await e2.init();
    e2.load(JSON.parse(JSON.stringify(e.exportState())));
    await e2.restore();
    await e2.endTurn();
    expect(e2.s.year).toBe(2027);
  }, 180000);
});
