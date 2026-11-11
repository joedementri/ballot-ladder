/**
 * M11: a living world. AI politicians climb the ladder (the bench), rivals with persistent careers, redistricting
 * after the 2030 census (reapportionment, new maps, the player's veto, eliminated seats), and the shipped data
 * (district plans and the town-boundary PMTiles archive).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHeader } from 'pmtiles';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { EV, isUp } from '../src/sim/offices';
import { activeRivals, recordRace } from '../src/sim/careers';
import { conventions } from '../src/sim/primaries';
import { vacate } from '../src/sim/vacancies';
import { STATE_LIST, type Background, type Party, type StatePlans, type Town } from '../src/data/types';

const DATA = join(import.meta.dirname, '..', 'public', 'data');
let e: Engine;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
});

async function start(st: string, prefix: string, party: Party, o: { seed?: number; background?: Background; start?: 2025 | 2027 } = {}): Promise<Town> {
  const town = (await e.data.townsOf(st)).find((t) => t.name.startsWith(prefix))!;
  await e.newGame({
    first: 'Test', last: 'Player', gender: 'F', age: 45, party, homeTown: town.id, background: o.background ?? 'lawyer',
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
/** Every office's holder points back at that office, and nobody holds two. */
function consistent() {
  const seen = new Set<string>();
  for (const o of Object.values(e.s.offices)) {
    if (!o.holder) continue;
    const p = e.s.politicians[o.holder];
    expect(p, o.id).toBeDefined();
    expect(p.officeId, `${o.id} holder`).toBe(o.id);
    expect(seen.has(p.id), `${p.id} holds two seats`).toBe(false);
    seen.add(p.id);
  }
}

describe('rivals and careers', () => {
  it('seeds rivals from both parties around the player', async () => {
    await start('PA', 'Harrisburg', 'D');
    const rivals = activeRivals(e);
    expect(rivals.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rivals.map(([id]) => e.pol(id)!.party))).toEqual(new Set(['D', 'R']));
    for (const [id] of rivals) expect(e.pol(id)!.notable).toBe(true);
    expect(e.s.news.some((n) => n.kind === 'rival')).toBe(true);
    const v = e.view().rivals;
    expect(v.length).toBe(rivals.length);
    expect(v[0].note.length).toBeGreaterThan(10);
  });

  it('officeholders climb: open seats draw nominees from the bench', async () => {
    await start('OH', 'Columbus', 'R', { seed: 11 });
    await advance(24, () => e.s.year === 2026 && e.s.month === 11);
    const before = new Map(Object.values(e.s.offices).filter((o) => o.holder).map((o) => [o.holder!, o.id]));
    await advance(3, () => e.s.year === 2027 && e.s.month === 2);
    let up = 0;
    for (const [pid, old] of before) {
      const p = e.pol(pid);
      if (p?.officeId && p.officeId !== old && (e.def(p.officeId)?.level ?? 0) > (e.def(old)?.level ?? 0)) up++;
    }
    console.log(`officeholders who moved up in the 2026 midterms: ${up}`);
    expect(up).toBeGreaterThan(15);
    consistent();
  }, 60000);

  it('remembers who beat the player, and keeps rivals after they leave office', async () => {
    const town = await start('WI', 'Madison', 'D', { seed: 3 });
    const id = `sldl:${town.sldl}`;
    const rival = e.pol(e.s.offices[id].holder)!;
    recordRace(e, {
      officeId: id, title: e.def(id)!.title, year: 2026, stage: 'general', winnerId: rival.id, units: [], blocs: [], unitKind: 'precinct',
      cands: [{ id: e.player.id, name: 'Test Player', party: 'D', votes: 45, isPlayer: true }, { id: rival.id, name: e.name(rival), party: rival.party, votes: 55 }],
    }, false);
    expect(e.s.rivals![rival.id].tag).toBe('nemesis');
    expect(e.s.rivals![rival.id].record).toHaveLength(1);
    vacate(e, id, 'resigned to take a private-sector job');
    expect(e.pol(rival.id)).toBeDefined();
    expect(e.view().rivals.find((r) => r.id === rival.id)!.losses).toBe(1);
  });

  it('rivals jump into the player’s races', async () => {
    let joined = 0;
    for (let seed = 1; seed <= 6 && !joined; seed++) {
      const town = await start('GA', 'Savannah', 'R', { seed });
      await e.file(`sldl:${town.sldl}`);
      const c = e.s.campaign!;
      joined += [...c.primaryField, ...c.generalField, ...c.otherField].filter((id) => e.s.rivals?.[id]).length;
    }
    expect(joined).toBeGreaterThan(0);
  });

  it('presidential tickets come from governors, senators and the Vice President', async () => {
    let known = 0;
    for (let seed = 1; seed <= 3; seed++) {
      await start('IA', 'Des Moines', 'D', { seed });
      e.s.year = 2028;
      e.s.month = 7;
      conventions(e);
      for (const p of ['D', 'R'] as const) {
        const pres = e.pol(e.s.tickets![p]!.pres)!;
        if (pres.officeId && /^(gov|sen|vp)/.test(pres.officeId)) known++;
        expect(pres.notable).toBe(true);
      }
    }
    expect(known).toBeGreaterThanOrEqual(3);
  });
});

