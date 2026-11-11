/**
 * Presidential nominations (M10): a state-by-state primary calendar with delegates, the running-mate pick,
 * and the summer conventions that set both tickets when the player isn't the nominee.
 *
 * The player's nomination race is a Campaign with `pres` set. Each month that has contests (PRES_CALENDAR),
 * the month's states vote at the end of the month and award pledged delegates:
 *   Democrats   proportional among candidates with 15%+ of the state's vote
 *   Republicans proportional (20% threshold) in January–March unless someone tops 50%, winner-take-all from April
 * A majority of pledged delegates clinches. Trailing candidates drop out, winners gain momentum, and a player
 * who is mathematically eliminated loses the nomination. If nobody clinches by June, the delegate leader wins
 * at the convention.
 */
import type { Engine } from './game';
import type { Campaign, Decision, DecisionOption, Politician, PresPrimary, ResultSummary } from './model';
import type { OfficeDef } from './offices';
import type { Party } from '../data/types';
import { demoFrom } from '../data/types';
import { EV, PRES_CALENDAR, expectedSpend } from './offices';
import { Rng, clamp } from './rng';
import { runElection, type Unit } from './vote';
import { PARTY_BASE } from './issues';

/** Pledged delegates per party (recent conventions). */
const TOTAL: Record<'D' | 'R', number> = { D: 3949, R: 2429 };
const ALL_STATES = PRES_CALENDAR.flatMap((m) => m.states);
const monthLabel = (m: number) => PRES_CALENDAR.find((x) => x.month === m)?.label ?? '';

/** Delegates per state: electoral votes weighted by the party's strength there. */
export function delegatePool(e: Engine, party: Party): { pool: Record<string, number>; total: number; needed: number } {
  const p: 'D' | 'R' = party === 'R' ? 'R' : 'D';
  const w: Record<string, number> = {};
  for (const st of ALL_STATES) {
    const s = e.data.states[st];
    if (!s) continue;
    w[st] = (EV[st] ?? 3) * (p === 'D' ? 0.5 + s.lean : 1.5 - s.lean);
  }
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  const pool: Record<string, number> = {};
  for (const [st, x] of Object.entries(w)) pool[st] = Math.max(3, Math.round((TOTAL[p] * x) / sum));
  const total = Object.values(pool).reduce((a, b) => a + b, 0);
  return { pool, total, needed: Math.floor(total / 2) + 1 };
}

