/**
 * The player's races: filing a field, counting units, primaries and generals, AI campaigns, debates and polls.
 * Split out of game.ts (M12): functions take the Engine; Engine keeps one-line delegates for the public API.
 */
import { demoFrom, type Party } from '../data/types';
import { EV, TOP_TWO, expectedSpend, primaryMonth, shortTownName, type OfficeDef } from './offices';
import { draftedRec, recordRace, rivalFor, rivalJoins } from './careers';
import { ensureRunningMate, holdPresContests, runningMate, setupPresField, vpDecision } from './primaries';
import type { Campaign, Politician, PollPoint, ResultSummary, SpecialElection } from './model';
import { Rng, clamp } from './rng';
import { anchorPrecincts, runElection, syntheticPrecincts, unitShares, type RaceCtx, type Unit } from './vote';
import { monthName, partyName, round2, round3, genMonth } from './util';
import type { Engine } from './game';

export async function startCampaign(e: Engine, def: OfficeDef, year: number, sp?: SpecialElection) {
  const me = e.player;
  const o = e.ensureOffice(def.id)!;
  const rng = new Rng(`${e.s.seed}|camp|${def.id}|${year}`);
  const unit = e.jurUnit(def);
  const holder = e.pol(o.holder);
  const holderRuns = holder && !holder.isPlayer && e.willRunAgain(holder, def, rng);
  const kind: Campaign['kind'] = !def.partisan ? 'nonpartisan' : TOP_TWO.has(def.st ?? '') && def.type !== 'president' ? 'top-two' : 'partisan';
  const c: Campaign = {
    officeId: def.id, year, stage: kind === 'nonpartisan' ? 'general' : 'primary', primaryMonth: sp ? sp.primaryMonth ?? sp.month : primaryMonth(def, year), kind,
    generalMonth: sp?.month, special: sp ? true : undefined,
    primaryField: [me.id], generalField: [], otherField: [], spend: { [me.id]: 0 }, raised: 0, endorse: {}, polls: [], debates: [], bias: {}, rec: {}, budget: {}, debatePrep: 0,
  };
  const exp = expectedSpend(def.type, def.pop);
  const addAI = (p: Politician, rec: number, quality: number, list: string[]) => {
    list.push(p.id);
    c.rec[p.id] = round2(rec);
    c.spend[p.id] = 0;
    c.budget[p.id] = Math.round(exp * clamp(quality, 0.15, 2.2) * (def.level <= 2 ? 1.3 : 1) * e.diff.aiBudget);
  };
  // a rival whose turf overlaps may jump in instead of a newcomer
  const rivalPool: Partial<Record<Party, Politician | null>> = {};
  if (def.type !== 'president') for (const party of ['D', 'R'] as Party[]) rivalPool[party] = await rivalFor(e, def, party, new Set([me.id, ...(holder ? [holder.id] : [])]));
  const joinRng = new Rng(`${e.s.seed}|rivaljoin|${def.id}|${year}`);
  const joined: Politician[] = [];
  const challenger = (party: Party, q: number, list: string[]) => {
    const r = rivalPool[party];
    if (r && joinRng.chance(0.7)) {
      rivalPool[party] = null;
      addAI(r, r.officeId ? draftedRec(r) : clamp(0.08 + r.rec * 0.5, 0.05, 0.4), q * rng.range(0.6, 1.3), list);
      joined.push(r);
      return r;
    }
    const p = e.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home: def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US', quality: q, ageMin: def.minAge });
    addAI(p, clamp(0.06 + q * 0.18 + rng.normal(0, 0.04), 0.03, 0.6), q * rng.range(0.5, 1.3), list);
    return p;
  };
  const mySideHolds = holder?.party === me.party;
  const partisanStrength = me.party === 'D' ? unit.lean : 1 - unit.lean;
  if (kind === 'nonpartisan') {
    c.generalField.push(me.id);
    if (holderRuns) addAI(holder!, holder!.rec, 1.1, c.generalField);
    const n = holderRuns ? rng.int(0, 1) : rng.int(1, 2);
    for (let i = 0; i < n; i++) challenger(rng.chance(unit.lean) ? 'D' : 'R', rng.range(0.3, 0.9), c.generalField);
  } else if (kind === 'top-two') {
    c.primaryField = [me.id];
    if (holderRuns) addAI(holder!, holder!.rec, 1.2, c.primaryField);
    const nSame = rng.int(0, mySideHolds && holderRuns ? 0 : 2);
    for (let i = 0; i < nSame; i++) challenger(me.party, rng.range(0.4, 1), c.primaryField);
    const other: Party = me.party === 'D' ? 'R' : 'D';
    if (!(holderRuns && holder!.party === other)) challenger(other, rng.range(0.4, 1.1), c.primaryField);
    if (rng.chance(0.4)) challenger(rng.chance(0.5) ? me.party : other, rng.range(0.2, 0.6), c.primaryField);
  } else if (def.type === 'president') {
    setupPresField(e, c, def, rng, holder, !!holderRuns);
  } else {
    // my primary
    if (holderRuns && mySideHolds) addAI(holder!, holder!.rec, 1.3, c.primaryField);
    const contested = holderRuns && mySideHolds ? rng.int(0, 1) : partisanStrength > 0.55 ? rng.int(1, 3) : rng.int(0, 2);
    for (let i = 0; i < contested; i++) challenger(me.party, rng.range(0.35, 1.05), c.primaryField);
    // the other party's nominee pool
    const other: Party = me.party === 'D' ? 'R' : 'D';
    if (holderRuns && holder!.party === other) addAI(holder!, holder!.rec, 1.3, c.otherField);
    const n = c.otherField.length ? rng.int(0, 1) : rng.int(1, 3);
    for (let i = 0; i < n; i++) challenger(other, rng.range(0.35, 1.1) * (1 - partisanStrength + 0.5), c.otherField);
  }
  if (holder?.isPlayer) c.rec[me.id] = e.recIn(e.jurKey(def));
  e.s.campaign = c;
  const hasPrimary = c.stage === 'primary';
  e.news({
    kind: 'player',
    title: `${e.name(me)} files for ${def.title}`,
    body: hasPrimary
      ? c.pres
        ? `The ${partyName(me.party)} nomination: primaries run January to June ${year}, and ${c.pres.needed.toLocaleString()} of ${c.pres.total.toLocaleString()} pledged delegates clinch it. The field: ${c.primaryField.map((id) => e.name(e.pol(id))).join(', ')}.`
        : `The ${monthName(c.primaryMonth)} ${year} ${kind === 'top-two' ? 'top-two primary' : `${partyName(me.party)} primary`} field: ${c.primaryField.map((id) => e.name(e.pol(id))).join(', ')}.`
      : `The ${monthName(genMonth(c))} ${year} field: ${c.generalField.map((id) => e.name(e.pol(id))).join(', ')}.`,
    tone: 'good',
  });
  for (const r of joined) rivalJoins(e, r, def, year);
}

