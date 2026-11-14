/**
 * M16 campaign trail: interactive debates, poll crosstabs, adaptive AI messaging and the AI's pivot to the center,
 * get out the vote, and public media polls. Win-rate effects are in the balance table (npm run balance).
 */
import { describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { ISSUES, PARTY_BASE } from '../src/sim/issues';
import { answerQuality, holdDebate } from '../src/sim/debates';
import { PIVOT, adaptMessages, pivotToCenter, raceCtx } from '../src/sim/trail';
import { poll } from '../src/sim/races';
import { audience, unitShares } from '../src/sim/vote';
import type { Campaign, DebateQuestion } from '../src/sim/model';

/** A Lansdale, PA Republican in the 2026 general election for governor against the sitting Democrat. */
async function general(seed = 16, month = 9) {
  const e = new Engine(BASE);
  await e.init();
  const town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))!;
  await e.newGame({
    first: 'Deb', last: 'Ater', gender: 'F', age: 48, party: 'R', homeTown: town.id, background: 'lawyer', difficulty: 'normal',
    pos: PARTY_BASE.R.map((x) => x * 0.7), skills: { charisma: 60, debate: 60, fundraising: 60, policy: 60, integrity: 60, organization: 60 }, seed,
  });
  e.s.year = 2026;
  e.s.month = 1;
  const def = e.def('gov:PA')!;
  const holder = e.pol(e.ensureOffice('gov:PA')!.holder)!;
  holder.terms = 1;
  holder.birthYear = 2026 - 55;
  expect((await e.file('gov:PA')).ok).toBe(true);
  const c = e.s.campaign!;
  c.stage = 'general';
  c.generalField = [e.player.id, holder.id];
  c.rec[holder.id] = 0.8;
  e.s.month = month;
  return { e, def, holder, c };
}

const debateDecisions = (e: Engine) => e.s.decisions.filter((d) => d.meta?.kind === 'debate');

