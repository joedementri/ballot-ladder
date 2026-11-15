/**
 * M19: ballot measures. Initiatives and local measures qualify in June of even years and are decided in November by
 * an issue-only vote; the player can campaign on them, and governors and state legislators can refer one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { INITIATIVE_STATES, LOCAL_MIN_POP, MEASURE_PUSH_CAP, generateMeasures, offerReferral, projectSupport, resolveMeasures } from '../src/sim/measures';
import { billTemplate } from '../src/sim/governing';
import { members } from '../src/sim/legislature';
import type { Party } from '../src/data/types';
import type { GameState, Measure } from '../src/sim/model';

let e: Engine;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
});

async function start(st: string, prefix: string, party: Party, seed: number, eng = e) {
  const town = (await eng.data.townsOf(st)).find((t) => t.name.startsWith(prefix))!;
  await eng.newGame({
    first: 'Test', last: 'Player', gender: 'F', age: 45, party, homeTown: town.id, background: 'teacher',
    pos: PARTY_BASE[party].map((x) => x * 0.8), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed,
  });
  return town;
}

/** A statewide measure built on a bill template, added to the ballot by hand. */
async function addMeasure(st: string, bill: string, year = e.s.year, extra: Partial<Measure> = {}): Promise<Measure> {
  const b = billTemplate(bill)!;
  const m: Measure = { id: `t:${st}:${bill}:${year}`, st, label: 'Question 9', title: b.title, templateId: bill, issue: b.issue, dir: b.dir, year, origin: 'initiative', support: 0.5, ...extra };
  m.support = await projectSupport(e, m);
  (e.s.measures ??= []).push(m);
  return m;
}

describe('generation', () => {
  it('is deterministic, statewide only in initiative states, and local only in big towns of the home state', async () => {
    const town = await start('CA', 'Fresno', 'D', 7);
    e.s.year = 2026;
    await generateMeasures(e, 2026);
    const a = JSON.stringify(e.s.measures);
    const ms = e.s.measures!;
    expect(ms.length).toBeGreaterThan(5);
    for (const m of ms.filter((x) => !x.town)) expect(INITIATIVE_STATES[m.st]).toBeTruthy();
    const perState: Record<string, number> = {};
    for (const m of ms.filter((x) => !x.town)) perState[m.st] = (perState[m.st] ?? 0) + 1;
    expect(Math.max(...Object.values(perState))).toBeLessThanOrEqual(2);
    for (const m of ms.filter((x) => x.town)) {
      expect(m.st).toBe(town.st);
      expect(e.data.townSync(m.town!)!.pop).toBeGreaterThanOrEqual(LOCAL_MIN_POP);
    }
    for (const m of ms) expect(m.support).toBeGreaterThan(0.05);
    // a second engine with the same seed draws the same ballot, and the main RNG stream is untouched
    const e2 = new Engine(BASE);
    await e2.init();
    await start('CA', 'Fresno', 'D', 7, e2);
    const rng0 = e2.rng.state;
    e2.s.year = 2026;
    await generateMeasures(e2, 2026);
    expect(JSON.stringify(e2.s.measures)).toBe(a);
    expect(e2.rng.state).toBe(rng0);
    // another seed draws a different ballot
    await start('CA', 'Fresno', 'D', 8, e2);
    e2.s.year = 2026;
    await generateMeasures(e2, 2026);
    expect(JSON.stringify(e2.s.measures)).not.toBe(a);
  });

  it('keeps only the last three cycles and avoids repeating a recent template in a state', async () => {
    await start('CA', 'Fresno', 'D', 9);
    for (const y of [2026, 2028, 2030, 2032]) {
      e.s.year = y;
      await generateMeasures(e, y);
      const byState: Record<string, Set<string>> = {};
      for (const m of e.s.measures!.filter((x) => !x.town)) {
        const k = `${m.st}`;
        byState[k] ??= new Set();
        // within the kept window (this cycle and the two before) a template appears at most once per state
        expect(byState[k].has(m.templateId)).toBe(false);
        byState[k].add(m.templateId);
      }
    }
    expect(Math.min(...e.s.measures!.map((m) => m.year))).toBe(2028);
  });
});

