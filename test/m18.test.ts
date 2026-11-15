/**
 * M18: Congress and legislature realism. Cross-pressure from seat lean, the Senate filibuster, budget reconciliation,
 * the nuclear option, bipartisan cosponsors, and national lawmaking under the same rules.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import {
  COSPONSOR_COST, COSPONSOR_PULL, RECONCILABLE, RECONCILE_COST, aiChamberVote, cosponsorPull, countVotes, crossPressure, maybeOfferNuclear, members,
  passThreshold, reconciliationAvailable, seatLean, sponsorPartyFor, support,
} from '../src/sim/legislature';
import { billTemplatesFor } from '../src/sim/governing';
import { nationalLawmaking } from '../src/sim/background';
import type { Party, Town } from '../src/data/types';

let e: Engine;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
});

async function start(st: string, prefix: string, party: Party, seed: number): Promise<Town> {
  const town = (await e.data.townsOf(st)).find((t) => t.name.startsWith(prefix))!;
  await e.newGame({
    first: 'Test', last: 'Player', gender: 'F', age: 45, party, homeTown: town.id, background: 'teacher',
    pos: PARTY_BASE[party].map((x) => x * 0.8), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed,
  });
  return town;
}
async function advance(max: number) {
  for (let i = 0; i < max; i++) {
    if (e.s.pendingNight) e.ackNight();
    await e.endTurn();
  }
  if (e.s.pendingNight) e.ackNight();
}

/** Make the U.S. Senate `nD` Democrats (the bluest seats, the player included) and the rest Republicans, with textbook positions. */
function senateOf(nD: number) {
  const ms = members(e, 'senate').filter((p) => !p.isPlayer);
  ms.sort((a, b) => (seatLean(e, b.officeId!) ?? 0) - (seatLean(e, a.officeId!) ?? 0));
  const playerD = e.player.officeId?.startsWith('sen:') && e.player.party === 'D' ? 1 : 0;
  ms.forEach((p, i) => {
    p.party = i < nD - playerD ? 'D' : 'R';
    p.pos = PARTY_BASE[p.party].slice();
  });
}

