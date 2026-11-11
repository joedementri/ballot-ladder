/**
 * Vacancies, appointments and special elections.
 *
 * Officeholders occasionally leave mid-term (retirement, death, scandal, a new job). How the seat is filled
 * depends on the office:
 *   President, Governor, Mayor  → succession (the sitting VP or Lt. Governor moves up; otherwise a successor
 *                                 is generated) — immediate; the successor's old seat then empties in turn
 *   Vice President              → the President nominates a replacement
 *   AG, SoS, Treasurer, Lt. Gov., Justices → the Governor appoints
 *   School board                → the board appoints
 *   U.S. House                  → special election about four months out (no appointment)
 *   U.S. Senate                 → the Governor appoints, then a special election the next even-year November
 *   State legislature, county   → the departed member's party picks a replacement (one month)
 *   Council                     → the council appoints (one month)
 * The player can seek an appointment in their area, make appointments as Governor (Senate) or as a member of
 * the council, and run in special elections.
 */
import type { Engine, ActionResult } from './game';
import type { Decision, DecisionOption, SpecialElection, Vacancy } from './model';
import type { OfficeDef } from './offices';
import type { Party } from '../data/types';
import { expectedSpend, isUp, officesForTown, primaryMonth } from './offices';
import { Rng, clamp } from './rng';
import { PARTY_BASE } from './issues';
import { quickDShare, type RaceCtx } from './vote';

const REASONS = ['resigned to take a private-sector job', 'resigned for health reasons', 'resigned to care for family', 'resigned to join the administration', 'resigned to lead a university'];
const SCANDAL_REASONS = ['resigned amid an ethics investigation', 'resigned after being indicted'];

type Fill = 'succession' | 'special' | 'appoint';
export function fillMethod(def: OfficeDef): Fill {
  if (def.type === 'president' || def.type === 'governor' || def.type === 'mayor') return 'succession';
  if (def.type === 'house') return 'special';
  return 'appoint';
}
const SUCCESSOR: Record<string, string> = { president: 'Vice President', governor: 'Lieutenant Governor', mayor: 'Council President' };
/** The office whose holder moves up when a chief executive leaves. */
const SUCCESSOR_OFFICE = (def: OfficeDef) => (def.type === 'president' ? 'vp' : def.type === 'governor' ? `ltgov:${def.st}` : null);

/** Who fills a vacancy by appointment: an office id (its holder decides), 'caucus', 'council' or 'school'. */
function appointer(def: OfficeDef): string {
  if (def.type === 'senate' || def.type === 'ag' || def.type === 'sos' || def.type === 'treas' || def.type === 'ltgov' || def.type === 'judge') return `gov:${def.st}`;
  if (def.type === 'vp') return 'pres';
  if (def.type === 'council') return 'council';
  if (def.type === 'school') return 'school';
  return 'caucus';
}
const byOffice = (v: Vacancy) => v.by.includes(':') || v.by === 'pres';
export function appointerLabel(e: Engine, v: Vacancy): string {
  if (byOffice(v)) return e.def(v.by)?.title.replace(/ of the United States$/, '') ?? 'The executive';
  if (v.by === 'council') return 'The council';
  if (v.by === 'school') return 'The school board';
  return `${v.party === 'D' ? 'Democratic' : v.party === 'R' ? 'Republican' : 'Local'} party leaders`;
}

/** Offices (and politicians) that must not be vacated: anything tied up in the player's race or a pending change. */
function guarded(e: Engine): Set<string> {
  const g = new Set<string>();
  const c = e.s.campaign;
  if (c && c.stage !== 'done') {
    g.add(c.officeId);
    for (const id of [...c.primaryField, ...c.generalField, ...c.otherField]) g.add(id);
  }
  for (const [o, p] of Object.entries(e.s.incoming)) { g.add(o); g.add(p); }
  for (const v of e.s.vacancies ?? []) g.add(v.officeId);
  for (const s of e.s.specials ?? []) g.add(s.officeId);
  return g;
}

/** Is this office newsworthy for the player (their state, or a statewide/federal post)? */
function relevant(e: Engine, def: OfficeDef) {
  const home = e.data.townSync(e.player.home);
  return def.level >= 6 || def.st === home?.st || def.jur.id === home?.id || def.jur.id === home?.county;
}

