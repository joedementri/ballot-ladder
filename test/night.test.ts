import { describe, expect, it, beforeAll } from 'vitest';
import { BASE } from './setup';
import { DataStore } from '../src/data/store';
import { EV } from '../src/sim/offices';
import { Rng } from '../src/sim/rng';
import { anchorPrecincts, type Unit } from '../src/sim/vote';
import { demoFrom } from '../src/data/types';
import { DESK, frameAt, keyItems, planNight, shortName, top2, type NightPlan } from '../src/sim/night';
import type { ResultSummary } from '../src/sim/model';

let data: DataStore;
beforeAll(async () => {
  data = new DataStore(BASE);
  await data.loadCore();
});

const cands = (n = 2): ResultSummary['cands'] => ['Ana Diaz', 'Bo Reed', 'Cy Park'].slice(0, n).map((name, i) => ({ id: `c${i}`, name, party: i === 0 ? 'D' : 'R', votes: 0, isPlayer: i === 0 }));

/** A summary whose units vote by their real lean, with noise. */
function summary(units: { id: string; label: string; lean: number; pop: number }[], opts: { swing?: number; officeId?: string; kind?: ResultSummary['unitKind']; electoral?: boolean } = {}): ResultSummary {
  const rng = new Rng(`test|${opts.officeId}`);
  const cs = cands();
  const us = units.map((u) => {
    const d = Math.min(0.95, Math.max(0.05, u.lean + (opts.swing ?? 0) + rng.normal(0, 0.03)));
    const turnout = Math.max(50, Math.round(u.pop * 0.45));
    return { id: u.id, label: u.label, votes: [Math.round(turnout * d), Math.round(turnout * (1 - d))] };
  });
  const totals = [0, 1].map((j) => us.reduce((a, u) => a + u.votes[j], 0));
  cs.forEach((c, j) => (c.votes = totals[j]));
  const s: ResultSummary = { officeId: opts.officeId ?? 'gov:PA', title: 'Test race', year: 2026, stage: 'general', cands: cs, winnerId: cs[top2(totals)[0]].id, units: us, blocs: [], unitKind: opts.kind ?? 'county' };
  if (opts.electoral) {
    const byState: Record<string, number[]> = {};
    for (const u of us) {
      const v = (byState[data.counties[u.id].st] ??= [0, 0]);
      v[0] += u.votes[0];
      v[1] += u.votes[1];
    }
    const ev: Record<string, number> = {};
    for (const [st, v] of Object.entries(byState)) ev[cs[v[0] >= v[1] ? 0 : 1].id] = (ev[cs[v[0] >= v[1] ? 0 : 1].id] ?? 0) + (EV[st] ?? 0);
    s.electoral = ev;
    s.winnerId = Object.entries(ev).sort((a, b) => b[1] - a[1])[0][0];
  }
  return s;
}

const countiesOf = (st?: string) =>
  Object.entries(data.counties)
    .filter(([, c]) => !st || c.st === st)
    .map(([id, c]) => ({ id, label: c.n, lean: c.lean, pop: c.d[0] ?? 0 }));

/** Play the night on a grid and check the invariants every frame. */
function playThrough(s: ResultSummary, plan: NightPlan) {
  const finalLeader = s.units.map((u) => top2(u.votes)[0]);
  const finalGroup: Record<string, number> = {};
  for (const [g, idxs] of Object.entries(plan.groupUnits)) finalGroup[g] = top2(s.cands.map((_, j) => idxs.reduce((a, i) => a + s.units[i].votes[j], 0)))[0];
  const wasCalled = new Array(s.units.length).fill(false);
  const reverts = new Array(s.units.length).fill(0);
  const groupWas: Record<string, boolean> = {};
  let raceWas = false;
  let lastPct = 0;
  for (let step = 0; step <= 100; step++) {
    const t = step / 100;
    const f = frameAt(s, plan, t);
    expect(f.pctIn).toBeGreaterThanOrEqual(lastPct - 0.05); // the count only grows (allowing early-vote skew)
    lastPct = f.pctIn;
    f.units.forEach((u, i) => {
      const r = plan.retractions[i];
      // calls stick, except a premature call, which is retracted once
      if (wasCalled[i] && !u.called) {
        expect(r).toBeTruthy();
        expect(u.retracted).toBe(true);
        expect(t).toBeGreaterThanOrEqual(r.retractAt);
        expect(++reverts[i]).toBe(1);
      }
      if (u.retracted) expect(r).toBeTruthy();
      // a call is for the unit's real winner, outside a premature call's window
      const premature = r && t >= r.at && t < r.retractAt;
      if (u.called) expect(u.callFor).toBe(premature ? r.cand : finalLeader[i]);
      if (premature && u.called) expect(u.callFor).not.toBe(finalLeader[i]);
      wasCalled[i] = u.called;
    });
    for (const g of Object.values(f.groups ?? {})) {
      if (groupWas[g.id]) expect(g.called).toBe(true);
      if (g.called) expect(g.callFor).toBe(finalGroup[g.id]); // states are never called wrong
      groupWas[g.id] = g.called;
    }
    if (raceWas) expect(f.called).toBe(true);
    raceWas = f.called;
    if (f.called && f.evCalled) expect(f.allIn || f.evCalled[plan.winnerIdx] >= 270).toBe(true);
  }
}

