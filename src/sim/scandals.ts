/**
 * M15 scandals and crisis response.
 *
 * A scandal is a story with a hidden truth and a severity. The player answers each new story (a decision):
 *   Apologize        take a smaller hit now and end the story (a true, severe one can still draw investigators)
 *   Deny             no hit now; if the story is true, new evidence may contradict you, which is worse
 *   Attack the press party standing up, swing voters down; the story runs its course
 *   Lawyer up        costs cash; quieter coverage and slower escalation, but the story lingers
 * An unanswered story counts as "no comment". Only true, severe stories escalate: story → investigation (a monthly
 * drain on favorability, approval and party standing) → charges, when the party presses the player to resign.
 * Fighting the charges ends in a verdict five months later; a conviction removes the player from office.
 *
 * Opposition research opens a story on an opponent, who responds by integrity (honest ones apologize, others deny,
 * attack or lawyer up); the response scales the damage. Opponents' stories don't escalate.
 *
 * Randomness: the monthly "does a new scandal break" roll stays on the main stream (as before M15); everything inside
 * a story draws from its own seeded stream, so it is deterministic and independent of the rest of the month.
 */
import type { Engine, ActionResult } from './game';
import type { Decision, Politician, Scandal, ScandalEnd, ScandalResponse, YM } from './model';
import { expectedSpend } from './offices';
import { Rng, clamp } from './rng';
import { round3 } from './util';
import { BLOCS } from './issues';
import { vacate } from './vacancies';

/** Severity at or above which a true story can escalate. */
export const SEVERE = 0.55;
/** Months a story stays in the news before it fades (lawyering up adds two). */
const FADE = 3;
/** An investigation that hasn't produced charges after this many months closes. */
const INVESTIGATION_MONTHS = 8;
/** Months from charges to a verdict for a politician who fights them. */
const TRIAL_MONTHS = 5;
/** Monthly escalation odds by stage, before the response multiplier. */
const ESCALATE = { story: 0.3, investigation: 0.15 };
/** How each response changes the odds of escalation. */
export const ESCALATION_MULT: Record<ScandalResponse, number> = { apologize: 0.4, deny: 1, attack: 1.2, lawyer: 0.5, silent: 1 };

const PLAYER_STORIES = [
  'faces questions over a donor’s no-bid contract',
  'caught in a misleading statement about their résumé',
  'campaign accused of finance violations',
  'under fire for leaked private remarks',
  'accused of using staff for personal errands',
  'tied to a lobbyist’s undisclosed gifts',
];
const OPPO_STORIES = ['missed taxes on a rental property', 'steered contracts to a donor', 'padded a résumé', 'has a history of unpaid liens', 'used public funds for travel'];

const ym = (e: Engine): YM => ({ year: e.s.year, month: e.s.month });
const monthsSince = (e: Engine, t: YM) => (e.s.year - t.year) * 12 + e.s.month - t.month;
const addMonths = (t: YM, n: number): YM => {
  const m = t.year * 12 + (t.month - 1) + n;
  return { year: Math.floor(m / 12), month: (m % 12) + 1 };
};
const streamFor = (e: Engine, s: Scandal, tag: string) => new Rng(`${e.s.seed}|scandal|${s.id}|${tag}|${e.s.year}|${e.s.month}`);

export const active = (s: Scandal) => !s.ended;
export function playerScandals(e: Engine) {
  return e.s.scandals.filter((s) => s.who === e.s.player.id);
}
function note(e: Engine, s: Scandal, text: string, tone: 'good' | 'bad' | 'neutral' = 'bad') {
  s.log.push({ year: e.s.year, month: e.s.month, text, tone });
}
function end(e: Engine, s: Scandal, how: ScandalEnd, text: string, tone: 'good' | 'bad' | 'neutral' = 'neutral') {
  s.ended = { ...ym(e), how };
  note(e, s, text, tone);
}
export function severityLabel(x: number) {
  return x >= 0.75 ? 'Major' : x >= SEVERE ? 'Serious' : x >= 0.35 ? 'Moderate' : 'Minor';
}