/** Monthly roll for officeholders leaving mid-term. Uses its own RNG so the main stream (and balance) is untouched. */
export function rollVacancies(e: Engine) {
  // the November election and January swearing-in handle seats that are about to turn over anyway
  if (e.s.month >= 11) return;
  const rng = new Rng(`${e.s.seed}|vac|${e.s.year}|${e.s.month}`);
  const g = guarded(e);
  // Poisson thinning: rather than rolling for each of ~8,000 seats, draw candidates at the maximum rate and
  // accept each with probability (its risk / max risk). Same distribution, a few hundred lookups a month.
  const ids = officeIds(e);
  const draws = poisson(rng, ids.length * MAX_RISK);
  const hit = new Set<string>();
  for (let i = 0; i < draws; i++) {
    const id = ids[Math.floor(rng.next() * ids.length)];
    const o = e.s.offices[id];
    if (!o.holder || hit.has(id) || g.has(id) || g.has(o.holder)) continue;
    const p = e.s.politicians[o.holder];
    if (!p || p.isPlayer) continue;
    const age = e.age(p);
    const risk = Math.min(MAX_RISK, 0.0006 + Math.max(0, age - 72) * 0.0004 + p.scandal * 0.02);
    if (!rng.chance(risk / MAX_RISK)) continue;
    hit.add(id);
    const reason = p.scandal > 0.2 && rng.chance(0.6) ? rng.pick(SCANDAL_REASONS) : age > 76 && rng.chance(0.5) ? 'died in office' : rng.pick(REASONS);
    vacate(e, id, reason);
  }
}

/** Office ids, cached per offices object and month (seats materialized since then just miss one month's roll). */
const idCache = new WeakMap<object, { at: number; ids: string[] }>();
function officeIds(e: Engine) {
  const at = e.s.year * 12 + e.s.month;
  let c = idCache.get(e.s.offices);
  if (!c || at - c.at >= 12) idCache.set(e.s.offices, (c = { at, ids: Object.keys(e.s.offices) }));
  return c.ids;
}

/** Highest monthly chance of leaving office (an old officeholder deep in scandal). */
const MAX_RISK = 0.025;

function poisson(rng: Rng, lambda: number) {
  // normal approximation is fine at these rates (lambda is ~200)
  if (lambda > 30) return Math.max(0, Math.round(rng.normal(lambda, Math.sqrt(lambda))));
  let k = 0, p = 1;
  const l = Math.exp(-lambda);
  do { k++; p *= rng.next(); } while (p > l);
  return k - 1;
}

/**
 * Empty a seat and start filling it. `keepHolder` is for holders moving to another office (they are not deleted).
 */