describe('the vote', () => {
  it('results match the state lean on average', async () => {
    const rows: { lean: number; prog: number; passed: boolean; dir: number }[] = [];
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      await start('PA', 'Lansdale', 'D', seed);
      e.s.year = 2026;
      await generateMeasures(e, 2026);
      await resolveMeasures(e, 2026);
      for (const m of e.s.measures!.filter((x) => !x.town)) {
        const share = m.result!.yes / (m.result!.yes + m.result!.no);
        rows.push({ lean: e.data.states[m.st].lean, prog: m.dir < 0 ? share : 1 - share, passed: m.result!.passed, dir: m.dir });
      }
    }
    expect(rows.length).toBeGreaterThan(60);
    const n = rows.length;
    const ml = rows.reduce((a, r) => a + r.lean, 0) / n, mp = rows.reduce((a, r) => a + r.prog, 0) / n;
    const cov = rows.reduce((a, r) => a + (r.lean - ml) * (r.prog - mp), 0);
    const corr = cov / Math.sqrt(rows.reduce((a, r) => a + (r.lean - ml) ** 2, 0) * rows.reduce((a, r) => a + (r.prog - mp) ** 2, 0));
    expect(corr).toBeGreaterThan(0.4);
    // progressive measures pass more often in blue states than in red ones (and conservative ones the other way)
    const rate = (f: (r: (typeof rows)[number]) => boolean) => { const xs = rows.filter(f); return xs.filter((r) => r.passed).length / (xs.length || 1); };
    expect(rate((r) => r.dir < 0 && r.lean > 0.5)).toBeGreaterThan(rate((r) => r.dir < 0 && r.lean < 0.45));
    expect(rate((r) => r.dir > 0 && r.lean < 0.45)).toBeGreaterThan(rate((r) => r.dir > 0 && r.lean > 0.5));
    // not a rubber stamp either way
    const all = rows.filter((r) => r.passed).length / n;
    expect(all).toBeGreaterThan(0.3);
    expect(all).toBeLessThan(0.8);
  });

  it('a passed measure moves the economy, and becomes a law in force for the governor', async () => {
    await start('CA', 'Fresno', 'D', 21);
    e.s.year = 2026;
    e.installOffice('gov:CA', e.player.id, 'appointed');
    const before = { ...e.s.world.policy };
    const m = await addMeasure('CA', 'min_wage', 2026, { push: 3 });
    const off = await addMeasure('OR', 'infra', 2026, { push: -3 });
    await resolveMeasures(e, 2026);
    expect(m.result!.passed).toBe(true);
    expect(off.result!.passed).toBe(false);
    expect(e.s.world.policy.unemployment).not.toBe(before.unemployment);
    expect(e.s.player.policies.some((p) => p.id === m.id)).toBe(true);
    expect(e.s.player.policies.some((p) => p.id === off.id)).toBe(false);
    expect(e.s.news.some((n) => n.kind === 'measure' && n.title.includes('passes'))).toBe(true);
    // decided measures are not decided twice
    const r = { ...m.result! };
    await resolveMeasures(e, 2026);
    expect(m.result).toEqual(r);
  });
});

