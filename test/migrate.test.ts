/**
 * M12 save migrations: a real version 1 save (test/fixtures/save-v1.json.gz, see test/fixtures/README.md) loads,
 * gets the version 2 defaults and keeps playing; newer saves are refused; reloading a save mid-career replays exactly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine, SAVE_VERSION } from '../src/sim/game';
import { migrate } from '../src/sim/migrate';
import { members } from '../src/sim/legislature';
import { PARTY_BASE } from '../src/sim/issues';

const fixture = () => JSON.parse(gunzipSync(readFileSync(join(import.meta.dirname, 'fixtures', 'save-v1.json.gz'))).toString('utf8'));

let e: Engine;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
});

async function advance(n: number) {
  for (let i = 0; i < n; i++) {
    if (e.s.pendingNight) e.ackNight();
    for (const d of [...e.s.decisions]) e.decide(d.id, 0);
    await e.endTurn();
  }
  if (e.s.pendingNight) e.ackNight();
}

describe('save migrations', () => {
  it('upgrades a version 1 save and keeps playing', async () => {
    const st = fixture();
    expect(st.version).toBe(1);
    for (const k of ['leadership', 'vacancies', 'specials', 'rivals', 'difficulty', 'startYear']) expect(st[k]).toBeUndefined();
    expect(st.player.favors).toBeUndefined();
    e.load(st);
    await e.restore();
    expect(e.s.version).toBe(SAVE_VERSION);
    expect(e.s).toMatchObject({ difficulty: 'normal', startYear: 2025, leadership: {}, vacancies: [], specials: [], rivals: {}, tickets: null });
    expect(e.s.player).toMatchObject({ log: [], favors: 0, role: null, bid: null, committees: [], bills: [], budget: null, policies: [] });
    expect(e.s.world.policy).toEqual({ unemployment: 0, inflation: 0, gdp: 0 });
    // redistricting stays unset so restore() can catch up saves already past the 2030 census
    expect(e.s.redistricting).toBeUndefined();

    // the player sits in the PA House: the chamber, leadership and governing all work on the old save
    const officeId = e.player.officeId!;
    expect(officeId).toMatch(/^sldl:/);
    expect(e.legislature()!.chamber!.seats).toBeGreaterThan(150);
    const { year, month } = e.s;
    await advance(12);
    expect(e.s.year * 12 + e.s.month).toBe(year * 12 + month + 12);
    expect(e.s.player.favors).toBeGreaterThan(0);
    expect(Object.keys(e.s.leadership)).toContain('sldl:PA');
    expect(members(e, 'sldl:PA').length).toBeGreaterThan(150);
    expect(e.view().summary).not.toBeNull();
  }, 120000);

  it('is a no-op for current saves and refuses newer ones', () => {
    const st = fixture();
    const once = JSON.stringify(migrate(st));
    expect(JSON.stringify(migrate(JSON.parse(once)))).toBe(once);
    expect(() => migrate({ ...JSON.parse(once), version: SAVE_VERSION + 1 })).toThrow(/newer version/);
    expect(() => migrate({ version: 1 })).toThrow(/Not a Ballot Ladder save/);
  });

  it('a reloaded save continues exactly like the original', async () => {
    const town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))!;
    const play = async (n: number) => {
      for (let i = 0; i < n; i++) {
        if (e.s.pendingNight) e.ackNight();
        for (const [a, t] of [['fund_small'], ['canvass', town.id], ['town_hall', town.id]] as [string, string?][]) await e.act(a, t);
        for (const d of [...e.s.decisions]) e.decide(d.id, 0);
        await e.endTurn();
      }
    };
    const start = async () => {
      await e.newGame({
        first: 'Re', last: 'Load', gender: 'F', age: 40, party: 'R', homeTown: town.id, background: 'business',
        pos: PARTY_BASE.R.map((x) => x * 0.7), skills: { charisma: 60, debate: 55, fundraising: 60, policy: 50, integrity: 65, organization: 55 }, seed: 77,
      });
      e.installOffice(`council:${town.id}:0`, e.player.id);
      const mayor = (await e.availableOffices()).find((o) => o.id.startsWith('mayor:'))!;
      expect((await e.file(mayor.id)).ok).toBe(true);
    };
    await start();
    await play(12);
    const straight = JSON.stringify(e.exportState());
    await start();
    await play(6);
    const saved = JSON.stringify(e.exportState());
    e.load(JSON.parse(saved));
    await e.restore();
    await play(6);
    expect(e.s.results.some((r) => r.officeId.startsWith('mayor:'))).toBe(true);
    expect(JSON.stringify(e.exportState())).toBe(straight);
  }, 120000);
});
