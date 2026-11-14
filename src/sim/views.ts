/**
 * Read-only queries for the UI: the game view, officeholders, map colors, the legislature and budget cards, action targets.
 * Split out of game.ts (M12): functions take the Engine; Engine keeps one-line delegates for the public API.
 */
import type { Party } from '../data/types';
import { incumbencyFactors, incumbencyStrength } from './incumbency';
import { councilSeats, expectedSpend, nextElection, schoolSeats, shortTownName, statewideIds } from './offices';
import { isRival, rivalsView } from './careers';
import { presView } from './primaries';
import { STAFF_ROLES, staffCost } from './campaign';
import { COMMITTEES, MAX_ACTIVE_BILLS, bidOptions, billCount, billOptions, chamberKey, chamberLabel, committeeMembers, ensureLeadership, execChambers, executiveOf, hearingOdds, isPartisanChamber, isSmall, members, monthlyFavors, otherChamber, partyCounts, roleLabel, seatCount, seniority } from './legislature';
import { monthName, genMonth } from './util';
import type { Engine } from './game';
import { approval } from './upkeep';
import { metricTargets } from './office';
import { scandalView } from './scandals';

export function holderSummary(e: Engine, officeId: string) {
  const o = e.ensureOffice(officeId);
  const def = e.def(officeId);
  if (!o || !def) return null;
  const p = e.pol(o.holder);
  return {
    officeId, title: def.title, type: def.type, level: def.level,
    holder: p ? { id: p.id, name: e.name(p), party: p.party, age: e.age(p), since: p.since ?? o.since, terms: p.terms, ideology: p.pos.reduce((a, b) => a + b, 0) / p.pos.length, isPlayer: !!p.isPlayer, rec: p.rec, fav: p.fav, skills: p.skills, pos: p.pos, rival: isRival(e, p.id) } : null,
    lastShare: o.lastShare ?? null, nextElection: nextElection(officeId, e.s.year, e.data), partisan: def.partisan,
  };
}

/** Officeholders for a map selection. */
export async function jurisdiction(e: Engine, kind: 'state' | 'county' | 'cd' | 'sldu' | 'sldl' | 'town', id: string) {
  const ids: string[] = [];
  if (kind === 'state') {
    if (id !== 'DC') ids.push(...statewideIds(id, e.data));
    for (const s of e.data.states[id]?.senators ?? []) ids.push(`sen:${id}:${s.cls}`);
  } else if (kind === 'county') {
    const c = e.data.counties[id];
    for (const k of ['cexec', 'sheriff', 'da']) if (e.def(`${k}:${id}`)) ids.push(`${k}:${id}`);
    if (c && c.st !== 'CT' && c.st !== 'RI') for (let i = 0; i < 5; i++) ids.push(`county:${id}:${i}`);
  } else if (kind === 'cd') ids.push(`house:${id}`);
  else if (kind === 'sldu') ids.push(`sldu:${id}`);
  else if (kind === 'sldl') ids.push(`sldl:${id}`);
  else if (kind === 'town') {
    const t = await e.data.town(id);
    if (t) {
      ids.push(`mayor:${id}`);
      for (let i = 0; i < councilSeats(t.pop); i++) ids.push(`council:${id}:${i}`);
      for (let i = 0; i < schoolSeats(t.pop); i++) ids.push(`school:${id}:${i}`);
    }
  }
  const offices = ids.map((x) => holderSummary(e, x)).filter(Boolean);
  let chambers: Record<string, Record<string, number>> | undefined;
  if (kind === 'state') {
    chambers = { 'State Senate': {}, 'State House': {}, 'U.S. House delegation': {} };
    for (const o of Object.values(e.s.offices)) {
      const p = e.pol(o.holder);
      if (!p) continue;
      const [t, g] = o.id.split(':');
      const st = t === 'house' || t === 'sldu' || t === 'sldl' ? e.data.districts[`${t === 'house' ? 'cd' : t}:${g}`]?.st : null;
      if (st !== id) continue;
      const ch = t === 'sldu' ? 'State Senate' : t === 'sldl' ? 'State House' : 'U.S. House delegation';
      chambers[ch][p.party] = (chambers[ch][p.party] ?? 0) + 1;
    }
    if (id === 'NE') delete chambers['State House'];
  }
  return { offices, chambers };
}