/** Split a state's delegates. */
export function allocate(votes: number[], n: number, party: Party, month: number): number[] {
  const tot = votes.reduce((a, b) => a + b, 0) || 1;
  const shares = votes.map((v) => v / tot);
  const top = shares.indexOf(Math.max(...shares));
  const out = new Array(votes.length).fill(0);
  const wta = party === 'R' && (month >= 4 || shares[top] > 0.5);
  if (wta) {
    out[top] = n;
    return out;
  }
  const thr = party === 'R' ? 0.2 : 0.15;
  const elig = shares.map((s) => s >= thr);
  if (!elig.some(Boolean)) elig[top] = true;
  const es = shares.reduce((a, s, i) => a + (elig[i] ? s : 0), 0);
  // largest remainder
  const raw = shares.map((s, i) => (elig[i] ? (s / es) * n : 0));
  raw.forEach((r, i) => (out[i] = Math.floor(r)));
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).filter(([, i]) => elig[i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++;
  return out;
}

/** Set up the field and the delegate race for the player's presidential bid. */
export function setupPresField(e: Engine, c: Campaign, def: OfficeDef, rng: Rng, holder: Politician | undefined, holderRuns: boolean) {
  const me = e.player;
  const other: Party = me.party === 'D' ? 'R' : 'D';
  const exp = expectedSpend(def.type, def.pop);
  const homes: Record<string, string> = {};
  const states = Object.keys(e.data.states).filter((s) => s !== 'DC');
  const add = (p: Politician, rec: number, q: number, list: string[]) => {
    list.push(p.id);
    c.rec[p.id] = Math.round(rec * 100) / 100;
    c.spend[p.id] = 0;
    c.budget[p.id] = Math.round(exp * clamp(q, 0.15, 2.2) * 0.35 * e.diff.aiBudget);
    homes[p.id] = e.data.states[p.home] ? p.home : rng.pick(states);
  };
  const contender = (party: Party, q: number, list: string[]) => {
    // big-state politicians are likelier to run
    const st = rng.chance(0.6) ? rng.pick(['CA', 'TX', 'FL', 'NY', 'PA', 'IL', 'OH', 'GA', 'NC', 'MI', 'VA', 'AZ', 'MN', 'WI', 'IN', 'TN', 'SC']) : rng.pick(states);
    const s = e.data.states[st];
    const p = e.genPolitician(rng, { party, lean: s.lean, demo: demoFrom(s.d), home: st, quality: q, ageMin: 40 });
    add(p, clamp(0.22 + q * 0.2 + rng.normal(0, 0.06), 0.12, 0.7), q * rng.range(0.7, 1.3), list);
    return p;
  };
  homes[me.id] = e.data.townSync(me.home)?.st ?? 'DC';
  const incumbentMine = holderRuns && holder && holder.party === me.party;
  if (incumbentMine) {
    add(holder!, 0.97, 1.6, c.primaryField);
    if (rng.chance(0.4)) contender(me.party, rng.range(0.3, 0.6), c.primaryField);
  } else {
    const n = rng.int(3, 5);
    for (let i = 0; i < n; i++) contender(me.party, rng.range(0.7, 1.25), c.primaryField);
  }
  if (holderRuns && holder && holder.party === other) add(holder, 0.97, 1.6, c.otherField);
  else for (let i = 0, n = rng.int(2, 4); i < n; i++) contender(other, rng.range(0.7, 1.25), c.otherField);
  const { pool, total, needed } = delegatePool(e, me.party);
  c.pres = { party: me.party, delegates: Object.fromEntries(c.primaryField.map((id) => [id, 0])), pool, total, needed, states: {}, dropped: [], homes };
}

const active = (c: Campaign) => c.primaryField.filter((id) => !c.pres!.dropped.some((d) => d.id === id));

/**
 * Hold this month's contests. Returns the night's result and what happened to the race:
 * 'won' (the player is the nominee), 'lost' (eliminated or beaten at the convention) or 'continue'.
 */
export function holdPresContests(e: Engine, c: Campaign): { result: ResultSummary; outcome: 'won' | 'lost' | 'continue'; text: string } {
  const P = c.pres!;
  const def = e.def(c.officeId)!;
  const meId = e.player.id;
  const month = e.s.month;
  const sched = PRES_CALENDAR.find((m) => m.month === month)!;
  const ids = active(c);
  const rng = new Rng(`${e.s.seed}|pres|${c.year}|${month}|${e.rng.next()}`);
  const cands = ids.map((id) => e.candidate(id, def, c));
  const units: Unit[] = sched.states.filter((st) => e.data.states[st]).map((st) => {
    const s = e.data.states[st];
    const rec: Record<string, number> = { [meId]: Math.max(e.s.player.rec[st] ?? 0, e.recIn('US') * 0.85) };
    for (const id of ids) if (id !== meId && P.homes[id] === st) rec[id] = Math.max(c.rec[id] ?? 0.3, 0.8);
    if (P.homes[meId] === st) rec[meId] = Math.max(rec[meId], 0.6);
    return { id: st, label: s.n, pop: s.pop, lean: s.lean, demo: demoFrom(s.d), rec };
  });
  const out = runElection(units, cands, e.ctxFor(def, 'primary', P.party), rng, { level: 7, presYear: true });
  const won: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const u of out.units) {
    const n = P.pool[u.id] ?? 0;
    const alloc = allocate(u.votes, n, P.party, month);
    const tot = u.votes.reduce((a, b) => a + b, 0) || 1;
    const w = u.votes.indexOf(Math.max(...u.votes));
    P.states[u.id] = { month, winner: ids[w], delegates: {}, shares: {} };
    ids.forEach((id, i) => {
      if (alloc[i]) P.states[u.id].delegates[id] = alloc[i];
      P.states[u.id].shares[id] = Math.round((u.votes[i] / tot) * 1000) / 1000;
      won[id] += alloc[i];
      P.delegates[id] = (P.delegates[id] ?? 0) + alloc[i];
    });
  }
  // momentum: the night's delegate winner surges, candidates shut out fade
  const nightWinner = ids.reduce((a, b) => (won[b] > won[a] ? b : a), ids[0]);
  c.bias[nightWinner] = (c.bias[nightWinner] ?? 0) + 0.05;
  if (nightWinner !== meId) c.rec[nightWinner] = clamp((c.rec[nightWinner] ?? 0.3) + 0.06);
  else e.bumpRec('US', 0.04);
  for (const id of ids) if (!won[id]) c.bias[id] = (c.bias[id] ?? 0) - 0.03;

  // dropouts
  const totVotes = out.totals.reduce((a, b) => a + b, 0) || 1;
  const leader = () => active(c).reduce((a, b) => ((P.delegates[b] ?? 0) > (P.delegates[a] ?? 0) ? b : a), active(c)[0]);
  const exits: string[] = [];
  for (const [i, id] of ids.entries()) {
    if (id === meId || active(c).length <= 2) continue;
    const l = leader();
    const weak = month <= 2 ? out.totals[i] / totVotes < 0.1 : id !== l && (P.delegates[id] ?? 0) < (P.delegates[l] ?? 0) * 0.3;
    if (weak && rng.chance(month <= 2 ? 0.7 : 0.6)) {
      P.dropped.push({ id, month });
      exits.push(e.name(e.pol(id)));
    }
  }
  if (exits.length) e.news({ kind: 'race', title: `${exits.join(' and ')} ${exits.length > 1 ? 'end their campaigns' : 'ends their campaign'}`, body: 'The field narrows after a disappointing night.', tone: 'neutral' });
  c.primaryField = c.primaryField.filter((id) => active(c).includes(id) || id === meId);

  // where the race stands
  const remaining = PRES_CALENDAR.filter((m) => m.month > month).flatMap((m) => m.states).reduce((a, st) => a + (P.pool[st] ?? 0), 0);
  const lead = leader();
  const mine = P.delegates[meId] ?? 0;
  let outcome: 'won' | 'lost' | 'continue' = 'continue';
  let text = '';
  if (mine >= P.needed || active(c).length === 1) {
    outcome = 'won';
    text = mine >= P.needed ? `You clinched the nomination with ${mine.toLocaleString()} delegates.` : 'Your last rival dropped out. You are the presumptive nominee.';
  } else if (lead !== meId && ((P.delegates[lead] ?? 0) >= P.needed || mine + remaining < (P.delegates[lead] ?? 0))) {
    outcome = 'lost';
    text = (P.delegates[lead] ?? 0) >= P.needed ? `${e.name(e.pol(lead))} clinched the nomination.` : `You can no longer catch ${e.name(e.pol(lead))} in delegates.`;
  } else if (!remaining) {
    outcome = lead === meId ? 'won' : 'lost';
    text = lead === meId ? 'You lead in delegates and win the nomination at the convention.' : `${e.name(e.pol(lead))} leads in delegates and wins the nomination at the convention.`;
  }
  if (outcome !== 'continue') P.nominee = outcome === 'won' ? meId : lead;
  const result: ResultSummary = {
    officeId: def.id, title: `Presidential primaries: ${sched.label}`, year: c.year, stage: 'primary',
    cands: out.cands.map((x, i) => ({ ...x, votes: out.totals[i], isPlayer: x.id === meId })),
    winnerId: nightWinner,
    units: [...out.units].sort(() => rng.next() - 0.5),
    blocs: out.blocs.map((b) => ({ label: b.label, shares: b.shares })),
    unitKind: 'state',
    delegates: { contest: sched.label, won, total: Object.fromEntries(ids.map((id) => [id, P.delegates[id] ?? 0])), needed: P.needed, outcome: text || undefined },
  };
  if (outcome === 'continue') c.primaryMonth = PRES_CALENDAR.find((m) => m.month > month)!.month;
  return { result, outcome, text };
}