describe('the filibuster and reconciliation', () => {
  it('the filibuster blocks a 55-seat majority until it is abolished', async () => {
    await start('PA', 'Lansdale', 'D', 31);
    senateOf(55);
    const v = aiChamberVote(e, 'senate', 'guns', -1, 'fb-test', null);
    expect(v.yes).toBeGreaterThanOrEqual(51);
    expect(v.yes).toBeLessThan(60);
    expect(v).toMatchObject({ rule: 'cloture', needed: 60, passes: false, filibustered: true });
    // the House has no filibuster, and a veto override still needs two-thirds
    expect(passThreshold(e, 'house', {}, 435)).toEqual({ needed: 218, rule: 'majority' });
    expect(passThreshold(e, 'senate', {}, 100, { twoThirds: true }).needed).toBe(67);
    // committees vote by majority
    expect(passThreshold(e, 'senate', {}, 15, { committee: true }).rule).toBe('majority');
    e.s.filibuster = { abolished: { year: e.s.year, month: e.s.month } };
    expect(aiChamberVote(e, 'senate', 'guns', -1, 'fb-test', null)).toMatchObject({ rule: 'majority', passes: true, yes: v.yes });
  });

  it('reconciliation passes a tax bill by simple majority, once a year, for the majority only', async () => {
    await start('PA', 'Lansdale', 'D', 32);
    senateOf(55);
    expect(aiChamberVote(e, 'senate', 'taxes', -1, 'rec-1', null, { title: 'Millionaire surtax' })).toMatchObject({ rule: 'reconciliation', passes: true });
    expect(e.s.reconciliation).toEqual({ year: e.s.year, title: 'Millionaire surtax' });
    // used up for the year
    expect(aiChamberVote(e, 'senate', 'spending', -1, 'rec-2', null)).toMatchObject({ rule: 'cloture', passes: false });
    e.s.year++;
    // a non-budget bill never qualifies, and the minority party can't use it
    expect(aiChamberVote(e, 'senate', 'guns', -1, 'rec-3', null)).toMatchObject({ rule: 'cloture', passes: false });
    expect(aiChamberVote(e, 'senate', 'taxes', 1, 'rec-4', null)).toMatchObject({ rule: 'cloture', passes: false });
    expect(reconciliationAvailable(e)).toBe(true);
    expect(aiChamberVote(e, 'senate', 'taxes', -1, 'rec-5', null)).toMatchObject({ rule: 'reconciliation', passes: true });
  });

  it('a senator can put their own tax bill through reconciliation', async () => {
    await start('PA', 'Lansdale', 'D', 33);
    e.installOffice('sen:PA:1', e.player.id);
    senateOf(55);
    e.s.player.ap = 10;
    e.s.player.favors = 20;
    expect(e.introduceBill('taxes', -1, 'millionaire').ok).toBe(true);
    const b = e.s.player.bills[0];
    b.stage = 'floor';
    expect(countVotes(e, b, 'senate').count).toMatchObject({ needed: 60, rule: 'cloture' });
    expect(e.billAction(b.id, 'reconcile').ok).toBe(true);
    expect(e.s.player.favors).toBe(20 - RECONCILE_COST); // a rank-and-file member pays for it
    expect(countVotes(e, b, 'senate').count).toMatchObject({ needed: 51, rule: 'reconciliation' });
    expect(e.s.reconciliation?.year).toBe(e.s.year);
    expect(e.billAction(b.id, 'vote').ok).toBe(true);
    expect(b.stage).toBe('second');
    // once a year: a second spending bill can't use it
    expect(e.introduceBill('spending', -1, 'infra').ok).toBe(true);
    const b2 = e.s.player.bills[0];
    b2.stage = 'floor';
    expect(e.billAction(b2.id, 'reconcile').ok).toBe(false);
  });

  it('a Majority Leader whose bill is filibustered can go nuclear, once a term', async () => {
    await start('PA', 'Lansdale', 'D', 34);
    e.installOffice('sen:PA:1', e.player.id);
    senateOf(55);
    e.s.player.role = { chamber: 'senate', role: 'majority', since: e.s.year };
    e.s.player.ap = 10;
    expect(e.introduceBill('guns', -1, 'red_flag').ok).toBe(true);
    const b = e.s.player.bills[0];
    b.stage = 'floor';
    expect(e.billAction(b.id, 'vote').msg).toMatch(/Filibustered/);
    expect(b.stage).toBe('dead');
    const d = e.s.decisions.find((x) => x.meta?.kind === 'nuclear')!;
    expect(d).toBeTruthy();
    const standing = e.s.player.partyStanding;
    e.decide(d.id, 0);
    expect(e.s.filibuster?.abolished).toBeTruthy();
    expect(e.s.player.partyStanding).toBeLessThan(standing);
    expect(e.s.news.some((n) => /nuclear/.test(n.title))).toBe(true);
    // the same bill now clears the Senate with its majority
    expect(e.introduceBill('guns', -1, 'red_flag').ok).toBe(true);
    const again = e.s.player.bills[0];
    again.stage = 'floor';
    e.billAction(again.id, 'vote');
    expect(again.stage).toBe('second');
    // no second offer within the term, even if the rule were back
    e.s.filibuster = { offered: e.s.year };
    e.s.decisions = [];
    maybeOfferNuclear(e, 'Another bill');
    expect(e.s.decisions.some((x) => x.meta?.kind === 'nuclear')).toBe(false);
    e.s.year += 6;
    maybeOfferNuclear(e, 'Another bill');
    expect(e.s.decisions.some((x) => x.meta?.kind === 'nuclear')).toBe(true);
  });

  it('a trifecta without 60 senators passes only reconciliation bills, at most once a year', async () => {
    await start('PA', 'Lansdale', 'D', 35);
    // 2025: Republicans hold the House, 53 Senate seats and the White House
    expect(e.s.world.presParty).toBe('R');
    const reconcilable = new Set(billTemplatesFor('federal').filter((b) => RECONCILABLE.has(b.issue)).map((b) => b.title));
    const run = () => {
      const passed: { year: number; title: string }[] = [];
      for (let year = 2025; year < 2055; year++) {
        for (let month = 1; month <= 12; month++) {
          e.s.year = year;
          e.s.month = month;
          const seen = new Set(e.s.news.map((n) => n.id));
          nationalLawmaking(e);
          for (const n of e.s.news) {
            const m = !seen.has(n.id) && n.title.match(/^Congress passes "(.*)"/);
            if (m) passed.push({ year, title: m[1] });
          }
        }
      }
      return passed;
    };
    const passed = run();
    expect(passed.length).toBeGreaterThan(0);
    for (const p of passed) expect(reconcilable.has(p.title)).toBe(true);
    const perYear: Record<number, number> = {};
    for (const p of passed) perYear[p.year] = (perYear[p.year] ?? 0) + 1;
    expect(Math.max(...Object.values(perYear))).toBe(1);
    // without the filibuster, other party bills get through too
    e.s.filibuster = { abolished: { year: 2025, month: 1 } };
    e.s.reconciliation = undefined;
    expect(run().some((p) => !reconcilable.has(p.title))).toBe(true);
  });
});

