/**
 * The player's office: decisions, votes on AI bills and their fate, laws in force, and the executive budget.
 * Split out of game.ts (M12): functions take the Engine; Engine keeps one-line delegates for the public API.
 */
import { BLOCS, ISSUES, PARTY_BASE, blocIdeal, blocSalience, issueDistance } from './issues';
import { expectedSpend, type OfficeDef } from './offices';
import { answerMap } from './redistricting';
import { answerTicket, applyVpPick } from './primaries';
import type { Budget, Decision } from './model';
import { clamp } from './rng';
import { calibrate } from './vote';
import { METRIC_INFO, billIssue } from './governing';
import { FAVOR_CAP, aiChamberVote, chamberKey, chamberLabel, econWeight, execChambers, executiveOf, executiveSigns, members, otherChamber, playerChamber } from './legislature';
import { LEVERS, addShift, baselineBudget, budgetGroups, budgetPositions, budgetTargets, econOffsets, fiscalShift, lawEcon, legislateBudget, policyOffsets, type LeverKey } from './budget';
import { applyAppointment } from './vacancies';
import { round2 } from './util';
import type { Engine, ActionResult } from './game';

export function decide(e: Engine, decisionId: string, optionIdx: number): ActionResult {
  const d = e.s.decisions.find((x) => x.id === decisionId);
  if (!d) return { ok: false, msg: 'Decision not found.' };
  const opt = d.options[optionIdx];
  if (!opt) return { ok: false, msg: 'Unknown option.' };
  const P = e.s.player;
  const me = e.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  shiftPositions(e, opt.pos ?? {}, opt.bloc);
  for (const [g, v] of Object.entries(opt.groups ?? {})) P.groups[g] = clamp((P.groups[g] ?? 0) + v * 0.5, -100, 100);
  let outcome = '';
  const meta = d.meta;
  if (meta?.kind === 'vp' || meta?.kind === 'ticket') {
    if (opt.party) P.partyStanding = clamp(P.partyStanding + opt.party, 0, 100);
    shiftPositions(e, {}, opt.bloc);
    e.s.decisions = e.s.decisions.filter((x) => x.id !== decisionId);
    if (meta.kind === 'vp' && opt.pick) applyVpPick(e, d, opt.pick);
    if (meta.kind === 'ticket') answerTicket(e, optionIdx === 0);
    P.record.unshift({ year: e.s.year, month: e.s.month, title: d.title, choice: opt.label });
    return { ok: true, msg: `${opt.label}.` };
  }
  const bill = meta?.kind === 'override' ? { issue: meta.issue!, dir: meta.dir! } : billIssue(d.templateId);
  const partyDir = bill ? Math.sign(PARTY_BASE[me.party][ISSUES.findIndex((x) => x.key === bill.issue)]) : 0;
  if (meta?.kind === 'override' && def) {
    // legislator: vote to override an executive's veto of a bill the player supported
    const yes = optionIdx === 0;
    const key = chamberKey(def)!;
    const own = aiChamberVote(e, key, bill!.issue, bill!.dir, d.id, yes ? 'yes' : 'no', true);
    const o = otherChamber(key);
    const other = o ? aiChamberVote(e, o, bill!.issue, bill!.dir, d.id, null, true) : null;
    const passed = own.passes && (!other || other.passes);
    P.partyStanding = clamp(P.partyStanding + ((yes ? bill!.dir : -bill!.dir) === partyDir ? 1.5 : -2), 0, 100);
    const tally = `${own.yes}–${own.no}${other ? `, ${other.yes}–${other.no}` : ''}`;
    if (passed) {
      lawTakesEffect(e, key, bill!.issue, bill!.dir);
      outcome = ` — the override succeeded (${tally}).`;
    } else outcome = ` — the veto stands (${tally}).`;
    e.news({ kind: 'office', title: `Veto override on "${meta.title}" ${passed ? 'succeeds' : 'fails'}`, body: `${tally}; two-thirds needed. You voted ${yes ? 'to override' : 'to sustain'}.`, tone: 'neutral' });
  } else if (bill && def && !def.executive) {
    if (opt.kill) {
      P.partyStanding = clamp(P.partyStanding + (bill.dir === partyDir ? -4 : 2), 0, 100);
      const negGroups = d.options[1]?.groups ?? {};
      for (const [g, v] of Object.entries(negGroups)) P.groups[g] = clamp((P.groups[g] ?? 0) + v * 0.3, -100, 100);
      e.news({ kind: 'office', title: `${e.name(me)} kills "${d.title}" before a vote`, tone: 'neutral' });
      outcome = ' — the bill is dead.';
    } else {
      const yes = optionIdx === 0;
      const supp = chamberSupport(e, def, bill.issue, bill.dir, yes ? 'yes' : optionIdx === 1 ? 'no' : 'present', d.id);
      const passed = supp.yes > supp.no;
      const fate = passed ? billFate(e, def, d, bill, yes) : '';
      if (def.level >= 3) e.news({ kind: 'office', title: `${d.title}: ${passed ? 'passes' : 'fails'} ${supp.yes}–${supp.no}`, body: `You voted ${yes ? 'yes' : optionIdx === 1 ? 'no' : 'present'}.${fate}`, tone: 'neutral' });
      if (optionIdx < 2) P.partyStanding = clamp(P.partyStanding + ((yes ? bill.dir : -bill.dir) === partyDir ? 1.5 : -3), 0, 100);
      // voting with your party on a contested bill banks a little goodwill
      if (optionIdx < 2 && (yes ? bill.dir : -bill.dir) === partyDir && inChamber(e)) P.favors = Math.min(FAVOR_CAP, P.favors + 0.5);
      if (passed === yes && optionIdx < 2) P.metrics.effectiveness = (P.metrics.effectiveness ?? 50) + 1;
      outcome = ` — the bill ${passed ? 'passed' : 'failed'}.${fate}`;
    }
  } else if (bill && def?.executive) {
    P.partyStanding = clamp(P.partyStanding + ((optionIdx === 0 ? bill.dir : -bill.dir) === partyDir ? 2 : -3), 0, 100);
    const yesOpt = d.options[0];
    if (optionIdx === 0) {
      enactPolicy(e, d.id, d.title, yesOpt.metrics);
      lawTakesEffect(e, execChambers(def)[0] ?? '', bill.issue, bill.dir);
      outcome = ' — it is law.';
    } else {
      // the legislature may override the veto
      const votes = execChambers(def).map((k) => ({ k, v: aiChamberVote(e, k, bill.issue, bill.dir, d.id, null, true) }));
      const overridden = votes.length > 0 && votes.every((x) => x.v.passes);
      const tally = votes.map((x) => `${x.v.yes}–${x.v.no}`).join(', ');
      if (overridden) {
        enactPolicy(e, d.id, d.title, yesOpt.metrics);
        lawTakesEffect(e, votes[0].k, bill.issue, bill.dir);
        P.partyStanding = clamp(P.partyStanding - 2, 0, 100);
        P.metrics.effectiveness = (P.metrics.effectiveness ?? 50) - 4;
        e.news({ kind: 'office', title: `Legislature overrides your veto of "${d.title}"`, body: `Override votes: ${tally}.`, tone: 'bad' });
        outcome = ` — but the legislature overrode you (${tally}).`;
      } else {
        if (def.level >= 2) e.news({ kind: 'office', title: `Your veto of "${d.title}" stands`, body: votes.length ? `The override attempt fell short (${tally}).` : undefined, tone: 'neutral' });
        outcome = ' — the veto stands.';
      }
    }
  }
  if (!bill && (def?.executive || def?.official)) for (const [m, v] of Object.entries(opt.metrics ?? {})) P.metrics[m] = (P.metrics[m] ?? METRIC_INFO[m]?.base ?? 50) + v * (m === 'budget' ? 1 : 4);
  else if (!def?.executive && opt.metrics?.effectiveness) P.metrics.effectiveness = (P.metrics.effectiveness ?? 50) + opt.metrics.effectiveness * 4;
  if (opt.party) P.partyStanding = clamp(P.partyStanding + opt.party, 0, 100);
  if (opt.cash) {
    const amt = Math.round(opt.cash * (def ? expectedSpend(def.type, def.pop) : 10000));
    P.cash += amt;
  }
  if (opt.scandalRisk) P.metrics.scandalRisk = (P.metrics.scandalRisk ?? 0) + opt.scandalRisk;
  if (opt.rec && def) e.bumpRec(e.jurKey(def), opt.rec);
  P.record.unshift({ year: e.s.year, month: e.s.month, title: d.title, choice: opt.label });
  if (P.record.length > 120) P.record.length = 120;
  e.s.decisions = e.s.decisions.filter((x) => x.id !== decisionId);
  if (meta?.kind === 'appoint' && opt.pick) applyAppointment(e, d, opt.pick);
  if (meta?.kind === 'map') answerMap(e, d, optionIdx);
  return { ok: true, msg: `${opt.label}${outcome || '.'}` };
}