/** Summary of the delegate race for the UI. */
export function presView(e: Engine, c: Campaign) {
  const P = c.pres;
  if (!P) return null;
  const all = [...new Set([...c.primaryField, ...P.dropped.map((d) => d.id)])];
  return {
    needed: P.needed, total: P.total,
    candidates: all.map((id) => {
      const p = e.pol(id);
      const d = P.dropped.find((x) => x.id === id);
      return { id, name: p ? e.name(p) : 'Former candidate', delegates: P.delegates[id] ?? 0, home: P.homes[id] ?? '', out: d ? d.month : null, isPlayer: id === e.player.id, states: Object.values(P.states).filter((s) => s.winner === id).length };
    }).sort((a, b) => b.delegates - a.delegates),
    calendar: PRES_CALENDAR.map((m) => ({
      month: m.month, label: m.label, delegates: m.states.reduce((a, st) => a + (P.pool[st] ?? 0), 0),
      states: m.states.map((st) => ({ st, delegates: P.pool[st] ?? 0, winner: P.states[st]?.winner ?? null })),
      done: m.states.some((st) => P.states[st]),
    })),
    nominee: P.nominee ?? null,
    vp: c.vp ? { id: c.vp, name: e.name(e.pol(c.vp)), home: e.pol(c.vp)?.home ?? '' } : null,
  };
}

// ------------------------------------------------------------------ running mates