/** Expected spend of the race or office the player is in (sets the price of lawyers). */
function scale(e: Engine) {
  const c = e.s.campaign && e.s.campaign.stage !== 'done' ? e.s.campaign : null;
  const def = c ? e.def(c.officeId) : e.player.officeId ? e.def(e.player.officeId) : null;
  return def ? expectedSpend(def.type, def.pop) : 15000;
}
export function lawyerCost(e: Engine) {
  return Math.round(Math.max(3000, scale(e) * 0.06) / 100) * 100;
}

// ------------------------------------------------------------------ the player's stories

/**
 * A new story about the player. Severity and truth are drawn from the story's own stream, skewed by integrity
 * (`force` pins them, for tests and scripted stories). Applies the first hit and puts a response on the desk.
 */
export function openPlayerScandal(e: Engine, title?: string, force: { severity?: number; truth?: boolean } = {}): Scandal {
  const me = e.player;
  const id = e.newId('x');
  const rng = new Rng(`${e.s.seed}|scandal|${id}|open`);
  const integ = me.skills.integrity;
  const severity = round3(force.severity ?? clamp(rng.range(0.2, 0.85) + (50 - integ) / 400, 0.1, 1));
  const truth = force.truth ?? rng.chance(clamp(0.55 - (integ - 50) / 150, 0.15, 0.85));
  const s: Scandal = { id, who: me.id, title: title ?? rng.pick(PLAYER_STORIES), stage: 'story', severity, truth, since: ym(e), stageSince: ym(e), log: [] };
  e.s.scandals.push(s);
  me.scandal = clamp(me.scandal + 0.1 + 0.25 * severity);
  me.fav = clamp(me.fav - 0.02 - 0.03 * severity);
  note(e, s, 'The story breaks.');
  e.news({ kind: 'scandal', title: `Scandal: ${e.name(me)} ${s.title}`, body: `${severityLabel(severity)} story. How you respond decides whether it fades or grows.`, tone: 'bad' });
  e.s.decisions.push(responseDecision(e, s));
  return s;
}

function responseDecision(e: Engine, s: Scandal): Decision {
  const cost = lawyerCost(e);
  return {
    id: e.newId('d'),
    templateId: `scandal:${s.id}`,
    title: `Respond: ${s.title.replace(/^./, (x) => x.toUpperCase())}`,
    body: `A ${severityLabel(s.severity).toLowerCase()} story is running. Reporters want an answer this month; silence lets it run its course.`,
    options: [
      { label: 'Apologize', detail: 'A smaller hit now, and the story ends. If it is serious and true, investigators may still look.' },
      { label: 'Deny it', detail: 'No hit now. If it is true and the evidence comes out, it gets much worse.' },
      { label: 'Attack the press', detail: 'Your party rallies; swing voters sour. The story runs its course.' },
      { label: 'Lawyer up', detail: `Costs $${cost.toLocaleString()}. Quieter coverage and slower escalation, but it lingers.` },
    ],
    deadline: ym(e),
    meta: { kind: 'scandal', scandal: s.id },
  };
}

function chargesDecision(e: Engine, s: Scandal): Decision {
  const inOffice = !!e.player.officeId;
  return {
    id: e.newId('d'),
    templateId: `scandal-charges:${s.id}`,
    title: `Charged: ${s.title.replace(/^./, (x) => x.toUpperCase())}`,
    body: inOffice
      ? 'Prosecutors have filed charges. Party leaders want you to resign before this drags down the ticket.'
      : 'Prosecutors have filed charges. Your party wants you out of the spotlight.',
    options: inOffice
      ? [
          { label: 'Resign', detail: 'Leave office now and end the story. A lasting mark on your career.' },
          { label: 'Fight the charges', detail: `Stay and fight. The party turns on you; a verdict comes in ${TRIAL_MONTHS} months.` },
        ]
      : [
          { label: 'Plead and step back', detail: 'End the case now. You drop any race you are in, and it follows you.' },
          { label: 'Fight the charges', detail: `Go to trial. The party keeps its distance; a verdict comes in ${TRIAL_MONTHS} months.` },
        ],
    deadline: addMonths(ym(e), 1),
    meta: { kind: 'scandal', scandal: s.id },
  };
}

const RESPONSES: ScandalResponse[] = ['apologize', 'deny', 'attack', 'lawyer'];