export function vacate(e: Engine, officeId: string, reason: string, opts: { keepHolder?: boolean } = {}) {
  const o = e.ensureOffice(officeId);
  const def = e.def(officeId);
  if (!o || !def) return;
  const p = e.pol(o.holder);
  const party: Party = p?.party ?? (e.jurUnit(def).lean >= 0.5 ? 'D' : 'R');
  const who = p ? `${def.title.replace(/,.*$/, '')} ${e.name(p)} (${p.party})` : def.title;
  if (p) {
    p.officeId = undefined;
    p.career.push({ year: e.s.year, officeId, title: def.title, result: 'left-office' });
    if (!p.isPlayer && !opts.keepHolder) delete e.s.politicians[p.id];
  }
  o.holder = null;
  o.since = e.s.year;
  const show = relevant(e, def);
  const fill = fillMethod(def);
  if (fill === 'succession') {
    // a sitting Vice President / Lieutenant Governor moves up (their own seat then empties)
    const nextId = SUCCESSOR_OFFICE(def);
    const heir = nextId && e.def(nextId) ? e.pol(e.ensureOffice(nextId)?.holder) : undefined;
    if (heir) {
      e.installOffice(officeId, heir.id, 'succeeded');
      // the heir's old seat emptied before they were sworn in; if they now make that appointment, it's their call
      const v = (e.s.vacancies ?? []).find((x) => x.officeId === nextId);
      const vdef = e.def(nextId!);
      if (v && vdef && !e.s.decisions.some((d) => d.meta?.officeId === nextId)) {
        const d = appointmentDecision(e, v, vdef);
        if (d) e.s.decisions.push(d);
      }
      if (heir.isPlayer) e.news({ kind: 'player', title: `${who} ${reason}. You are now ${def.title}!`, body: `As ${SUCCESSOR[def.type]}, you take the oath of office.`, tone: 'good' });
      else if (show || def.type === 'president') e.news({ kind: def.level >= 7 ? 'national' : 'office', title: `${who} ${reason}; ${SUCCESSOR[def.type]} ${e.name(heir)} takes over`, tone: 'neutral' });
      return;
    }
    const rng = new Rng(`${e.s.seed}|succ|${officeId}|${e.s.year}|${e.s.month}`);
    const unit = e.jurUnit(def);
    const s = e.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home: def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US', quality: def.level >= 6 ? 0.9 : 0.6, ageMin: def.minAge + 5 });
    e.installOffice(officeId, s.id, 'succeeded');
    if (show || def.type === 'president') e.news({ kind: def.level >= 7 ? 'national' : 'office', title: `${who} ${reason}; ${SUCCESSOR[def.type]} ${e.name(s)} takes over`, tone: 'neutral' });
    return;
  }
  const sp = scheduleSpecial(e, def, party, reason);
  if (fill === 'special') {
    if (show) e.news({ kind: 'office', title: `${who} ${reason}`, body: sp ? `A special election is set for ${monthNames[sp.month - 1]} ${sp.year}${sp.primaryMonth ? `, with primaries in ${monthNames[sp.primaryMonth - 1]}` : ''}.` : 'The seat stays vacant until the regular election.', tone: 'neutral' });
    return;
  }
  const v: Vacancy = { officeId, year: e.s.year, month: e.s.month, reason, party, by: appointer(def), due: nextMonth(e) };
  (e.s.vacancies ??= []).push(v);
  if (show) e.news({ kind: 'office', title: `${who} ${reason}`, body: `${appointerLabel(e, v)} will appoint a replacement next month${sp ? `; a special election follows in November ${sp.year}` : ''}.${canSeek(e, v).ok ? ' You could seek the appointment (Run tab).' : ''}`, tone: 'neutral' });
  const d = appointmentDecision(e, v, def);
  if (d) e.s.decisions.push(d);
}

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const nextMonth = (e: Engine) => ({ year: e.s.month === 12 ? e.s.year + 1 : e.s.year, month: e.s.month === 12 ? 1 : e.s.month + 1 });

function scheduleSpecial(e: Engine, def: OfficeDef, party: Party, reason: string): SpecialElection | null {
  const { year, month } = e.s;
  let sp: SpecialElection | null = null;
  if (def.type === 'house') {
    let m = month + 4, y = year;
    if (m > 12) { m -= 12; y++; }
    if (m <= 2) m = 3; // keep the special primary in the same calendar year
    // the regular November election comes first
    if (isUp(def.id, year, e.data) && (y > year || m >= 11)) return null;
    if (y > year && isUp(def.id, y, e.data) && m >= 9) return null;
    sp = { officeId: def.id, year: y, month: m, primaryMonth: m - 2, reason, party };
  } else if (def.type === 'senate') {
    const y = year % 2 === 0 && month <= 7 ? year : year % 2 === 0 ? year + 2 : year + 1;
    if (isUp(def.id, y, e.data)) return null;
    let pm = primaryMonth(def, y);
    if (y === year && pm <= month + 1) pm = Math.min(9, month + 2);
    sp = { officeId: def.id, year: y, month: 11, primaryMonth: pm, reason, party };
  }
  if (sp) (e.s.specials ??= []).push(sp);
  return sp;
}

// ------------------------------------------------------------------ appointments

/** Does the player make this appointment? */
function playerAppoints(e: Engine, v: Vacancy): boolean {
  const me = e.player;
  if (byOffice(v)) return me.officeId === v.by;
  if (v.by === 'school') return !!me.officeId?.startsWith(`school:${v.officeId.split(':')[1]}:`);
  if (v.by === 'council') {
    const town = v.officeId.split(':')[1];
    return !!me.officeId && (me.officeId.startsWith(`council:${town}:`) || me.officeId === `mayor:${town}`);
  }
  return false;
}

