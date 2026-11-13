/**
 * Everyone else: November background elections, joint tickets, the background presidential race, the 2027 prelude and national lawmaking.
 * Split out of game.ts (M12): functions take the Engine; Engine keeps one-line delegates for the public API.
 */
import type { Party } from '../data/types';
import { ISSUES } from './issues';
import { EV, LTGOV_TICKET, expectedSpend, isUp, type OfficeDef } from './offices';
import { draftCandidates, draftedRec, nationalContender, raceNews, type BgRace } from './careers';
import { runningMate } from './primaries';
import type { OfficeState, Politician, ResultSummary } from './model';
import { Rng, clamp } from './rng';
import { runElection, quickDShare, type RaceCtx } from './vote';
import { envLogit, stepWorld } from './world';
import { billTemplatesFor } from './governing';
import { addShift, lawEcon } from './budget';
import { round2, round3 } from './util';
import type { Engine } from './game';
import { raceUnits } from './races';
import { national } from './views';

/**
 * 2027 start: play out 2025–26 for everyone else (the economy, the 2025 off-year races and the 2026 midterms),
 * then swear in the winners. Real results override the simulation where the data has them: the 2025 governor
 * races here, and results/latest.json when the pipeline has newer results (pipeline/README.md).
 */
export async function preludeTo2027(e: Engine): Promise<string> {
  const rng = new Rng(`${e.s.seed}|prelude`);
  const latest = await e.data.json<{ cycles: number[]; house: Record<string, Party>; senate: Record<string, Party>; gov: Record<string, Party> }>('results/latest.json').catch(() => null);
  const real2026 = !!latest?.cycles.includes(2026);
  for (let y = 2025; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      e.s.year = y;
      e.s.month = m;
      if (m === 11) {
        await backgroundElections(e, y);
        if (y === 2025) for (const [st, party] of Object.entries(REAL_2025.gov)) forceWinner(e, `gov:${st}`, party, y);
        if (y === 2026 && real2026) {
          for (const [cd, party] of Object.entries(latest!.house)) forceWinner(e, `house:${cd}`, party, y);
          for (const [seat, party] of Object.entries(latest!.senate)) forceWinner(e, `sen:${seat}`, party, y);
          for (const [st, party] of Object.entries(latest!.gov)) forceWinner(e, `gov:${st}`, party, y);
        }
      }
      stepWorld(e.s.world, rng, y, m, y % 4 === 2);
    }
    e.s.year = y + 1;
    e.s.month = 1;
    const order = Object.entries(e.s.incoming).sort(([a], [b]) => (a === 'pres' ? -1 : b === 'pres' ? 1 : 0));
    for (const [officeId, pid] of order) if (e.pol(pid)) e.installOffice(officeId, pid, 'elected');
    e.s.incoming = {};
  }
  const n = national(e);
  const fmt = (r: Record<string, number>) => `${r.D ?? 0}D–${r.R ?? 0}R`;
  // keep the election coverage from the midterms, drop the rest of the two simulated years
  e.s.news = e.s.news.filter((x) => x.kind === 'election' && x.year === 2026);
  return `House ${fmt(n.house)}, Senate ${fmt(n.senate)}, governors ${fmt(n.governors)}. ${real2026 ? 'Seat control reflects the real 2026 results.' : 'The 2026 midterms were simulated: real results are not in the game data yet.'} The 2025 New Jersey and Virginia governor races use the real winners.`;
}

/** Make sure the winner of a race held this November is from `party` (real results), replacing a simulated winner. */
export function forceWinner(e: Engine, officeId: string, party: Party, year: number) {
  const def = e.def(officeId);
  const o = e.s.offices[officeId];
  if (!def || !o) return;
  const cur = e.pol(e.s.incoming[officeId] ?? o.holder);
  if (cur?.party === party) return;
  if (cur && e.s.incoming[officeId] === cur.id && !cur.officeId) {
    delete e.s.incoming[officeId];
    e.discard(cur.id);
  }
  const rng = new Rng(`${e.s.seed}|real|${officeId}|${year}`);
  const unit = e.jurUnit(def);
  const p = e.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home: def.st ?? 'US', quality: 0.8, ageMin: def.minAge + 2 });
  p.rec = 0.3;
  p.career.push({ year, officeId, title: def.title, result: 'won' });
  e.s.incoming[officeId] = p.id;
  if (def.type === 'governor' && LTGOV_TICKET.has(def.st!) && e.def(`ltgov:${def.st}`)) {
    const lg = e.s.incoming[`ltgov:${def.st}`];
    delete e.s.incoming[`ltgov:${def.st}`];
    if (lg) e.discard(lg);
    jointTicket(e, `ltgov:${def.st}`, year);
  }
}

