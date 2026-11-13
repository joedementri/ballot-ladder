/**
 * Monthly player upkeep: money, time, recognition, scandals, approval and metric drift; the history series.
 * Split out of game.ts (M12): functions take the Engine; Engine keeps one-line delegates for the public API.
 */
import { BLOCS, PARTY_BASE, blocIdeal, blocSalience, blocShares, issueDistance } from './issues';
import { SALARY, type OfficeDef } from './offices';
import { clamp, expit, logit } from './rng';
import { calibrate } from './vote';
import { STAFF_ROLES, apMaxFor, staffCost } from './campaign';
import { METRIC_INFO } from './governing';
import { FAVOR_CAP, chamberKey, monthlyFavors } from './legislature';
import { round2, round3, INC_REC } from './util';
import type { Engine } from './game';
import { metricTargets } from './office';

const BLOC_D = BLOCS.map((b) => logit(b.dShare));

export function playerUpkeep(e: Engine): { payroll: number; staffLeft: boolean } {
  const P = e.s.player;
  const me = e.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  const level = Math.max(def?.level ?? 1, e.s.campaign ? e.def(e.s.campaign.officeId)!.level : 1);
  // Money
  if (def) P.personal += Math.round(SALARY[def.type] / 12 * 0.35);
  P.personal += P.background === 'business' || P.background === 'doctor' || P.background === 'lawyer' ? (def?.level ?? 0) >= 5 ? 0 : 2500 : 600;
  const payroll = STAFF_ROLES.reduce((a, r) => a + staffCost(P.staff[r.key], level), 0);
  const cashBeforePayroll = P.cash;
  let staffLeft = false;
  P.cash -= payroll;
  if (P.cash < 0) {
    staffLeft = true;
    // Can't make payroll: staff quit from the top
    for (const r of [...STAFF_ROLES].reverse()) if (P.staff[r.key] > 0 && P.cash < 0) { P.staff[r.key]--; P.cash += staffCost(P.staff[r.key] + 1, level); }
    P.cash = Math.max(0, P.cash);
    e.news({ kind: 'player', title: 'Campaign can’t make payroll — staff leave', tone: 'bad' });
  }
  // Time and energy
  P.apMax = apMaxFor(P.staff, me.skills) - (def ? Math.ceil(def.level / 2) : 0);
  P.energy = clamp(P.energy + 25, 0, 100);
  P.ap = P.energy < 20 ? Math.ceil(P.apMax / 2) : P.apMax;
  P.emphasis = P.emphasis.map((x) => round3(x * 0.85));
  // Recognition decays slowly; officeholders get coverage in their jurisdiction
  for (const k of Object.keys(P.rec)) P.rec[k] = round3(Math.max(0.02, P.rec[k] * 0.995));
  if (def) {
    const r = P.role && P.role.chamber === chamberKey(def) ? P.role.role : null;
    const target = INC_REC[def.type] + (P.metrics.effectiveness ?? 50) / 1000 + (r === 'speaker' ? 0.15 : r === 'majority' || r === 'minority' ? 0.1 : r ? 0.04 : 0);
    const k = e.jurKey(def);
    if (e.recIn(k) < target) e.bumpRec(k, 0.025);
  }
  // Scandals
  me.scandal = round3(me.scandal * 0.88);
  const risk = 0.006 + (P.metrics.scandalRisk ?? 0) * 0.08 - me.skills.integrity / 20000;
  if (e.rng.chance(Math.max(0.001, risk))) {
    me.scandal = clamp(me.scandal + e.rng.range(0.2, 0.45));
    me.fav = clamp(me.fav - 0.05);
    P.metrics.scandalRisk = Math.max(0, (P.metrics.scandalRisk ?? 0) - 0.1);
    e.news({ kind: 'scandal', title: `Scandal: ${e.name(me)} ${e.rng.pick(['faces questions over a donor’s no-bid contract', 'caught in misleading statement about résumé', 'campaign accused of finance violations', 'under fire for leaked private remarks'])}`, tone: 'bad' });
  }
  // Approval and favorability
  if (def) updateApproval(e, def);
  else me.fav = clamp(me.fav + 0.03 * (0.5 + (me.skills.charisma - 50) / 400 - me.fav) - me.scandal * 0.02);
  // Metrics drift toward targets set by the budget, laws in force and the economy
  const targets = metricTargets(e, def);
  for (const [k, info] of Object.entries(METRIC_INFO)) if (P.metrics[k] != null) P.metrics[k] = round2(P.metrics[k] + 0.08 * (info.base + (targets[k] ?? 0) - P.metrics[k]) + e.rng.normal(0, k === 'budget' ? 0.15 : 0.6));
  if (P.metrics.effectiveness != null) P.metrics.effectiveness = clamp(P.metrics.effectiveness, 0, 100);
  // Favors accrue to legislators (more with a leadership post); leaders keep the party's ear
  if (def && chamberKey(def)) {
    P.favors = Math.min(FAVOR_CAP, P.favors + monthlyFavors(e));
    if (P.role) P.partyStanding = clamp(P.partyStanding + 0.5, 0, 100);
  }
  // Age events
  if (e.age(me) > 80 && e.rng.chance(0.004)) e.s.gameOver = `${e.name(me)} retired from public life for health reasons at age ${e.age(me)}.`;
  return { payroll: Math.round(cashBeforePayroll - P.cash), staffLeft };
}