/** Units that votes are counted in. Player recognition is localized per unit for state/national races. */
export async function raceUnits(e: Engine, def: OfficeDef, primary: boolean, rng: Rng): Promise<{ units: Unit[]; kind: ResultSummary['unitKind'] }> {
  const meId = e.s.player.id;
  const recFor = (k: string, fallbackKey: string) => ({ [meId]: Math.max(e.s.player.rec[k] ?? 0, e.recIn(fallbackKey) * 0.85) });
  const { kind, id } = def.jur;
  if (kind === 'state') {
    const units = Object.entries(e.data.counties)
      .filter(([, c]) => c.st === id)
      .map(([fips, c]) => ({ id: fips, label: c.n, pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d), rec: recFor(fips, id) }));
    return { units, kind: 'county' };
  }
  if (kind === 'nation') {
    if (primary) {
      const units = Object.entries(e.data.states).map(([st, s]) => ({ id: st, label: s.n, pop: s.pop, lean: s.lean, demo: demoFrom(s.d), rec: recFor(st, 'US') }));
      return { units, kind: 'state' };
    }
    const units = Object.entries(e.data.counties).map(([fips, c]) => ({ id: fips, label: `${c.n}, ${c.st}`, pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d), rec: recFor(c.st, 'US') }));
    return { units, kind: 'county' };
  }
  const base = e.jurUnit(def);
  base.rec = { [meId]: e.recIn(e.jurKey(def)) };
  let labels: string[] = [];
  let n = 8;
  if (kind === 'town') {
    n = clamp(Math.round(base.pop / 2500), 3, 30);
    labels = Array.from({ length: n }, (_, i) => `Ward ${i + 1}`);
    const units = syntheticPrecincts(base, n, rng, labels);
    units.forEach((u) => (u.geo = id));
    return { units, kind: 'precinct' };
  }
  const towns = await e.data.townsOf(def.st!);
  const inJur = towns.filter((t) => (kind === 'county' ? t.county === id : kind === 'cd' ? t.cd === id : kind === 'sldu' ? t.sldu === id : t.sldl === id));
  labels = inJur.slice(0, 60).map((t) => shortTownName(t.name));
  if (!labels.length) labels = ['Precinct'];
  n = clamp(Math.round(base.pop / 6000), 6, 60);
  const units = syntheticPrecincts(base, n, rng, labels);
  anchorPrecincts(units, inJur.map((t) => ({ id: t.id, label: shortTownName(t.name), lean: t.lean, pop: t.pop })));
  return { units, kind: 'precinct' };
}

