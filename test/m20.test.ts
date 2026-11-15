/**
 * M20 rivals 2.0 and officeholder endorsements: rivals announce runs months ahead and then file for that race,
 * incumbents (the player included) draw primary challengers, and the player can ask officeholders to endorse them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { ANNOUNCE, THREAT, activeRivals, announceRuns, primaryChallenges, primaryThreat, rivalFor, type BgRace, type Draft } from '../src/sim/careers';
import { ENDORSE, endorserOdds, endorserTargets, endorserWeight } from '../src/sim/endorsements';
import { startCampaign } from '../src/sim/races';
import { backgroundElections } from '../src/sim/background';
import type { Party, Town } from '../src/data/types';
import type { GameState } from '../src/sim/model';

let e: Engine;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
});

async function start(st: string, prefix: string, party: Party, seed = 7, lean = 0.8): Promise<Town> {
  const town = (await e.data.townsOf(st)).find((t) => t.name.startsWith(prefix))!;
  await e.newGame({
    first: 'Test', last: 'Player', gender: 'F', age: 45, party, homeTown: town.id, background: 'lawyer',
    pos: PARTY_BASE[party].map((x) => x * lean), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed,
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
const raceIds = () => { const c = e.s.campaign!; return [...c.primaryField, ...c.generalField, ...c.otherField]; };

describe('announcements', () => {
  it('rivals announce January to May, on their own streams, and then run in the race they announced', async () => {
    let plans = 0, honored = 0;
    for (const [st, prefix, party, seed] of [['PA', 'Harrisburg', 'D', 7], ['OH', 'Columbus', 'R', 11], ['GA', 'Savannah', 'R', 3]] as [string, string, Party, number][]) {
      await start(st, prefix, party, seed);
      await advance(12); // to January 2026
      expect(e.s.year).toBe(2026);
      // announcing never touches the main stream
      const rng = e.rng.state;
      await announceRuns(e);
      expect(e.rng.state).toBe(rng);
      await advance(ANNOUNCE.lastMonth, () => e.s.month === ANNOUNCE.lastMonth + 1);
      const planned = activeRivals(e).filter(([, r]) => r.plan?.year === 2026).map(([id, r]) => ({ id, ...r.plan! }));
      // one rival per party per background race
      const keys = planned.map((p) => `${e.pol(p.id)!.party}|${p.officeId}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const p of planned) {
        expect(p.month).toBeGreaterThanOrEqual(1);
        expect(p.month).toBeLessThanOrEqual(ANNOUNCE.lastMonth);
        expect(e.s.news.some((n) => n.kind === 'rival' && n.title.includes('announces a run for') && n.title.includes(e.def(p.officeId)!.title))).toBe(true);
      }
      // the Rivals card shows the plan
      const v = e.view().rivals.find((r) => r.id === planned[0]?.id);
      if (planned.length) expect(v?.plan?.title).toBe(e.def(planned[0].officeId)!.title);
      await advance(8, () => e.s.year === 2027);
      for (const p of planned) {
        plans++;
        if (e.pol(p.id)!.career.some((c) => c.officeId === p.officeId && c.year === 2026)) honored++;
      }
      // plans are cleared after November
      expect(activeRivals(e).some(([, r]) => r.plan?.year === 2026)).toBe(false);
    }
    expect(plans).toBeGreaterThanOrEqual(3);
    expect(honored).toBe(plans);
  }, 120000);

  it('an announced rival always files in the player’s race, and isn’t pulled into a different one', async () => {
    const town = await start('GA', 'Savannah', 'R', 3);
    e.s.year = 2026;
    const id = `sldl:${town.sldl}`;
    const def = e.def(id)!;
    const [rid, info] = activeRivals(e).find(([rid]) => e.pol(rid)!.party === 'R' && (e.pol(rid)!.officeId ? e.def(e.pol(rid)!.officeId!)!.level : 0) < def.level)!;
    // committed to some other race this year: never joins
    info.plan = { officeId: 'gov:GA', year: 2026, kind: 'open', month: 2 };
    expect(await rivalFor(e, def, 'R', new Set([e.player.id]), 2026)).not.toBe(e.pol(rid));
    // announced for this race: always files
    info.plan = { officeId: id, year: 2026, kind: 'you', month: 2 };
    await e.file(id);
    expect(raceIds()).toContain(rid);
    expect(e.s.news.some((n) => n.kind === 'rival' && n.title.includes('jumps into the race'))).toBe(true);
  });

  it('a rival who announces after the player filed joins the race under way', async () => {
    let joins = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const town = await start('PA', 'Harrisburg', 'D', seed);
      e.s.year = 2026;
      e.s.month = 1;
      const id = `sldl:${town.sldl}`;
      await e.file(id);
      for (const [, r] of activeRivals(e)) delete r.plan;
      for (let m = 1; m <= ANNOUNCE.lastMonth; m++) {
        e.s.month = m;
        await announceRuns(e);
      }
      for (const [rid, r] of activeRivals(e)) {
        if (r.plan?.officeId !== id) continue;
        expect(['you', 'primary']).toContain(r.plan.kind);
        expect(raceIds()).toContain(rid);
        joins++;
      }
    }
    expect(joins).toBeGreaterThan(0);
  }, 60000);
});

describe('primary challenges', () => {
  async function incumbent(standing: number, lean = 0.8) {
    const town = await start('PA', 'Harrisburg', 'D', 7, lean);
    const id = `sldl:${town.sldl}`;
    e.ensureOffice(id);
    e.installOffice(id, e.player.id, 'elected');
    e.s.year = 2026;
    e.s.month = 1;
    e.s.player.partyStanding = standing;
    // keep the rivals out of it, so only the threat decides
    for (const r of Object.values(e.s.rivals)) r.retired = 2025;
    await startCampaign(e, e.def(id)!, 2026);
    return e.s.campaign!;
  }

  it('a player with low standing, or far from the base, draws a challenger', async () => {
    const low = await incumbent(THREAT.standing - 10);
    expect(low.challenge).toBeDefined();
    expect(low.primaryField).toContain(low.challenge!.id);
    expect(low.challenge!.why).toMatch(/soured/);
    expect(e.pol(low.challenge!.id)!.party).toBe('D');
    expect(e.s.news.some((n) => n.title.includes('launches a primary challenge'))).toBe(true);
    expect(e.view().campaign!.challenger?.why).toBe(low.challenge!.why);

    const loyal = await incumbent(60);
    expect(primaryThreat(e)).toBeNull();
    expect(loyal.challenge).toBeUndefined();

    const drifted = await incumbent(60, -0.3); // a Democrat who sits right of center
    expect(drifted.challenge?.why).toMatch(/out of step/);
  });

  it('a player who loses renomination leaves office: the primary winner runs for the seat in November', async () => {
    const c = await incumbent(THREAT.standing - 10);
    const id = c.officeId;
    const chal = e.pol(c.challenge!.id)!;
    // the primary is lost (as resolvePrimary records it)
    c.stage = 'done';
    c.resultPrimary = { officeId: id, title: e.def(id)!.title, year: 2026, stage: 'primary', winnerId: chal.id, units: [], blocs: [], unitKind: 'precinct', cands: [] };
    e.s.month = 11;
    await backgroundElections(e, 2026);
    const next = e.s.incoming[id];
    expect(next).toBeDefined();
    expect(next).not.toBe(e.player.id);
    if (e.pol(next)!.party === chal.party) expect(next).toBe(chal.id);
    expect(e.s.news.some((n) => n.title.includes('did not seek re-election'))).toBe(false);
    e.s.month = 12;
    await e.endTurn();
    expect(e.player.officeId).toBeUndefined();
    expect(e.s.offices[id].holder).toBe(next);
  });

  it('AI incumbents in safe seats face occasional challenges, more when vulnerable, always when a rival announced one', async () => {
    await start('PA', 'Harrisburg', 'D', 7);
    const races: BgRace[] = [];
    for (const def of Object.values(e.s.offices).map((o) => e.def(o.id)!).filter((d) => d && (d.type === 'sldl' || d.type === 'house') && d.st === 'PA')) {
      const holder = e.pol(e.s.offices[def.id].holder)!;
      if (holder.isPlayer) continue;
      races.push({ id: def.id, def, holder, runs: true, lean: e.jurUnit(def).lean });
    }
    const challenged = (rs: BgRace[], year: number) => {
      const before = e.s.news.length;
      primaryChallenges(e, rs.map((r) => ({ ...r })), new Map(), year);
      const n = e.s.news.slice(0, e.s.news.length - before).find((x) => x.title.includes('challenged incumbents'));
      return n ? Number(/of (\d+) challenged/.exec(n.title)![1]) : 0;
    };
    let base = 0, weak = 0;
    for (let y = 2026; y <= 2040; y += 2) base += challenged(races, y);
    for (const r of races) r.holder!.scandal = 0.4;
    for (let y = 2026; y <= 2040; y += 2) weak += challenged(races, y);
    for (const r of races) r.holder!.scandal = 0;
    expect(base).toBeGreaterThan(0);
    expect(weak).toBeGreaterThan(base * 2);

    // an announced rival always gets their primary, and a winner becomes the nominee
    const r = races.find((x) => x.holder!.party === 'D' && x.lean > 0.65)!;
    const [rid] = activeRivals(e).find(([id]) => e.pol(id)!.party === 'D')!;
    const drafts = new Map<string, Draft>([[r.id, { primary: e.pol(rid)! }]]);
    const copy = { ...r };
    primaryChallenges(e, [copy], drafts, 2026);
    const lostPrimary = (p: string) => e.pol(p)!.career.some((c) => c.officeId === r.id && c.year === 2026 && c.result === 'lost-primary');
    expect(lostPrimary(rid) || lostPrimary(r.holder!.id)).toBe(true);
    if (lostPrimary(r.holder!.id)) {
      expect(copy.runs).toBe(false);
      expect(drafts.get(r.id)!.D?.id).toBe(rid);
    } else expect(copy.runs).toBe(true);
  });
});

describe('officeholder endorsements', () => {
  it('lists overlapping officeholders of the player’s party (never rivals), once each, with bounded odds', async () => {
    const town = await start('PA', 'Harrisburg', 'D', 7);
    e.s.year = 2026;
    await e.file(`sldl:${town.sldl}`);
    const c = e.s.campaign!;
    const list = endorserTargets(e, c);
    expect(list.length).toBeGreaterThan(0);
    for (const t of list) {
      expect(t.p.party).toBe('D');
      expect(e.s.rivals[t.p.id] && !e.s.rivals[t.p.id].retired).toBeFalsy();
      expect(raceIds()).not.toContain(t.p.id);
      expect(t.odds).toBeGreaterThanOrEqual(ENDORSE.min);
      expect(t.odds).toBeLessThanOrEqual(ENDORSE.max);
    }
    // the odds stay in bounds at the extremes
    const race = e.def(c.officeId)!;
    const t = list[0];
    for (const [standing, favors, lean] of [[0, 0, -1], [100, 20, 1], [100, 20, 0.8], [0, 0, 0.8]]) {
      e.s.player.partyStanding = standing;
      e.s.player.favors = favors;
      e.player.pos = PARTY_BASE.D.map((x) => x * lean);
      const p = endorserOdds(e, c, race, t.p, t.def);
      expect(p).toBeGreaterThanOrEqual(ENDORSE.min);
      expect(p).toBeLessThanOrEqual(ENDORSE.max);
    }
    const oddsAt = (standing: number, favors: number) => {
      e.s.player.partyStanding = standing;
      e.s.player.favors = favors;
      return endorserOdds(e, c, race, t.p, t.def);
    };
    e.player.pos = PARTY_BASE.D.map((x) => x * 0.8);
    expect(oddsAt(80, 4)).toBeGreaterThan(oddsAt(50, 0));
    expect(oddsAt(50, 0)).toBeGreaterThan(oddsAt(20, 0));
    // a sure yes: weight by level, the endorser is listed and can't be asked again
    e.s.player.partyStanding = 60;
    e.s.player.ap = 20;
    (e.rng as any).chance = () => true;
    const before = c.endorse[e.player.id] ?? 0;
    const r = await e.act('officeholder', t.p.id);
    delete (e.rng as any).chance;
    expect(r.ok).toBe(true);
    expect(c.endorse[e.player.id]).toBeCloseTo(before + endorserWeight(t.def.level));
    expect(c.endorsers).toEqual([t.p.id]);
    expect(e.view().campaign!.endorsedBy).toHaveLength(1);
    expect(endorserTargets(e, c).some((x) => x.p.id === t.p.id)).toBe(false);
    expect((await e.act('officeholder', t.p.id)).ok).toBe(false);
    expect(e.actionNotes().officeholder.options?.length).toBe(endorserTargets(e, c).length);
    // a rival in the player's party is never offered
    const [rid] = activeRivals(e).find(([id]) => e.pol(id)!.party === 'D' && e.pol(id)!.officeId) ?? [];
    if (rid) expect(endorserTargets(e, c).some((x) => x.p.id === rid)).toBe(false);
  });

  it('higher offices weigh more', () => {
    expect(endorserWeight(1)).toBeLessThan(endorserWeight(3));
    expect(endorserWeight(3)).toBeLessThan(endorserWeight(6));
    expect(endorserWeight(6)).toBeLessThan(endorserWeight(7));
  });
});

describe('saves', () => {
  it('saves from before M20 (no plans, no endorsements or challenges) keep playing', async () => {
    const town = await start('OH', 'Columbus', 'R', 11);
    await advance(12);
    await e.file(`sldl:${town.sldl}`);
    const st = JSON.parse(JSON.stringify(e.exportState())) as GameState;
    for (const r of Object.values(st.rivals)) delete r.plan;
    if (st.campaign) { delete st.campaign.challenge; delete st.campaign.asked; delete st.campaign.endorsers; }
    const e2 = new Engine(BASE);
    await e2.init();
    e2.load(st);
    await e2.restore();
    for (let i = 0; i < 12; i++) {
      if (e2.s.pendingNight) e2.ackNight();
      await e2.endTurn();
    }
    expect(e2.s.year).toBe(2027);
    expect(e2.view().rivals.length).toBeGreaterThan(0);
  }, 60000);
});
