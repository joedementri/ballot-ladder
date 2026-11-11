import { describe, expect, it, beforeAll } from 'vitest';
import { BASE } from './setup';
import { DataStore } from '../src/data/store';
import { demoFrom } from '../src/data/types';
import { calibrate, quickDShare, unitShares, type Candidate, type Unit } from '../src/sim/vote';
import { PARTY_BASE } from '../src/sim/issues';
import { isUp, officeDef, seedOfficeIds } from '../src/sim/offices';
import { Engine } from '../src/sim/game';
import { logit } from '../src/sim/rng';

let data: DataStore;
beforeAll(async () => {
  data = new DataStore(BASE);
  await data.loadCore();
});

const generic = (p: 'D' | 'R'): Candidate => ({ id: p, name: p, party: p, pos: PARTY_BASE[p], rec: 0.5, fav: 0.5, incumbent: false, spend: 1, endorse: 0, scandal: 0, skill: 0.5 });
const ctx = (env = 0) => ({ kind: 'general' as const, env, envWeight: 1, expectedSpend: 1 });

describe('vote model', () => {
  it('generic candidates reproduce each county lean', () => {
    let maxErr = 0;
    for (const [id, c] of Object.entries(data.counties).slice(0, 400)) {
      const u: Unit = { id, label: c.n, pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d) };
      calibrate(u);
      const s = quickDShare(u, generic('D'), generic('R'), ctx());
      maxErr = Math.max(maxErr, Math.abs(s - Math.min(0.98, Math.max(0.02, c.lean))));
    }
    expect(maxErr).toBeLessThan(0.01);
  });

  it('calibrated on 2016, predicts 2020 county winners (uniform national swing)', () => {
    const share = (r?: number[]) => (r && r[0] + r[1] > 0 ? r[0] / (r[0] + r[1]) : null);
    const nat16 = [0, 0], nat20 = [0, 0];
    for (const c of Object.values(data.counties)) {
      if (!c.pres?.[2016] || !c.pres?.[2020]) continue;
      nat16[0] += c.pres[2016][0]; nat16[1] += c.pres[2016][1];
      nat20[0] += c.pres[2020][0]; nat20[1] += c.pres[2020][1];
    }
    // party term is ±env/2, so the swing in logit space is doubled
    const env = (logit(nat20[0] / (nat20[0] + nat20[1])) - logit(nat16[0] / (nat16[0] + nat16[1]))) * 2;
    let right = 0, n = 0;
    for (const [id, c] of Object.entries(data.counties)) {
      const s16 = share(c.pres?.[2016]), s20 = share(c.pres?.[2020]);
      if (s16 == null || s20 == null) continue;
      const u: Unit = { id: `${id}-16`, label: c.n, pop: c.d[0] ?? 0, lean: s16, demo: demoFrom(c.d) };
      const pred = quickDShare(u, generic('D'), generic('R'), ctx(env));
      if (pred > 0.5 === s20 > 0.5) right++;
      n++;
    }
    console.log(`2016->2020 county winner accuracy: ${((right / n) * 100).toFixed(1)}% of ${n}`);
    expect(right / n).toBeGreaterThan(0.95);
  });

  it('a moderate beats a generic partisan in a swing seat', () => {
    const c = data.districts['cd:4207'];
    const u: Unit = { id: 'pa7', label: c.n, pop: c.pop, lean: c.lean, demo: demoFrom(c.d) };
    const mod = { ...generic('D'), pos: PARTY_BASE.D.map((x) => x * 0.4) };
    expect(quickDShare(u, mod, generic('R'), ctx())).toBeGreaterThan(quickDShare(u, generic('D'), generic('R'), ctx()));
  });

  it('primary electorate prefers the more partisan candidate', () => {
    const c = data.districts['cd:4207'];
    const u: Unit = { id: 'pa7p', label: c.n, pop: c.pop, lean: c.lean, demo: demoFrom(c.d) };
    const mod = { ...generic('D'), id: 'mod', pos: PARTY_BASE.D.map((x) => x * 0.2) };
    const { shares } = unitShares(u, [generic('D'), mod], { kind: 'primary', party: 'D', env: 0, envWeight: 1, expectedSpend: 1 });
    expect(shares[0]).toBeGreaterThan(shares[1]);
  });
});

describe('office catalog & calendar', () => {
  it('matches real seat counts', () => {
    const ids = seedOfficeIds(data);
    const count = (p: string) => ids.filter((x) => x.startsWith(p)).length;
    expect(count('house:')).toBe(435);
    expect(count('sen:')).toBe(100);
    expect(count('gov:')).toBe(50);
    const leg = count('sldu:') + count('sldl:');
    console.log(`state legislative districts: ${leg}`);
    expect(leg).toBeGreaterThan(4500);
  });
  it('schedules elections correctly', () => {
    expect(isUp('house:4207', 2026, data)).toBe(true);
    expect(isUp('house:4207', 2027, data)).toBe(false);
    expect(isUp('pres', 2028, data)).toBe(true);
    expect(isUp('gov:NJ', 2025, data)).toBe(true);
    expect(isUp('gov:PA', 2026, data)).toBe(true);
    expect(isUp('gov:PA', 2028, data)).toBe(false);
    expect(isUp('sen:PA:1', 2030, data)).toBe(true);
    expect(isUp('sen:GA:2', 2026, data)).toBe(true);
    expect(isUp('sen:PA:3', 2028, data)).toBe(true);
    expect(officeDef('house:4207', data)?.title).toContain('PA-7');
  });
});

describe('engine', () => {
  it('plays a council race through two years deterministically', async () => {
    const run = async () => {
      const e = new Engine(BASE);
      await e.init();
      const towns = await e.data.townsOf('PA');
      const town = towns.find((t) => t.name.startsWith('Lansdale'))!;
      await e.newGame({ first: 'Test', last: 'Player', gender: 'F', age: 35, party: 'D', homeTown: town.id, background: 'teacher', pos: PARTY_BASE.D.map((x) => x * 0.7), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed: 42 });
      const offices = await e.availableOffices();
      expect(offices.length).toBeGreaterThan(5);
      const council = offices.find((o) => o.id.startsWith('council:') && o.year === 2025)!;
      expect((await e.file(council.id)).ok).toBe(true);
      const t0 = Date.now();
      for (let i = 0; i < 24; i++) {
        if (e.view().pendingNight) e.ackNight();
        for (const a of ['fund_small', 'canvass', 'town_hall']) await e.act(a, town.id);
        for (const d of e.view().decisions) e.decide(d.id, 0);
        await e.endTurn();
      }
      const ms = Date.now() - t0;
      const st = e.exportState();
      return { ms, size: JSON.stringify(st).length, career: e.player.career, year: st.year, pols: Object.keys(st.politicians).length, nat: e.national() };
    };
    const a = await run();
    const b = await run();
    console.log(`24 turns in ${a.ms}ms, save ${(a.size / 1e6).toFixed(2)}MB, ${a.pols} politicians, career:`, JSON.stringify(a.career), 'national:', JSON.stringify({ h: a.nat.house, s: a.nat.senate, g: a.nat.governors }));
    expect(a.year).toBe(2027);
    expect(a.career.some((c) => c.officeId.startsWith('council:'))).toBe(true);
    expect(JSON.stringify(a.career)).toBe(JSON.stringify(b.career));
    expect(Object.values(a.nat.house).reduce((x, y) => x + (y ?? 0), 0)).toBe(435);
  }, 120000);
});