describe('interactive debates', () => {
  it('the month before the debate brings three questions on issues the audience cares about', async () => {
    const { e, c, def } = await general();
    await e.endTurn(); // September ends: October is debate month
    expect(e.s.month).toBe(10);
    const [d] = debateDecisions(e);
    expect(d).toBeTruthy();
    expect(d.deadline).toEqual({ year: 2026, month: 10 });
    const plan = c.debate!;
    expect(plan.questions).toHaveLength(3);
    expect(new Set(plan.questions.map((q) => q.issue)).size).toBe(3);
    // questions come from the six issues this audience cares most about
    const aud = audience(e.jurUnit(def), raceCtx(e, c, def, 'general'));
    const top6 = ISSUES.map((x, i) => ({ k: x.key, s: aud.salience[i] })).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.k);
    for (const q of plan.questions) expect(top6).toContain(q.issue);
    // and the view shows them on the Campaign tab, not the Office tab's decision list
    expect(e.view().campaign!.debatePlan!.questions).toHaveLength(3);
  });

  it('answers are kept until the debate, which records them and clears the desk', async () => {
    const { e, c } = await general();
    await e.endTurn();
    expect(e.answerDebate(0, 'policy').ok).toBe(true);
    expect(e.answerDebate(1, 'pivot').ok).toBe(true);
    expect(debateDecisions(e)).toHaveLength(1); // one still open
    expect(e.answerDebate(2, 'attack').ok).toBe(true);
    expect(debateDecisions(e)).toHaveLength(0);
    expect(e.answerDebate(2, 'policy').ok).toBe(true); // changeable until the debate
    await e.endTurn();
    const last = c.debates[c.debates.length - 1];
    expect(last.answers!.map((a) => a.answer)).toEqual(['policy', 'pivot', 'policy']);
    expect(c.debate).toBeNull();
    expect(e.s.news.some((n) => n.title.startsWith('Debate:'))).toBe(true);
    expect(e.answerDebate(0, 'policy').ok).toBe(false);
  });

  it('a game plan answers every open question; an ignored debate is held anyway with no penalty', async () => {
    const a = await general();
    await a.e.endTurn();
    a.e.answerDebate(1, 'attack');
    const d = debateDecisions(a.e)[0];
    expect(a.e.decide(d.id, 1).ok).toBe(true);
    expect(a.c.debate!.questions.map((q) => q.answer)).toEqual(['pivot', 'attack', 'pivot']);

    const b = await general();
    await b.e.endTurn();
    const eff = b.e.s.player.metrics.effectiveness;
    await b.e.endTurn();
    const last = b.c.debates[b.c.debates.length - 1];
    expect(last.answers).toBeUndefined(); // the old roll
    expect(debateDecisions(b.e)).toHaveLength(0);
    expect(b.e.s.player.metrics.effectiveness).toBe(eff);
    expect(b.e.s.news.some((n) => n.title.startsWith('You let'))).toBe(false);
  });

  it('a policy answer is strong close to the audience and costly far from it; attacks need an opponent out of step', async () => {
    const { e, c } = await general();
    const q: DebateQuestion = { issue: 'taxes', audience: 0.2, mine: 0.2, opp: 0.2, pivot: 'taxes', pivotAudience: 0.2 };
    const close = answerQuality(e, c, q, 'policy');
    const far = answerQuality(e, c, { ...q, mine: -0.8 }, 'policy');
    expect(close).toBeGreaterThan(0.15);
    expect(far).toBeLessThan(0);
    expect(answerQuality(e, c, { ...q, opp: -0.8 }, 'attack')).toBeGreaterThan(answerQuality(e, c, q, 'attack'));
    expect(answerQuality(e, c, { ...q, opp: null }, 'attack')).toBeLessThan(0);
    const pivot = answerQuality(e, c, { ...q, mine: -0.8 }, 'pivot');
    expect(pivot).toBeGreaterThan(far);
    expect(pivot).toBeLessThan(close);
  });

  it('good answers win more debates than no preparation', async () => {
    const { e, c } = await general(16, 10);
    const opp = c.generalField[1];
    const run = (prepared: boolean) => {
      let wins = 0;
      for (let i = 0; i < 300; i++) {
        c.debate = prepared
          ? { year: 2026, month: 10, stage: 'general', decisionId: 'none', oppId: opp, questions: ['taxes', 'crime', 'health'].map((k) => {
              const j = ISSUES.findIndex((x) => x.key === k);
              return { issue: k, audience: e.player.pos[j], mine: e.player.pos[j], opp: e.pol(opp)!.pos[j], pivot: k, pivotAudience: e.player.pos[j], answer: 'policy' as const };
            }) }
          : null;
        holdDebate(e, c);
        if (c.debates[c.debates.length - 1].winner === e.player.id) wins++;
      }
      return wins / 300;
    };
    const unprepared = run(false), prepared = run(true);
    expect(prepared).toBeGreaterThan(unprepared + 0.1);
  });
});

describe('polls', () => {
  it('a campaign manager unlocks crosstabs with bigger margins than the topline', async () => {
    const { e, c } = await general();
    poll(e, c);
    expect(c.polls[c.polls.length - 1].blocs).toBeUndefined();
    e.s.player.staff.manager = 1;
    poll(e, c);
    const p = c.polls[c.polls.length - 1];
    expect(p.blocs).toHaveLength(7);
    for (const b of p.blocs!) {
      expect(Object.values(b.shares).reduce((a, x) => a + x, 0)).toBeCloseTo(1, 2);
      expect(b.moe).toBeGreaterThan(p.moe);
    }
  });

  it('media polls run every other month in races at level 3 and up, with a pollster and a news item', async () => {
    const { e, c } = await general(16, 8);
    poll(e, c); // August (even)
    expect(c.mediaPolls).toHaveLength(1);
    expect(c.mediaPolls![0].pollster).toBeTruthy();
    expect(e.s.news[0].title.startsWith('Poll:')).toBe(true);
    e.s.month = 9;
    poll(e, c); // odd month: internal poll only
    expect(c.mediaPolls).toHaveLength(1);
    expect(c.polls).toHaveLength(2);
  });

  it('local races get no media polls', async () => {
    const { e, c } = await general(16, 8);
    const low: Campaign = { ...c, officeId: 'council:' + e.player.home + ':0', mediaPolls: undefined };
    e.s.campaign = low;
    low.generalField = [e.player.id, c.generalField[1]];
    poll(e, low);
    expect(low.mediaPolls).toBeUndefined();
  });
});

