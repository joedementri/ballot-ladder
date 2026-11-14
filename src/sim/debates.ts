/**
 * M16 interactive debates.
 *
 * The month before a debate, the player gets a decision with three questions, drawn from the issues the race's
 * audience cares most about. Each question can be answered three ways:
 *   policy  answer on the merits: strong when the player's position sits close to the audience, costly when it doesn't
 *   pivot   steer to the player's best issue with this audience: safe and modest, a little evasive
 *   attack  turn it on the leading opponent: pays off when they are out of step on the issue (more with oppo on them);
 *           some negativity sticks to the player, and attacking a fellow partisan in a primary costs party standing
 * The debate is scored as before (debate and policy skill, prep, policy staff, noise), plus the answers' average quality,
 * and with a little less noise. A debate the player didn't prepare answers for uses the old roll exactly.
 *
 * Randomness: questions and attack outcomes draw from the debate's own seeded streams; the main stream is used exactly
 * as before (one normal draw per debater), so unanswered debates replay identically.
 */
import type { Engine, ActionResult } from './game';
import type { Campaign, DebateAnswer, DebatePlan, DebateQuestion, Decision, Politician } from './model';
import { ISSUES } from './issues';
import { Rng, clamp } from './rng';
import { audience } from './vote';
import { genMonth, round2, round3 } from './util';
import { raceCtx, stageField, stageKind } from './trail';

export const ANSWERS: { key: DebateAnswer; label: string; detail: string }[] = [
  { key: 'policy', label: 'Give a policy answer', detail: 'Strong when your position is close to this audience; costly when it isn’t.' },
  { key: 'pivot', label: 'Pivot to your strength', detail: 'Steer to the issue where you fit this audience best. Safe, modest, a little evasive.' },
  { key: 'attack', label: 'Attack your opponent', detail: 'Pays off when they are out of step on the issue, more with opposition research on them. Some voters dislike it.' },
];
/** Quality of a question left unanswered in a debate the player otherwise prepared for. */
const UNANSWERED = -0.05;

/** Month of the vote the campaign is heading to (the debate is the month before). */
const voteMonth = (c: Campaign) => (c.stage === 'primary' ? c.primaryMonth : genMonth(c));

/** The opponent the player would face down in a debate: the leader in the last poll, else the best known. */
function mainOpponent(e: Engine, c: Campaign): Politician | null {
  const me = e.s.player.id;
  const field = stageField(c).filter((id) => id !== me);
  const last = c.polls[c.polls.length - 1];
  const score = (id: string) => (last?.shares[id] ?? 0) * 10 + (c.rec[id] ?? 0);
  const id = [...field].sort((a, b) => score(b) - score(a))[0];
  return e.pol(id) ?? null;
}

/**
 * The month before a debate: draw the questions and put the prep decision on the desk. Called after the calendar
 * advances, so the player answers during the debate month; the debate is held when that month ends.
 */