export function updateApproval(e: Engine, def: OfficeDef) {
  const P = e.s.player;
  const me = e.player;
  const unit = e.jurUnit(def);
  const delta = calibrate(unit);
  const shift = clamp(-delta * 0.22, -0.6, 0.6);
  const perf = Object.entries(METRIC_INFO).reduce((a, [k, info]) => {
    const v = P.metrics[k];
    if (v == null || k === 'effectiveness') return a;
    const dev = k === 'budget' ? v * 2 : v - info.base;
    return a + (info.good === 'up' ? dev : -dev);
  }, 0) / 100;
  const eff = ((P.metrics.effectiveness ?? 50) - 50) / 250;
  const nat = def.level >= 5 ? (me.party === e.s.world.presParty ? 1 : -1) * (e.s.world.presApproval - 0.45) * 0.3 : 0;
  BLOCS.forEach((b, i) => {
    const pD = expit(BLOC_D[i] + delta);
    const partisan = def.partisan ? (me.party === 'D' ? pD : me.party === 'R' ? 1 - pD : 0.5) : 0.5 + (me.party === 'D' ? pD - 0.5 : 0.5 - pD) * 0.3;
    const fit = issueDistance(PARTY_BASE[me.party], blocIdeal(b.key), blocSalience(b.key), shift) - issueDistance(me.pos, blocIdeal(b.key), blocSalience(b.key), shift);
    const target = clamp(0.22 + 0.5 * partisan + fit * 1.5 + perf + eff + nat - me.scandal * 0.3, 0.05, 0.95);
    P.blocApproval[i] = round3(clamp(P.blocApproval[i] + 0.15 * (target - P.blocApproval[i])));
  });
  const w = blocShares(unit.demo);
  const approval = P.blocApproval.reduce((a, x, i) => a + x * w[i], 0) / w.reduce((a, b) => a + b, 0);
  me.fav = round3(clamp(me.fav + 0.25 * (approval - me.fav)));
  if (def.type === 'president') e.s.world.presApproval = clamp(0.5 * e.s.world.presApproval + 0.5 * approval);
}

export function approval(e: Engine): number {
  const me = e.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  if (!def) return me.fav;
  const w = blocShares(e.jurUnit(def).demo);
  return e.s.player.blocApproval.reduce((a, x, i) => a + x * w[i], 0) / w.reduce((a, b) => a + b, 0);
}

export function pushHistory(e: Engine) {
  const me = e.player;
  const c = e.s.campaign;
  const def = c ? e.def(c.officeId) : me.officeId ? e.def(me.officeId) : null;
  e.s.history.push({
    year: e.s.year, month: e.s.month, approval: round3(approval(e)), rec: round3(def ? e.recIn(e.jurKey(def)) : e.recIn(me.home)),
    cash: Math.round(e.s.player.cash), presApproval: round3(e.s.world.presApproval), generic: round2(e.s.world.genericBallot),
    unemployment: round2(e.s.world.unemployment), inflation: round2(e.s.world.inflation),
  });
  if (e.s.history.length > 600) e.s.history.shift();
}
