/**
 * M14 beatable incumbents and a fairer primary path: incumbency strength, the incumbent's record, running against
 * it, and the party's backing before a primary. Win-rate bands live in balance.test.ts (npm run balance for the table).
 */
import { describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { incumbencyStrength, judgeIncumbents, recordApproval } from '../src/sim/incumbency';
import { unitShares } from '../src/sim/vote';
import type { Party } from '../src/data/types';
import type { GameState } from '../src/sim/model';

/** A Lansdale, PA politician in January 2026, ready to file for governor (held by a Democrat at game start). */
async function setup(party: Party = 'R', seed = 11) {
  const e = new Engine(BASE);
  await e.init();
  const town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))!;
  await e.newGame({
    first: 'Max', last: 'Challenger', gender: 'M', age: 48, party, homeTown: town.id, background: 'lawyer', difficulty: 'normal',
    pos: PARTY_BASE[party].map((x) => x * 0.7), skills: { charisma: 60, debate: 60, fundraising: 60, policy: 60, integrity: 60, organization: 60 }, seed,
  });
  e.s.year = 2026;
  e.s.month = 1;
  const def = e.def('gov:PA')!;
  const holder = e.pol(e.ensureOffice('gov:PA')!.holder)!;
  // a first-term, 55-year-old governor who runs again (seeded incumbents may otherwise be term-limited)
  holder.terms = 1;
  holder.birthYear = 2026 - 55;
  return { e, def, holder };
}

/** Make every chance roll come out `v` (restored by deleting the instance override). */
const forceChance = (e: Engine, v: boolean) => ((e.rng as any).chance = () => v);
const restoreChance = (e: Engine) => delete (e.rng as any).chance;

describe('incumbency strength', () => {
  it('wears down with narrow wins, scandal, long tenure and midterms in the President’s party', async () => {
    const { e, def, holder } = await setup();
    expect(holder.party).toBe('D');
    const o = e.s.offices['gov:PA'];
    const reset = () => {
      o.lastShare = 0.6;
      holder.scandal = 0;
      holder.terms = 1;
      e.s.world.presParty = 'R';
    };
    reset();
    expect(incumbencyStrength(e, holder, def, 2026)).toBe(1);
    o.lastShare = 0.505;
    expect(incumbencyStrength(e, holder, def, 2026)).toBeLessThan(0.9);
    reset();
    holder.scandal = 0.4;
    expect(incumbencyStrength(e, holder, def, 2026)).toBeCloseTo(0.8);
    reset();
    holder.terms = 4;
    expect(incumbencyStrength(e, holder, def, 2026)).toBeCloseTo(0.8);
    reset();
    e.s.world.presParty = 'D';
    expect(incumbencyStrength(e, holder, def, 2026)).toBeLessThan(1); // midterm
    expect(incumbencyStrength(e, holder, def, 2028)).toBe(1); // presidential year
    // not the incumbent: no advantage at all
    expect(incumbencyStrength(e, e.player, def, 2026)).toBe(0);
  });

  it('is worth votes in proportion to its strength', async () => {
    const { e, def, holder } = await setup();
    const ctx = e.ctxFor(def, 'general');
    const unit = e.jurUnit(def);
    const share = (inc: number) => {
      const a = { ...e.candidate(holder.id, def, null), incumbent: inc };
      const b = { ...e.candidate(e.player.id, def, null), rec: a.rec, fav: a.fav, spend: a.spend, endorse: 0, skill: a.skill };
      return unitShares(unit, [a, b], ctx).shares[0];
    };
    expect(share(1)).toBeGreaterThan(share(0.5));
    expect(share(0.5)).toBeGreaterThan(share(0));
    expect(share(1) - share(0)).toBeLessThan(0.1); // a ~0.35 logit edge, a few points
  });
});