/** The player answers a scandal decision (Engine.decide). */
export function respondScandal(e: Engine, d: Decision, optionIdx: number): ActionResult {
  const s = e.s.scandals.find((x) => x.id === d.meta?.scandal);
  e.s.decisions = e.s.decisions.filter((x) => x.id !== d.id);
  if (!s || s.ended) return { ok: false, msg: 'That story is over.' };
  const P = e.s.player;
  const opt = d.options[optionIdx];
  P.record.unshift({ year: e.s.year, month: e.s.month, title: d.title, choice: opt?.label ?? 'No comment' });
  if (P.record.length > 120) P.record.length = 120;
  if (s.stage === 'charges') return optionIdx === 0 ? stepDown(e, s) : fightCharges(e, s);
  const r = RESPONSES[optionIdx];
  if (!r) return { ok: false, msg: 'Unknown option.' };
  return { ok: true, msg: applyResponse(e, s, r) };
}

/** Effects of the player's response to a story. Returns a one-line result. */
export function applyResponse(e: Engine, s: Scandal, r: ScandalResponse): string {
  const P = e.s.player;
  const me = e.player;
  s.response = r;
  const sev = s.severity;
  switch (r) {
    case 'apologize': {
      me.fav = clamp(me.fav - 0.01 - 0.02 * sev);
      me.scandal = round3(me.scandal * 0.5);
      P.partyStanding = clamp(P.partyStanding - 1, 0, 100);
      if (s.truth && sev >= SEVERE) {
        note(e, s, 'You apologized. The press moves on, but questions remain about what happened.', 'neutral');
        e.news({ kind: 'scandal', title: `${e.name(me)} apologizes`, body: 'The apology takes the air out of the story.', tone: 'neutral' });
        return 'You apologized. The story is fading, though some questions remain.';
      }
      end(e, s, 'apologized', 'You apologized and the story ended.', 'neutral');
      e.news({ kind: 'scandal', title: `${e.name(me)} apologizes; the story fades`, tone: 'neutral' });
      return 'You apologized. The story is over.';
    }
    case 'deny': {
      me.scandal = round3(me.scandal * 0.85);
      note(e, s, 'You denied everything.', 'neutral');
      e.news({ kind: 'scandal', title: `${e.name(me)} denies the allegations`, body: '“There is nothing to this story.”', tone: 'neutral' });
      return 'You denied it. Now we see whether it holds.';
    }
    case 'attack': {
      P.partyStanding = clamp(P.partyStanding + 4, 0, 100);
      me.fav = clamp(me.fav - 0.01);
      swingVoters(e, -0.03);
      note(e, s, 'You went after the press. The base loved it; swing voters did not.', 'neutral');
      e.news({ kind: 'scandal', title: `${e.name(me)} blasts “fake” coverage`, body: 'Party loyalists rally; independents wince.', tone: 'neutral' });
      return 'You attacked the press. Your party rallied; swing voters soured.';
    }
    case 'lawyer': {
      const cost = lawyerCost(e);
      const fromCash = Math.min(P.cash, cost);
      P.cash -= fromCash;
      P.personal = Math.max(0, P.personal - (cost - fromCash));
      me.scandal = round3(me.scandal * 0.75);
      note(e, s, `You hired lawyers ($${cost.toLocaleString()}) and stopped commenting.`, 'neutral');
      return `You lawyered up ($${cost.toLocaleString()}). Coverage quiets down, but the story lingers.`;
    }
    case 'silent':
      note(e, s, 'No comment. The story runs its course.', 'neutral');
      return 'No comment.';
  }
}

/** College-educated, young and Asian voters (the least partisan blocs in the model) sour; working-class whites shrug. */
function swingVoters(e: Engine, d: number) {
  const P = e.s.player;
  const w: Record<string, number> = { wcol: 1, asian: 0.7, young: 0.7, hisp: 0.4, wnon: -0.3 };
  BLOCS.forEach((b, i) => (P.blocApproval[i] = clamp(P.blocApproval[i] + d * (w[b.key] ?? 0))));
  if (!e.player.officeId) e.player.fav = clamp(e.player.fav + d * 0.3);
}