export function scheduleDebate(e: Engine) {
  const c = e.s.campaign;
  if (!c || c.stage === 'done' || c.year !== e.s.year || e.s.month !== voteMonth(c) - 1) return;
  if (c.debate && c.debate.year === e.s.year && c.debate.month === e.s.month && c.debate.stage === c.stage) return;
  const def = e.def(c.officeId)!;
  if (def.level < 2 || stageField(c).length < 2) return;
  const me = e.player;
  const { kind, party } = stageKind(c, me.party);
  const aud = audience(e.jurUnit(def), raceCtx(e, c, def, kind, party));
  const rng = new Rng(`${e.s.seed}|debateq|${c.officeId}|${e.s.year}|${e.s.month}|${c.stage}`);
  // three of the six issues this audience cares most about, likelier the more it cares
  const pool = ISSUES.map((_, i) => i).sort((a, b) => aud.salience[b] - aud.salience[a]).slice(0, 6);
  const picks: number[] = [];
  while (picks.length < 3) {
    const left = pool.filter((i) => !picks.includes(i));
    const w = left.map((i) => aud.salience[i] ** 2);
    let r = rng.next() * w.reduce((a, x) => a + x, 0);
    let k = 0;
    while (k < left.length - 1 && (r -= w[k]) > 0) k++;
    picks.push(left[k]);
  }
  const opp = mainOpponent(e, c);
  const pivot = ISSUES.map((_, i) => i).sort((a, b) => aud.salience[b] * (0.6 - Math.abs(me.pos[b] - aud.ideal[b])) - aud.salience[a] * (0.6 - Math.abs(me.pos[a] - aud.ideal[a])))[0];
  const questions: DebateQuestion[] = picks.map((i) => ({
    issue: ISSUES[i].key, audience: round2(aud.ideal[i]), mine: me.pos[i], opp: opp ? opp.pos[i] : null, pivot: ISSUES[pivot].key, pivotAudience: round2(aud.ideal[pivot]),
  }));
  const d: Decision = {
    id: e.newId('d'),
    templateId: `debate:${c.officeId}:${e.s.year}:${e.s.month}`,
    title: `Prepare for the ${def.title} ${c.stage === 'primary' ? 'primary ' : ''}debate`,
    body: `The debate is at the end of this month. The moderators will ask about ${questions.map((q) => ISSUES.find((x) => x.key === q.issue)!.label.toLowerCase()).join(', ')}. Choose an answer for each question on the Campaign tab, or pick one game plan for all three.`,
    options: [
      { label: 'Stick to policy answers', detail: ANSWERS[0].detail },
      { label: 'Pivot to your strengths', detail: ANSWERS[1].detail },
      { label: 'Go on the attack', detail: ANSWERS[2].detail },
    ],
    deadline: { year: e.s.year, month: e.s.month },
    meta: { kind: 'debate', officeId: c.officeId },
  };
  e.s.decisions.push(d);
  c.debate = { year: e.s.year, month: e.s.month, stage: c.stage as 'primary' | 'general', decisionId: d.id, oppId: opp?.id ?? null, questions };
}

/** The live debate plan, if the player can still answer it this month. */
function livePlan(e: Engine): DebatePlan | null {
  const c = e.s.campaign;
  const p = c?.debate;
  return c && p && c.stage === p.stage && p.year === e.s.year && p.month === e.s.month ? p : null;
}

function dropDecision(e: Engine, plan: DebatePlan) {
  e.s.decisions = e.s.decisions.filter((d) => d.id !== plan.decisionId);
}

/** Answer one question (answers can be changed until the debate). */
export function answerDebate(e: Engine, q: number, answer: DebateAnswer): ActionResult {
  const plan = livePlan(e);
  if (!plan) return { ok: false, msg: 'There is no debate to prepare for this month.' };
  const question = plan.questions[q];
  if (!question || !ANSWERS.some((a) => a.key === answer)) return { ok: false, msg: 'Unknown answer.' };
  question.answer = answer;
  if (plan.questions.every((x) => x.answer)) dropDecision(e, plan);
  return { ok: true, msg: `${ANSWERS.find((a) => a.key === answer)!.label} on ${ISSUES.find((x) => x.key === question.issue)!.label.toLowerCase()}.` };
}

/** The debate decision's options are game plans: one answer for every question not yet answered. */
export function debateGamePlan(e: Engine, d: Decision, optionIdx: number): ActionResult {
  const plan = livePlan(e);
  const answer = ANSWERS[optionIdx]?.key;
  if (!answer) return { ok: false, msg: 'Unknown option.' };
  e.s.decisions = e.s.decisions.filter((x) => x.id !== d.id);
  if (!plan || plan.decisionId !== d.id) return { ok: false, msg: 'That debate has passed.' };
  for (const q of plan.questions) q.answer ??= answer;
  return { ok: true, msg: `Debate plan set: ${ANSWERS[optionIdx].label.toLowerCase()}.` };
}

/** Expected quality of an answer before the attack's own luck (−0.3 … +0.35). */
export function answerQuality(e: Engine, c: Campaign, q: DebateQuestion, answer: DebateAnswer): number {
  const sk = e.player.skills;
  const i = ISSUES.findIndex((x) => x.key === q.issue);
  if (answer === 'policy') return 0.3 - 0.6 * Math.abs(q.mine - q.audience) + (sk.policy - 50) / 500;
  if (answer === 'pivot') {
    const j = ISSUES.findIndex((x) => x.key === q.pivot);
    return 0.1 - 0.4 * Math.abs(e.player.pos[j] - q.pivotAudience) + (sk.charisma - 50) / 500 + (i === j ? 0.04 : 0);
  }
  if (q.opp == null) return -0.1;
  const oppo = c.debate?.oppId && (c.oppoFound ?? []).includes(c.debate.oppId) ? 0.08 : 0;
  return 0.4 * Math.abs(q.opp - q.audience) - 0.1 + (sk.debate - 50) / 400 + oppo;
}

