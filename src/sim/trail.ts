/**
 * M16 campaign trail: adaptive AI messaging, AI nominees' pivot to the center, get out the vote, poll crosstabs and
 * public media polls. Debates are in debates.ts.
 *
 * Adaptive AI. Each month, every AI candidate in the player's stage of the race presses the issue where the player is
 * most out of step with the race's audience relative to themselves (salience × (player's gap − their gap)). A pressed
 * issue becomes more salient for every voter in the race (race-wide emphasis on top of the national one), so the
 * player's distance on it costs more. Their attack ads name it.
 *
 * Get out the vote. In the final month only: extra turnout among the voter blocs that favor the player (more with a
 * field director), and a small election-day edge. Repeats in the month have diminishing returns.
 *
 * Randomness: crosstab noise and media polls use their own seeded streams; the main stream is used exactly as before.
 */
import type { Engine, ActionResult } from './game';
import type { Campaign, Politician, PollPoint } from './model';
import type { Party } from '../data/types';
import { BLOCS, ISSUES, N_BLOCS, N_ISSUES, type Positions } from './issues';
import type { OfficeDef } from './offices';
import { Rng, clamp } from './rng';
import { audience, unitShares, type RaceCtx } from './vote';
import { genMonth, monthName, round2, round3 } from './util';

/** Extra salience an issue gets when an AI candidate presses it (national emphasis runs about −0.25 … +0.5). */
export const PRESS = 0.5;
/** How far AI nominees move toward the general electorate after their primary (0.3 cut balanced climbers' state-house wins from 70% to 45% in the balance harness; 0.05 keeps the table within noise). */
export const PIVOT = 0.05;
/** Get out the vote: base extra turnout among the player's best blocs, election-day edge, and the repeat penalty. */
export const GOTV = { turnout: 0.05, bias: 0.01, repeat: 0.6 };

/** Candidates in the stage of the race now being fought (the primary field during the primary). */
export function stageField(c: Campaign): string[] {
  return c.stage === 'primary' ? c.primaryField : c.generalField;
}

/** The race context kind for the current stage (top-two primaries are fought like generals). */
export function stageKind(c: Campaign, party: Party): { kind: RaceCtx['kind']; party?: Party } {
  if (c.kind === 'nonpartisan') return { kind: 'nonpartisan' };
  if (c.stage === 'primary' && c.kind === 'partisan') return { kind: 'primary', party };
  return { kind: 'general' };
}

/** Race-wide issue emphasis from the AI candidates' messages. */
export function raceEmphasis(c: Campaign): Positions | null {
  const field = new Set(stageField(c));
  const out = new Array(N_ISSUES).fill(0);
  let any = false;
  for (const [id, i] of Object.entries(c.aiEmphasis ?? {})) {
    if (!field.has(id)) continue;
    out[i] = Math.min(out[i] + PRESS, PRESS * 1.5);
    any = true;
  }
  return any ? out : null;
}

/** The context for the player's race: the office's context plus the issues the race is being fought on. */
export function raceCtx(e: Engine, c: Campaign, def: OfficeDef, kind: RaceCtx['kind'], party?: Party): RaceCtx {
  const ctx = e.ctxFor(def, kind, party);
  const em = raceEmphasis(c);
  if (em) ctx.natEmphasis = ctx.natEmphasis!.map((x, i) => x + em[i]);
  return ctx;
}

/** The issue an AI candidate presses against the player, or null if the player has no weak spot against them. */
export function pressIssue(me: Politician, p: Politician, aud: { ideal: Positions; salience: Positions }): number | null {
  let best: number | null = null, top = 0.004;
  for (let i = 0; i < N_ISSUES; i++) {
    const s = aud.salience[i] * (Math.abs(me.pos[i] - aud.ideal[i]) - Math.abs(p.pos[i] - aud.ideal[i]));
    if (s > top) [best, top] = [i, s];
  }
  return best;
}