/**
 * Resolve every other materialized race on the ballot this November. Open seats usually draw their nominees from
 * the bench of ambitious officeholders (careers.ts), who give up their own seat if it is on the same ballot.
 */
export async function backgroundElections(e: Engine, year: number) {
  // the player's race is resolved on its own, unless they lost the primary (the seat is still on the ballot)
  const pc = e.s.campaign;
  const myOffice = pc?.year === year && (pc.stage !== 'done' || pc.resultGeneral) ? pc.officeId : null;
  const tickets: string[] = [];
  const env = envLogit(e.s.world);
  const tally = { house: {} as Record<string, number>, senate: {} as Record<string, number>, gov: {} as Record<string, number> };
  const flips: string[] = [];
  let pres: ResultSummary | undefined;
  // 1. who runs again
  const races: (BgRace & { o: OfficeState; rng: Rng })[] = [];
  let presRace: { def: OfficeDef; holder?: Politician; rng: Rng } | null = null;
  for (const o of Object.values(e.s.offices)) {
    if (o.id === myOffice || !isUp(o.id, year, e.data)) continue;
    const def = e.def(o.id);
    if (!def) continue;
    // joint-ticket lieutenant governors go with their governor (below)
    if (def.type === 'ltgov' && LTGOV_TICKET.has(def.st!)) { tickets.push(o.id); continue; }
    const rng = new Rng(`${e.s.seed}|bg|${o.id}|${year}`);
    const holder = e.pol(o.holder);
    if (holder?.isPlayer) {
      // player didn't file for re-election: seat opens
      if (!e.s.campaign || e.s.campaign.officeId !== o.id) {
        e.news({ kind: 'player', title: `${e.name(holder)} did not seek re-election as ${def.title}`, tone: 'neutral' });
      } else continue;
    }
    if (def.type === 'president') { presRace = { def, holder, rng }; continue; }
    const runs = !!holder && !holder.isPlayer && e.willRunAgain(holder, def, rng);
    races.push({ id: o.id, o, def, holder, runs, rng, lean: e.jurUnit(def).lean });
  }
  if (presRace) pres = await backgroundPresident(e, presRace.def, year, presRace.holder, presRace.rng);
  // 2. ambitious officeholders file for open seats (and take free shots at vulnerable incumbents)
  const drafts = await draftCandidates(e, races, year);
  const drafted = new Set<string>();
  for (const d of drafts.values()) for (const p of [d.D, d.R, d.any]) if (p) drafted.add(p.id);
  // 3. the vote
  for (const { o, def, holder, runs, rng } of races) {
    const unit = e.jurUnit(def);
    const incParty: Party = holder?.party ?? (rng.chance(unit.lean) ? 'D' : 'R');
    const mk = (party: Party, q: number) => {
      const p = e.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home: def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US', quality: q, ageMin: def.minAge });
      p.rec = round2(clamp(0.1 + q * 0.25, 0.05, 0.7));
      return p;
    };
    const d = drafts.get(o.id);
    const a = runs ? holder! : d?.[incParty] ?? (d?.any && !def.partisan ? d.any : undefined) ?? mk(incParty, rng.range(0.4, 1));
    const otherParty: Party = incParty === 'D' ? 'R' : 'D';
    const bParty: Party = def.partisan ? otherParty : rng.chance(0.5) ? 'D' : 'R';
    const b = (def.partisan ? d?.[otherParty] : undefined) ?? mk(bParty, rng.range(0.2, 0.9));
    const ctx: RaceCtx = { ...e.ctxFor(def, def.partisan ? 'general' : 'nonpartisan'), env };
    const ca = e.candidate(a.id, def, null);
    const cb = e.candidate(b.id, def, null);
    ca.spend = expectedSpend(def.type, def.pop) * (runs ? 1.2 : drafted.has(a.id) ? 1 : 0.8);
    cb.spend = expectedSpend(def.type, def.pop) * (drafted.has(b.id) ? rng.range(0.6, 1) : rng.range(0.2, 0.9));
    if (drafted.has(a.id)) ca.rec = draftedRec(a);
    if (drafted.has(b.id)) cb.rec = draftedRec(b);
    const shareA = clamp(quickDShare(unit, ca, cb, { ...ctx, noise: { [a.id]: rng.normal(0, 0.15), [b.id]: rng.normal(0, 0.15) } }), 0, 1);
    // uncontested in lopsided seats (unless an officeholder filed)
    const uncontested = def.partisan && (unit.lean > 0.78 || unit.lean < 0.22) && !drafted.has(b.id) && rng.chance(0.35);
    const winner = uncontested || shareA >= 0.5 ? a : b;
    const loser = winner === a ? b : a;
    const share = round3(uncontested ? 1 : Math.max(shareA, 1 - shareA));
    if (!uncontested) loser.career.push({ year, officeId: o.id, title: def.title, result: 'lost' });
    winner.career.push({ year, officeId: o.id, title: def.title, result: 'won', share });
    o.lastShare = share;
    o.lastYear = year;
    if (winner !== holder) e.s.incoming[o.id] = winner.id;
    if (holder && winner === holder) holder.terms++;
    if (def.partisan && holder && winner.party !== holder.party && def.level >= 5) flips.push(`${def.title.replace(/^U\.S\. (Representative|Senator from) /, '')} flips ${winner.party}`);
    const key = def.type === 'house' ? 'house' : def.type === 'senate' ? 'senate' : def.type === 'governor' ? 'gov' : null;
    if (key) tally[key][winner.party] = (tally[key][winner.party] ?? 0) + 1;
    raceNews(e, def, winner, uncontested ? null : loser, share, year, drafted);
    // clean up losers that never held office to keep saves small (including the would-be challenger of an
    // uncontested seat, who used to linger in the save)
    if (loser !== holder && !loser.officeId && !loser.isPlayer) e.discard(loser.id);
  }
  for (const id of tickets) jointTicket(e, id, year);
  const sum = (r: Record<string, number>) => Object.entries(r).map(([p, n]) => `${p} ${n}`).join(', ');
  if (Object.keys(tally.house).length) e.news({ kind: 'election', title: `${year} results: House races ${sum(tally.house)}`, body: flips.slice(0, 12).join(' · ') || 'No major seats changed hands.' });
  if (Object.keys(tally.senate).length) e.news({ kind: 'election', title: `${year} Senate races: ${sum(tally.senate)}` });
  if (Object.keys(tally.gov).length) e.news({ kind: 'election', title: `${year} governor races: ${sum(tally.gov)}` });
  e.s.lastNational = { year, ...tally, pres };
}