export function inChamber(e: Engine) {
  return !!playerChamber(e);
}

/** Move the player's positions and let each voter bloc react to the change. */
export function shiftPositions(e: Engine, pos: Partial<Record<string, number>>, bloc?: Partial<Record<string, number>>) {
  const P = e.s.player;
  const me = e.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  const unit = def ? e.jurUnit(def) : null;
  const delta = unit ? calibrate(unit) : 0;
  const shift = clamp(-delta * 0.22, -0.6, 0.6);
  const before = BLOCS.map((b) => issueDistance(me.pos, blocIdeal(b.key), blocSalience(b.key), shift));
  for (const [k, v] of Object.entries(pos)) {
    const i = ISSUES.findIndex((x) => x.key === k);
    if (i >= 0) me.pos[i] = round2(clamp(me.pos[i] + (v ?? 0), -1, 1));
  }
  BLOCS.forEach((b, i) => {
    const after = issueDistance(me.pos, blocIdeal(b.key), blocSalience(b.key), shift);
    P.blocApproval[i] = clamp(P.blocApproval[i] + (before[i] - after) * 6 + (bloc?.[b.key] ?? 0));
  });
}

/** A law the player signed (or that passed over their veto) keeps pushing the jurisdiction's metrics while they serve. */
export function enactPolicy(e: Engine, id: string, title: string, metrics?: Record<string, number>) {
  if (!metrics) return;
  const P = e.s.player;
  P.policies.unshift({ id, title, year: e.s.year, metrics });
  if (P.policies.length > 30) P.policies.length = 30;
}