describe('the player', () => {
  it('campaigns for or against a measure in their state', async () => {
    await start('CA', 'Fresno', 'D', 31);
    e.s.year = 2025;
    expect(e.actionNotes().measure.blocked).toMatch(/even years/);
    e.s.year = 2026;
    e.s.month = 7;
    const m = await addMeasure('CA', 'medicaid');
    const far = await addMeasure('OR', 'medicaid');
    expect(e.actionNotes().measure.blocked).toBeUndefined();
    expect((await e.act('measure', `${far.id}|1`)).ok).toBe(false);
    e.s.player.cash = 1e6;
    const s0 = m.support, rec0 = e.recIn('CA'), groups0 = e.s.player.groups.seniors ?? 0;
    const r = await e.act('measure', `${m.id}|1`);
    expect(r.ok).toBe(true);
    expect(m.push).toBeGreaterThan(0);
    expect(m.support).toBeGreaterThan(s0);
    expect(m.playerSide).toBe(1);
    expect(e.recIn('CA')).toBeGreaterThan(rec0);
    expect(e.s.player.groups.seniors).toBeGreaterThan(groups0);
    // repeats on the same measure land softer, and the push is capped
    expect(e.fatigue('measure', `${m.id}|1`)).toBeLessThan(1);
    for (let i = 0; i < 30; i++) {
      e.s.player.ap = 10;
      await e.act('measure', `${m.id}|1`);
    }
    expect(m.push).toBeLessThanOrEqual(MEASURE_PUSH_CAP);
    // switching sides is a flip-flop
    const fav = e.player.fav;
    e.s.player.ap = 10;
    await e.act('measure', `${m.id}|-1`);
    expect(m.playerSide).toBe(-1);
    expect(e.player.fav).toBeLessThan(fav);
    // the view lists it as one the player can campaign on
    expect(e.view().measures!.list.find((x) => x.id === m.id)!.canCampaign).toBe(true);
  });

  it('a state legislator can refer a measure; an unanswered referral lapses without penalty', async () => {
    await start('PA', 'Lansdale', 'D', 41);
    const town = e.data.townSync(e.player.home)!;
    e.installOffice(`sldl:${town.sldl}`, e.player.id, 'appointed');
    for (const k of ['sldl:PA', 'sldu:PA']) for (const p of members(e, k)) if (!p.isPlayer) { p.party = 'D'; p.pos = PARTY_BASE.D.slice(); }
    e.s.year = 2026;
    e.s.month = 5;
    e.s.decisions = [];
    offerReferral(e);
    const d = e.s.decisions.find((x) => x.meta?.kind === 'measure')!;
    expect(d).toBeTruthy();
    expect(d.options.at(-1)!.pick).toBeUndefined();
    // offered once
    offerReferral(e);
    expect(e.s.decisions.filter((x) => x.meta?.kind === 'measure')).toHaveLength(1);
    const r = e.decide(d.id, 0);
    expect(r.ok).toBe(true);
    const m = e.s.measures!.find((x) => x.sponsored)!;
    expect(m).toMatchObject({ st: 'PA', origin: 'referred', playerSide: 1, label: 'Question 1', year: 2026 });
    expect(e.s.decisions.some((x) => x.id === d.id)).toBe(false);
    // the initiatives that qualify in June never repeat it, and PA (no initiative process) gets no others
    await generateMeasures(e, 2026);
    expect(e.s.measures!.filter((x) => x.st === 'PA' && !x.town)).toHaveLength(1);
    // next cycle: let it lapse
    e.s.year = 2028;
    e.s.month = 5;
    offerReferral(e);
    expect(e.s.decisions.some((x) => x.meta?.kind === 'measure')).toBe(true);
    e.s.month = 6;
    e.s.decisions = e.s.decisions.filter((x) => x.meta?.kind === 'measure');
    await e.endTurn();
    expect(e.s.decisions.some((x) => x.meta?.kind === 'measure')).toBe(false);
    // not a missed vote: no "you let it pass" story (which comes with an effectiveness and approval penalty)
    expect(e.s.news.some((n) => n.title.includes('pass without action') && n.title.includes('ballot'))).toBe(false);
  });
});

describe('saves', () => {
  it('a save without measures loads and plays through a June and a November', async () => {
    await start('CA', 'Fresno', 'D', 51);
    e.s.year = 2026;
    e.s.month = 5;
    const save = JSON.parse(JSON.stringify(e.exportState())) as GameState;
    delete save.measures;
    const e2 = new Engine(BASE);
    await e2.init();
    e2.load(save);
    await e2.restore();
    expect(e2.view().measures).toBeNull();
    for (let i = 0; i < 7; i++) {
      if (e2.s.pendingNight) e2.ackNight();
      await e2.endTurn();
    }
    expect(e2.s.year).toBe(2026);
    expect(e2.s.month).toBe(12);
    const ms = e2.s.measures!;
    expect(ms.length).toBeGreaterThan(5);
    expect(ms.every((m) => m.result)).toBe(true);
    expect(e2.s.news.some((n) => n.kind === 'measure' && n.title.startsWith('Ballot measures:'))).toBe(true);
    // and a save with measures round-trips
    const e3 = new Engine(BASE);
    await e3.init();
    e3.load(JSON.parse(JSON.stringify(e2.exportState())));
    await e3.restore();
    expect(e3.s.measures).toEqual(ms);
  }, 60000);
});