/** A lieutenant governor elected on the governor's ticket: the governor's running mate takes the seat. */
export function jointTicket(e: Engine, id: string, year: number) {
  const def = e.def(id)!;
  const o = e.s.offices[id];
  const gov = e.pol(e.s.incoming[`gov:${def.st}`] ?? e.s.offices[`gov:${def.st}`]?.holder);
  const lg = e.pol(o.holder);
  if (!gov || gov.isPlayer && lg?.isPlayer) return;
  const rng = new Rng(`${e.s.seed}|lgt|${id}|${year}`);
  if (lg && !lg.isPlayer && lg.party === gov.party && e.willRunAgain(lg, def, rng)) {
    lg.terms++;
    o.lastYear = year;
    return;
  }
  const unit = e.jurUnit(def);
  const p = e.genPolitician(rng, { party: gov.party, lean: unit.lean, demo: unit.demo, home: def.st!, quality: 0.7, ageMin: def.minAge });
  p.rec = 0.25;
  p.career.push({ year, officeId: id, title: def.title, result: 'won' });
  o.lastYear = year;
  e.s.incoming[id] = p.id;
}

/** Real results after the game's data ends (2025 off-year governors), used by the 2027 start. */
const REAL_2025 = { gov: { NJ: 'D', VA: 'D' } as Record<string, Party> };

