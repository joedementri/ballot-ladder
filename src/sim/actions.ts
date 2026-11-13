/**
 * Player campaign actions: costs, repeat fatigue and effects (Engine.act).
 * Split out of game.ts (M12): functions take the Engine; Engine keeps one-line delegates for the public API.
 */
import { ISSUES, PARTY_BASE } from './issues';
import { expectedSpend, shortTownName } from './offices';
import type { ActionLogEntry } from './model';
import { clamp } from './rng';
import { ACTIONS, GROUPS, STAFF_ROLES, apMaxFor, groupAlignment, staffCost } from './campaign';
import { round2, round3 } from './util';
import type { Engine, ActionResult } from './game';
import { FRESH, backingBlocked, backingOdds, recordBlocked, recordTargets, runAgainstRecord, seekBacking } from './incumbency';

/** How many logged actions this month match `pred` (diminishing returns for repeats). */
export function thisMonth(e: Engine, pred: (x: ActionLogEntry) => boolean) {
  return e.s.player.log.filter((x) => x.year === e.s.year && x.month === e.s.month && pred(x)).length;
}

/** Effectiveness multiplier for repeating an action this month (shown in the UI). */
export function fatigue(e: Engine, actionId: string, target?: string): number {
  if (actionId.startsWith('fund_')) return FATIGUE.fund ** thisMonth(e, (x) => x.id.startsWith('fund_'));
  if (['town_hall', 'canvass', 'rally', 'community'].includes(actionId)) return FATIGUE.event ** thisMonth(e, (x) => EVENT_IDS.has(x.id) && x.target === target);
  if (actionId === 'ads_tv' || actionId === 'ads_digital') return FATIGUE.ads ** thisMonth(e, (x) => x.id === 'ads_tv' || x.id === 'ads_digital');
  return 1;
}

/** Diminishing returns per repeat within a month: fundraising (any kind), events in the same place, ad flights. */
export const FATIGUE = { fund: 0.8, event: 0.5, ads: 0.75 };
/** People an event meaningfully reaches; recognition gain scales with sqrt(reach / place population). */
const EVENT_REACH = 8000;
export const EVENT_IDS = new Set(['town_hall', 'canvass', 'rally', 'community']);
function describePos(x: number) {
  return x < -0.6 ? 'strongly progressive' : x < -0.2 ? 'progressive' : x <= 0.2 ? 'moderate' : x <= 0.6 ? 'conservative' : 'strongly conservative';
}

/**
 * Requirements and odds for actions that have them (M14), for the action cards: why an action is locked,
 * a short note (odds), and the only valid targets.
 */
export function actionNotes(e: Engine): Record<string, { blocked?: string; note?: string; targets?: string[] }> {
  const c = e.s.campaign && e.s.campaign.stage !== 'done' ? e.s.campaign : null;
  const out: Record<string, { blocked?: string; note?: string; targets?: string[] }> = {};
  const rb = recordBlocked(e, c);
  out.record = rb ? { blocked: rb } : { targets: recordTargets(e, c).map((p) => p.id), note: c?.recordRuns ? `${Math.round(FRESH ** c.recordRuns * 100)}% as fresh` : undefined };
  const bb = backingBlocked(e, c);
  out.party_backing = bb ? { blocked: bb } : { note: `${Math.round(backingOdds(e, c!) * 100)}% odds` };
  return out;
}

export function actionCost(e: Engine, actionId: string): { ap: number; cash: number } {
  const a = ACTIONS.find((x) => x.id === actionId);
  if (!a) return { ap: 0, cash: 0 };
  const c = e.s.campaign;
  const def = c ? e.def(c.officeId) : e.player.officeId ? e.def(e.player.officeId) : null;
  const exp = def ? expectedSpend(def.type, def.pop) : 10000;
  return { ap: a.ap, cash: Math.round(a.flat ?? (a.cost ?? 0) * exp) };
}