export async function runPlayerRace(e: Engine, stage: 'primary' | 'general'): Promise<ResultSummary> {
  const c = e.s.campaign!;
  const def = e.def(c.officeId)!;
  const me = e.player;
  const rng = new Rng(`${e.s.seed}|race|${def.id}|${c.year}|${stage}|${e.rng.next()}`);
  const field = stage === 'primary' ? c.primaryField : c.generalField;
  const kindCtx: RaceCtx['kind'] = c.kind === 'nonpartisan' ? 'nonpartisan' : stage === 'primary' && c.kind === 'partisan' ? 'primary' : c.kind === 'top-two' && stage === 'primary' ? 'nonpartisan' : 'general';
  const ctx = e.ctxFor(def, kindCtx, stage === 'primary' ? me.party : undefined);
  if (c.kind === 'top-two' && stage === 'primary') ctx.kind = 'general';
  const cands = field.map((id) => e.candidate(id, def, c));
  const { units, kind } = await raceUnits(e, def, stage === 'primary', rng);
  // a running mate is a favorite son or daughter at home
  const vpHome = def.type === 'president' && stage === 'general' && c.vp ? e.pol(c.vp)?.home : undefined;
  if (vpHome) for (const u of units) if (e.data.counties[u.id]?.st === vpHome && u.rec) u.rec[me.id] = Math.min(0.99, (u.rec[me.id] ?? 0) + 0.15);
  let out;
  if (cands.length === 1) {
    out = { cands: cands.map((x) => ({ id: x.id, name: x.name, party: x.party })), units: units.map((u) => ({ id: u.id, label: u.label, votes: [Math.round(u.pop * 0.1)] })), totals: [units.reduce((a, u) => a + Math.round(u.pop * 0.1), 0)], winner: 0, blocs: [] };
  } else out = runElection(units, cands, ctx, rng, { level: def.level, presYear: c.year % 4 === 0 });
  const summary: ResultSummary = {
    officeId: def.id, title: def.title, year: c.year, stage,
    cands: out.cands.map((x, i) => ({ ...x, votes: out.totals[i], isPlayer: x.id === me.id })),
    winnerId: out.cands[out.winner].id,
    units: rng ? [...out.units].sort(() => rng.next() - 0.5) : out.units,
    blocs: out.blocs.map((b) => ({ label: b.label, shares: b.shares })),
    unitKind: kind,
  };
  if (def.type === 'president' && stage === 'general') {
    const byState: Record<string, number[]> = {};
    for (const u of out.units) {
      const st = e.data.counties[u.id]?.st;
      if (!st) continue;
      const v = (byState[st] ??= new Array(cands.length).fill(0));
      u.votes.forEach((x, i) => (v[i] += x));
    }
    const ev: Record<string, number> = {};
    for (const [st, v] of Object.entries(byState)) {
      const w = v.indexOf(Math.max(...v));
      ev[cands[w].id] = (ev[cands[w].id] ?? 0) + (EV[st] ?? 0);
    }
    summary.electoral = ev;
    summary.winnerId = Object.entries(ev).sort((a, b) => b[1] - a[1])[0][0];
  }
  return summary;
}