/** Party of current holder for every feature in a map layer. */
export function holderMap(e: Engine, layer: 'states' | 'counties' | 'cd' | 'sldu' | 'sldl'): Record<string, Party> {
  const out: Record<string, Party> = {};
  for (const o of Object.values(e.s.offices)) {
    const p = e.pol(o.holder);
    if (!p) continue;
    const [t, a] = o.id.split(':');
    if (layer === 'states' && t === 'gov') out[e.data.states[a]?.fips] = p.party;
    else if (layer === 'cd' && t === 'house') out[a] = p.party;
    else if (layer === t) out[a] = p.party;
  }
  if (layer === 'counties') {
    const count: Record<string, Record<string, number>> = {};
    for (const o of Object.values(e.s.offices)) {
      const [t, a] = o.id.split(':');
      const p = e.pol(o.holder);
      if (t !== 'county' || !p) continue;
      (count[a] ??= {})[p.party] = (count[a][p.party] ?? 0) + 1;
    }
    for (const [a, c] of Object.entries(count)) out[a] = (c.D ?? 0) >= (c.R ?? 0) ? 'D' : 'R';
  }
  return out;
}

export function national(e: Engine) {
  const count = (prefix: string) => {
    const r: Record<string, number> = {};
    for (const o of Object.values(e.s.offices)) if (o.id.startsWith(prefix)) { const p = e.pol(o.holder); if (p) r[p.party] = (r[p.party] ?? 0) + 1; }
    return r;
  };
  const legis: Record<string, string> = {};
  for (const st of Object.keys(e.data.states)) {
    if (st === 'DC') continue;
    const ch = { u: { D: 0, R: 0 } as Record<string, number>, l: { D: 0, R: 0 } as Record<string, number> };
    for (const o of Object.values(e.s.offices)) {
      const [t, g] = o.id.split(':');
      if (t !== 'sldu' && t !== 'sldl') continue;
      if (e.data.districts[`${t}:${g}`]?.st !== st) continue;
      const p = e.pol(o.holder);
      if (p) ch[t === 'sldu' ? 'u' : 'l'][p.party] = (ch[t === 'sldu' ? 'u' : 'l'][p.party] ?? 0) + 1;
    }
    const ctrl = (x: Record<string, number>) => (x.D > x.R ? 'D' : x.R > x.D ? 'R' : 'S');
    const u = ctrl(ch.u), l = st === 'NE' ? u : ctrl(ch.l);
    legis[st] = u === l ? u : 'S';
  }
  return { house: count('house:'), senate: count('sen:'), governors: count('gov:'), legislatures: legis, pres: holderSummary(e, 'pres') };
}

