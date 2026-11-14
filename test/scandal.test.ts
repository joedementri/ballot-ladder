/**
 * M15 scandals and crisis response: each response's effect, escalation only for true and severe stories, resigning
 * and convictions, unanswered stories, opponents' responses to opposition research, and old saves.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine, SAVE_VERSION } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { migrate } from '../src/sim/migrate';
import { AI_DAMAGE, OPPO_HIT, SEVERE, applyResponse, charge, lawyerCost, openOppoScandal, openPlayerScandal, playerScandalMonth, aiScandalMonth } from '../src/sim/scandals';
import type { Scandal } from '../src/sim/model';

let e: Engine;
let town: string;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
  town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))!.id;
});

async function fresh(seed = 5) {
  await e.newGame({
    first: 'Sam', last: 'Story', gender: 'F', age: 45, party: 'D', homeTown: town, background: 'lawyer', difficulty: 'normal',
    pos: PARTY_BASE.D.map((x) => x * 0.7), skills: { charisma: 60, debate: 60, fundraising: 60, policy: 60, integrity: 60, organization: 60 }, seed,
  });
  e.s.player.cash = 100000;
  return e;
}

/** Move the calendar one month without running the rest of the turn. */
function tick(n = 1) {
  for (let i = 0; i < n; i++) {
    e.s.month = e.s.month === 12 ? 1 : e.s.month + 1;
    if (e.s.month === 1) e.s.year++;
    playerScandalMonth(e);
    aiScandalMonth(e);
  }
}

const reset = () => {
  e.player.scandal = 0;
  e.player.fav = 0.5;
  e.s.player.partyStanding = 50;
  e.s.player.blocApproval = e.s.player.blocApproval.map(() => 0.5);
  e.s.decisions = [];
};

describe('scandal responses', () => {
  it('opening a story hits the player and puts a response on the desk', async () => {
    await fresh();
    reset();
    const s = openPlayerScandal(e, 'test story', { severity: 0.5, truth: false });
    expect(e.player.scandal).toBeCloseTo(0.1 + 0.25 * 0.5);
    expect(e.player.fav).toBeLessThan(0.5);
    const d = e.s.decisions.find((x) => x.meta?.kind === 'scandal' && x.meta.scandal === s.id)!;
    expect(d.options.map((o) => o.label)).toEqual(['Apologize', 'Deny it', 'Attack the press', 'Lawyer up']);
    expect(d.deadline).toEqual({ year: e.s.year, month: e.s.month });
  });

  it('each response has its own effect', async () => {
    await fresh();
    const run = (i: number, truth = false) => {
      reset();
      const s = openPlayerScandal(e, 'test story', { severity: 0.4, truth });
      const before = { scandal: e.player.scandal, fav: e.player.fav, party: e.s.player.partyStanding, wcol: e.s.player.blocApproval[0], cash: e.s.player.cash };
      const d = e.s.decisions.find((x) => x.meta?.scandal === s.id)!;
      expect(e.decide(d.id, i).ok).toBe(true);
      expect(e.s.decisions.some((x) => x.id === d.id)).toBe(false);
      return { s, before };
    };
    // apologize: a small extra hit now, the score halves, and the story is over
    let { s, before } = run(0);
    expect(e.player.fav).toBeLessThan(before.fav);
    expect(e.player.scandal).toBeCloseTo(before.scandal * 0.5, 2);
    expect(s.ended?.how).toBe('apologized');
    // deny: no hit now
    ({ s, before } = run(1));
    expect(e.player.fav).toBe(before.fav);
    expect(e.player.scandal).toBeLessThan(before.scandal);
    expect(s.ended).toBeUndefined();
    // a false story falls apart within two months: vindicated
    tick(2);
    expect(s.ended?.how).toBe('vindicated');
    // attack the press: party standing up, college-educated voters down
    ({ s, before } = run(2));
    expect(e.s.player.partyStanding).toBe(before.party + 4);
    expect(e.s.player.blocApproval[0]).toBeLessThan(before.wcol);
    // lawyer up: costs money and quiets the coverage
    const cost = lawyerCost(e);
    ({ s, before } = run(3));
    expect(e.s.player.cash).toBe(before.cash - cost);
    expect(e.player.scandal).toBeCloseTo(before.scandal * 0.75, 2);
    expect(s.response).toBe('lawyer');
  });

  it('a true denial is often exposed, and that is worse than the story', async () => {
    await fresh();
    let exposed = 0;
    for (let i = 0; i < 30; i++) {
      reset();
      const s = openPlayerScandal(e, 'test', { severity: 0.5, truth: true });
      applyResponse(e, s, 'deny');
      const before = e.player.scandal;
      tick();
      if (s.exposed) {
        exposed++;
        expect(e.player.scandal).toBeGreaterThan(before + 0.1);
        expect(s.severity).toBeGreaterThan(0.5);
      }
    }
    // 0.45 + 0.3 × 0.5 = 60% in the first month
    expect(exposed).toBeGreaterThan(10);
    expect(exposed).toBeLessThan(28);
  });

  it('an unanswered story is "no comment", not a missed vote', async () => {
    await fresh();
    reset();
    const s = openPlayerScandal(e, 'test', { severity: 0.3, truth: false });
    const eff = e.s.player.metrics.effectiveness;
    await e.endTurn();
    expect(s.response).toBe('silent');
    expect(e.s.player.metrics.effectiveness).toBe(eff);
    expect(e.s.news.some((n) => n.title.includes('pass without action') && n.title.includes('test'))).toBe(false);
  });
});