export async function backgroundPresident(e: Engine, def: OfficeDef, year: number, holder: Politician | undefined, rng: Rng): Promise<ResultSummary> {
  const runs = holder && e.willRunAgain(holder, def, rng);
  const incParty = e.s.world.presParty;
  const mk = (party: Party) => {
    const p = nationalContender(e, party, rng, new Set(), year) ?? e.genPolitician(rng, { party, lean: 0.5, home: rng.pick(Object.keys(e.data.states)), quality: 1, ageMin: 40 });
    p.rec = Math.max(p.rec, 0.8);
    return p;
  };
  // tickets picked at the summer conventions (older saves fall back to fresh nominees)
  const t = e.s.tickets?.year === year ? e.s.tickets : null;
  const otherParty: Party = incParty === 'D' ? 'R' : 'D';
  const fromTicket = (party: Party) => e.pol(t?.[party as 'D' | 'R']?.pres);
  const a = fromTicket(incParty) ?? (runs ? holder! : mk(incParty));
  const b = fromTicket(otherParty) ?? mk(otherParty);
  const cands = [a, b].map((p) => ({ ...e.candidate(p.id, def, null), spend: 1e9, rec: 0.9 }));
  const { units } = await raceUnits(e, def, false, rng);
  units.forEach((u) => delete u.rec);
  const out = runElection(units, cands, e.ctxFor(def, 'general'), rng, { level: 7, presYear: true });
  const byState: Record<string, number[]> = {};
  for (const u of out.units) {
    const st = e.data.counties[u.id]?.st;
    if (!st) continue;
    const v = (byState[st] ??= [0, 0]);
    v[0] += u.votes[0];
    v[1] += u.votes[1];
  }
  const ev: Record<string, number> = {};
  for (const [st, v] of Object.entries(byState)) ev[v[0] >= v[1] ? a.id : b.id] = (ev[v[0] >= v[1] ? a.id : b.id] ?? 0) + (EV[st] ?? 0);
  const winner = (ev[a.id] ?? 0) >= 270 ? a : b;
  if (winner !== holder) e.s.incoming.pres = winner.id;
  else holder!.terms++;
  const vpId = t?.[winner.party as 'D' | 'R']?.vp;
  if (vpId && vpId !== e.s.offices.vp?.holder) e.s.incoming.vp = vpId;
  else if (!vpId && winner !== holder) e.s.incoming.vp = runningMate(e, winner.party, rng).id;
  if (vpId === e.s.player.id) {
    const won = winner.party === e.player.party;
    e.news({ kind: 'player', title: won ? 'Your ticket wins! You will be sworn in as Vice President' : 'Your ticket loses the presidential election', tone: won ? 'good' : 'bad' });
    if (!won) e.player.career.push({ year, officeId: 'vp', title: 'Vice President of the United States', result: 'lost' });
    else e.player.career.push({ year, officeId: 'vp', title: 'Vice President of the United States', result: 'won' });
  }
  e.news({ kind: 'election', title: `${e.name(winner)} (${winner.party}) wins the presidency`, body: `Electoral votes: ${e.name(a)} ${ev[a.id] ?? 0}, ${e.name(b)} ${ev[b.id] ?? 0}.`, tone: 'neutral' });
  return {
    officeId: 'pres', title: def.title, year, stage: 'general',
    cands: out.cands.map((x, i) => ({ ...x, votes: out.totals[i] })), winnerId: winner.id,
    units: Object.entries(byState).map(([st, v]) => ({ id: st, label: st, votes: v })), blocs: out.blocs.map((x) => ({ label: x.label, shares: x.shares })), unitKind: 'state', electoral: ev,
  };
}

/** Congress and the President pass the occasional law on their own (unless the player is part of it). */
export function nationalLawmaking(e: Engine) {
  const t = e.player.officeId ? e.def(e.player.officeId)?.type : null;
  if (t === 'house' || t === 'senate' || t === 'president') return;
  const rng = new Rng(`${e.s.seed}|natlaw|${e.s.year}|${e.s.month}`);
  if (!rng.chance(0.045)) return;
  const house: Record<string, number> = {}, senate: Record<string, number> = {};
  for (const o of Object.values(e.s.offices)) {
    const p = o.holder ? e.s.politicians[o.holder] : undefined;
    if (!p) continue;
    if (o.id.startsWith('house:')) house[p.party] = (house[p.party] ?? 0) + 1;
    else if (o.id.startsWith('sen:')) senate[p.party] = (senate[p.party] ?? 0) + 1;
  }
  const maj = (r: Record<string, number>, size: number): Party | null => ((r.D ?? 0) > size / 2 ? 'D' : (r.R ?? 0) > size / 2 ? 'R' : null);
  const h = maj(house, 435), sen = maj(senate, 100), pp = e.s.world.presParty;
  const fed = billTemplatesFor('federal');
  let pick: (typeof fed)[number] | undefined;
  let how = '';
  if (h && h === sen && sen === pp) {
    pick = rng.pick(fed.filter((b) => b.dir === (pp === 'R' ? 1 : -1)));
    how = `With ${pp === 'D' ? 'Democrats' : 'Republicans'} controlling Washington, the bill passed on a party-line vote.`;
  } else if (rng.chance(0.5)) {
    pick = fed.find((b) => b.id === (rng.chance(0.6) ? 'infra' : 'trade_deal'));
    how = 'A rare bipartisan deal in a divided government.';
  }
  if (!pick) return;
  addShift(e.s.world, lawEcon(pick.issue, pick.dir, 1));
  const i = ISSUES.findIndex((x) => x.key === pick!.issue);
  if (i >= 0) e.s.world.salience[i] = clamp(e.s.world.salience[i] + 0.08);
  e.news({ kind: 'national', title: `Congress passes "${pick.title}"; the President signs it`, body: how, tone: 'neutral' });
}