function appointmentDecision(e: Engine, v: Vacancy, def: OfficeDef): Decision | null {
  if (!playerAppoints(e, v)) return null;
  const me = e.player;
  const rng = new Rng(`${e.s.seed}|appt|${v.officeId}|${e.s.year}|${e.s.month}`);
  const unit = e.jurUnit(def);
  const home = def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US';
  const party: Party = def.partisan ? me.party : v.party;
  const loyal = e.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home, quality: 0.6, ageMin: def.minAge + 3 });
  loyal.pos = PARTY_BASE[party].map((x) => Math.round(clamp(x * 1.05 + rng.normal(0, 0.05), -1, 1) * 100) / 100);
  const moderate = e.genPolitician(rng, { party, lean: 0.5, demo: unit.demo, home, quality: 0.75, ageMin: def.minAge + 3 });
  moderate.pos = PARTY_BASE[party].map((x) => Math.round(clamp(x * 0.45 + rng.normal(0, 0.05), -1, 1) * 100) / 100);
  const caretaker = e.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home, quality: 0.5, ageMin: 66 });
  const options: DecisionOption[] = [
    { label: `Appoint ${e.name(loyal)}, a party loyalist`, detail: 'Party leaders are pleased. Votes the party line.', party: 6, pick: loyal.id, bloc: { wcol: -0.005 } },
    { label: `Appoint ${e.name(moderate)}, a consensus pick`, detail: 'Popular with swing voters; the base grumbles.', party: -2, pick: moderate.id, bloc: { wcol: 0.01, wnon: 0.01, senior: 0.01 } },
    { label: `Appoint ${e.name(caretaker)} as a caretaker`, detail: 'Pledges not to run, leaving the seat open. Seen as clean.', pick: caretaker.id, metrics: { effectiveness: 0.3 } },
  ];
  if (def.type === 'senate' && e.age(me) >= def.minAge) options.push({ label: 'Appoint yourself', detail: 'You resign as Governor and take the seat. Voters tend to punish self-appointments.', pick: 'self', party: -4, bloc: { wcol: -0.04, wnon: -0.04, black: -0.04, hisp: -0.04, asian: -0.04, young: -0.04, senior: -0.04 } });
  return {
    id: e.newId('d'),
    templateId: `appoint:${v.officeId}`,
    title: `Appoint a new ${def.title.replace(/ \(Class \d\)/, '')}`,
    body: `${v.reason[0].toUpperCase()}${v.reason.slice(1)} left the seat empty${def.type === 'senate' ? '; your appointee serves until the special election' : ''}. The choice is yours.`,
    options,
    deadline: v.due,
    meta: { kind: 'appoint', officeId: v.officeId, candidates: [loyal.id, moderate.id, caretaker.id] },
  };
}

/** Apply an appointment decision. */
export function applyAppointment(e: Engine, d: Decision, pick: string) {
  const officeId = d.meta!.officeId!;
  const def = e.def(officeId)!;
  for (const id of d.meta!.candidates ?? []) if (id !== pick && !e.s.politicians[id]?.officeId) delete e.s.politicians[id];
  e.s.vacancies = (e.s.vacancies ?? []).filter((v) => v.officeId !== officeId);
  if (pick === 'self') {
    appointPlayer(e, officeId);
    e.player.scandal = clamp(e.player.scandal + 0.1);
    e.player.fav = clamp(e.player.fav - 0.06);
    e.news({ kind: 'office', title: `Governor ${e.name(e.player)} appoints self to the U.S. Senate`, body: 'Critics call it a power grab.', tone: 'bad' });
    return;
  }
  const p = e.pol(pick);
  if (!p) return;
  p.rec = 0.3;
  e.installOffice(officeId, p.id, 'appointed');
  e.news({ kind: 'office', title: `${e.name(e.player)} appoints ${e.name(p)} as ${def.title}`, tone: 'neutral' });
}

/** Clean up candidates of an appointment decision that expired unanswered. */
export function dropAppointmentCandidates(e: Engine, d: Decision) {
  if (d.meta?.kind !== 'appoint' && d.meta?.kind !== 'vp') return;
  for (const id of d.meta.candidates ?? []) if (!e.s.politicians[id]?.officeId) delete e.s.politicians[id];
}