describe('escalation', () => {
  it('only true, severe stories escalate', async () => {
    await fresh();
    const stories: Scandal[] = [];
    for (let i = 0; i < 20; i++) {
      stories.push(openPlayerScandal(e, 'false', { severity: 0.9, truth: false }));
      stories.push(openPlayerScandal(e, 'minor', { severity: SEVERE - 0.1, truth: true }));
      stories.push(openPlayerScandal(e, 'severe', { severity: 0.8, truth: true }));
    }
    for (const s of stories) applyResponse(e, s, 'silent');
    e.s.decisions = [];
    for (let m = 0; m < 12; m++) {
      tick();
      // charges stop at a decision; fight them so the chain keeps moving
      e.s.decisions = [];
    }
    const reached = (t: string) => stories.filter((s) => s.title === t && (s.stage !== 'story' || s.ended?.how === 'cleared'));
    expect(reached('false')).toHaveLength(0);
    expect(reached('minor')).toHaveLength(0);
    expect(reached('severe').length).toBeGreaterThan(5);
    expect(stories.filter((s) => s.title !== 'severe').every((s) => s.ended)).toBe(true);
    expect(stories.some((s) => s.stage === 'charges')).toBe(true);
  });

  it('an investigation drains favorability and party standing every month', async () => {
    await fresh();
    reset();
    const s = openPlayerScandal(e, 'test', { severity: 0.8, truth: true });
    applyResponse(e, s, 'silent');
    s.stage = 'investigation';
    const before = { fav: e.player.fav, party: e.s.player.partyStanding };
    tick();
    expect(e.player.fav).toBeLessThan(before.fav);
    expect(e.s.player.partyStanding).toBeLessThan(before.party);
    expect(e.player.scandal).toBeGreaterThanOrEqual(0.15 + 0.2 * 0.8 - 0.001);
  });

  it('resigning over charges opens a vacancy', async () => {
    await fresh();
    reset();
    const seat = `sldl:${e.data.townSync(town)!.sldl}`;
    e.installOffice(seat, e.player.id);
    expect(e.player.officeId).toBe(seat);
    const s = openPlayerScandal(e, 'test', { severity: 0.8, truth: true });
    applyResponse(e, s, 'silent');
    e.s.decisions = [];
    charge(e, s);
    const d = e.s.decisions.find((x) => x.meta?.scandal === s.id)!;
    expect(d.options[0].label).toBe('Resign');
    expect(e.decide(d.id, 0).ok).toBe(true);
    expect(e.player.officeId).toBeUndefined();
    expect(e.s.offices[seat].holder).toBeNull();
    expect(e.s.vacancies.some((v) => v.officeId === seat)).toBe(true);
    expect(e.player.career[e.player.career.length - 1].result).toBe('resigned');
    expect(s.ended?.how).toBe('resigned');
  });

  it('fighting the charges ends in a verdict; a conviction removes the player', async () => {
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 12 && outcomes.size < 2; seed++) {
      await fresh(seed);
      reset();
      const seat = `sldl:${e.data.townSync(town)!.sldl}`;
      e.installOffice(seat, e.player.id);
      const s = openPlayerScandal(e, 'test', { severity: 0.8, truth: true });
      applyResponse(e, s, 'silent');
      e.s.decisions = [];
      charge(e, s);
      const d = e.s.decisions.find((x) => x.meta?.scandal === s.id)!;
      e.decide(d.id, 1);
      expect(s.trial).toBeTruthy();
      tick(4);
      expect(s.ended).toBeUndefined();
      tick();
      expect(['convicted', 'acquitted']).toContain(s.ended?.how);
      outcomes.add(s.ended!.how);
      if (s.ended!.how === 'convicted') {
        expect(e.player.officeId).toBeUndefined();
        expect(e.player.career.some((c) => c.result === 'removed')).toBe(true);
      } else expect(e.player.officeId).toBe(seat);
    }
    expect(outcomes.size).toBe(2);
  }, 60000);
});

