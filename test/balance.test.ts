/**
 * Balance guard rails: a small, deterministic run of the balance harness.
 * Bands are loose on purpose; they catch tuning regressions, not small shifts.
 * For the full table run `npm run balance`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { RUNGS, runRung, summarize, townPool, type RaceResult } from './balance/harness';
import type { Town } from '../src/data/types';

let e: Engine;
let pool: Town[];
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
  pool = await townPool(e, ['PA', 'OH', 'WI', 'GA', 'AZ']);
});
const rung = (k: string) => RUNGS.find((r) => r.key === k)!;
const active = (rs: RaceResult[]) => rs.filter((r) => r.strategy !== 'passive');

describe('balance', () => {
  it('local races: campaigning matters, but wins are not automatic', async () => {
    const rs = await runRung(e, pool, rung('council'), { n: 10, profile: 'newcomer' });
    const passive = summarize(rs.filter((r) => r.strategy === 'passive'));
    const act = summarize(active(rs));
    console.log(`council newcomer: passive ${passive.win}, active ${act.win.toFixed(2)}, median share ${act.share.toFixed(2)}, spend/exp ${act.spendRatio.toFixed(2)}`);
    expect(passive.win).toBeLessThanOrEqual(0.2);
    expect(act.win).toBeGreaterThan(0.5);
    expect(act.win).toBeLessThan(0.97);
    expect(act.spendRatio).toBeLessThan(3);
  }, 120000);

  it('higher office is harder, and a track record helps', async () => {
    const sh = active(await runRung(e, pool, rung('state house'), { n: 8, profile: 'climber' }));
    const ush = active(await runRung(e, pool, rung('us house'), { n: 8, profile: 'climber' }));
    const ushNew = active(await runRung(e, pool, rung('us house'), { n: 8, profile: 'newcomer' }));
    const [a, b, c] = [summarize(sh).win, summarize(ush).win, summarize(ushNew).win];
    console.log(`state house climber ${a.toFixed(2)}, us house climber ${b.toFixed(2)}, us house newcomer ${c.toFixed(2)}`);
    expect(a).toBeGreaterThan(0.3);
    expect(a).toBeLessThan(0.9);
    expect(b).toBeLessThan(a + 0.05);
    expect(c).toBeLessThanOrEqual(b);
  }, 180000);

  it('difficulty orders outcomes', async () => {
    const story = summarize(active(await runRung(e, pool, rung('council'), { n: 8, profile: 'newcomer', difficulty: 'story', strategies: ['balanced', 'grassroots'] })));
    const hard = summarize(active(await runRung(e, pool, rung('council'), { n: 8, profile: 'newcomer', difficulty: 'hard', strategies: ['balanced', 'grassroots'] })));
    console.log(`council story ${story.win.toFixed(2)} vs hard ${hard.win.toFixed(2)}`);
    expect(story.win).toBeGreaterThan(hard.win);
  }, 120000);
});

describe('month summary', () => {
  it('itemizes money and explains changes', async () => {
    const town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))!;
    await e.newGame({ first: 'Test', last: 'Player', gender: 'F', age: 35, party: 'D', homeTown: town.id, background: 'teacher', pos: PARTY_BASE.D.map((x) => x * 0.7), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed: 7 });
    const council = (await e.availableOffices()).find((o) => o.id.startsWith('council:') && o.year === 2025)!;
    await e.file(council.id);
    await e.act('hire', 'field');
    await e.act('fund_small');
    await e.act('canvass', town.id);
    await e.act('canvass', town.id);
    const log = e.s.player.log!;
    expect(log[0].msg).toContain('Repeat this month');
    await e.endTurn();
    const s = e.view().summary!;
    expect(s.monthName).toBe('Jan');
    expect(s.actions.map((a) => a.id)).toEqual(['hire', 'fund_small', 'canvass', 'canvass']);
    // money lines reconcile with the cash change
    const net = s.money.reduce((a, m) => a + m.amount, 0);
    expect(Math.abs(s.cash[0] + net - s.cash[1])).toBeLessThanOrEqual(1);
    expect(s.money.find((m) => m.label === 'Staff payroll')?.amount).toBeLessThan(0);
    expect(s.rec[1]).toBeGreaterThan(s.rec[0]);
    expect(s.why.some((w) => w.includes('recognition'))).toBe(true);
    expect(s.next.length).toBeGreaterThan(0);
  });

  it('loads saves made before difficulty and the action log existed', async () => {
    const st = JSON.parse(JSON.stringify(e.exportState()));
    delete st.difficulty;
    delete st.player.log;
    delete st.monthStart;
    delete st.lastSummary;
    e.load(st);
    expect(e.view().difficulty).toBe('normal');
    expect((await e.act('fund_small')).ok).toBe(true);
    await e.endTurn();
    expect(e.view().summary?.actions.length).toBe(1);
  });
});