export function view(e: Engine) {
  const s = e.s;
  const me = e.player;
  const P = s.player;
  const c = s.campaign;
  const def = c ? e.def(c.officeId) : null;
  const officeDef = me.officeId ? e.def(me.officeId) : null;
  const home = e.data.townSync(me.home);
  const campaign = c && def
    ? {
        ...c,
        title: def.title, type: def.type, level: def.level, jurName: def.jurName, jurKind: def.jur.kind, jurId: def.jur.id, st: def.st,
        expectedSpend: expectedSpend(def.type, def.pop), lean: e.jurUnit(def).lean, myRec: e.recIn(e.jurKey(def)),
        monthsToPrimary: c.stage === 'primary' ? (c.year - s.year) * 12 + c.primaryMonth - s.month : null,
        monthsToGeneral: (c.year - s.year) * 12 + genMonth(c) - s.month,
        presRace: presView(e, c),
        field: [...new Set([...(c.stage === 'primary' ? c.primaryField : c.generalField), ...(c.stage === 'primary' ? c.otherField : [])])].map((id) => {
          const p = e.pol(id)!;
          return {
            id, name: e.name(p), party: p.party, age: e.age(p), isPlayer: !!p.isPlayer, incumbent: p.officeId === c.officeId,
            incStrength: incumbencyStrength(e, p, def, c.year), incFactors: incumbencyFactors(e, p, def, c.year).map((f) => f.label),
            rec: p.isPlayer ? e.recIn(e.jurKey(def)) : c.rec[id] ?? p.rec, fav: p.fav, spend: c.spend[id] ?? 0, scandal: p.scandal, pos: p.pos, skills: p.skills,
            office: p.officeId ? e.def(p.officeId)?.title ?? null : null, rival: isRival(e, id), inMyPrimary: c.primaryField.includes(id) || c.stage === 'general', endorse: (c.endorse[id] ?? 0) + (p.isPlayer ? P.endorsements.length : 0),
          };
        }),
      }
    : null;
  return {
    year: s.year, month: s.month, monthName: monthName(s.month), seed: s.seed,
    me: {
      id: me.id, name: e.name(me), first: me.first, last: me.last, party: me.party, age: e.age(me), gender: me.gender, background: P.background,
      homeTown: home ? `${shortTownName(home.name)}, ${home.st}` : me.home, homeId: me.home, homeSt: home?.st ?? '', homeCounty: home?.county ?? '',
      office: officeDef ? { id: me.officeId!, title: officeDef.title, type: officeDef.type, level: officeDef.level, executive: officeDef.executive, official: !!officeDef.official, since: me.since, jurName: officeDef.jurName, nextElection: officeDef.ticket ? null : nextElection(me.officeId!, s.year, e.data) } : null,
      pos: me.pos, skills: me.skills, fav: me.fav, scandal: me.scandal, approval: approval(e), career: me.career, terms: me.terms,
    },
    player: { ...P, rec: undefined, recHome: e.recIn(me.home), recCounty: home ? e.recIn(home.county) : 0, recState: home ? e.recIn(home.st) : 0, recUS: e.recIn('US') },
    payroll: STAFF_ROLES.reduce((a, r) => a + staffCost(P.staff[r.key], Math.max(officeDef?.level ?? 1, def?.level ?? 1)), 0),
    campaign,
    world: s.world,
    news: s.news.slice(0, 80),
    decisions: s.decisions,
    history: s.history,
    results: s.results.slice(0, 10).map((r) => ({ ...r, units: [] })),
    pendingNight: s.pendingNight,
    lastNational: s.lastNational ? { ...s.lastNational, pres: s.lastNational.pres ? { ...s.lastNational.pres } : undefined } : null,
    gameOver: s.gameOver ?? null,
    summary: s.lastSummary ?? null,
    difficulty: s.difficulty,
    startYear: s.startYear,
    rivals: rivalsView(e),
    scandals: scandalView(e),
    redistricting: s.redistricting ? { census: s.redistricting.census, apportioned: s.redistricting.apportioned, plans: Object.fromEntries(Object.entries(s.redistricting.plans).map(([k, v]) => [k, v.plan])) } : null,
    tickets: s.tickets && s.tickets.year === s.year ? (['D', 'R'] as const).filter((p) => s.tickets![p]).map((p) => ({ party: p, pres: e.name(e.pol(s.tickets![p]!.pres)), vp: e.name(e.pol(s.tickets![p]!.vp)), mine: s.tickets![p]!.vp === me.id })) : null,
  };
}