describe('adaptive AI', () => {
  it('presses the issue where the player is out of step, and the race weighs it more', async () => {
    const { e, c, def, holder } = await general();
    const i = ISSUES.findIndex((x) => x.key === 'abortion');
    const before = unitShares(e.jurUnit(def), c.generalField.map((id) => e.candidate(id, def, c)), raceCtx(e, c, def, 'general')).shares[0];
    e.player.pos[i] = 1; // far from a swing state's voters
    holder.pos[i] = -0.2;
    adaptMessages(e, c);
    expect(c.aiEmphasis![holder.id]).toBe(i);
    expect(e.s.news[0].title).toContain('abortion');
    const cands = c.generalField.map((id) => e.candidate(id, def, c));
    const withPress = unitShares(e.jurUnit(def), cands, raceCtx(e, c, def, 'general')).shares[0];
    const noPress = unitShares(e.jurUnit(def), cands, e.ctxFor(def, 'general')).shares[0];
    expect(withPress).toBeLessThan(noPress);
    expect(noPress).toBeLessThan(before); // the position itself costs votes too
  });

  it('AI nominees move part of the way toward the general electorate, once', async () => {
    const { e, c, def, holder } = await general();
    const aud = audience(e.jurUnit(def), e.ctxFor(def, 'general'));
    const dist = () => holder.pos.reduce((a, x, i) => a + Math.abs(x - aud.ideal[i]), 0);
    const d0 = dist();
    pivotToCenter(e, c);
    // each position moves PIVOT of the way (up to rounding and the ±1 bounds)
    expect(dist()).toBeCloseTo(d0 * (1 - PIVOT), 1);
    expect(dist()).toBeLessThan(d0);
    const d1 = dist();
    pivotToCenter(e, c);
    expect(dist()).toBe(d1);
  });
});

describe('get out the vote', () => {
  it('only in the final month; turns out the blocs that favor the player', async () => {
    const { e, c, def } = await general(16, 10);
    e.s.player.cash = 1e7;
    expect((await e.act('gotv')).ok).toBe(false);
    expect(e.actionNotes().gotv.blocked).toMatch(/final month/);
    e.s.month = 11;
    expect(e.actionNotes().gotv.blocked).toBeUndefined();
    const cands = c.generalField.map((id) => e.candidate(id, def, c));
    const ctx = raceCtx(e, c, def, 'general');
    const before = unitShares(e.jurUnit(def), cands, ctx);
    expect((await e.act('gotv')).ok).toBe(true);
    const g = c.gotv!;
    expect(g.stage).toBe('general');
    // boosted blocs are the ones where the player runs ahead of their overall share
    g.blocs.forEach((x, b) => { if (x > 0) expect(before.byBloc[b][0]).toBeGreaterThan(before.shares[0]); });
    expect(g.blocs.some((x) => x > 0)).toBe(true);
    const after = unitShares(e.jurUnit(def), cands, { ...ctx, turnoutBoost: g.blocs });
    expect(after.shares[0]).toBeGreaterThan(before.shares[0]);
    // a second drive the same month does less
    const first = g.bias;
    await e.act('gotv');
    expect(g.bias - first).toBeCloseTo(first * 0.6, 3);
    expect(g.drives).toBe(2);
  });
});

describe('saves', () => {
  it('a campaign saved before M16 keeps playing', async () => {
    const { e, c } = await general(16, 9);
    for (const k of ['debate', 'aiEmphasis', 'gotv', 'pivoted', 'mediaPolls'] as const) delete c[k];
    const st = JSON.parse(JSON.stringify(e.exportState()));
    const f = new Engine(BASE);
    await f.init();
    f.load(st);
    await f.restore();
    await f.endTurn();
    await f.endTurn();
    expect(f.s.campaign!.debates.length).toBeGreaterThan(0);
    expect(f.view().campaign).toBeTruthy();
  });
});