/** A response decision expired unanswered. */
export function scandalLapsed(e: Engine, d: Decision) {
  const s = e.s.scandals.find((x) => x.id === d.meta?.scandal);
  if (!s || s.ended) return;
  if (s.stage === 'charges') {
    fightCharges(e, s);
    e.news({ kind: 'scandal', title: `${e.name(e.player)} stays silent and fights the charges`, tone: 'bad' });
  } else if (!s.response) applyResponse(e, s, 'silent');
}

function stepDown(e: Engine, s: Scandal): ActionResult {
  const me = e.player;
  const P = e.s.player;
  const officeId = me.officeId;
  dropRace(e);
  if (officeId) {
    const def = e.def(officeId)!;
    leaveInDisgrace(e, officeId, 'resigned amid a criminal case', 'resigned');
    me.scandal = round3(Math.max(me.scandal * 0.7, 0.25));
    P.partyStanding = clamp(P.partyStanding - 5, 0, 100);
    end(e, s, 'resigned', `You resigned as ${def.title}.`, 'bad');
    e.news({ kind: 'player', title: `${e.name(me)} resigns as ${def.title}`, body: 'The party is relieved. The case is closed with a plea deal.', tone: 'bad' });
    return { ok: true, msg: `You resigned as ${def.title}. The case is closed.` };
  }
  me.scandal = round3(Math.max(me.scandal, 0.5));
  me.fav = clamp(me.fav - 0.06);
  P.partyStanding = clamp(P.partyStanding - 8, 0, 100);
  end(e, s, 'pleaded', 'You took a plea deal and stepped back from politics for now.', 'bad');
  e.news({ kind: 'player', title: `${e.name(me)} takes a plea deal`, tone: 'bad' });
  return { ok: true, msg: 'You took a plea deal. The case is closed, but it will follow you.' };
}

function fightCharges(e: Engine, s: Scandal): ActionResult {
  const P = e.s.player;
  s.trial = addMonths(ym(e), TRIAL_MONTHS);
  P.partyStanding = clamp(P.partyStanding - 6, 0, 100);
  note(e, s, `You are fighting the charges. Trial verdict expected ${s.trial.month}/${s.trial.year}.`, 'neutral');
  return { ok: true, msg: 'You will fight the charges. The party is not happy.' };
}

/** Leaving office over a scandal (resignation or conviction): the seat empties and is filled by its own rules. */
function leaveInDisgrace(e: Engine, officeId: string, reason: string, result: 'resigned' | 'removed') {
  const me = e.player;
  vacate(e, officeId, reason);
  const last = me.career[me.career.length - 1];
  if (last?.officeId === officeId && last.result === 'left-office') last.result = result;
  e.playerLeftOffice();
}

/** A scandal ends the player's campaign (resignation, plea or conviction). */
function dropRace(e: Engine) {
  const c = e.s.campaign;
  if (!c || c.stage === 'done') return;
  const def = e.def(c.officeId)!;
  e.player.career.push({ year: e.s.year, officeId: c.officeId, title: def.title, result: 'withdrew' });
  e.s.campaign = null;
}

/** Monthly chance that a new scandal about the player breaks (main RNG stream, as before M15). */
export function rollPlayerScandal(e: Engine) {
  const P = e.s.player;
  const me = e.player;
  const risk = 0.006 + (P.metrics.scandalRisk ?? 0) * 0.08 - me.skills.integrity / 20000;
  if (!e.rng.chance(Math.max(0.001, risk))) return;
  P.metrics.scandalRisk = Math.max(0, (P.metrics.scandalRisk ?? 0) - 0.1);
  openPlayerScandal(e);
}