/** Everything the Office tab needs about the player's legislature (or, for executives, the legislature they face). */
export function legislature(e: Engine) {
  const me = e.player;
  const P = e.s.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  if (!def) return null;
  const person = (id?: string) => {
    const p = e.pol(id);
    return p ? { id: p.id, name: e.name(p), party: p.party, isPlayer: !!p.isPlayer, seniority: seniority(e, p) } : null;
  };
  const info = (k: string) => {
    const l = ensureLeadership(e, k);
    return { key: k, label: chamberLabel(e, k), seats: seatCount(e, k), parties: partyCounts(members(e, k)), majorityParty: l.majorityParty, small: isSmall(k), partisan: isPartisanChamber(k) };
  };
  const leadersOf = (k: string) => {
    const l = ensureLeadership(e, k);
    const minParty = l.majorityParty === 'D' ? 'R' : 'D';
    const rows: { label: string; person: ReturnType<typeof person> }[] = [{ label: roleLabel(k, 'speaker'), person: person(l.speaker) }];
    if (!isSmall(k) && isPartisanChamber(k)) {
      rows.push({ label: `Majority Leader (${l.majorityParty})`, person: person(l.majority) }, { label: `Minority Leader (${minParty})`, person: person(l.minority) });
      rows.push({ label: 'Majority Whip', person: person(l.whip) }, { label: 'Minority Whip', person: person(l.minorityWhip) });
    }
    return rows.filter((r) => r.person);
  };
  const key = chamberKey(def);
  const execOf = (k: string) => {
    const x = executiveOf(k, e);
    const o = x ? e.ensureOffice(x) : null;
    const p = e.pol(o?.holder);
    return x ? { title: e.def(x)?.title ?? '', name: p ? e.name(p) : 'Vacant', party: p?.party ?? null } : null;
  };
  if (!key) {
    const chs = execChambers(def);
    return {
      kind: 'executive' as const, chamber: null, other: null, chambers: chs.map(info), exec: null,
      leaders: chs.flatMap((k) => leadersOf(k).slice(0, 3).map((r) => ({ ...r, label: `${chamberLabel(e, k)}: ${r.label}` }))),
      committees: [], role: null, bid: null, favors: 0, favorsPerMonth: 0, bidOptions: [], templates: [], bills: [], maxBills: 0, canSetCommittees: false,
    };
  }
  const l = ensureLeadership(e, key);
  const maj = me.party === l.majorityParty;
  const o = otherChamber(key);
  const lightBill = (b: NonNullable<typeof P.bills>[number]) => ({
    ...b,
    count: b.stage === 'law' || b.stage === 'dead' || b.stage === 'desk' ? null : billCount(e, b),
    hearingOdds: b.stage === 'committee' && !b.hearing ? hearingOdds(e, b) : null,
    chair: b.committee ? person(l.chairs[b.committee]) : null,
    committeeLabel: COMMITTEES.find((c) => c.key === b.committee)?.label ?? null,
  });
  return {
    kind: 'legislator' as const,
    chamber: info(key), other: o ? info(o) : null, chambers: [], exec: execOf(key),
    leaders: leadersOf(key),
    committees: isSmall(key) ? [] : COMMITTEES.map((c) => ({ key: c.key, label: c.label, chair: person(l.chairs[c.key]), mine: !!P.committees.includes(c.key), size: committeeMembers(e, key, c.key).length })),
    role: P.role && P.role.chamber === key ? { ...P.role, label: roleLabel(key, P.role.role, P.role.committee, maj) } : null,
    bid: P.bid ? { ...P.bid, label: roleLabel(key, P.bid.role, P.bid.committee, maj) } : null,
    favors: P.favors, favorsPerMonth: monthlyFavors(e),
    bidOptions: bidOptions(e),
    templates: billOptions(e),
    bills: P.bills.map(lightBill),
    maxBills: MAX_ACTIVE_BILLS,
    canSetCommittees: e.s.month <= 2 && !isSmall(key),
  };
}

/** Budget card data for executives. */
export function budgetView(e: Engine) {
  const me = e.player;
  const def = me.officeId ? e.def(me.officeId) : null;
  if (!def?.executive) return null;
  const P = e.s.player;
  const control = execChambers(def).map((k) => {
    const ms = members(e, k);
    return { label: chamberLabel(e, k), share: ms.length ? ms.filter((p) => p.party === me.party).length / ms.length : 1 };
  });
  const b = P.budget;
  const canSubmit = !b || b.year < e.s.year || !!b.note?.startsWith('Continuing');
  return { budget: b, canSubmit, control, targets: metricTargets(e, def), policies: P.policies };
}

/** Targets for unit-based actions in the current race (or home area). */
export async function targets(e: Engine): Promise<{ id: string; label: string; pop: number; rec: number }[]> {
  const me = e.player;
  const c = e.s.campaign;
  const def = c ? e.def(c.officeId)! : me.officeId ? e.def(me.officeId)! : null;
  const home = await e.data.town(me.home);
  if (!home) return [];
  const kind = def?.jur.kind ?? 'town';
  const r = (id: string) => e.recIn(id);
  if (kind === 'town') return [{ id: home.id, label: shortTownName(home.name), pop: home.pop, rec: r(home.id) }];
  if (kind === 'state' || kind === 'nation') {
    if (kind === 'nation') return Object.entries(e.data.states).map(([st, s]) => ({ id: st, label: s.n, pop: s.pop, rec: r(st) })).sort((a, b) => b.pop - a.pop);
    return Object.entries(e.data.counties).filter(([, x]) => x.st === def!.st).map(([f, x]) => ({ id: f, label: x.n, pop: x.d[0] ?? 0, rec: r(f) })).sort((a, b) => b.pop - a.pop);
  }
  const towns = await e.data.townsOf(home.st);
  const id = def!.jur.id;
  const inJur = towns.filter((t) => (kind === 'county' ? t.county === id : kind === 'cd' ? t.cd === id : kind === 'sldu' ? t.sldu === id : t.sldl === id));
  return inJur.slice(0, 150).map((t) => ({ id: t.id, label: shortTownName(t.name), pop: t.pop, rec: r(t.id) }));
}