describe('opponents', () => {
  it('their response scales the damage of opposition research', async () => {
    await fresh();
    const opp = e.genPolitician(new (await import('../src/sim/rng')).Rng('opp'), { party: 'R', lean: 0.5, home: town, quality: 0.5 });
    const hit = (response: 'apologize' | 'deny' | 'attack' | 'lawyer' | 'silent') => {
      opp.scandal = 0;
      opp.fav = 0.5;
      openOppoScandal(e, opp, { severity: 0.5, truth: true, response });
      return opp.scandal;
    };
    const full = hit('silent');
    expect(full).toBeCloseTo(OPPO_HIT(0.5));
    for (const r of ['apologize', 'deny', 'attack', 'lawyer'] as const) expect(hit(r)).toBeCloseTo(full * AI_DAMAGE[r].scandal);
    // on average weaker than the pre-M15 hit (0.15–0.4, mean 0.275)
    expect(hit('lawyer')).toBeLessThan(0.275);
  });

  it('a true denial by an opponent can blow up a month later; stories fade', async () => {
    await fresh();
    const { Rng } = await import('../src/sim/rng');
    const opp = e.genPolitician(new Rng('opp2'), { party: 'R', lean: 0.5, home: town, quality: 0.5 });
    const list = Array.from({ length: 20 }, () => openOppoScandal(e, opp, { severity: 0.5, truth: true, response: 'deny' }));
    tick();
    const n = list.filter((s) => s.exposed).length;
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(20);
    tick(3);
    expect(list.every((s) => s.ended)).toBe(true);
  });

  it('the view never reveals whether a story is true', async () => {
    await fresh();
    openPlayerScandal(e, 'test', { severity: 0.5, truth: true });
    const v = e.view().scandals;
    expect(v).toHaveLength(1);
    expect(JSON.stringify(v)).not.toContain('truth');
    expect(v[0].decision).toBeTruthy();
  });
});

describe('saves', () => {
  it('saves without scandals load and get an empty list', async () => {
    const v1 = JSON.parse(gunzipSync(readFileSync(join(import.meta.dirname, 'fixtures', 'save-v1.json.gz'))).toString('utf8'));
    expect(v1.scandals).toBeUndefined();
    expect(migrate(v1).scandals).toEqual([]);
    // a version 2 save (M12–M14)
    await fresh();
    const v2 = JSON.parse(JSON.stringify(e.exportState()));
    delete v2.scandals;
    v2.version = 2;
    e.load(v2);
    await e.restore();
    expect(e.s.version).toBe(SAVE_VERSION);
    expect(e.s.scandals).toEqual([]);
    await e.endTurn();
    expect(e.s.month).toBe(2);
  });
});