const hintOf = (x: number) => (x >= 0.15 ? 'strong' : x >= 0 ? 'fair' : 'risky');

/** The debate card: questions, positions and (with a policy director) how each answer is likely to land. */
export function debateView(e: Engine) {
  const plan = livePlan(e);
  const c = e.s.campaign;
  if (!plan || !c) return null;
  const staffed = e.s.player.staff.policy >= 1;
  return {
    month: plan.month, stage: plan.stage, opponent: plan.oppId ? e.name(e.pol(plan.oppId)) : null, staffed,
    questions: plan.questions.map((q) => ({
      ...q,
      label: ISSUES.find((x) => x.key === q.issue)!.label,
      pivotLabel: ISSUES.find((x) => x.key === q.pivot)!.label,
      hints: staffed ? Object.fromEntries(ANSWERS.map((a) => [a.key, hintOf(answerQuality(e, c, q, a.key))])) as Record<DebateAnswer, 'strong' | 'fair' | 'risky'> : null,
    })),
  };
}

/**
 * Hold the debate at the end of the month before the vote. Scores are the old ones; a prepared player adds the
 * answers' average quality and draws less noise.
 */
export function holdDebate(e: Engine, c: Campaign) {
  if (c.year !== e.s.year || e.s.month !== voteMonth(c) - 1) return;
  const def = e.def(c.officeId)!;
  if (def.level < 2) return;
  const field = stageField(c).map((id) => e.pol(id)!);
  if (field.length < 2) return;
  const me = e.player;
  const plan = livePlan(e);
  const prepared = !!plan?.questions.some((q) => q.answer);
  const luck = new Rng(`${e.s.seed}|debate|${c.officeId}|${e.s.year}|${e.s.month}|${c.stage}`);
  const answers = prepared ? plan!.questions.map((q) => {
    const quality = q.answer ? answerQuality(e, c, q, q.answer) + (q.answer === 'attack' ? luck.normal(0, 0.08) : 0) : UNANSWERED;
    return { issue: q.issue, answer: q.answer ?? null, quality: round3(quality) };
  }) : undefined;
  const bonus = answers ? answers.reduce((a, x) => a + x.quality, 0) / answers.length : 0;
  const scores = field.map((p) => p.skills.debate / 100 + p.skills.policy / 300 + (p.isPlayer ? c.debatePrep + e.s.player.staff.policy * 0.05 + bonus : 0) + e.rng.normal(0, p.isPlayer && prepared ? 0.2 : 0.25));
  const best = scores.indexOf(Math.max(...scores));
  const winner = field[best];
  c.bias[winner.id] = (c.bias[winner.id] ?? 0) + 0.12;
  for (const p of field) if (p !== winner) c.bias[p.id] = (c.bias[p.id] ?? 0) - 0.03;
  // what the answers did besides the score
  let body = `Snap polls give ${winner.isPlayer ? 'you' : e.name(winner)} the edge in the ${def.title} ${c.stage} debate.`;
  if (answers) {
    const attacks = answers.filter((a) => a.answer === 'attack').length;
    const opp = e.pol(plan!.oppId);
    if (attacks && opp) {
      opp.fav = clamp(opp.fav - 0.008 * attacks);
      me.fav = clamp(me.fav - 0.003 * attacks);
      if (c.stage === 'primary' && opp.party === me.party) e.s.player.partyStanding = clamp(e.s.player.partyStanding - attacks, 0, 100);
    }
    const label = (k: string) => ISSUES.find((x) => x.key === k)!.label.toLowerCase();
    const top = [...answers].sort((a, b) => b.quality - a.quality)[0];
    const low = [...answers].sort((a, b) => a.quality - b.quality)[0];
    if (top.quality >= 0.12) body += ` Your answer on ${label(top.issue)} landed.`;
    if (low.quality < 0 && low !== top) body += ` ${low.answer ? `Your answer on ${label(low.issue)} fell flat` : `You looked unprepared on ${label(low.issue)}`}.`;
  }
  c.debates.push({ month: e.s.month, winner: winner.id, swing: 0.12, year: e.s.year, stage: c.stage as 'primary' | 'general', answers });
  c.debatePrep = 0;
  if (plan) {
    dropDecision(e, plan);
    c.debate = null;
  }
  e.news({ kind: 'race', title: `Debate: ${e.name(winner)} wins the night`, body, tone: winner.isPlayer ? 'good' : 'bad' });
}
