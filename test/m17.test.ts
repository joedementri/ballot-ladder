/**
 * M17 legacy, achievements and the end of a career: the score moves the right way in clear cases, achievements fire
 * exactly once, race records note flips and incumbents, retiring ends the game and the save still loads, and saves
 * from before M17 pick up the new fields.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine, SAVE_VERSION } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { migrate } from '../src/sim/migrate';
import { ACHIEVEMENTS, checkAchievements, legacyScore, legacyView, rankFor, recordPlayerRace, tenures } from '../src/sim/legacy';
import type { Campaign, ResultSummary } from '../src/sim/model';

let e: Engine;
let town: { id: string; sldl?: string; county: string };
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
  town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))! as typeof town;
});

async function fresh(seed = 17) {
  await e.newGame({
    first: 'Lee', last: 'Gacy', gender: 'F', age: 40, party: 'D', homeTown: town.id, background: 'lawyer', difficulty: 'normal',
    pos: PARTY_BASE.D.map((x) => x * 0.7), skills: { charisma: 60, debate: 60, fundraising: 60, policy: 60, integrity: 60, organization: 60 }, seed,
  });
  return e;
}
const score = () => legacyScore(e).score;

describe('legacy score', () => {
  it('starts at zero and rises with wins, years in office, laws and leadership', async () => {
    await fresh();
    expect(score()).toBe(0);
    const me = e.player;
    me.career.push({ year: 2026, officeId: `sldl:${town.sldl}`, title: 'State Rep', result: 'won', share: 0.55 });
    const afterWin = score();
    expect(afterWin).toBeGreaterThan(0);
    me.career.push({ year: 2027, officeId: `sldl:${town.sldl}`, title: 'State Rep', result: 'took-office' });
    e.s.year = 2031;
    const afterYears = score();
    expect(afterYears).toBeGreaterThan(afterWin);
    expect(tenures(e)[0].years).toBe(4);
    e.s.year = 2035;
    expect(score()).toBeGreaterThan(afterYears);
    const beforeLaw = score();
    e.s.stats.laws.push({ id: 'b1', title: 'A law', year: 2030, level: 3 });
    expect(score()).toBeGreaterThan(beforeLaw);
    const beforePost = score();
    e.s.stats.posts.push({ chamber: 'sldl:PA', role: 'speaker', label: 'Speaker', year: 2031, level: 3 });
    expect(score()).toBeGreaterThan(beforePost);
  });

  it('a higher office counts for more, and scandals and losses count against', async () => {
    await fresh();
    e.player.career.push({ year: 2026, officeId: 'council:x:0', title: 'Council', result: 'won', share: 0.55 });
    const local = score();
    await fresh();
    e.player.career.push({ year: 2026, officeId: 'gov:PA', title: 'Governor', result: 'won', share: 0.55 });
    const gov = score();
    expect(gov).toBeGreaterThan(local);
    e.player.career.push({ year: 2028, officeId: 'sen:PA:1', title: 'Senator', result: 'lost', share: 0.45 });
    const afterLoss = score();
    expect(afterLoss).toBeLessThan(gov);
    e.s.scandals.push({ id: 'sx', who: e.player.id, title: 't', stage: 'investigation', severity: 0.7, truth: true, since: { year: 2028, month: 1 }, stageSince: { year: 2028, month: 3 }, log: [] });
    expect(score()).toBeLessThan(afterLoss);
    // a flip and a beaten incumbent add to the same win
    await fresh();
    e.player.career.push({ year: 2026, officeId: 'gov:PA', title: 'Governor', result: 'won', share: 0.55 });
    e.s.stats.races.push({ year: 2026, officeId: 'gov:PA', title: 'Governor', level: 6, stage: 'general', won: true, share: 0.55, margin: 0.1, flip: true, vsIncumbent: true });
    expect(score()).toBeGreaterThan(gov);
  });

  it('ranks go up with the score', () => {
    expect(rankFor(0).label).toBe('Footnote');
    expect(rankFor(10000).label).toBe('Historic');
    expect(rankFor(100).next!.min).toBeGreaterThan(100);
  });
});

describe('race records', () => {
  it('note flips, incumbents on the ballot and underdog primaries', async () => {
    await fresh();
    const me = e.player;
    const def = e.def('gov:PA')!;
    const inc = e.pol(e.ensureOffice('gov:PA')!.holder)!;
    const c = { officeId: 'gov:PA', year: 2026, polls: [{ year: 2026, month: 10, label: '', moe: 3, shares: { [me.id]: 0.4, [inc.id]: 0.5 } }] } as unknown as Campaign;
    const r = { cands: [{ id: me.id, name: '', party: 'D', votes: 52 }, { id: inc.id, name: '', party: inc.party, votes: 48 }], winnerId: me.id } as unknown as ResultSummary;
    recordPlayerRace(e, c, def, r, 'general', true, inc.party === 'D' ? 'R' : 'R');
    const rec = e.s.stats.races[0];
    expect(rec).toMatchObject({ won: true, vsIncumbent: true, underdog: true, share: 0.52, margin: 0.04, flip: true });
  });
});

describe('achievements', () => {
  it('each fires exactly once, with a news item', async () => {
    await fresh();
    e.player.career.push({ year: 2025, officeId: `sldl:${town.sldl}`, title: 'State Rep', result: 'won', share: 0.62 });
    expect(checkAchievements(e)).toContain('first_win');
    expect(checkAchievements(e)).toEqual([]);
    await e.endTurn();
    await e.endTurn();
    expect(e.s.achievements.filter((a) => a.id === 'first_win')).toHaveLength(1);
    expect(e.s.news.filter((n) => n.title === 'Achievement: First victory')).toHaveLength(1);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
  });

  it('months in office count toward average approval and leadership posts are remembered', async () => {
    await fresh();
    e.installOffice(`sldl:${town.sldl}`, e.player.id);
    e.s.player.role = { chamber: 'x', role: 'chair', committee: 'finance', since: e.s.year };
    await e.endTurn();
    await e.endTurn();
    expect(e.s.stats.officeMonths).toBe(2);
    expect(e.s.stats.approvalSum).toBeGreaterThan(0);
    expect(e.s.stats.posts).toHaveLength(1);
    expect(e.s.achievements.some((a) => a.id === 'leader')).toBe(true);
  });
});

describe('retirement', () => {
  it('leaves office, ends the game and keeps the save loadable', async () => {
    await fresh();
    const office = `sldl:${town.sldl}`;
    e.installOffice(office, e.player.id);
    e.s.year = 2029;
    const r = e.retire();
    expect(r.ok).toBe(true);
    expect(e.s.gameOver).toMatch(/retired from politics/);
    expect(e.player.officeId).toBeUndefined();
    expect(e.s.offices[office].holder).not.toBe(e.player.id);
    expect(e.player.career.at(-1)!.result).toBe('retired');
    expect(e.retire().ok).toBe(false);
    const years = legacyView(e).yearsInOffice;
    expect(years).toBeCloseTo(4, 5);
    const saved = JSON.parse(JSON.stringify(e.exportState()));
    const e2 = new Engine(BASE);
    await e2.init();
    e2.load(saved);
    await e2.restore();
    const v = e2.view();
    expect(v.gameOver).toBe(e.s.gameOver);
    expect(v.retired).toBe(true);
    expect(v.legacy.score).toBe(legacyScore(e).score);
  });
});

describe('saves', () => {
  it('saves from before M17 get achievements and tallies', async () => {
    await fresh();
    const st = JSON.parse(JSON.stringify(e.exportState()));
    delete st.achievements;
    delete st.stats;
    st.version = 3;
    const m = migrate(st);
    expect(m.version).toBe(SAVE_VERSION);
    expect(m.achievements).toEqual([]);
    expect(m.stats).toMatchObject({ officeMonths: 0, laws: [], races: [] });
  });
});