describe('the incumbent’s record', () => {
  it('a challenged incumbent’s favorability follows the national mood', async () => {
    const { e, def, holder } = await setup();
    expect((await e.file('gov:PA')).ok).toBe(true);
    const c = e.s.campaign!;
    const w = e.s.world;
    const start = holder.fav;
    // a bad year for the incumbent's party: their President is unpopular and the generic ballot runs against them
    Object.assign(w, { presParty: 'D', presApproval: 0.38, genericBallot: -7 });
    const bad = recordApproval(e, holder, def);
    for (let i = 0; i < 12; i++) judgeIncumbents(e, c);
    expect(holder.fav).toBeLessThan(start);
    expect(Math.abs(holder.fav - bad)).toBeLessThan(0.05);
    // a good year lifts them
    Object.assign(w, { presParty: 'R', presApproval: 0.38, genericBallot: 7 });
    expect(recordApproval(e, holder, def)).toBeGreaterThan(bad + 0.05);
    for (let i = 0; i < 12; i++) judgeIncumbents(e, c);
    expect(holder.fav).toBeGreaterThan(bad + 0.03);
  });

  it('runs against the record only after opposition research lands, and repeats fade', async () => {
    const { e, holder } = await setup();
    await e.file('gov:PA');
    const c = e.s.campaign!;
    const P = e.s.player;
    P.cash = 1e9;
    expect(e.actionNotes().record.blocked).toMatch(/opposition research/);
    expect((await e.act('record', holder.id)).ok).toBe(false);
    for (let i = 0; i < 40 && !(c.oppoFound ?? []).includes(holder.id); i++) {
      P.ap = 99;
      await e.act('oppo', holder.id);
    }
    expect(c.oppoFound).toContain(holder.id);
    expect(e.actionNotes().record.targets).toEqual([holder.id]);
    const me = e.player.id;
    const fav0 = holder.fav, bias0 = c.bias[me] ?? 0;
    P.ap = 99;
    expect((await e.act('record', holder.id)).ok).toBe(true);
    const firstFav = fav0 - holder.fav, firstBias = c.bias[me] - bias0;
    expect(firstFav).toBeGreaterThan(0);
    expect(firstBias).toBeGreaterThan(0);
    const fav1 = holder.fav, bias1 = c.bias[me];
    await e.act('record', holder.id);
    expect(c.bias[me] - bias1).toBeLessThan(firstBias);
    expect(fav1 - holder.fav).toBeLessThan(firstFav);
    expect(c.recordRuns).toBe(2);
  });
});

describe('party backing', () => {
  /** File for governor and make sure there are three same-party challengers in the primary. */
  async function filed(party: Party = 'R') {
    const s = await setup(party);
    await s.e.file('gov:PA');
    const c = s.e.s.campaign!;
    const unit = s.e.jurUnit(s.def);
    while (c.primaryField.filter((id) => s.e.pol(id)!.party === party && id !== s.e.player.id).length < 3) {
      const p = s.e.genPolitician(s.e.rng, { party, lean: unit.lean, home: 'PA', quality: 0.6 });
      c.primaryField.push(p.id);
      c.budget[p.id] = 1000;
      c.rec[p.id] = 0.1;
    }
    return { ...s, c };
  }

  it('clears the primary field when party leaders agree', async () => {
    const { e, c } = await filed();
    const P = e.s.player;
    P.partyStanding = 90;
    expect(e.actionNotes().party_backing.blocked).toBeUndefined();
    const before = c.primaryField.length;
    forceChance(e, true);
    const r = await e.act('party_backing');
    restoreChance(e);
    expect(r.ok).toBe(true);
    expect(c.backing).toBe('won');
    expect(c.primaryField.length).toBeLessThan(before);
    expect(c.primaryField).toContain(e.player.id);
    expect(c.endorse[e.player.id]).toBeGreaterThanOrEqual(2);
    // once per race
    expect(e.actionNotes().party_backing.blocked).toMatch(/already behind you/);
    expect((await e.act('party_backing')).ok).toBe(false);
  });

  it('a snub costs standing and leaves the field alone', async () => {
    const { e, c } = await filed();
    const P = e.s.player;
    const standing = P.partyStanding, field = [...c.primaryField];
    forceChance(e, false);
    await e.act('party_backing');
    restoreChance(e);
    expect(c.backing).toBe('lost');
    expect(P.partyStanding).toBe(standing - 6);
    expect(c.primaryField).toEqual(field);
  });

  it('is only for contested primaries the party can clear, before the primary month', async () => {
    // the party backs its own incumbent
    const d = await filed('D');
    expect(d.c.primaryField).toContain(d.holder.id);
    expect(d.e.actionNotes().party_backing.blocked).toMatch(/incumbent/);
    // too late in the primary month itself
    const r = await filed('R');
    r.e.s.month = r.c.primaryMonth;
    expect(r.e.actionNotes().party_backing.blocked).toMatch(/before the primary/);
    // odds rise with standing
    r.e.s.month = 1;
    r.e.s.player.partyStanding = 20;
    const low = Number(r.e.actionNotes().party_backing.note!.replace(/\D/g, ''));
    r.e.s.player.partyStanding = 80;
    const high = Number(r.e.actionNotes().party_backing.note!.replace(/\D/g, ''));
    expect(high).toBeGreaterThan(low);
  });
});

describe('saves', () => {
  it('a campaign saved before M14 keeps playing', async () => {
    const { e } = await setup();
    await e.file('gov:PA');
    const st = JSON.parse(JSON.stringify(e.exportState())) as GameState;
    delete st.campaign!.oppoFound;
    delete st.campaign!.recordRuns;
    delete st.campaign!.backing;
    e.load(st);
    await e.restore();
    expect(e.actionNotes().record.blocked).toBeTruthy();
    for (let i = 0; i < 3; i++) await e.endTurn();
    expect(e.view().campaign?.field.some((f) => f.incumbent && f.incStrength > 0)).toBe(true);
  });
});