export async function act(e: Engine, actionId: string, target?: string): Promise<ActionResult> {
  const a = ACTIONS.find((x) => x.id === actionId);
  if (!a) return { ok: false, msg: 'Unknown action' };
  const P = e.s.player;
  const me = e.player;
  const c = e.s.campaign && e.s.campaign.stage !== 'done' ? e.s.campaign : null;
  const def = c ? e.def(c.officeId)! : me.officeId ? e.def(me.officeId) : null;
  if (a.needsCampaign && !c) return { ok: false, msg: 'You need to be running for office.' };
  const { ap, cash } = actionCost(e, actionId);
  if (P.ap < ap) return { ok: false, msg: 'Not enough action points this month.' };
  if (P.cash < cash) return { ok: false, msg: `Costs $${cash.toLocaleString()} — not enough campaign cash.` };
  // M14 actions check their own requirements before anything is spent
  const blocked = actionId === 'record' ? recordBlocked(e, c) : actionId === 'party_backing' ? backingBlocked(e, c) : null;
  if (blocked) return { ok: false, msg: blocked };
  const rng = e.rng;
  const cash0 = P.cash;
  const fat = fatigue(e, actionId, target);
  const tired = (P.energy < 25 ? 0.6 : 1) * fat;
  const sk = me.skills;
  const exp = def ? expectedSpend(def.type, def.pop) : 15000;
  const level = def?.level ?? 1;
  let msg = '';
  const spend = (amt: number) => {
    P.cash -= amt;
    if (c) c.spend[me.id] = (c.spend[me.id] ?? 0) + amt;
  };
  switch (actionId) {
    case 'fund_small': {
      const base = exp * 0.03 * (0.5 + sk.fundraising / 100) * (1 + P.staff.finance * 0.3) * (0.4 + e.recIn(def ? e.jurKey(def) : me.home)) * tired;
      const amt = Math.round(base * rng.range(0.7, 1.3) + 100 * fat);
      P.cash += amt;
      if (c) c.raised += amt;
      msg = `Raised $${amt.toLocaleString()} from small donors.`;
      break;
    }
    case 'fund_big': {
      const amt = Math.round(exp * 0.065 * (0.4 + sk.fundraising / 90) * (1 + P.staff.finance * 0.35) * rng.range(0.6, 1.4) * tired + 250 * fat);
      P.cash += amt;
      if (c) c.raised += amt;
      P.groups.chamber = clamp((P.groups.chamber ?? 0) + 3, -100, 100);
      me.fav = clamp(me.fav - 0.004);
      if (rng.chance(0.04)) {
        me.scandal = clamp(me.scandal + 0.15);
        e.news({ kind: 'scandal', title: `Report: ${e.name(me)} donor tied to pay-to-play probe`, tone: 'bad' });
      }
      msg = `The dinner raised $${amt.toLocaleString()}.`;
      break;
    }
    case 'fund_pac': {
      const g = GROUPS.find((x) => x.key === target);
      if (!g) return { ok: false, msg: 'Pick a group.' };
      const align = groupAlignment(me.pos, g) + (P.groups[g.key] ?? 0) / 200;
      if (align < 0.05) {
        msg = `${g.label} declined — your positions don't line up.`;
        P.groups[g.key] = clamp((P.groups[g.key] ?? 0) - 2, -100, 100);
      } else {
        const amt = Math.round((exp * 0.1 * align * 2 * rng.range(0.6, 1.3) + 150) * tired);
        P.cash += amt;
        if (c) c.raised += amt;
        P.groups[g.key] = clamp((P.groups[g.key] ?? 0) + 5, -100, 100);
        msg = `${g.label} PAC contributed $${amt.toLocaleString()}.`;
      }
      break;
    }
    case 'self_fund': {
      const amt = Math.min(P.personal, Math.max(0, Math.round(Number(target) || 0)));
      if (amt <= 0) return { ok: false, msg: 'No personal funds to move.' };
      P.personal -= amt;
      P.cash += amt;
      msg = `Moved $${amt.toLocaleString()} into the campaign.`;
      break;
    }
    case 'town_hall':
    case 'canvass':
    case 'rally':
    case 'community': {
      if (!target) return { ok: false, msg: 'Pick a place.' };
      const mult = { town_hall: 0.08, canvass: 0.1, rally: 0.09, community: 0.05 }[actionId]!;
      const field = actionId === 'canvass' ? 1 + P.staff.field * 0.3 : 1;
      const smallRace = level <= 2 ? 1.6 : level <= 4 ? 1 : 0.5;
      // An event reaches a few thousand people: big in a village, a drop in the bucket in a big county.
      const tp = e.data.townSync(target)?.pop ?? e.data.counties[target]?.d[0] ?? e.data.states[target]?.pop ?? 20000;
      const reach = clamp(Math.sqrt(EVENT_REACH / Math.max(tp, 500)), 0.15, 1.3);
      e.bumpRec(target, mult * field * reach * tired * (0.6 + sk.charisma / 120));
      const favGain = actionId === 'community' ? 0.006 : actionId === 'town_hall' ? (sk.charisma - 45) / 6000 + (rng.chance(0.08) ? -0.01 : 0.003) : 0.002;
      me.fav = clamp(me.fav + (favGain > 0 ? favGain * fat : favGain));
      if (actionId === 'rally' && c) c.bias[me.id] = (c.bias[me.id] ?? 0) + 0.01 * fat;
      if (actionId === 'canvass' && c) c.bias[me.id] = (c.bias[me.id] ?? 0) + 0.006 * smallRace * fat;
      if (cash) spend(cash);
      const t = e.data.townSync(target);
      const placeName = t ? shortTownName(t.name) : e.data.counties[target]?.n ?? e.data.states[target]?.n ?? target;
      msg = `${a.label} in ${placeName} went ${favGain >= 0 ? 'well' : 'poorly — a heckler went viral'}.`;
      break;
    }
    case 'ads_tv':
    case 'ads_digital': {
      spend(cash);
      const k = e.jurKey(def!);
      const comms = (1 + P.staff.comms * 0.25) * fat;
      e.bumpRec(k, (actionId === 'ads_tv' ? 0.045 : 0.03) * comms);
      if (def!.jur.kind === 'state' || def!.jur.kind === 'nation') {
        // spread to sub-units so localized recognition rises too
        const subs = def!.jur.kind === 'state' ? Object.entries(e.data.counties).filter(([, x]) => x.st === def!.st).map(([f]) => f) : Object.keys(e.data.states);
        for (const sId of subs) e.s.player.rec[sId] = round3(clamp((e.s.player.rec[sId] ?? 0.02) + (actionId === 'ads_tv' ? 0.05 : 0.03) * comms * (1 - (e.s.player.rec[sId] ?? 0.02))));
      }
      me.fav = clamp(me.fav + 0.004 * comms);
      msg = `Ad flight launched ($${cash.toLocaleString()}).`;
      break;
    }
    case 'attack_ad': {
      const opp = e.pol(target);
      if (!opp || !c) return { ok: false, msg: 'Pick an opponent.' };
      spend(cash);
      opp.fav = clamp(opp.fav - 0.03 * (1 + P.staff.comms * 0.2));
      me.fav = clamp(me.fav - 0.008);
      msg = `Your ad hammered ${e.name(opp)}. Some voters found it nasty.`;
      break;
    }
    case 'interview': {
      const gaffe = rng.chance(0.14 - sk.debate / 1000 - P.staff.comms * 0.025);
      if (gaffe) {
        me.fav = clamp(me.fav - 0.02);
        e.news({ kind: 'player', title: `${e.name(me)} stumbles in interview`, body: 'Clip of an awkward answer circulates online.', tone: 'bad' });
        msg = 'Ouch — a gaffe. The clip is everywhere.';
      } else {
        e.bumpRec(def ? e.jurKey(def) : me.home, 0.03);
        me.fav = clamp(me.fav + 0.004);
        msg = 'Solid interview. Good exposure.';
      }
      break;
    }
    case 'speech': {
      const i = ISSUES.findIndex((x) => x.key === target);
      if (i < 0) return { ok: false, msg: 'Pick an issue.' };
      P.emphasis[i] = clamp(P.emphasis[i] + 0.35);
      e.bumpRec(def ? e.jurKey(def) : me.home, 0.015);
      msg = `You put ${ISSUES[i].label.toLowerCase()} at the center of your message.`;
      break;
    }
    case 'moderate':
    case 'harden': {
      const i = ISSUES.findIndex((x) => x.key === target);
      if (i < 0) return { ok: false, msg: 'Pick an issue.' };
      const base = PARTY_BASE[me.party][i];
      const dir = actionId === 'moderate' ? -Math.sign(me.pos[i] || base) : Math.sign(base || me.pos[i]);
      me.pos[i] = round2(clamp(me.pos[i] + dir * 0.15, -1, 1));
      P.partyStanding = clamp(P.partyStanding + (actionId === 'harden' ? 2 : -2), 0, 100);
      if (rng.chance(0.25)) {
        me.fav = clamp(me.fav - 0.01);
        e.news({ kind: 'player', title: `${e.name(me)} accused of flip-flopping on ${ISSUES[i].label.toLowerCase()}`, tone: 'bad' });
      }
      msg = `Your ${ISSUES[i].label.toLowerCase()} position is now ${describePos(me.pos[i])}.`;
      break;
    }
    case 'endorse': {
      const g = GROUPS.find((x) => x.key === target);
      if (!g) return { ok: false, msg: 'Pick a group.' };
      if (P.endorsements.includes(g.key)) return { ok: false, msg: 'Already endorsed you.' };
      const p = clamp(0.25 + groupAlignment(me.pos, g) * 1.2 + (P.groups[g.key] ?? 0) / 150 + (P.partyStanding - 50) / 300);
      if (rng.chance(p)) {
        P.endorsements.push(g.key);
        P.groups[g.key] = clamp((P.groups[g.key] ?? 0) + 10, -100, 100);
        e.news({ kind: 'player', title: `${g.label} endorses ${e.name(me)}`, tone: 'good' });
        msg = `${g.label} endorsed you!`;
      } else msg = `${g.label} is staying out of it for now (odds were ${Math.round(p * 100)}%).`;
      break;
    }
    case 'party_event': {
      P.partyStanding = clamp(P.partyStanding + 4 + sk.charisma / 40, 0, 100);
      msg = 'Party leaders appreciated you showing up.';
      break;
    }
    case 'hire': {
      const role = STAFF_ROLES.find((r) => r.key === target);
      if (!role) return { ok: false, msg: 'Pick a role.' };
      if (P.staff[role.key] >= 3) return { ok: false, msg: 'Already elite.' };
      const tier = P.staff[role.key] + 1;
      const monthly = staffCost(tier, level);
      if (P.cash < monthly) return { ok: false, msg: `Need $${monthly.toLocaleString()} for the first month's salary.` };
      P.staff[role.key] = tier;
      P.apMax = apMaxFor(P.staff, sk);
      msg = `Hired a ${['', 'volunteer', 'professional', 'elite'][tier]} ${role.label.toLowerCase()} ($${monthly.toLocaleString()}/mo).`;
      break;
    }
    case 'oppo': {
      const opp = e.pol(target);
      if (!opp || !c) return { ok: false, msg: 'Pick an opponent.' };
      spend(cash);
      if (rng.chance(0.25 + (100 - opp.skills.integrity) / 300)) {
        opp.scandal = clamp(opp.scandal + rng.range(0.15, 0.4));
        opp.fav = clamp(opp.fav - 0.04);
        if (!(c.oppoFound ??= []).includes(opp.id)) c.oppoFound.push(opp.id);
        e.news({ kind: 'scandal', title: `Records reveal ${e.name(opp)} ${rng.pick(['missed taxes on a rental property', 'steered contracts to a donor', 'padded a résumé', 'has a history of unpaid liens', 'used public funds for travel'])}`, tone: 'good' });
        msg = 'Your researchers found something — and it leaked.';
      } else msg = 'Nothing usable turned up.';
      break;
    }
    case 'record': {
      if (target && !recordTargets(e, c).some((p) => p.id === target)) return { ok: false, msg: 'Pick the incumbent your researchers have dirt on.' };
      spend(cash);
      msg = runAgainstRecord(e, c!, target).msg;
      break;
    }
    case 'party_backing': {
      msg = seekBacking(e, c!).msg;
      break;
    }
    case 'debate_prep': {
      if (c) c.debatePrep = clamp(c.debatePrep + 0.25);
      msg = 'Mock debates sharpened your answers.';
      break;
    }
    case 'rest': {
      P.energy = clamp(P.energy + 30, 0, 100);
      msg = 'You took time off. Energy restored.';
      break;
    }
  }
  P.ap -= ap;
  if (actionId !== 'rest') P.energy = clamp(P.energy - ap * 3, 0, 100);
  if (fat < 0.95) msg += ` (Repeat this month: ${Math.round(fat * 100)}% effect.)`;
  const log = P.log;
  log.unshift({ year: e.s.year, month: e.s.month, id: actionId, label: a.label, target, msg, cash: Math.round(P.cash - cash0) });
  if (log.length > 80) log.length = 80;
  return { ok: true, msg };
}