/** Economic effect of a state or federal law on the national economy. */
export function lawTakesEffect(e: Engine, chamber: string, issue: string, dir: number) {
  if (!chamber) return;
  addShift(e.s.world, lawEcon(issue, dir, econWeight(e, chamber)));
}

/**
 * After the player's chamber passes an AI bill: the other chamber votes and the executive signs or vetoes.
 * A veto of a bill the player voted for comes back as an override vote.
 */
export function billFate(e: Engine, def: OfficeDef, d: Decision, bill: { issue: string; dir: number }, playerYes: boolean): string {
  const key = chamberKey(def);
  if (!key) return '';
  const o = otherChamber(key);
  if (o) {
    const r = aiChamberVote(e, o, bill.issue, bill.dir, d.id, null);
    if (!r.passes) return ` It then died in the ${chamberLabel(e, o)} (${r.yes}–${r.no}).`;
  }
  const x = executiveSigns(e, executiveOf(key, e), bill.issue, bill.dir, d.id);
  if (x && !x.signs) {
    if (playerYes) {
      const due = e.s.month >= 11 ? { year: e.s.year + 1, month: e.s.month - 10 } : { year: e.s.year, month: e.s.month + 2 };
      e.s.decisions.push({
        id: e.newId('d'), templateId: `override:${d.templateId}`, title: `Override the veto: ${d.title}`,
        body: `${x.title} ${x.name} vetoed the bill you voted for. Overriding takes two-thirds${o ? ' of both chambers' : ''}.`,
        options: [
          { label: 'Vote to override', detail: d.options[0]?.detail ?? '', groups: Object.fromEntries(Object.entries(d.options[0]?.groups ?? {}).map(([k, v]) => [k, v * 0.5])) },
          { label: 'Vote to sustain the veto', detail: 'Back down and side with the executive.', bloc: { wcol: 0.003 } },
        ],
        deadline: due,
        meta: { kind: 'override', issue: bill.issue, dir: bill.dir, title: d.title },
      });
    }
    return ` ${x.title} ${x.name} vetoed it.`;
  }
  lawTakesEffect(e, key, bill.issue, bill.dir);
  return x ? ` ${x.title} ${x.name} signed it into law.` : ' It takes effect.';
}

/**
 * Count the player's chamber on an AI bill. Members vote by the same rule as every other vote (legislature.ts
 * `support()`); `tag` (the decision id) seeds their personal quirks. A 'present' vote leaves the player out of the count.
 */
export function chamberSupport(e: Engine, def: OfficeDef, issue: string, dir: number, vote: 'yes' | 'no' | 'present', tag: string) {
  const key = chamberKey(def);
  if (!key) return { yes: 0, no: 0 };
  const { yes, no } = aiChamberVote(e, key, issue, dir, tag, vote);
  return { yes, no };
}