/** A generated running mate: a governor or senator type from `st`. */
export function runningMate(e: Engine, party: Party, rng: Rng, st?: string, style: 'swing' | 'loyal' | 'moderate' = 'loyal'): Politician {
  const states = Object.keys(e.data.states).filter((s) => s !== 'DC');
  const home = st ?? rng.pick(states);
  const s = e.data.states[home];
  const p = e.genPolitician(rng, { party, lean: s.lean, demo: demoFrom(s.d), home, quality: 1, ageMin: 40 });
  if (style === 'loyal') p.pos = PARTY_BASE[party].map((x) => Math.round(clamp(x * 1.05 + rng.normal(0, 0.05), -1, 1) * 100) / 100);
  if (style === 'moderate') p.pos = PARTY_BASE[party].map((x) => Math.round(clamp(x * 0.45 + rng.normal(0, 0.05), -1, 1) * 100) / 100);
  p.rec = 0.4;
  return p;
}

/** Swing states by electoral votes × closeness. */
function swingStates(e: Engine, exclude?: string) {
  return Object.entries(e.data.states)
    .filter(([st]) => st !== 'DC' && st !== exclude)
    .map(([st, s]) => ({ st, score: (EV[st] ?? 3) * Math.max(0, 0.1 - Math.abs(s.lean - 0.5)) }))
    .sort((a, b) => b.score - a.score);
}

/** The nominee's decision: pick a running mate. */
export function vpDecision(e: Engine, c: Campaign): Decision {
  const me = e.player;
  const rng = new Rng(`${e.s.seed}|vp|${c.year}`);
  const myState = c.pres?.homes[me.id];
  const swing = swingStates(e, myState);
  const sw = runningMate(e, me.party, rng, swing[rng.int(0, Math.min(2, swing.length - 1))].st, 'moderate');
  const loyal = runningMate(e, me.party, rng, undefined, 'loyal');
  // the strongest primary rival who dropped out, if any (a unity ticket)
  const rival = c.primaryField.concat(c.pres?.dropped.map((d) => d.id) ?? []).filter((id) => id !== me.id && e.pol(id) && !e.pol(id)!.officeId?.startsWith('pres'))
    .sort((a, b) => (c.pres?.delegates[b] ?? 0) - (c.pres?.delegates[a] ?? 0))[0];
  const sn = e.data.states;
  const options: DecisionOption[] = [
    { label: `${e.name(sw)}, a popular figure from ${sn[sw.home].n}`, detail: `A swing-state pick: helps you carry ${sn[sw.home].n} and reassures moderates; the base shrugs.`, pick: sw.id, party: -2, bloc: { wcol: 0.02, wnon: 0.01 } },
    { label: `${e.name(loyal)}, a party favorite`, detail: 'Thrills activists and donors; does little for swing voters.', pick: loyal.id, party: 8, bloc: { wcol: -0.01 } },
  ];
  if (rival) {
    const r = e.pol(rival)!;
    options.push({ label: `${e.name(r)}, your primary rival`, detail: `A unity ticket: their supporters come home and ${sn[c.pres?.homes[rival] ?? '']?.n ?? 'their home state'} gets a boost; your relationship is frosty.`, pick: rival, party: 4, bloc: { wcol: 0.01, wnon: 0.01, black: 0.01, hisp: 0.01 } });
  }
  return {
    id: e.newId('d'), templateId: 'vp_pick', title: 'Choose your running mate',
    body: 'Your running mate is on the ballot with you in November and becomes Vice President if you win. Their home state leans a little more your way.',
    options, deadline: { year: e.s.year, month: Math.min(12, Math.max(e.s.month + 2, 8)) },
    meta: { kind: 'vp', candidates: [sw.id, loyal.id] },
  };
}

/** Lock in the running mate: a boost to the ticket and to their home state. */
export function applyVpPick(e: Engine, d: Decision, pick: string) {
  const c = e.s.campaign;
  for (const id of d.meta?.candidates ?? []) if (id !== pick && !e.s.politicians[id]?.officeId) delete e.s.politicians[id];
  if (!c || c.stage === 'done') return;
  c.vp = pick;
  const p = e.pol(pick);
  if (!p) return;
  c.bias[e.player.id] = (c.bias[e.player.id] ?? 0) + 0.02 + (p.skills.charisma - 50) / 2500;
  e.news({ kind: 'player', title: `${e.name(e.player)} picks ${e.name(p)} as running mate`, body: `${e.name(p)} of ${e.data.states[p.home]?.n ?? p.home} joins the ticket.`, tone: 'good' });
}

/** Default pick if the nominee never chose. */
export function ensureRunningMate(e: Engine, c: Campaign) {
  if (c.vp && e.pol(c.vp)) return;
  const rng = new Rng(`${e.s.seed}|vpauto|${c.year}`);
  const sw = swingStates(e, c.pres?.homes[e.player.id]);
  c.vp = runningMate(e, e.player.party, rng, sw[0]?.st, 'moderate').id;
}