export function canSeek(e: Engine, v: Vacancy): { ok: boolean; reason?: string } {
  const me = e.player;
  const def = e.def(v.officeId);
  const home = e.data.townSync(me.home);
  if (!def || !home) return { ok: false, reason: 'Unknown seat' };
  if (playerAppoints(e, v)) return { ok: false, reason: 'You make this appointment' };
  if (!officesForTown(home, e.data).includes(v.officeId)) return { ok: false, reason: 'You do not live here' };
  if (e.age(me) < def.minAge) return { ok: false, reason: `Must be ${def.minAge}+` };
  if (def.type === 'judge' && e.s.player.background !== 'lawyer') return { ok: false, reason: 'Justices must be lawyers' };
  const party = byOffice(v) ? e.pol(e.s.offices[v.by]?.holder)?.party : v.party;
  if (def.partisan && party && party !== me.party) return { ok: false, reason: `${appointerLabel(e, v)} will pick a ${party === 'D' ? 'Democrat' : 'Republican'}` };
  const cur = me.officeId ? e.def(me.officeId)?.level ?? 0 : 0;
  if (me.officeId && def.level <= cur) return { ok: false, reason: 'Not a step up' };
  return { ok: true };
}

export function appointmentOdds(e: Engine, v: Vacancy): number {
  const def = e.def(v.officeId)!;
  const P = e.s.player;
  const me = e.player;
  const cur = me.officeId ? e.def(me.officeId)?.level ?? 0 : 0;
  const gap = Math.max(0, def.level - cur - 1);
  const rec = e.recIn(e.jurKey(def));
  return Math.round(clamp(0.1 + P.partyStanding / 200 + Math.min(0.15, (P.favors ?? 0) * 0.01) + rec * 0.5 + (cur ? 0.08 : 0) - 0.12 * gap, 0.03, 0.85) * 100) / 100;
}

export function seekAppointment(e: Engine, officeId: string): ActionResult {
  const v = (e.s.vacancies ?? []).find((x) => x.officeId === officeId);
  if (!v) return { ok: false, msg: 'That seat is not open for appointment.' };
  if (v.playerSeeks) return { ok: false, msg: 'You are already in the running.' };
  const ok = canSeek(e, v);
  if (!ok.ok) return { ok: false, msg: ok.reason ?? 'Not eligible.' };
  const P = e.s.player;
  if (P.ap < 2) return { ok: false, msg: 'Making your case takes 2 action points.' };
  P.ap -= 2;
  v.playerSeeks = true;
  return { ok: true, msg: `You made your case to ${appointerLabel(e, v).toLowerCase()}. Decision next month (odds about ${Math.round(appointmentOdds(e, v) * 100)}%).` };
}

/** The player takes an office by appointment, leaving whatever they held. */
export function appointPlayer(e: Engine, officeId: string) {
  e.installOffice(officeId, e.player.id, 'appointed');
}

/** End of month: fill seats whose appointment is due, and hold special elections. */
export function processVacancies(e: Engine) {
  const now = e.s.year * 12 + e.s.month;
  const due = (e.s.vacancies ?? []).filter((v) => v.due.year * 12 + v.due.month <= now);
  for (const v of due) {
    // a pending decision of the player's own handles it (or expires first)
    if (e.s.decisions.some((d) => d.meta?.kind === 'appoint' && d.meta.officeId === v.officeId)) continue;
    e.s.vacancies = (e.s.vacancies ?? []).filter((x) => x !== v);
    const def = e.def(v.officeId);
    const o = e.s.offices[v.officeId];
    if (!def || !o || o.holder) continue;
    const rng = new Rng(`${e.s.seed}|fill|${v.officeId}|${e.s.year}|${e.s.month}`);
    if (v.playerSeeks && canSeek(e, v).ok) {
      if (rng.chance(appointmentOdds(e, v))) {
        appointPlayer(e, v.officeId);
        e.news({ kind: 'player', title: `${e.name(e.player)} appointed ${def.title}`, body: `${appointerLabel(e, v)} chose you to fill the seat.`, tone: 'good' });
        continue;
      }
      e.news({ kind: 'player', title: `Passed over for ${def.title}`, body: `${appointerLabel(e, v)} went another way.`, tone: 'bad' });
      e.s.player.partyStanding = clamp(e.s.player.partyStanding - 1, 0, 100);
    }
    const party = byOffice(v) ? e.pol(e.s.offices[v.by]?.holder)?.party ?? v.party : v.party;
    const unit = e.jurUnit(def);
    const p = e.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home: def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US', quality: 0.55, ageMin: def.minAge + 2 });
    p.rec = clamp(0.1 + def.level * 0.04);
    e.installOffice(v.officeId, p.id, 'appointed');
    if (relevant(e, def)) e.news({ kind: 'office', title: `${e.name(p)} (${p.party}) appointed ${def.title}`, tone: 'neutral' });
  }
  // special elections this month (the player's own race is resolved by the campaign)
  const c = e.s.campaign;
  for (const sp of [...(e.s.specials ?? [])]) {
    const when = sp.year * 12 + sp.month;
    if (when > now) continue;
    e.s.specials = (e.s.specials ?? []).filter((x) => x !== sp);
    if (when < now) continue;
    if (c && c.special && c.officeId === sp.officeId && c.stage !== 'done') { e.s.specials.push(sp); continue; }
    backgroundSpecial(e, sp);
  }
}