/** Monthly: AI candidates in the player's stage of the race pick the issue to press (news when it changes). */
export function adaptMessages(e: Engine, c: Campaign) {
  const def = e.def(c.officeId)!;
  const me = e.player;
  const { kind, party } = stageKind(c, me.party);
  // judged without the race's own emphasis, so candidates don't chase each other's messages
  const aud = audience(e.jurUnit(def), e.ctxFor(def, kind, party));
  const em = (c.aiEmphasis ??= {});
  for (const id of stageField(c)) {
    const p = e.pol(id);
    if (!p || p.isPlayer) continue;
    const i = pressIssue(me, p, aud);
    if (i == null) {
      delete em[id];
      continue;
    }
    if (em[id] !== i) e.news({ kind: 'race', title: `${e.name(p)} makes ${ISSUES[i].label.toLowerCase()} the issue against ${e.name(me)}`, body: `Their campaign says you are out of step with ${def.jurName} voters on ${ISSUES[i].label.toLowerCase()}. The issue now weighs more with voters in this race.`, tone: 'bad' });
    em[id] = i;
  }
}

/** After the primary: AI nominees move toward the general electorate (once per race). */
export function pivotToCenter(e: Engine, c: Campaign) {
  if (c.pivoted || c.stage !== 'general' || c.kind === 'nonpartisan') return;
  const def = e.def(c.officeId)!;
  const aud = audience(e.jurUnit(def), e.ctxFor(def, 'general'));
  for (const id of c.generalField) {
    const p = e.pol(id);
    if (!p || p.isPlayer) continue;
    p.pos = p.pos.map((x, i) => round2(clamp(x + PIVOT * (aud.ideal[i] - x), -1, 1)));
  }
  c.pivoted = true;
}

// ------------------------------------------------------------------ get out the vote

/** Why get-out-the-vote isn't available now (null when it is). */
export function gotvBlocked(e: Engine, c: Campaign | null): string | null {
  if (!c) return 'You need to be running for office.';
  const m = c.stage === 'primary' ? c.primaryMonth : genMonth(c);
  if (c.pres && c.stage === 'primary') return 'Presidential primaries are won state by state; turnout drives come with the general election.';
  if (c.year !== e.s.year || e.s.month !== m) return `Only in the final month before the vote (${monthName(m)} ${c.year}).`;
  if (stageField(c).length < 2) return 'Nobody is running against you.';
  return null;
}

/** The player's share in each bloc against the field, relative to their overall share (positive = favors the player). */
function blocLeans(e: Engine, c: Campaign): number[] {
  const def = e.def(c.officeId)!;
  const { kind, party } = stageKind(c, e.player.party);
  const unit = e.jurUnit(def);
  unit.rec = { [e.s.player.id]: e.recIn(e.jurKey(def)) };
  const field = stageField(c);
  const r = unitShares(unit, field.map((id) => e.candidate(id, def, c)), raceCtx(e, c, def, kind, party));
  const me = field.indexOf(e.s.player.id);
  return r.byBloc.map((s) => s[me] - r.shares[me]);
}

/** Blocs a turnout drive would reach (for the action card). */
export function gotvNote(e: Engine, c: Campaign): string {
  const leans = blocLeans(e, c);
  const best = BLOCS.map((b, i) => ({ label: b.label, x: leans[i] })).filter((b) => b.x > 0.01).sort((a, b) => b.x - a.x).slice(0, 3);
  return best.length ? `Turns out ${best.map((b) => b.label.toLowerCase()).join(', ')}` : 'No group favors you much; a small edge';
}

export function getOutTheVote(e: Engine, c: Campaign, fat: number): ActionResult {
  const field = e.s.player.staff.field;
  const leans = blocLeans(e, c);
  const stage = c.stage as 'primary' | 'general';
  if (!c.gotv || c.gotv.stage !== stage) c.gotv = { stage, blocs: new Array(N_BLOCS).fill(0), bias: 0, drives: 0 };
  const g = c.gotv;
  const k = GOTV.turnout * (1 + 0.4 * field) * fat;
  const reached: string[] = [];
  leans.forEach((x, b) => {
    const add = k * clamp(x / 0.15, 0, 1);
    if (add > 0.005) reached.push(BLOCS[b].label.toLowerCase());
    g.blocs[b] = round3(g.blocs[b] + add);
  });
  g.bias = round3(g.bias + GOTV.bias * (1 + 0.3 * field) * fat);
  g.drives++;
  return { ok: true, msg: reached.length ? `Volunteers knocked doors and ran phone banks for ${reached.join(', ')} voters.` : 'Your volunteers worked the phones, but no voter group leans your way much.' };
}