describe('cross-pressure and cosponsors', () => {
  it('swing-seat members defect more often than safe-seat members', async () => {
    let swingD = 0, swingN = 0, safeD = 0, safeN = 0;
    for (const seed of [41, 42]) {
      await start('PA', 'Lansdale', 'D', seed);
      for (const key of ['house', 'sldl:PA', 'sldl:TX']) {
        const ms = members(e, key);
        const cp = crossPressure(e, key, ms);
        // how far each member's seat tilts toward the other party, relative to their party's median seat
        const tilt = (p: (typeof ms)[number]) => (p.party === 'D' ? 1 : -1) * (cp.get(p.id) ?? 0);
        const sorted = [...ms].sort((a, b) => tilt(a) - tilt(b));
        const q = Math.floor(sorted.length / 4);
        const tally = (ps: typeof ms) => {
          let d = 0, n = 0;
          for (const p of ps) for (const b of billTemplatesFor(key === 'house' ? 'federal' : 'state')) for (let t = 0; t < 8; t++) {
            const sp = sponsorPartyFor(b.issue, b.dir);
            const yes = support(e, p, { id: `${seed}|${b.id}|${t}`, issue: b.issue, dir: b.dir }, sp, key, false, cp) > 0;
            n++;
            if (yes !== (sp === p.party)) d++;
          }
          return [d, n];
        };
        const [sd, sn] = tally(sorted.slice(0, q));
        const [wd, wn] = tally(sorted.slice(-q));
        safeD += sd; safeN += sn; swingD += wd; swingN += wn;
      }
    }
    const safe = safeD / safeN, swing = swingD / swingN;
    expect(swing).toBeGreaterThan(0.015);
    expect(swing).toBeGreaterThan(safe * 4);
  }, 60000);

  it('a bipartisan cosponsor votes yes and softens wavering members of the other party', async () => {
    const town = await start('TX', 'Austin', 'D', 43);
    e.installOffice(`sldl:${town.sldl}`, e.player.id);
    e.s.player.ap = 30;
    e.s.player.favors = 30;
    expect(e.introduceBill('spending', -1, 'infra').ok).toBe(true);
    const b = e.s.player.bills[0];
    b.stage = 'floor';
    const before = countVotes(e, b, b.chamber);
    for (let i = 0; i < 10 && !b.cosponsor; i++) e.billAction(b.id, 'cosponsor');
    expect(b.cosponsor).toBeTruthy();
    const co = e.pol(b.cosponsor)!;
    expect(co.party).toBe('R');
    expect(e.s.player.favors).toBe(30 - COSPONSOR_COST);
    expect(e.billAction(b.id, 'cosponsor').ok).toBe(false); // one per bill
    expect(countVotes(e, b, b.chamber).count.yes).toBeGreaterThan(before.count.yes);
    // the pull only reaches other-party members who were close to yes
    const me = e.player;
    expect(cosponsorPull(b, co, me.party, -0.1)).toBe(COSPONSOR_PULL);
    expect(cosponsorPull(b, co, me.party, -0.5)).toBe(0);
    expect(cosponsorPull(b, co, me.party, 0.2)).toBe(0);
    expect(cosponsorPull(b, me, me.party, -0.1)).toBe(0);
    expect(cosponsorPull({}, co, me.party, -0.1)).toBe(0);
  });

  it('saves from before M18 load with the Senate’s usual rules', async () => {
    await start('PA', 'Lansdale', 'D', 44);
    e.s.filibuster = { abolished: { year: 2025, month: 3 } };
    e.s.reconciliation = { year: e.s.year, title: 'x' };
    const st = JSON.parse(JSON.stringify(e.exportState()));
    delete st.filibuster;
    delete st.reconciliation;
    e.load(st);
    await e.restore();
    expect(passThreshold(e, 'senate', {}, 100).rule).toBe('cloture');
    expect(reconciliationAvailable(e)).toBe(true);
    await advance(2);
    expect(e.s.year * 12 + e.s.month).toBeGreaterThan(2025 * 12 + 1);
  });
});