function backgroundSpecial(e: Engine, sp: SpecialElection) {
  const def = e.def(sp.officeId);
  const o = e.ensureOffice(sp.officeId);
  if (!def || !o) return;
  const rng = new Rng(`${e.s.seed}|special|${sp.officeId}|${sp.year}|${sp.month}`);
  const unit = e.jurUnit(def);
  const holder = e.pol(o.holder);
  const home = def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US';
  const mk = (party: Party, q: number) => {
    const p = e.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home, quality: q, ageMin: def.minAge });
    p.rec = clamp(0.12 + q * 0.25, 0.05, 0.7);
    return p;
  };
  const a = holder && !holder.isPlayer ? holder : mk(sp.party, rng.range(0.4, 1));
  const b = mk(a.party === 'D' ? 'R' : 'D', rng.range(0.3, 0.9));
  const ctx: RaceCtx = { ...e.ctxFor(def, 'general'), noise: { [a.id]: rng.normal(0, 0.18), [b.id]: rng.normal(0, 0.18) } };
  const ca = e.candidate(a.id, def, null);
  const cb = e.candidate(b.id, def, null);
  ca.spend = expectedSpend(def.type, def.pop) * (a === holder ? 1.1 : 0.9);
  cb.spend = expectedSpend(def.type, def.pop) * rng.range(0.3, 0.9);
  const shareA = clamp(quickDShare(unit, ca, cb, ctx), 0, 1);
  const winner = shareA >= 0.5 ? a : b;
  const loser = winner === a ? b : a;
  const share = Math.round(Math.max(shareA, 1 - shareA) * 1000) / 1000;
  winner.career.push({ year: sp.year, officeId: def.id, title: def.title, result: 'won', share });
  o.lastShare = share;
  o.lastYear = sp.year;
  if (winner !== holder) e.installOffice(def.id, winner.id, 'elected');
  if (!loser.officeId && !loser.isPlayer) delete e.s.politicians[loser.id];
  if (relevant(e, def)) {
    const flip = winner.party !== sp.party;
    e.news({ kind: 'election', title: `Special election: ${e.name(winner)} (${winner.party}) wins ${def.title}${flip ? ` — a ${winner.party} flip` : ''}`, body: `${Math.round(share * 100)}% of the vote.`, tone: 'neutral' });
  }
}

/** Specials and appointments the player could pursue, for the Run tab. */
export function opportunities(e: Engine) {
  const out: { officeId: string; title: string; kind: 'appointment' | 'special'; reason: string; when: string; by?: string; ok: boolean; why?: string; odds?: number; sought?: boolean; filed?: boolean }[] = [];
  const home = e.data.townSync(e.player.home);
  if (!home) return out;
  const mine = new Set(officesForTown(home, e.data));
  for (const v of e.s.vacancies ?? []) {
    if (!mine.has(v.officeId)) continue;
    const def = e.def(v.officeId)!;
    const ok = canSeek(e, v);
    out.push({ officeId: v.officeId, title: def.title, kind: 'appointment', reason: v.reason, when: `${monthNames[v.due.month - 1]} ${v.due.year}`, by: appointerLabel(e, v), ok: ok.ok && !v.playerSeeks, why: ok.reason, odds: ok.ok ? appointmentOdds(e, v) : undefined, sought: v.playerSeeks });
  }
  const c = e.s.campaign;
  for (const sp of e.s.specials ?? []) {
    if (!mine.has(sp.officeId)) continue;
    const def = e.def(sp.officeId)!;
    const filed = !!c && c.officeId === sp.officeId && c.special && c.stage !== 'done';
    out.push({ officeId: sp.officeId, title: def.title, kind: 'special', reason: sp.reason, when: `${monthNames[sp.month - 1]} ${sp.year}${sp.primaryMonth ? ` (primary ${monthNames[sp.primaryMonth - 1]})` : ''}`, ok: false, filed });
  }
  return out;
}