describe('redistricting', () => {
  it('reapportions after the census, redraws the maps in 2031 and retires lost seats in 2033', async () => {
    const austin = await start('TX', 'Austin', 'D', { seed: 5 });
    expect(EV.TX).toBe(40);
    e.s.year = 2030;
    e.s.month = 12;
    await advance(1);
    expect(e.s.redistricting?.apportioned).toBe(true);
    expect(EV.TX).toBe(44);
    expect(EV.CA).toBe(50);
    expect(Object.values(EV).reduce((a, b) => a + b, 0)).toBe(538);
    expect(e.s.news.some((n) => n.title.startsWith('Census 2030'))).toBe(true);

    await advance(9, () => e.s.year === 2031 && e.s.month === 10);
    const R = e.s.redistricting!;
    expect(Object.keys(R.plans).filter((k) => k.startsWith('cd:')).length).toBe(50);
    expect(R.plans['cd:TX'].plan).toBe('R'); // Republican trifecta
    expect(R.plans['cd:CA'].plan).toBe('fair'); // commission
    const live = (st: string) => Object.values(e.data.districts).filter((d) => d.kind === 'cd' && d.st === st && !d.retired).length;
    expect(live('TX')).toBe(42);
    expect(live('CA')).toBe(48);
    const newTx = Object.keys(e.s.offices).filter((id) => /^house:48(39|4\d)$/.test(id));
    expect(newTx.length).toBe(4);
    for (const id of newTx) expect(e.s.offices[id].holder).toBeNull();
    // towns follow the new lines, and lost seats come off the ballot
    const plans: StatePlans = JSON.parse(readFileSync(join(DATA, 'redistrict', 'TX.json'), 'utf8'));
    const i = (await e.data.townsOf('TX')).findIndex((t) => t.id === austin.id);
    expect(austin.cd).toBe(plans.cd!.codes![plans.cd!.plans!.R!.towns[i]]);
    const gone = R.retired!.filter((id) => id.startsWith('house:06'));
    expect(gone.length).toBe(4);
    expect(isUp(gone[0], 2032, e.data)).toBe(false);
    const upIn2032 = Object.keys(e.s.offices).filter((id) => id.startsWith('house:') && isUp(id, 2032, e.data));
    expect(upIn2032.length).toBe(435);

    await advance(16, () => e.s.year === 2033 && e.s.month === 2);
    const house = Object.keys(e.s.offices).filter((id) => id.startsWith('house:'));
    expect(house.length).toBe(435);
    expect(house.filter((id) => !e.s.offices[id].holder).length).toBeLessThan(10);
    expect(e.s.offices[gone[0]]).toBeUndefined();
    consistent();
    const tx = house.filter((id) => e.def(id)?.st === 'TX');
    expect(tx.length).toBe(42);
  }, 120000);

  it('a governor facing the other party’s legislature can veto its map', async () => {
    await start('WI', 'Madison', 'D', { seed: 9 });
    e.installOffice('gov:WI', e.player.id);
    e.s.year = 2030;
    e.s.month = 12;
    await advance(1);
    e.s.month = 8;
    await advance(1);
    const d = e.s.decisions.find((x) => x.meta?.kind === 'map');
    expect(d, 'map decision').toBeDefined();
    expect(d!.options[0].label).toContain('Veto');
    expect(e.decide(d!.id, 0).ok).toBe(true);
    await advance(1);
    const c = e.s.redistricting!.plans['cd:WI'];
    expect(c.plan).toBe('fair');
    expect(c.by).toContain('vetoed');
    // reloading the save brings the maps back
    const st = JSON.parse(JSON.stringify(e.exportState()));
    await start('VT', 'Burlington', 'R');
    expect(e.data.activePlans['cd:WI']).toBeUndefined();
    expect(EV.TX).toBe(40);
    e.load(st);
    await e.restore();
    expect(e.data.activePlans['cd:WI']).toBe('fair');
    expect(EV.TX).toBe(44);
  }, 60000);
});

describe('M11 data', () => {
  it('has three plans for every redrawn map, aligned with the towns', () => {
    const app = JSON.parse(readFileSync(join(DATA, 'redistrict', 'apportion.json'), 'utf8'));
    expect(Object.values(app.seats as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(435);
    for (const st of STATE_LIST) {
      if (st === 'DC') continue;
      const f: StatePlans = JSON.parse(readFileSync(join(DATA, 'redistrict', `${st}.json`), 'utf8'));
      const towns = JSON.parse(readFileSync(join(DATA, 'places', `${st}.json`), 'utf8'));
      expect(f.cd!.seats).toBe(app.seats[st]);
      for (const [kind, m] of Object.entries(f)) {
        if (m.keep) continue;
        for (const [pk, p] of Object.entries(m.plans!)) {
          expect(Object.keys(p.d).length, `${st} ${kind} ${pk}`).toBe(m.seats);
          expect(p.towns.length).toBe(towns.length);
          expect(existsSync(join(DATA, 'geo', 'plans', kind, `${st}-${pk}.json`)), `${st} ${kind} ${pk} shapes`).toBe(true);
        }
      }
    }
  });

  it('ships town boundaries as a valid PMTiles archive', () => {
    const buf = readFileSync(join(DATA, 'geo', 'towns.pmtiles'));
    const h = bytesToHeader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 127), undefined);
    expect(h.specVersion).toBe(3);
    expect(h.tileType).toBe(1); // vector tiles
    expect(h.minZoom).toBe(6);
    expect(h.numAddressedTiles).toBeGreaterThan(5000);
    expect(h.tileDataOffset + h.tileDataLength).toBe(buf.length);
  });
});
