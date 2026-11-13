/**
 * M10: more offices (school board, sheriff, prosecutor, county executive, row offices, lieutenant governor,
 * supreme court, Vice President), the state-by-state presidential primary calendar with delegates and running
 * mates, House and governor result history, and the 2027 start.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { COURTS, PRES_CALENDAR, isUp, officeDef, officesForTown, seedOfficeIds } from '../src/sim/offices';
import { allocate, delegatePool } from '../src/sim/primaries';
import { generateDecisions } from '../src/sim/governing';
import { vacate } from '../src/sim/vacancies';
import { Rng } from '../src/sim/rng';
import type { Background, Party, Town } from '../src/data/types';

let e: Engine;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
});

async function start(st: string, prefix: string, party: Party, o: { seed?: number; background?: Background; start?: 2025 | 2027; age?: number } = {}): Promise<Town> {
  const town = (await e.data.townsOf(st)).find((t) => t.name.startsWith(prefix))!;
  await e.newGame({
    first: 'Test', last: 'Player', gender: 'F', age: o.age ?? 45, party, homeTown: town.id, background: o.background ?? 'lawyer',
    pos: PARTY_BASE[party].map((x) => x * 0.8), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed: o.seed ?? 7, start: o.start,
  });
  return town;
}
async function advance(max: number, done: () => boolean = () => false) {
  for (let i = 0; i < max && !done(); i++) {
    if (e.s.pendingNight) e.ackNight();
    await e.endTurn();
  }
  if (e.s.pendingNight) e.ackNight();
}

describe('office catalog', () => {
  it('seeds row offices, lieutenant governors, courts and the VP', () => {
    const ids = seedOfficeIds(e.data);
    const count = (p: string) => ids.filter((x) => x.startsWith(p)).length;
    expect(count('ltgov:')).toBe(43);
    expect(count('ag:')).toBe(43);
    expect(count('sos:')).toBe(35);
    expect(count('treas:')).toBe(36);
    expect(count('judge:')).toBe(Object.values(COURTS).reduce((a, c) => a + c.seats, 0));
    expect(ids).toContain('vp');
    expect(officeDef('treas:FL', e.data)?.title).toBe('Chief Financial Officer of Florida');
    expect(officeDef('ltgov:AZ', e.data)).toBeNull();
  });

  it('gives towns a school board and counties a sheriff, prosecutor and (where elected) an executive', async () => {
    const harris = (await e.data.townsOf('TX')).find((t) => t.name.startsWith('Houston'))!;
    const ids = officesForTown(harris, e.data);
    expect(ids.some((x) => x.startsWith(`school:${harris.id}:`))).toBe(true);
    expect(ids).toContain(`sheriff:${harris.county}`);
    expect(ids).toContain(`da:${harris.county}`);
    expect(officeDef(`cexec:${harris.county}`, e.data)?.title).toBe('County Judge of Harris County');
    // no elected prosecutors in New Jersey, and a small Ohio county has no executive
    const nj = (await e.data.townsOf('NJ'))[0];
    expect(officeDef(`da:${nj.county}`, e.data)).toBeNull();
    const oh = (await e.data.townsOf('OH')).find((t) => (e.data.counties[t.county].d[0] ?? 0) < 50000)!;
    expect(officeDef(`cexec:${oh.county}`, e.data)).toBeNull();
    // California sheriffs are nonpartisan
    const la = (await e.data.townsOf('CA')).find((t) => t.name.startsWith('Los Angeles'))!;
    expect(officeDef(`sheriff:${la.county}`, e.data)?.partisan).toBe(false);
  });

  it('schedules the new offices', () => {
    const harris = '48201';
    expect(isUp(`sheriff:${harris}`, 2028, e.data)).toBe(true);
    expect(isUp(`sheriff:${harris}`, 2026, e.data)).toBe(false);
    expect(isUp('ag:OH', 2026, e.data)).toBe(true);
    expect(isUp('ag:PA', 2028, e.data)).toBe(true); // Pennsylvania row offices run in presidential years
    expect(isUp('ag:PA', 2026, e.data)).toBe(false);
    expect(isUp('ltgov:VA', 2025, e.data)).toBe(true);
    expect(isUp('vp', 2028, e.data)).toBe(false);
    // every court seat is up exactly once per term, in the right parity
    for (const [st, ct] of Object.entries(COURTS)) {
      for (let seat = 0; seat < ct.seats; seat++) {
        const years = Array.from({ length: ct.term * 2 }, (_, i) => 2026 + i).filter((y) => isUp(`judge:${st}:${seat}`, y, e.data));
        expect(years.length, `${st} seat ${seat}`).toBe(2);
        expect(years[1] - years[0]).toBe(ct.term % 2 && !ct.odd ? ct.term + 1 : ct.term);
        expect(years.every((y) => (y % 2 === 1) === !!ct.odd)).toBe(true);
      }
    }
  });
});

describe('officials', () => {
  it('have their own decisions, and justices must be lawyers', async () => {
    const town = await start('OH', 'Columbus', 'R', { background: 'teacher' });
    const opts = await e.availableOffices();
    const bench = opts.find((o) => o.id.startsWith('judge:OH:'))!;
    expect(bench.eligible).toBe(false);
    expect(bench.reason).toContain('lawyer');
    expect(opts.some((o) => o.id === `sheriff:${town.county}`)).toBe(true);
    expect(opts.some((o) => o.id.startsWith(`school:${town.id}:`))).toBe(true);

    e.installOffice(`sheriff:${town.county}`, e.player.id);
    expect(e.legislature()?.kind).toBe('executive'); // no chamber of their own
    const rng = new Rng('sheriff-decisions');
    const seen = new Set<string>();
    for (let m = 0; m < 40; m++) for (const d of generateDecisions(rng, 'sheriff', false, 'Franklin County', 2025, (m % 12) + 1, [], () => `t${m}`)) seen.add(d.templateId);
    expect(seen.has('jail_crowding') || seen.has('detainers') || seen.has('bodycams')).toBe(true);
    expect([...seen].every((id) => !['min_wage', 'tax_cut', 'budget'].includes(id))).toBe(true);
    // deciding moves the office's metrics
    const crime0 = e.s.player.metrics.crime;
    e.s.decisions.push(...generateDecisions(new Rng('x'), 'sheriff', false, 'Franklin County', 2025, 2, [], () => 'x').filter(() => false));
    e.s.decisions.push({ id: 'dtest', templateId: 'drug_bust', title: 't', body: '', options: [{ label: 'Crack down', detail: '', metrics: { crime: -0.6 } }], deadline: { year: 2025, month: 3 } });
    expect(e.decide('dtest', 0).ok).toBe(true);
    expect(e.s.player.metrics.crime).toBeLessThan(crime0);
  });

  it('a county executive signs or vetoes county commission bills', async () => {
    const town = await start('TX', 'Austin', 'D');
    e.installOffice(`cexec:${town.county}`, e.player.id);
    const leg = e.legislature()!;
    expect(leg.kind).toBe('executive');
    expect(leg.chambers[0].key).toBe(`county:${town.county}`);
    expect(leg.chambers[0].seats).toBe(5);
    expect(e.budgetView()).not.toBeNull();
  });
});

describe('succession', () => {
  it('a lieutenant governor becomes governor and appoints their own replacement', async () => {
    await start('MI', 'Lansing', 'D');
    e.installOffice('ltgov:MI', e.player.id);
    vacate(e, 'gov:MI', 'resigned for health reasons');
    expect(e.player.officeId).toBe('gov:MI');
    expect(e.s.offices['ltgov:MI'].holder).toBeNull();
    // the new governor fills the lieutenant governor's seat
    expect(e.s.decisions.some((d) => d.meta?.kind === 'appoint' && d.meta.officeId === 'ltgov:MI')).toBe(true);
  });

  it('the Vice President succeeds the President', async () => {
    await start('PA', 'Lansdale', 'D');
    const vp = e.s.offices.vp.holder!;
    vacate(e, 'pres', 'died in office');
    expect(e.s.offices.pres.holder).toBe(vp);
    expect(e.s.vacancies?.some((v) => v.officeId === 'vp' && v.by === 'pres')).toBe(true);
  });
});

describe('presidential primaries', () => {
  it('pools delegates by state and allocates them by party rules', () => {
    const d = delegatePool(e, 'D');
    const r = delegatePool(e, 'R');
    expect(Math.abs(d.total - 3949)).toBeLessThan(80);
    expect(Math.abs(r.total - 2429)).toBeLessThan(80);
    expect(d.needed).toBe(Math.floor(d.total / 2) + 1);
    expect(d.pool.CA).toBeGreaterThan(d.pool.WY * 20);
    expect(Object.keys(d.pool).length).toBe(PRES_CALENDAR.flatMap((m) => m.states).length);
    // Democrats: proportional above 15%
    expect(allocate([45, 40, 10, 5], 100, 'D', 3)).toEqual([53, 47, 0, 0]);
    // Republicans: proportional early unless someone tops 50%, winner-take-all from April
    expect(allocate([45, 35, 20], 30, 'R', 2)).toEqual([14, 10, 6]);
    expect(allocate([55, 45], 30, 'R', 2)).toEqual([30, 0]);
    expect(allocate([40, 35, 25], 30, 'R', 4)).toEqual([30, 0, 0]);
  });

  it('runs the nomination state by state, with nights, delegates and a running mate', async () => {
    const run = async (seed: number) => {
      await start('PA', 'Lansdale', 'D', { seed });
      e.installOffice('sen:PA:1', e.player.id);
      e.s.year = 2027;
      e.s.month = 11;
      e.s.player.rec.US = 0.6;
      e.player.fav = 0.62;
      e.s.player.cash = 4e8;
      const r = await e.file('pres');
      expect(r.ok).toBe(true);
      const c = e.s.campaign!;
      expect(c.pres!.needed).toBeGreaterThan(1900);
      expect(c.primaryField.length).toBeGreaterThanOrEqual(4);
      const nights: string[] = [];
      for (let i = 0; i < 9 && c.stage === 'primary'; i++) {
        for (const a of ['ads_tv', 'ads_digital', 'rally']) await e.act(a, 'IA');
        await e.endTurn();
        if (e.s.pendingNight) {
          const n = e.s.pendingNight;
          expect(n.unitKind).toBe('state');
          expect(n.delegates).toBeTruthy();
          nights.push(`${n.title}|${Object.values(n.delegates!.won).reduce((a, b) => a + b, 0)}`);
          e.ackNight();
        }
      }
      return { nights, stage: c.stage, delegates: { ...c.pres!.delegates }, career: e.player.career.map((x) => x.result), decisions: e.s.decisions.map((d) => d.templateId) };
    };
    const a = await run(21);
    const b = await run(21);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    console.log('primary nights:', a.nights.join(' · '), '| stage:', a.stage, '| career:', a.career.join(','));
    expect(a.nights[0]).toContain('Iowa & New Hampshire');
    if (a.stage === 'general') expect(a.decisions).toContain('vp_pick');
    else expect(a.career).toContain('lost-primary');
  }, 120000);

  it('conventions set both tickets, and the winning running mate becomes Vice President', async () => {
    await start('VA', 'Richmond', 'R', { seed: 5 });
    e.s.year = 2028;
    e.s.month = 7;
    await advance(1);
    expect(e.s.tickets?.year).toBe(2028);
    const t = e.s.tickets!;
    expect(t.D && t.R).toBeTruthy();
    await advance(8, () => e.s.year === 2029);
    const pres = e.s.offices.pres.holder!;
    const vp = e.s.offices.vp.holder!;
    const party = e.s.politicians[pres].party as 'D' | 'R';
    expect([t[party]!.pres, pres]).toContain(pres);
    expect(vp).toBe(t[party]!.vp);
    expect(e.s.tickets).toBeNull();
  }, 120000);
});

describe('history and the 2027 start', () => {
  it('ships House and governor result history', () => {
    const dir = join(import.meta.dirname, '..', 'public', 'data');
    const house = JSON.parse(readFileSync(join(dir, 'results', 'house.json'), 'utf8'));
    expect(Object.keys(house).length).toBe(435);
    expect(Object.keys(house['4207'])).toContain('2024');
    const pa = e.data.states.PA as any;
    expect(pa.gov['2022'][0]).toBeGreaterThan(pa.gov['2022'][1]); // Shapiro (D) won 2022
    expect((e.data.states.VA as any).gov['2021'][1]).toBeGreaterThan((e.data.states.VA as any).gov['2021'][0]); // Youngkin (R)
  });

  it('starts in January 2027 after simulating the midterms', async () => {
    const t0 = Date.now();
    await start('WI', 'Madison', 'D', { start: 2027, age: 40 });
    console.log(`2027 start in ${Date.now() - t0}ms`);
    expect(e.s.year).toBe(2027);
    expect(e.s.month).toBe(1);
    expect(e.age(e.player)).toBe(40);
    expect(e.s.startYear).toBe(2027);
    // the 2025 off-year governors are the real winners
    expect(e.pol(e.s.offices['gov:NJ'].holder)?.party).toBe('D');
    expect(e.pol(e.s.offices['gov:VA'].holder)?.party).toBe('D');
    // NJ's lieutenant governor rides the governor's ticket
    expect(e.pol(e.s.offices['ltgov:NJ'].holder)?.party).toBe('D');
    const n = e.national();
    const seated = (n.house.D ?? 0) + (n.house.R ?? 0);
    expect(seated).toBeGreaterThan(428);
    expect(e.s.news.some((x) => x.title.includes('2026 midterms'))).toBe(true);
    expect(e.s.incoming).toEqual({});
    // and the game carries on
    await advance(2);
    expect(e.s.month).toBe(3);
  }, 120000);
});