export function aiCampaign(e: Engine, c: Campaign) {
  const def = e.def(c.officeId)!;
  const monthsLeft = Math.max(1, (c.stage === 'primary' ? c.primaryMonth : genMonth(c)) - e.s.month + 1 + (c.year - e.s.year) * 12);
  const ids = [...(c.stage === 'primary' ? c.primaryField : c.generalField), ...(c.stage === 'primary' ? c.otherField : [])];
  for (const id of ids) {
    const p = e.pol(id);
    if (!p || p.isPlayer) continue;
    const budget = c.budget[id] ?? 0;
    const left = Math.max(0, budget * (c.stage === 'primary' ? 0.4 : 1) - (c.spend[id] ?? 0));
    const urgency = monthsLeft <= 2 ? 0.6 : 1 / monthsLeft;
    c.spend[id] = Math.round((c.spend[id] ?? 0) + left * urgency);
    const gain = (0.012 + p.skills.organization / 3000 + p.skills.charisma / 4000) * (monthsLeft <= 3 ? 1.6 : 1) * (def.level <= 2 ? 2 : 1) * e.diff.aiRec;
    c.rec[id] = round2(clamp((c.rec[id] ?? p.rec) + gain * (1 - (c.rec[id] ?? p.rec))));
    // AI goes negative when trailing late
    const last = c.polls[c.polls.length - 1];
    if (last && monthsLeft <= 3 && (last.shares[id] ?? 0) < (last.shares[e.player.id] ?? 0) && e.rng.chance(0.35)) {
      e.player.fav = clamp(e.player.fav - 0.015);
      e.news({ kind: 'race', title: `${e.name(p)} launches attack ad against ${e.name(e.player)}`, tone: 'bad' });
    }
    c.endorse[id] = c.endorse[id] ?? (p.officeId === def.id ? 3 : e.rng.int(0, 2));
    if (e.rng.chance(0.08)) c.endorse[id]++;
  }
}

export async function maybeDebate(e: Engine, c: Campaign) {
  const target = c.stage === 'primary' ? c.primaryMonth : genMonth(c);
  if (c.year !== e.s.year || e.s.month !== target - 1) return;
  const def = e.def(c.officeId)!;
  if (def.level < 2) return;
  const field = (c.stage === 'primary' ? c.primaryField : c.generalField).map((id) => e.pol(id)!);
  if (field.length < 2) return;
  const me = e.player;
  const scores = field.map((p) => p.skills.debate / 100 + p.skills.policy / 300 + (p.isPlayer ? c.debatePrep + e.s.player.staff.policy * 0.05 : 0) + e.rng.normal(0, 0.25));
  const best = scores.indexOf(Math.max(...scores));
  const winner = field[best];
  c.bias[winner.id] = (c.bias[winner.id] ?? 0) + 0.12;
  for (const p of field) if (p !== winner) c.bias[p.id] = (c.bias[p.id] ?? 0) - 0.03;
  c.debates.push({ month: e.s.month, winner: winner.id, swing: 0.12 });
  c.debatePrep = 0;
  e.news({ kind: 'race', title: `Debate: ${e.name(winner)} wins the night`, body: `Snap polls give ${winner.isPlayer ? 'you' : e.name(winner)} the edge in the ${def.title} ${c.stage} debate.`, tone: winner.isPlayer ? 'good' : me ? 'bad' : 'neutral' });
}