// ------------------------------------------------------------------ conventions (player not the nominee)

/**
 * July of a presidential year: both parties pick their tickets. A well-placed player in the nominee's party
 * may be offered the vice-presidential slot.
 */
export function conventions(e: Engine) {
  const { year, month } = e.s;
  if (year % 4 !== 0 || month !== 7) return;
  const c = e.s.campaign;
  if (c?.pres && c.year === year && c.stage !== 'done') return; // the player's own nomination race sets their ticket
  if (e.s.tickets?.year === year) return;
  const rng = new Rng(`${e.s.seed}|conv|${year}`);
  const holder = e.pol(e.ensureOffice('pres')?.holder);
  const vpHolder = e.pol(e.ensureOffice('vp')?.holder);
  const def = e.def('pres')!;
  const t: NonNullable<typeof e.s.tickets> = { year };
  for (const party of ['D', 'R'] as const) {
    let pres: Politician | undefined;
    if (holder && !holder.isPlayer && holder.party === party && e.willRunAgain(holder, def, rng)) pres = holder;
    if (!pres && c?.pres?.nominee && c.year === year && c.pres.party === party) pres = e.pol(c.pres.nominee);
    if (!pres) {
      const st = rng.pick(Object.keys(e.data.states).filter((s) => s !== 'DC'));
      const s = e.data.states[st];
      pres = e.genPolitician(rng, { party, lean: s.lean, demo: demoFrom(s.d), home: st, quality: 1, ageMin: 40 });
    }
    pres.rec = 0.8;
    const vp = pres === holder && vpHolder && vpHolder.party === party && !vpHolder.isPlayer ? vpHolder : runningMate(e, party, rng, swingStates(e, pres.home)[rng.int(0, 3)]?.st);
    t[party] = { pres: pres.id, vp: vp.id };
  }
  e.s.tickets = t;
  e.news({ kind: 'national', title: `Conventions set the ${year} tickets`, body: (['D', 'R'] as const).map((p) => `${p === 'D' ? 'Democrats' : 'Republicans'}: ${e.name(e.pol(t[p]!.pres))} and ${e.name(e.pol(t[p]!.vp))}`).join(' · ') });
  maybeOfferTicket(e, rng);
}

/** Odds that the nominee asks the player to be their running mate. */
export function ticketOdds(e: Engine): number {
  const me = e.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  if (!def || def.level < 5 || e.age(me) < 35 || me.party === 'I') return 0;
  return clamp(0.02 + (e.s.player.partyStanding - 50) / 250 + e.recIn('US') * 0.6 + (def.level >= 6 ? 0.12 : 0.03) - me.scandal, 0, 0.6);
}

function maybeOfferTicket(e: Engine, rng: Rng) {
  const t = e.s.tickets!;
  const me = e.player;
  const mine = t[me.party as 'D' | 'R'];
  if (!mine || mine.pres === me.id || !rng.chance(ticketOdds(e))) return;
  const pres = e.pol(mine.pres)!;
  t.offered = true;
  e.s.decisions.push({
    id: e.newId('d'), templateId: 'ticket_offer', title: `${e.name(pres)} asks you to be their running mate`,
    body: `The ${me.party === 'D' ? 'Democratic' : 'Republican'} nominee wants you on the ticket. If you accept you give up any other race this year; if the ticket wins you become Vice President in January.`,
    options: [
      { label: 'Accept the nomination', detail: 'A national stage — and a step toward the presidency.', party: 8 },
      { label: 'Decline', detail: 'Stay where you are.', party: -2 },
    ],
    deadline: { year: e.s.year, month: 8 },
    meta: { kind: 'ticket' },
  });
}

/** The player's answer to a running-mate offer. */
export function answerTicket(e: Engine, accept: boolean) {
  const t = e.s.tickets;
  const me = e.player;
  const mine = t?.[me.party as 'D' | 'R'];
  if (!t || !mine || !accept) return;
  const old = e.pol(mine.vp);
  if (old && !old.officeId && !old.isPlayer) delete e.s.politicians[old.id];
  mine.vp = me.id;
  const c = e.s.campaign;
  if (c && c.stage !== 'done') e.withdraw();
  e.bumpRec('US', 0.25);
  e.news({ kind: 'player', title: `${e.name(me)} joins the ${me.party === 'D' ? 'Democratic' : 'Republican'} ticket`, body: `${e.name(e.pol(mine.pres))} names you as their running mate.`, tone: 'good' });
}