/** Monthly upkeep of the player's open stories: denials tested, escalation, investigations, trials. */
export function playerScandalMonth(e: Engine) {
  const P = e.s.player;
  const me = e.player;
  for (const s of playerScandals(e).filter(active)) {
    const rng = streamFor(e, s, 'month');
    const sev = s.severity;
    const mult = ESCALATION_MULT[s.response ?? 'silent'];
    const months = monthsSince(e, s.stageSince);
    if (months <= 0) continue; // broke this month: the player answers first
    if (s.stage === 'story') {
      // a denial is tested against the facts
      if (s.response === 'deny' && !s.exposed) {
        if (s.truth && rng.chance(months === 1 ? 0.45 + 0.3 * sev : 0.2)) {
          s.exposed = true;
          s.response = 'silent';
          s.severity = round3(Math.min(1, sev + 0.2));
          me.scandal = clamp(me.scandal + 0.15 + 0.2 * sev);
          me.fav = clamp(me.fav - 0.04 - 0.04 * sev);
          P.partyStanding = clamp(P.partyStanding - 3, 0, 100);
          note(e, s, 'New documents contradict your denial. The cover-up is now the story.');
          e.news({ kind: 'scandal', title: `Documents contradict ${e.name(me)}’s denial`, body: 'The story is bigger than before.', tone: 'bad' });
          continue;
        }
        if (!s.truth && months >= 2) {
          me.scandal = round3(me.scandal * 0.5);
          me.fav = clamp(me.fav + 0.02);
          end(e, s, 'vindicated', 'The story fell apart. You were right to deny it.', 'good');
          e.news({ kind: 'scandal', title: `Story about ${e.name(me)} falls apart`, body: 'The outlet issues a correction.', tone: 'good' });
          continue;
        }
      }
      if (s.truth && s.severity >= SEVERE && rng.chance(ESCALATE.story * mult)) {
        s.stage = 'investigation';
        s.stageSince = ym(e);
        me.scandal = Math.max(me.scandal, round3(0.2 + 0.2 * s.severity));
        note(e, s, 'Investigators open a formal inquiry.');
        e.news({ kind: 'scandal', title: `${e.name(me)} under investigation`, body: 'Prosecutors confirm an inquiry into the allegations.', tone: 'bad' });
        continue;
      }
      if (months >= FADE + (s.response === 'lawyer' ? 2 : 0)) end(e, s, s.response === 'apologize' ? 'apologized' : 'faded', 'The story faded from the news.', 'neutral');
    } else if (s.stage === 'investigation') {
      const k = s.response === 'lawyer' ? 0.5 : 1;
      me.fav = clamp(me.fav - 0.01 * s.severity * k);
      P.blocApproval = P.blocApproval.map((x) => clamp(x - 0.005 * s.severity * k));
      P.partyStanding = clamp(P.partyStanding - 1, 0, 100);
      me.scandal = Math.max(me.scandal, round3(0.15 + 0.2 * s.severity));
      if (months >= 2 && rng.chance(ESCALATE.investigation * mult)) {
        charge(e, s);
        continue;
      }
      if (months >= INVESTIGATION_MONTHS) {
        me.fav = clamp(me.fav + 0.02);
        me.scandal = round3(me.scandal * 0.6);
        end(e, s, 'cleared', 'Investigators closed the case without charges.', 'good');
        e.news({ kind: 'scandal', title: `Investigation of ${e.name(me)} closes without charges`, tone: 'good' });
      }
    } else if (s.stage === 'charges' && s.trial) {
      // fighting: the party keeps up the pressure while the case drags on
      if (me.officeId) P.partyStanding = clamp(P.partyStanding - 2, 0, 100);
      me.fav = clamp(me.fav - 0.01);
      me.scandal = Math.max(me.scandal, round3(0.35 + 0.2 * s.severity));
      if (monthsSince(e, s.trial) >= 0) verdict(e, s, rng);
    }
  }
}

/** Investigators file charges: the party presses the player to resign (a decision). */
export function charge(e: Engine, s: Scandal) {
  const me = e.player;
  const P = e.s.player;
  s.stage = 'charges';
  s.stageSince = ym(e);
  me.scandal = Math.max(me.scandal, round3(0.35 + 0.2 * s.severity));
  me.fav = clamp(me.fav - 0.05);
  P.partyStanding = clamp(P.partyStanding - 5, 0, 100);
  note(e, s, 'You are charged. Party leaders call on you to step aside.');
  e.news({ kind: 'scandal', title: `${e.name(me)} charged`, body: me.officeId ? 'Party leaders call for a resignation.' : 'Party leaders keep their distance.', tone: 'bad' });
  e.s.decisions.push(chargesDecision(e, s));
}