/** Budget the player's executive office is under (null for legislators and private citizens). */
export function setBudget(e: Engine, levers: Partial<Record<LeverKey, number>>): ActionResult {
  const me = e.player;
  const P = e.s.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  if (!def?.executive) return { ok: false, msg: 'Only executives submit budgets.' };
  const cur = P.budget;
  if (cur && cur.year >= e.s.year && !cur.note?.startsWith('Continuing')) return { ok: false, msg: `The ${e.s.year} budget is already enacted. Next one in January.` };
  if (P.ap < 2) return { ok: false, msg: 'Preparing a budget takes 2 action points.' };
  const proposal: Budget = baselineBudget(e.s.year, e.s.month);
  for (const l of LEVERS) proposal[l.key] = Math.round(clamp(levers[l.key] ?? 1, l.min, l.max) * 20) / 20;
  const control = execChambers(def).map((k) => {
    const ms = members(e, k);
    return ms.length ? ms.filter((p) => p.party === me.party).length / ms.length : 1;
  });
  const { budget, note } = legislateBudget(proposal, control);
  P.budget = { ...budget, note };
  P.ap -= 2;
  const pos = budgetPositions(budget);
  shiftPositions(e, { spending: pos.spending, taxes: pos.taxes });
  for (const [g, v] of Object.entries(budgetGroups(budget))) if (Math.abs(v) >= 0.5) P.groups[g] = clamp((P.groups[g] ?? 0) + v * 0.5, -100, 100);
  const pctl = (x: number) => (Math.abs(x - 1) < 0.001 ? 'flat' : `${x > 1 ? '+' : ''}${Math.round((x - 1) * 100)}%`);
  const summary = LEVERS.map((l) => `${l.label} ${pctl(budget[l.key])}`).join(', ');
  P.record.unshift({ year: e.s.year, month: e.s.month, title: `${e.s.year} budget`, choice: summary });
  e.news({ kind: 'office', title: `${def.jurName} adopts the ${e.s.year} budget`, body: `${summary}.${note ? ` ${note}` : ''}`, tone: note ? 'neutral' : 'good' });
  return { ok: true, msg: `Budget enacted${note ? ' with changes' : ''}. Effects build up over the year.` };
}

/** End of March with no budget: spending continues at last year's levels. */
export function budgetDeadline(e: Engine) {
  const P = e.s.player;
  const def = e.player.officeId ? e.def(e.player.officeId) : null;
  if (!def?.executive || e.s.month !== 3) return;
  if (P.budget && P.budget.year >= e.s.year) return;
  const prev = P.budget ?? baselineBudget(e.s.year, 3);
  P.budget = { ...prev, year: e.s.year, month: 3, note: 'Continuing resolution: last year’s levels.' };
  e.s.player.metrics.effectiveness = (e.s.player.metrics.effectiveness ?? 50) - 3;
  e.news({ kind: 'office', title: `No ${e.s.year} budget: spending continues at last year's levels`, body: 'You can still submit a budget later this year.', tone: 'bad' });
}

/** The President's (or a governor's, weighted by state size) budget nudges the national economy. */
export function setFiscal(e: Engine) {
  const def = e.player.officeId ? e.def(e.player.officeId) : null;
  const w = e.s.world;
  if (def?.type === 'president') w.fiscal = fiscalShift(e.s.player.budget, 1);
  else if (def?.type === 'governor') {
    const us = Object.values(e.data.states).reduce((a, s) => a + s.pop, 0);
    w.fiscal = fiscalShift(e.s.player.budget, (e.data.states[def.st!]?.pop ?? 0) / us);
  } else delete w.fiscal;
}

/** Metric targets for the player's jurisdiction: budget, laws in force, and the national economy. */
export function metricTargets(e: Engine, def: OfficeDef | null): Record<string, number> {
  if (!def) return {};
  const P = e.s.player;
  const out: Record<string, number> = {};
  const add = (r: Record<string, number>, k = 1) => { for (const [m, v] of Object.entries(r)) out[m] = (out[m] ?? 0) + v * k; };
  if (def.executive) add(budgetTargets(P.budget));
  add(policyOffsets(P.policies), def.executive ? 1 : 0.5);
  add(econOffsets(e.s.world), def.executive ? 1 : 0.5);
  return out;
}