describe('election night playback', () => {
  it('starts empty, ends with the final result, and never makes a call that reverts', () => {
    const s = summary(countiesOf('PA'));
    const plan = planNight(s);
    const f0 = frameAt(s, plan, 0);
    expect(f0.counted).toBe(0);
    expect(f0.called).toBe(false);
    const f1 = frameAt(s, plan, 1);
    expect(f1.tally).toEqual(s.cands.map((c) => c.votes));
    expect(f1.units.every((u) => u.called)).toBe(true);
    expect(f1.called).toBe(true);
    playThrough(s, plan);
    // a race is called before everything is in unless it's very close
    expect(plan.raceCallAt).toBeLessThanOrEqual(1);
  });

  it('calls a landslide early and a close race late', () => {
    const lop = summary(countiesOf('OH'), { swing: 0.25, officeId: 'gov:OH' });
    const close = summary(countiesOf('OH'), { swing: 0.005 + 0.5 - 0.45, officeId: 'sen:OH:1' });
    const pl = planNight(lop), pc = planNight(close);
    expect(pl.raceCallAt).toBeLessThan(0.5);
    // county calls come before the last county reports in a landslide
    expect(Math.min(...pl.unitCallAt)).toBeLessThan(Math.min(...pl.start.map((s, i) => s + pl.dur[i])));
    playThrough(close, pc);
  });

  it('is deterministic for replays', () => {
    const s = summary(countiesOf('WI'), { officeId: 'gov:WI' });
    const a = planNight(s), b = planNight(s);
    expect(JSON.stringify(frameAt(s, a, 0.4))).toBe(JSON.stringify(frameAt(s, b, 0.4)));
  });

  it('presidential: states are called, and the race is called at 270 electoral votes', () => {
    const s = summary(countiesOf(), { officeId: 'pres', electoral: true, swing: 0.02 }); // (with no swing this fixture is a 269-269 tie)
    const t0 = Date.now();
    const plan = planNight(s, { groupOf: (id) => data.counties[id]?.st ?? null, waves: true, ev: EV });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2500);
    expect(Object.keys(plan.groupUnits).length).toBe(51);
    const atCall = frameAt(s, plan, plan.raceCallAt);
    expect(atCall.called).toBe(true);
    if (!atCall.allIn) expect(atCall.evCalled![plan.winnerIdx]).toBeGreaterThanOrEqual(270);
    // Eastern polls close before Pacific ones
    const first = (st: string) => Math.min(...plan.groupUnits[st].map((i) => plan.start[i]));
    expect(first('PA')).toBeLessThan(first('CA'));
    playThrough(s, plan);
    const keys = keyItems(s, plan, { unitWord: 'county', home: { group: 'WY' } });
    expect(keys.some((k) => k.tag === 'Tipping point')).toBe(true);
    expect(keys.some((k) => k.tag === 'Home state' && k.group === 'WY')).toBe(true);
    console.log(`national plan in ${ms}ms; race called at t=${plan.raceCallAt.toFixed(2)}; keys:`, keys.map((k) => `${k.tag}=${k.group ?? s.units[k.unit!].label}`).join(', '));
  });

  it('the desk rarely retracts a premature call, and the right call follows (M21)', () => {
    let units = 0, retracted = 0;
    for (const [i, swing] of [-0.04, -0.01, 0.01, 0.03].entries()) {
      const s = summary(countiesOf(), { officeId: `pres${i}`, electoral: true, swing });
      const plan = planNight(s, { groupOf: (id) => data.counties[id]?.st ?? null, waves: true, ev: EV });
      const rs = Object.entries(plan.retractions);
      units += plan.n;
      retracted += rs.length;
      expect(rs.length).toBeLessThanOrEqual(Math.floor(plan.n * DESK.maxRetractShare));
      for (const [k, r] of rs) {
        const u = +k;
        expect(r.cand).not.toBe(top2(s.units[u].votes)[0]);
        expect(r.at).toBeLessThan(r.retractAt);
        expect(plan.unitCallAt[u]).toBeGreaterThan(r.retractAt);
        // called for the early leader, then retracted, then called for the real winner
        expect(frameAt(s, plan, r.at + 1e-9).units[u]).toMatchObject({ called: true, callFor: r.cand });
        expect(frameAt(s, plan, r.retractAt + 1e-9).units[u]).toMatchObject({ called: false, retracted: true });
        expect(frameAt(s, plan, plan.unitCallAt[u] + 1e-9).units[u]).toMatchObject({ called: true, callFor: top2(s.units[u].votes)[0] });
      }
      if (i === 0) playThrough(s, plan);
    }
    console.log(`retracted calls: ${retracted} of ${units} county calls (${((retracted / units) * 100).toFixed(2)}%)`);
    expect(retracted).toBeGreaterThan(0);
    expect(retracted / units).toBeLessThan(0.02);
    // small nights never see one
    const small = summary(countiesOf('DE'), { officeId: 'gov:DE' });
    expect(Object.keys(planNight(small).retractions)).toHaveLength(0);
  });

  it('the desk estimate is noisy: the same count can be called at different times (M21)', () => {
    const s = summary(countiesOf('PA'), { officeId: 'gov:PA', swing: 0.04 });
    const noisy = planNight(s);
    const saved = DESK.noise;
    DESK.noise = 0;
    const exact = planNight(s);
    DESK.noise = saved;
    // same reporting timeline, different call times for some counties (earlier and later)
    expect(noisy.start).toEqual(exact.start);
    const diff = noisy.unitCallAt.map((t, i) => t - exact.unitCallAt[i]);
    expect(diff.some((d) => d < 0)).toBe(true);
    expect(diff.some((d) => d > 0)).toBe(true);
    playThrough(s, noisy);
  });

  it('short names disambiguate shared last names', () => {
    const n = { cands: [{ name: 'Alice Quinn' }, { name: 'Avery Quinn' }, { name: 'Bo Reed' }] } as ResultSummary;
    expect([0, 1, 2].map((i) => shortName(n, i))).toEqual(['Alice Quinn', 'Avery Quinn', 'Reed']);
    const m = { cands: [{ name: 'Alice Quinn' }, { name: 'Bob Quinn' }] } as ResultSummary;
    expect([0, 1].map((i) => shortName(m, i))).toEqual(['A. Quinn', 'B. Quinn']);
  });

  it('picks distinct key units', () => {
    const s = summary(countiesOf('GA'), { officeId: 'gov:GA' });
    const plan = planNight(s);
    const keys = keyItems(s, plan, { unitWord: 'county', home: { unit: 3 } });
    const ids = keys.map((k) => k.unit);
    expect(new Set(ids).size).toBe(ids.length);
    expect(keys.map((k) => k.tag)).toEqual(expect.arrayContaining(['Biggest vote', 'Bellwether', 'Battleground', 'Home']));
  });
});

describe('precinct anchoring', () => {
  it('matches precincts to towns by lean rank without changing votes', async () => {
    const towns = (await data.townsOf('PA')).filter((t) => t.cd === '4201');
    const base: Unit[] = Array.from({ length: 12 }, (_, i) => ({ id: `x#${i}`, label: 'P', pop: 1000, lean: 0.3 + i * 0.03, demo: demoFrom([]) }));
    const before = base.map((u) => ({ ...u }));
    anchorPrecincts(base, towns.map((t) => ({ id: t.id, label: t.name, lean: t.lean, pop: t.pop })));
    expect(base.every((u) => u.geo)).toBe(true);
    expect(base.map((u) => u.lean)).toEqual(before.map((u) => u.lean));
    const leanOf = (id: string) => towns.find((t) => t.id === id)!.lean;
    for (let i = 1; i < base.length; i++) expect(leanOf(base[i].geo!)).toBeGreaterThanOrEqual(leanOf(base[i - 1].geo!));
  });
});