function verdict(e: Engine, s: Scandal, rng: Rng) {
  const me = e.player;
  const P = e.s.player;
  const lawyer = s.response === 'lawyer';
  const convict = clamp(0.5 + 0.3 * s.severity - (lawyer ? 0.15 : 0), 0.2, 0.85);
  if (rng.chance(convict)) {
    dropRace(e);
    const officeId = me.officeId;
    if (officeId) leaveInDisgrace(e, officeId, 'was removed after a criminal conviction', 'removed');
    me.scandal = round3(Math.max(me.scandal, 0.6));
    me.fav = clamp(me.fav - 0.1);
    P.partyStanding = clamp(P.partyStanding - 15, 0, 100);
    end(e, s, 'convicted', officeId ? 'Convicted. You were removed from office.' : 'Convicted.', 'bad');
    e.news({ kind: 'scandal', title: `${e.name(me)} convicted`, body: officeId ? 'The conviction ends their time in office.' : undefined, tone: 'bad' });
  } else {
    me.scandal = round3(me.scandal * 0.4);
    me.fav = clamp(me.fav + 0.03);
    P.partyStanding = clamp(P.partyStanding + 3, 0, 100);
    end(e, s, 'acquitted', 'Acquitted on all counts.', 'good');
    e.news({ kind: 'scandal', title: `${e.name(me)} acquitted`, body: 'A jury clears them on all counts.', tone: 'good' });
  }
}

/** Floor on the player's scandal score while a story is under investigation or in court (upkeep decays it otherwise). */
export function scandalFloor(e: Engine): number {
  let f = 0;
  for (const s of playerScandals(e).filter(active)) {
    if (s.stage === 'investigation') f = Math.max(f, 0.15 + 0.2 * s.severity);
    if (s.stage === 'charges') f = Math.max(f, 0.35 + 0.2 * s.severity);
  }
  return round3(f);
}

// ------------------------------------------------------------------ opponents

/** Scandal score an opposition-research story adds before the opponent's response (pre-M15 it was a flat 0.15–0.4). */
export const OPPO_HIT = (severity: number) => 0.12 + 0.36 * severity;

/** Damage multiplier by an opponent's response to an opposition-research story. */
export const AI_DAMAGE: Record<ScandalResponse, { scandal: number; fav: number }> = {
  apologize: { scandal: 0.65, fav: 0.04 },
  deny: { scandal: 0.45, fav: 0.01 },
  attack: { scandal: 0.9, fav: 0.03 },
  lawyer: { scandal: 0.75, fav: 0.02 },
  silent: { scandal: 1, fav: 0.04 },
};

/** How an AI politician answers a story: honest ones apologize, the least honest deny or attack, the rest lawyer up. */
export function aiResponse(p: Politician, rng: Rng): ScandalResponse {
  const i = p.skills.integrity;
  if (i >= 65) return 'apologize';
  if (i < 40) return rng.chance(0.5) ? 'deny' : 'attack';
  return 'lawyer';
}

/** Opposition research found something: open a story on the opponent and apply the damage their response allows. */
export function openOppoScandal(e: Engine, opp: Politician, force: { severity?: number; truth?: boolean; response?: ScandalResponse } = {}): Scandal {
  const id = e.newId('x');
  const rng = new Rng(`${e.s.seed}|scandal|${id}|open`);
  const severity = round3(force.severity ?? rng.range(0.2, 0.85));
  // oppo digs through records, so most of what it finds is true
  const truth = force.truth ?? rng.chance(0.8);
  const r = force.response ?? aiResponse(opp, rng);
  const s: Scandal = { id, who: opp.id, title: rng.pick(OPPO_STORIES), stage: 'story', severity, truth, since: ym(e), stageSince: ym(e), response: r, log: [] };
  e.s.scandals.push(s);
  const dmg = AI_DAMAGE[r];
  opp.scandal = clamp(opp.scandal + OPPO_HIT(severity) * dmg.scandal);
  opp.fav = clamp(opp.fav - dmg.fav);
  const c = e.s.campaign;
  if (r === 'attack' && c) c.bias[opp.id] = (c.bias[opp.id] ?? 0) + 0.02; // their base rallies
  if (r === 'lawyer' && c?.budget[opp.id]) c.budget[opp.id] = Math.round(c.budget[opp.id] * 0.95);
  const how = { apologize: 'apologizes', deny: 'denies everything', attack: 'attacks the press', lawyer: 'hires lawyers and goes quiet', silent: 'declines to comment' }[r];
  note(e, s, `Records reveal ${e.name(opp)} ${s.title}. ${e.name(opp)} ${how}.`, 'good');
  e.news({ kind: 'scandal', title: `Records reveal ${e.name(opp)} ${s.title}`, body: `${e.name(opp)} ${how}.`, tone: 'good' });
  return s;
}