export function poll(e: Engine, c: Campaign) {
  const def = e.def(c.officeId)!;
  const field = c.stage === 'primary' ? c.primaryField : c.generalField;
  if (field.length < 2) return;
  const kind: RaceCtx['kind'] = c.kind === 'nonpartisan' || (c.kind === 'top-two' && c.stage === 'primary') ? 'nonpartisan' : c.stage === 'primary' ? 'primary' : 'general';
  const ctx = e.ctxFor(def, kind === 'nonpartisan' && c.kind === 'top-two' ? 'general' : kind, e.player.party);
  const unit = e.jurUnit(def);
  unit.rec = { [e.s.player.id]: e.recIn(e.jurKey(def)) };
  const cands = field.map((id) => e.candidate(id, def, c));
  const { shares } = unitShares(unit, cands, ctx);
  const n = 400 + e.s.player.staff.manager * 200;
  const moe = 1 / Math.sqrt(n);
  const undecided = clamp(0.25 * (1 - Math.max(...cands.map((x) => x.rec))) + 0.03, 0.03, 0.3);
  const noisy = shares.map((s) => Math.max(0.005, s + e.rng.normal(0, moe / 2)));
  const tot = noisy.reduce((a, b) => a + b, 0);
  const point: PollPoint = { year: e.s.year, month: e.s.month, label: `${monthName(e.s.month)} ${String(e.s.year).slice(2)}`, shares: {}, moe: round3(moe * 2) };
  field.forEach((id, i) => (point.shares[id] = round3((noisy[i] / tot) * (1 - undecided))));
  point.shares.undecided = round3(undecided);
  c.polls.push(point);
}

export async function resolvePrimary(e: Engine, c: Campaign): Promise<ResultSummary> {
  const def = e.def(c.officeId)!;
  const me = e.player;
  if (c.pres) return resolvePresContests(e, c, def);
  const r = await runPlayerRace(e, 'primary');
  c.resultPrimary = r;
  e.s.results.unshift(r);
  const order = [...r.cands].sort((a, b) => b.votes - a.votes);
  if (c.kind === 'top-two') {
    const top = order.slice(0, 2).map((x) => x.id);
    recordRace(e, r, top.includes(me.id));
    if (top.includes(me.id)) {
      c.generalField = top;
      c.stage = 'general';
      e.news({ kind: 'election', title: `${e.name(me)} advances from the top-two primary`, tone: 'good' });
    } else loseRace(e, c, def, 'lost-primary', r);
  } else {
    recordRace(e, r, r.winnerId === me.id);
    if (r.winnerId === me.id) {
      const nominee = otherNominee(e, c, def);
      c.generalField = nominee ? [me.id, nominee.id] : [me.id];
      c.stage = 'general';
      e.news({ kind: 'election', title: `${e.name(me)} wins the ${partyName(me.party)} primary for ${def.title}`, body: nominee ? `Faces ${e.name(nominee)} (${nominee.party}) in November.` : 'No opponent filed for November.', tone: 'good' });
      e.s.player.partyStanding = clamp(e.s.player.partyStanding + 8, 0, 100);
    } else loseRace(e, c, def, 'lost-primary', r);
  }
  return r;
}

/** The other party's nominee: simulate their primary quickly. */
export function otherNominee(e: Engine, c: Campaign, def: OfficeDef): Politician | undefined {
  const other = c.otherField.map((id) => e.pol(id)!).filter(Boolean);
  let nominee = other[0];
  if (other.length > 1) {
    const ctx = e.ctxFor(def, 'primary', other[0].party);
    const shares = unitShares(e.jurUnit(def), other.map((p) => e.candidate(p.id, def, c)), ctx).shares.map((s) => s + e.rng.normal(0, 0.05));
    nominee = other[shares.indexOf(Math.max(...shares))];
  }
  if (nominee) c.rec[nominee.id] = clamp((c.rec[nominee.id] ?? 0.1) + 0.08);
  return nominee;
}