// ------------------------------------------------------------------ polls

const POLLSTERS = ['Marist', 'Emerson', 'Quinnipiac', 'Siena', 'Monmouth', 'SurveyUSA', 'PPP', 'Suffolk', 'the local paper', 'a university poll'];

/** Bloc crosstabs for an internal poll: each bloc's shares among decided voters, with its own (bigger) margin of error. */
export function crosstabs(e: Engine, c: Campaign, field: string[], byBloc: number[][], weights: number[], n: number): PollPoint['blocs'] {
  const rng = new Rng(`${e.s.seed}|xtab|${c.officeId}|${e.s.year}|${e.s.month}`);
  return BLOCS.map((b, bi) => {
    const nb = Math.max(20, n * weights[bi]);
    const moe = 1 / Math.sqrt(nb);
    const noisy = byBloc[bi].map((s) => Math.max(0.005, s + rng.normal(0, moe / 2)));
    const tot = noisy.reduce((a, x) => a + x, 0);
    const shares: Record<string, number> = {};
    field.forEach((id, i) => (shares[id] = round3(noisy[i] / tot)));
    return { label: b.label, weight: round3(weights[bi]), shares, moe: round3(moe * 2) };
  });
}

/** Every other month in races at level 3 and up, a public poll with its own noise and a pollster's house lean. */
export function mediaPoll(e: Engine, c: Campaign, def: OfficeDef, field: string[], shares: number[], undecided: number) {
  if (def.level < 3 || (e.s.year * 12 + e.s.month) % 2 !== 0) return;
  const rng = new Rng(`${e.s.seed}|media|${c.officeId}|${e.s.year}|${e.s.month}`);
  const pollster = rng.pick(POLLSTERS);
  const house = new Rng(`${e.s.seed}|house|${pollster}`).normal(0, 0.012);
  const n = rng.int(500, 900);
  const moe = 1 / Math.sqrt(n);
  const und = clamp(undecided + rng.range(0, 0.03), 0.02, 0.33);
  const noisy = shares.map((s, i) => {
    const p = e.pol(field[i])?.party;
    return Math.max(0.005, s + rng.normal(0, moe / 2) + (p === 'D' ? house : p === 'R' ? -house : 0));
  });
  const tot = noisy.reduce((a, x) => a + x, 0);
  const point: PollPoint = { year: e.s.year, month: e.s.month, label: `${monthName(e.s.month)} ${String(e.s.year).slice(2)}`, shares: {}, moe: round3(moe * 2), pollster };
  field.forEach((id, i) => (point.shares[id] = round3((noisy[i] / tot) * (1 - und))));
  point.shares.undecided = round3(und);
  (c.mediaPolls ??= []).push(point);
  const order = [...field].sort((a, b) => point.shares[b] - point.shares[a]);
  const [a, b] = order;
  const pa = Math.round(point.shares[a] * 100), pb = Math.round(point.shares[b] * 100);
  const me = e.s.player.id;
  const nm = (id: string) => (id === me ? 'You' : e.name(e.pol(id)));
  e.news({
    kind: 'race',
    title: pa === pb ? `Poll: ${def.title} race tied at ${pa}%` : `Poll: ${nm(a)} lead${a === me ? '' : 's'} ${nm(b) === 'You' ? 'you' : nm(b)} ${pa}–${pb}% for ${def.title}`,
    body: `${pollster.replace(/^./, (x) => x.toUpperCase())}, ${n} likely voters, ±${Math.round(moe * 200)} pts. ${Math.round(und * 100)}% undecided.`,
    tone: pa === pb ? 'neutral' : a === me ? 'good' : field.includes(me) && b === me ? 'bad' : 'neutral',
  });
}