/** Monthly upkeep of opponents' stories: a false-hearted denial may fall apart; stories fade after a few months. */
export function aiScandalMonth(e: Engine) {
  const meId = e.s.player.id;
  for (const s of e.s.scandals.filter((x) => active(x) && x.who !== meId)) {
    const p = e.pol(s.who);
    const months = monthsSince(e, s.stageSince);
    if (!p) {
      s.ended = { ...ym(e), how: 'faded' };
      continue;
    }
    if (months <= 0) continue;
    if (s.response === 'deny' && s.truth && !s.exposed && streamFor(e, s, 'ai').chance(0.6)) {
      s.exposed = true;
      p.scandal = clamp(p.scandal + 0.1 + 0.25 * s.severity);
      p.fav = clamp(p.fav - 0.04);
      note(e, s, `New records contradict ${e.name(p)}’s denial.`, 'good');
      e.news({ kind: 'scandal', title: `Documents contradict ${e.name(p)}’s denial`, tone: 'good' });
      continue;
    }
    if (months >= FADE) end(e, s, s.response === 'deny' && !s.truth ? 'vindicated' : 'faded', 'The story faded.', 'neutral');
  }
}

/** Keep the list short: drop finished stories after two years, and opponents' after one. */
export function pruneScandals(e: Engine) {
  const meId = e.s.player.id;
  e.s.scandals = e.s.scandals.filter((s) => !s.ended || monthsSince(e, s.ended) < (s.who === meId ? 24 : 12));
}

/** Everything for the month (called from playerUpkeep): old stories move on, then a new one may break. */
export function scandalMonth(e: Engine) {
  playerScandalMonth(e);
  aiScandalMonth(e);
  pruneScandals(e);
  rollPlayerScandal(e);
}

// ------------------------------------------------------------------ views

/** Scandal watch card: the player's stories (open, and ended in the last year) and open stories about opponents in the race. Truth stays hidden. */
export function scandalView(e: Engine) {
  const meId = e.s.player.id;
  const c = e.s.campaign && e.s.campaign.stage !== 'done' ? e.s.campaign : null;
  const inRace = new Set(c ? [...c.primaryField, ...c.generalField, ...c.otherField] : []);
  return e.s.scandals
    .filter((s) => (s.who === meId ? !s.ended || monthsSince(e, s.ended) < 12 : !s.ended && inRace.has(s.who)))
    .map((s) => {
      const p = e.pol(s.who);
      return {
        id: s.id, who: s.who, name: e.name(p), isPlayer: s.who === meId, title: s.title, stage: s.stage, severity: severityLabel(s.severity),
        response: s.response ?? null, exposed: !!s.exposed, since: s.since, months: monthsSince(e, s.since), trial: s.trial ?? null,
        ended: s.ended ?? null, log: s.log.slice(-6), decision: e.s.decisions.find((d) => d.meta?.kind === 'scandal' && d.meta.scandal === s.id) ?? null,
      };
    })
    .sort((a, b) => Number(!!a.ended) - Number(!!b.ended) || Number(b.isPlayer) - Number(a.isPlayer));
}

/** Month summary lines: what the player's stories did this month. */
export function scandalWhy(e: Engine, year: number, month: number): string[] {
  const out: string[] = [];
  for (const s of playerScandals(e)) {
    const lines = s.log.filter((l) => l.year === year && l.month === month);
    if (!lines.length) continue;
    const stage = s.ended ? '' : s.stage === 'investigation' ? ' It is under investigation, which drains your favorability and party standing every month.' : s.stage === 'charges' ? ' You face charges; the party is pressing you.' : '';
    out.push(`Scandal (${s.title}): ${lines.map((l) => l.text).join(' ')}${stage}`);
  }
  return out;
}