/** One month of presidential primaries and caucuses (see primaries.ts). */
export function resolvePresContests(e: Engine, c: Campaign, def: OfficeDef): ResultSummary {
  const me = e.player;
  const { result: r, outcome, text } = holdPresContests(e, c);
  e.s.results.unshift(r);
  if (e.s.results.length > 20) e.s.results.length = 20;
  const P = c.pres!;
  const mine = P.delegates[me.id] ?? 0;
  if (outcome === 'won') {
    const nominee = otherNominee(e, c, def);
    c.generalField = nominee ? [me.id, nominee.id] : [me.id];
    c.primaryField = c.primaryField.filter((id) => id === me.id || P.delegates[id] != null);
    c.stage = 'general';
    e.s.player.partyStanding = clamp(e.s.player.partyStanding + 12, 0, 100);
    e.news({ kind: 'election', title: `${e.name(me)} wins the ${partyName(me.party)} presidential nomination`, body: `${text}${nominee ? ` ${e.name(nominee)} (${nominee.party}) awaits in November.` : ''} Choose a running mate on the Office tab.`, tone: 'good' });
    e.s.decisions.push(vpDecision(e, c));
  } else if (outcome === 'lost') {
    loseRace(e, c, def, 'lost-primary', r);
    e.news({ kind: 'election', title: 'The nomination slips away', body: text, tone: 'bad' });
  } else {
    const lead = Object.entries(P.delegates).sort((a, b) => b[1] - a[1])[0];
    e.news({
      kind: 'election', title: `${r.delegates!.contest}: ${e.name(e.pol(r.winnerId))} wins the most delegates`,
      body: `You won ${(r.delegates!.won[me.id] ?? 0).toLocaleString()} tonight and have ${mine.toLocaleString()} of the ${P.needed.toLocaleString()} needed${lead && lead[0] !== me.id ? `; ${e.name(e.pol(lead[0]))} leads with ${lead[1].toLocaleString()}` : ' — you lead the race'}. Next contests: ${monthName(c.primaryMonth)}.`,
      tone: r.winnerId === me.id ? 'good' : 'neutral',
    });
  }
  return r;
}

export function loseRace(e: Engine, c: Campaign, def: OfficeDef, result: 'lost' | 'lost-primary', r: ResultSummary) {
  const me = e.player;
  const tot = r.cands.reduce((a, x) => a + x.votes, 0) || 1;
  const share = (r.cands.find((x) => x.id === me.id)?.votes ?? 0) / tot;
  me.career.push({ year: c.year, officeId: def.id, title: def.title, result, share: round3(share) });
  const w = e.pol(r.winnerId);
  e.news({ kind: 'election', title: `${e.name(me)} ${result === 'lost-primary' ? 'loses primary' : 'defeated'} for ${def.title}`, body: `${e.name(w)} wins with ${Math.round(((r.cands.find((x) => x.id === r.winnerId)?.votes ?? 0) / tot) * 100)}%.`, tone: 'bad' });
  c.stage = 'done';
  e.s.player.partyStanding = clamp(e.s.player.partyStanding - 5, 0, 100);
  if (result === 'lost' && w) {
    if (c.special) {
      e.s.specials = e.s.specials.filter((x) => x.officeId !== def.id);
      e.installOffice(def.id, w.id, 'elected');
    } else e.s.incoming[def.id] = w.id;
    // the winning presidential ticket brings its own Vice President
    if (def.type === 'president') e.s.incoming.vp = runningMate(e, w.party, new Rng(`${e.s.seed}|vpw|${c.year}`)).id;
  }
}

export async function resolveGeneral(e: Engine, c: Campaign): Promise<ResultSummary> {
  const def = e.def(c.officeId)!;
  const me = e.player;
  if (def.type === 'president') ensureRunningMate(e, c);
  const r = await runPlayerRace(e, 'general');
  c.resultGeneral = r;
  e.s.results.unshift(r);
  recordRace(e, r, r.winnerId === me.id);
  if (e.s.results.length > 20) e.s.results.length = 20;
  if (r.winnerId === me.id) {
    const tot = r.cands.reduce((a, x) => a + x.votes, 0) || 1;
    const share = (r.cands.find((x) => x.id === me.id)?.votes ?? 0) / tot;
    me.career.push({ year: c.year, officeId: def.id, title: def.title, result: 'won', share: round3(share) });
    e.news({ kind: 'election', title: `${e.name(me)} wins ${c.special ? 'the special election' : 'election'} as ${def.title}!`, body: `${Math.round(share * 100)}% of the vote. ${c.special ? 'Sworn in right away.' : 'Sworn in this January.'}`, tone: 'good' });
    e.s.player.partyStanding = clamp(e.s.player.partyStanding + 10, 0, 100);
    c.stage = 'done';
    const o = e.ensureOffice(def.id)!;
    o.lastShare = round3(share);
    o.lastYear = c.year;
    if (c.special) {
      e.s.specials = e.s.specials.filter((x) => x.officeId !== def.id);
      e.installOffice(def.id, me.id, 'elected');
    } else e.s.incoming[def.id] = me.id;
    if (def.type === 'president' && c.vp) e.s.incoming.vp = c.vp;
  } else loseRace(e, c, def, 'lost', r);
  return r;
}
