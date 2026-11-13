/**
 * Legislatures: chambers, committees, leadership, and the life of a bill.
 *
 * A chamber is identified by a key:
 *   council:{townId}  county:{fips}  sldl:{ST}  sldu:{ST}  house  senate
 * Members are whichever seats of that body are materialized (state legislatures and Congress always are;
 * a council or county board is materialized once the player joins it).
 *
 * Player bills: introduce → committee (needs a hearing from the chair, then a committee vote) → floor vote
 * → other chamber (bicameral bodies) → executive's desk → law, or veto → override (2/3 of both chambers).
 * Small bodies (councils, county boards) skip committee. Whipping converts persuadable members by spending
 * favors (or party standing when out of favors).
 */
import type { Engine, ActionResult } from './game';
import type { Bill, Decision, Leadership, Politician, RoleKind } from './model';
import type { OfficeDef } from './offices';
import type { Party } from '../data/types';
import { ISSUES, PARTY_BASE } from './issues';
import { GROUPS } from './campaign';
import { Rng, clamp, expit, hashStr } from './rng';
import { billTemplate, billTemplatesFor, describeGroupEffects } from './governing';
import { addShift, lawEcon } from './budget';

export const COMMITTEES = [
  { key: 'finance', label: 'Finance & Appropriations', issues: ['taxes', 'spending'] },
  { key: 'health', label: 'Health & Human Services', issues: ['health'] },
  { key: 'judiciary', label: 'Judiciary & Public Safety', issues: ['crime', 'guns', 'abortion', 'immigration'] },
  { key: 'energy', label: 'Energy & Environment', issues: ['energy'] },
  { key: 'education', label: 'Education', issues: ['education'] },
  { key: 'commerce', label: 'Commerce & Labor', issues: ['trade', 'labor'] },
  { key: 'housing', label: 'Housing & Local Government', issues: ['housing'] },
] as const;
export const committeeFor = (issue: string) => COMMITTEES.find((c) => (c.issues as readonly string[]).includes(issue))?.key ?? 'finance';
export const committeeLabel = (key?: string | null) => COMMITTEES.find((c) => c.key === key)?.label ?? 'Committee of the Whole';

/** Most bills a player can have moving at once. */
export const MAX_ACTIVE_BILLS = 3;
export const FAVOR_CAP = 40;

// ------------------------------------------------------------------ chambers

export function chamberKey(def: OfficeDef): string | null {
  switch (def.type) {
    case 'council': return `council:${def.jur.id}`;
    case 'county': return `county:${def.jur.id}`;
    case 'sldl':
    case 'sldu': return `${def.type}:${def.st}`;
    case 'house': return 'house';
    case 'senate': return 'senate';
  }
  return null;
}
/** Chambers an executive works with. */
export function execChambers(def: OfficeDef): string[] {
  if (def.type === 'mayor') return [`council:${def.jur.id}`];
  if (def.type === 'cexec') return [`county:${def.jur.id}`];
  if (def.type === 'governor') return def.st === 'NE' ? ['sldu:NE'] : [`sldl:${def.st}`, `sldu:${def.st}`];
  if (def.type === 'president') return ['house', 'senate'];
  return [];
}
export function otherChamber(key: string): string | null {
  const [t, a] = key.split(':');
  if (t === 'house') return 'senate';
  if (t === 'senate') return 'house';
  if (t === 'sldl') return `sldu:${a}`;
  if (t === 'sldu') return a === 'NE' ? null : `sldl:${a}`;
  return null;
}
export function executiveOf(key: string, e?: Engine): string | null {
  const [t, a] = key.split(':');
  if (t === 'council') return `mayor:${a}`;
  // counties with an elected executive (TX/KY everywhere, big counties elsewhere) send bills to them
  if (t === 'county') return e?.def(`cexec:${a}`) ? `cexec:${a}` : null;
  if (t === 'sldl' || t === 'sldu') return `gov:${a}`;
  if (t === 'house' || t === 'senate') return 'pres';
  return null;
}
export const isSmall = (key: string) => key.startsWith('council:') || key.startsWith('county:');
export const isPartisanChamber = (key: string) => !key.startsWith('council:') && key !== 'sldu:NE';

/** Scope of laws a chamber passes (for templates and economic weight). */
export function chamberScope(key: string) {
  const t = key.split(':')[0];
  return t === 'council' ? 'local' : t === 'county' ? 'county' : t === 'house' || t === 'senate' ? 'federal' : 'state';
}

/** Seated members of a chamber. */
export function members(e: Engine, key: string): Politician[] {
  const [t, a] = key.split(':');
  const prefix = t === 'house' ? 'house:' : t === 'senate' ? 'sen:' : t === 'council' || t === 'county' ? `${t}:${a}:` : `${t}:`;
  const out: Politician[] = [];
  for (const o of Object.values(e.s.offices)) {
    if (!o.holder || !o.id.startsWith(prefix)) continue;
    if ((t === 'sldl' || t === 'sldu') && e.data.districts[o.id]?.st !== a) continue;
    const p = e.s.politicians[o.holder];
    if (p) out.push(p);
  }
  return out;
}
export function seatCount(e: Engine, key: string) {
  const [t, a] = key.split(':');
  const prefix = t === 'house' ? 'house:' : t === 'senate' ? 'sen:' : t === 'council' || t === 'county' ? `${t}:${a}:` : `${t}:`;
  let n = 0;
  for (const o of Object.values(e.s.offices)) if (o.id.startsWith(prefix) && (!(t === 'sldl' || t === 'sldu') || e.data.districts[o.id]?.st === a)) n++;
  return n;
}

export function chamberLabel(e: Engine, key: string): string {
  const [t, a] = key.split(':');
  if (t === 'house') return 'U.S. House';
  if (t === 'senate') return 'U.S. Senate';
  if (t === 'council') {
    const d = e.def(`council:${a}:0`);
    return d ? `${d.jurName.split(',')[0]} ${d.title.replace(/, Seat \d+$/, '')}` : 'Council';
  }
  if (t === 'county') {
    const c = e.data.counties[a];
    return c ? `${c.n} ${c.st === 'LA' ? 'Parish Council' : 'Commission'}` : 'County Commission';
  }
  const st = e.data.states[a]?.n ?? a;
  for (const o of Object.keys(e.s.offices)) {
    if (!o.startsWith(`${t}:`) || e.data.districts[o]?.st !== a) continue;
    const d = e.def(o);
    if (d) return `${st} ${d.title.split(',')[0]}`;
  }
  return `${st} ${t === 'sldu' ? 'State Senate' : 'State House'}`;
}

export function roleLabel(key: string, role: RoleKind, committee?: string, majority = true): string {
  const t = key.split(':')[0];
  switch (role) {
    case 'speaker':
      return t === 'council' ? 'Council President' : t === 'county' ? 'Board Chair' : t === 'sldu' || t === 'senate' ? 'President pro tempore' : 'Speaker';
    case 'majority': return 'Majority Leader';
    case 'minority': return 'Minority Leader';
    case 'whip': return majority ? 'Majority Whip' : 'Minority Whip';
    case 'chair': return `Chair, ${committeeLabel(committee)}`;
  }
}

export function partyCounts(ps: Politician[]) {
  const c: Record<string, number> = {};
  for (const p of ps) c[p.party] = (c[p.party] ?? 0) + 1;
  return c;
}
function majorityOf(ps: Politician[], fallback: Party): Party {
  const c = partyCounts(ps);
  const best = (Object.entries(c) as [Party, number][]).sort((a, b) => b[1] - a[1]);
  if (!best.length) return fallback;
  if (best.length > 1 && best[0][1] === best[1][1]) return fallback;
  return best[0][0];
}

export const seniority = (e: Engine, p: Politician) => Math.max(0, e.s.year - (p.since ?? e.s.year));
const tieBreak = (e: Engine, tag: string, id: string) => hashStr(`${e.s.seed}|${tag}|${id}`) / 4294967296;

/** The chamber the player sits in (null for executives and private citizens). */
export function playerChamber(e: Engine): string | null {
  const id = e.player.officeId;
  const def = id ? e.def(id) : null;
  return def ? chamberKey(def) : null;
}

// ------------------------------------------------------------------ leadership

/**
 * Leadership of a chamber, kept in the save for chambers the player deals with. Slots are refilled lazily
 * when their holder leaves, and the majority's posts change hands when control flips.
 */
export function ensureLeadership(e: Engine, key: string): Leadership {
  const L = e.s.leadership;
  const ms = members(e, key);
  const prevMaj = L[key]?.majorityParty;
  const majorityParty = majorityOf(ms, prevMaj ?? e.player.party);
  let l = L[key];
  if (!l) l = L[key] = { chamber: key, year: e.s.year, majorityParty, chairs: {} };
  if (l.majorityParty !== majorityParty) {
    l.majorityParty = majorityParty;
    l.speaker = l.majority = l.whip = undefined;
    [l.minority, l.minorityWhip] = [undefined, undefined];
    l.chairs = {};
  }
  const me = e.player;
  const P = e.s.player;
  const inChamber = new Set(ms.map((p) => p.id));
  const role = P.role && P.role.chamber === key ? P.role : null;
  const used = new Set<string>();
  const minorityParty = (Object.entries(partyCounts(ms)) as [Party, number][]).filter(([p]) => p !== majorityParty).sort((a, b) => b[1] - a[1])[0]?.[0];
  const pick = (party: Party | undefined, cur: string | undefined, tag: string, pool?: Politician[]): string | undefined => {
    if (!party) return undefined;
    if (cur && inChamber.has(cur) && !used.has(cur) && e.s.politicians[cur]?.party === party && !e.s.politicians[cur]?.isPlayer) {
      used.add(cur);
      return cur;
    }
    const cands = (pool ?? ms).filter((p) => p.party === party && !p.isPlayer && !used.has(p.id));
    cands.sort((a, b) => seniority(e, b) - seniority(e, a) || tieBreak(e, tag, a.id) - tieBreak(e, tag, b.id));
    const id = cands[0]?.id;
    if (id) used.add(id);
    return id;
  };
  const playerSlot = (r: RoleKind, committee?: string) => role && role.role === r && (r !== 'chair' || role.committee === committee);
  const majSide = me.party === majorityParty;
  if (playerSlot('speaker')) { l.speaker = me.id; used.add(me.id); } else l.speaker = pick(majorityParty, l.speaker, 'spk');
  if (!isSmall(key) && isPartisanChamber(key)) {
    l.majority = playerSlot('majority') ? me.id : pick(majorityParty, l.majority, 'maj');
    l.minority = playerSlot('minority') ? me.id : pick(minorityParty, l.minority, 'min');
    l.whip = playerSlot('whip') && majSide ? me.id : pick(majorityParty, l.whip, 'whip');
    l.minorityWhip = playerSlot('whip') && !majSide ? me.id : pick(minorityParty, l.minorityWhip, 'mwhip');
  }
  if (!isSmall(key)) {
    for (const c of COMMITTEES) l.chairs[c.key] = playerSlot('chair', c.key) ? me.id : pick(majorityParty, l.chairs[c.key], `ch-${c.key}`)!;
  }
  return l;
}

/** Members of a committee (whole chamber for small bodies). Deterministic from the seat holders. */
export function committeeMembers(e: Engine, key: string, committee: string | null): Politician[] {
  const ms = members(e, key);
  if (isSmall(key) || !committee) return ms;
  const l = ensureLeadership(e, key);
  const size = Math.max(5, Math.min(25, Math.round(ms.length * 0.15) | 1));
  const maj = ms.filter((p) => p.party === l.majorityParty);
  const min = ms.filter((p) => p.party !== l.majorityParty);
  const share = maj.length / Math.max(1, ms.length);
  const majN = clamp(Math.round(size * share) + (share > 0.5 ? 1 : 0), Math.ceil(size / 2), Math.min(size, maj.length));
  const P = e.s.player;
  const order = (xs: Politician[]) =>
    [...xs].sort((a, b) => rank(a) - rank(b) || tieBreak(e, `cm|${key}|${committee}`, a.id) - tieBreak(e, `cm|${key}|${committee}`, b.id));
  const rank = (p: Politician) => (p.id === l.chairs[committee] ? -2 : p.isPlayer && P.committees.includes(committee) ? -1 : 0);
  return [...order(maj).slice(0, majN), ...order(min).slice(0, size - majN)];
}

export function committeeChair(e: Engine, key: string, committee: string | null): Politician | undefined {
  if (!committee || isSmall(key)) return undefined;
  return e.pol(ensureLeadership(e, key).chairs[committee]);
}

// ------------------------------------------------------------------ support & votes

/** Party whose platform the bill's direction matches. */
export const sponsorPartyFor = (issue: string, dir: number): Party => {
  const i = ISSUES.findIndex((x) => x.key === issue);
  return Math.sign(PARTY_BASE.R[i]) === Math.sign(dir) ? 'R' : 'D';
};

/**
 * How much a member wants to vote yes (>0 = yes). Issue agreement, party loyalty to the sponsor's side,
 * leadership pull, and a fixed personal quirk per member and bill.
 */
export function support(e: Engine, p: Politician, b: { id: string; issue: string; dir: number }, sponsorParty: Party, key: string, committee = false): number {
  const i = ISSUES.findIndex((x) => x.key === b.issue);
  const partisan = isPartisanChamber(key) ? 1 : 0.5;
  const quirk = (tieBreak(e, `sup|${b.id}`, p.id) - 0.5) * 0.3;
  let s = p.pos[i] * b.dir + (p.party === sponsorParty ? 0.12 : -0.1) * partisan + quirk;
  // the player's leadership post pulls their own side
  const role = e.s.player.role;
  if (role && role.chamber === key && p.party === e.player.party && sponsorParty === e.player.party) {
    if (role.role === 'speaker' || role.role === 'majority') s += 0.08;
    else if (role.role === 'minority') s += 0.05;
    else if (committee && role.role === 'chair') s += 0.1;
  }
  return s;
}

export interface WhipCount {
  body: string;
  yes: number;
  whipped: number;
  persuadable: number;
  no: number;
  total: number;
  needed: number;
}

/** Votes for a bill in a body. `twoThirds` for overrides. The player (sponsor) always votes yes. */
export function countVotes(e: Engine, bill: Bill, key: string, opts: { committee?: string | null; twoThirds?: boolean; label?: string } = {}) {
  const body = opts.committee !== undefined ? committeeMembers(e, key, opts.committee) : members(e, key);
  const me = e.player;
  let yes = 0, whipped = 0, no = 0;
  const persuadable: { p: Politician; s: number }[] = [];
  for (const p of body) {
    if (p.isPlayer) { yes++; continue; }
    const s = support(e, p, bill, me.party, key, opts.committee != null);
    if (bill.whipped.includes(p.id)) { yes++; whipped++; continue; }
    if (s > 0) yes++;
    else {
      no++;
      if (s > -0.3) persuadable.push({ p, s });
    }
  }
  const total = yes + no;
  const needed = opts.twoThirds ? Math.ceil((total * 2) / 3) : Math.floor(total / 2) + 1;
  persuadable.sort((a, b) => b.s - a.s);
  return {
    count: { body: opts.label ?? chamberLabel(e, key), yes, whipped, persuadable: persuadable.length, no, total, needed } as WhipCount,
    persuadable,
    passes: total > 0 && yes >= needed,
  };
}

/**
 * Vote on an AI-written bill in a chamber (decisions the player votes on or signs). With `playerVote` null, a seated
 * player votes like any other member; 'present' leaves them out of the count.
 */
export function aiChamberVote(e: Engine, key: string, issue: string, dir: number, tag: string, playerVote: 'yes' | 'no' | 'present' | null, twoThirds = false) {
  const sponsor = sponsorPartyFor(issue, dir);
  let yes = 0, no = 0;
  for (const p of members(e, key)) {
    if (p.isPlayer && playerVote) {
      if (playerVote === 'yes') yes++;
      else if (playerVote === 'no') no++;
      continue;
    }
    support(e, p, { id: tag, issue, dir }, sponsor, key) > 0 ? yes++ : no++;
  }
  const total = yes + no;
  return { yes, no, passes: total > 0 && (twoThirds ? yes >= Math.ceil((total * 2) / 3) : yes > no) };
}

/** Would the executive sign? Uses the AI officeholder's positions and party. */
export function executiveSigns(e: Engine, execOffice: string | null, issue: string, dir: number, tag: string): { signs: boolean; title: string; name: string } | null {
  if (!execOffice) return null;
  const o = e.ensureOffice(execOffice);
  const def = e.def(execOffice);
  const x = e.pol(o?.holder);
  if (!def || !x) return { signs: true, title: def?.title ?? 'The executive', name: 'The vacant office' };
  const i = ISSUES.findIndex((k) => k.key === issue);
  const s = x.pos[i] * dir + (x.party === sponsorPartyFor(issue, dir) ? 0.15 : -0.15) + (tieBreak(e, `exec|${tag}`, x.id) - 0.5) * 0.2;
  return { signs: s > -0.1, title: def.title.replace(/ of .*$/, ''), name: e.name(x) };
}

// ------------------------------------------------------------------ favors & roles

export function monthlyFavors(e: Engine): number {
  const ch = playerChamber(e);
  if (!ch) return 0;
  const r = e.s.player.role?.chamber === ch ? e.s.player.role.role : null;
  return 1 + (r === 'speaker' ? 3 : r === 'majority' || r === 'minority' ? 2 : r ? 1 : 0);
}

/** Pay `n` favors, falling back to party standing (3 per favor). Returns false if the player can't afford it. */
export function spendFavors(e: Engine, n: number): boolean {
  const P = e.s.player;
  const have = P.favors;
  if (have >= n) { P.favors = have - n; return true; }
  const short = n - have;
  if (P.partyStanding < short * 3 + 5) return false;
  P.favors = 0;
  P.partyStanding = clamp(P.partyStanding - short * 3, 0, 100);
  return true;
}

interface BidOption { role: RoleKind; committee?: string; label: string; ok: boolean; reason?: string; odds: number; rival?: string }

function rivalFor(e: Engine, key: string, role: RoleKind, committee?: string): Politician | undefined {
  const l = ensureLeadership(e, key);
  const majSide = e.player.party === l.majorityParty;
  const id = role === 'speaker' ? l.speaker : role === 'majority' ? l.majority : role === 'minority' ? l.minority : role === 'whip' ? (majSide ? l.whip : l.minorityWhip) : l.chairs[committee!];
  return e.pol(id);
}

function bidScores(e: Engine, key: string, role: RoleKind, committee?: string) {
  const P = e.s.player;
  const me = e.player;
  const ps = 0.25 + P.partyStanding / 200 + Math.min(0.35, 0.07 * seniority(e, me)) + Math.min(0.2, P.favors * 0.01) + (me.skills.charisma - 50) / 400;
  const rival = rivalFor(e, key, role, committee);
  const extra = { speaker: 0.15, majority: 0.1, minority: 0.1, whip: 0, chair: -0.05 }[role];
  const rs = rival && !rival.isPlayer ? 0.45 + Math.min(0.35, 0.07 * seniority(e, rival)) + 0.12 + extra : 0.3 + extra;
  return { ps, rs, rival: rival && !rival.isPlayer ? rival : undefined };
}

export function bidOptions(e: Engine): BidOption[] {
  const key = playerChamber(e);
  if (!key) return [];
  const P = e.s.player;
  const me = e.player;
  const l = ensureLeadership(e, key);
  const maj = me.party === l.majorityParty;
  const sen = seniority(e, me);
  const opts: { role: RoleKind; committee?: string; req: string | null }[] = [];
  if (isSmall(key)) opts.push({ role: 'speaker', req: sen < 1 ? 'Serve a year first' : P.partyStanding < 35 ? 'Party standing 35+' : null });
  else {
    const partisan = isPartisanChamber(key);
    opts.push({ role: 'speaker', req: partisan && !maj ? 'Your party is in the minority' : sen < 2 ? 'Serve two years first' : P.partyStanding < 60 ? 'Party standing 60+' : null });
    if (partisan) {
      opts.push(maj ? { role: 'majority', req: sen < 2 ? 'Serve two years first' : P.partyStanding < 50 ? 'Party standing 50+' : null } : { role: 'minority', req: sen < 2 ? 'Serve two years first' : P.partyStanding < 50 ? 'Party standing 50+' : null });
      opts.push({ role: 'whip', req: P.partyStanding < 45 ? 'Party standing 45+' : null });
    }
    for (const c of P.committees) opts.push({ role: 'chair', committee: c, req: partisan && !maj ? 'Your party is in the minority' : sen < 1 && P.partyStanding < 65 ? 'Serve a year (or party standing 65+)' : null });
  }
  return opts
    .filter((o) => !(P.role && P.role.chamber === key && P.role.role === o.role && P.role.committee === o.committee))
    .map((o) => {
      const { ps, rs, rival } = bidScores(e, key, o.role, o.committee);
      return { role: o.role, committee: o.committee, label: roleLabel(key, o.role, o.committee, maj), ok: !o.req, reason: o.req ?? undefined, odds: o.req ? 0 : round2(expit((ps - rs) / 0.07)), rival: rival ? e.name(rival) : undefined };
    });
}

export function placeBid(e: Engine, role: RoleKind, committee?: string): ActionResult {
  const opt = bidOptions(e).find((o) => o.role === role && (o.committee ?? undefined) === (committee || undefined));
  if (!opt) return { ok: false, msg: 'That post is not open to you.' };
  if (!opt.ok) return { ok: false, msg: opt.reason ?? 'Not eligible.' };
  e.s.player.bid = { role, committee };
  return { ok: true, msg: `You are running for ${opt.label}. The caucus votes at the end of January (odds now about ${Math.round(opt.odds * 100)}%).` };
}

/** End of January: the caucus votes on the player's bid. */
export function resolveBid(e: Engine) {
  const P = e.s.player;
  const bid = P.bid;
  if (!bid) return;
  P.bid = null;
  const key = playerChamber(e);
  if (!key) return;
  const opt = bidOptions(e).find((o) => o.role === bid.role && o.committee === bid.committee);
  if (!opt || !opt.ok) {
    e.news({ kind: 'office', title: `Your bid for ${opt?.label ?? 'leadership'} fizzled`, body: opt?.reason, tone: 'bad' });
    return;
  }
  const rng = new Rng(`${e.s.seed}|bid|${key}|${e.s.year}|${bid.role}|${bid.committee ?? ''}`);
  const { ps, rs, rival } = bidScores(e, key, bid.role, bid.committee);
  const won = ps + rng.normal(0, 0.05) > rs + rng.normal(0, 0.05);
  if (won) {
    P.role = { chamber: key, role: bid.role, committee: bid.committee, since: e.s.year };
    P.favors = Math.floor(P.favors * 0.67);
    P.partyStanding = clamp(P.partyStanding + 4, 0, 100);
    ensureLeadership(e, key);
    e.news({ kind: 'office', title: `${e.name(e.player)} elected ${opt.label}`, body: rival ? `The caucus chose ${e.name(e.player)} over ${e.name(rival)}.` : undefined, tone: 'good' });
    e.bumpRec(e.jurKey(e.def(e.player.officeId!)!), bid.role === 'speaker' ? 0.08 : 0.04);
  } else {
    P.partyStanding = clamp(P.partyStanding - 2, 0, 100);
    e.news({ kind: 'office', title: `${e.name(e.player)} loses bid for ${opt.label}`, body: rival ? `${e.name(rival)} keeps the post.` : undefined, tone: 'bad' });
  }
}

/** January: check the player's post still makes sense (still in the chamber, party still in the majority). */
export function reviewRole(e: Engine) {
  const P = e.s.player;
  const key = playerChamber(e);
  if (!P.role) return;
  if (P.role.chamber !== key) { P.role = null; return; }
  const l = ensureLeadership(e, key);
  const maj = e.player.party === l.majorityParty;
  if (!isPartisanChamber(key) || isSmall(key)) return;
  const r = P.role.role;
  if (!maj && (r === 'speaker' || r === 'majority')) {
    P.role = { ...P.role, role: 'minority', since: e.s.year };
    e.news({ kind: 'office', title: `Your party loses the majority; you become Minority Leader`, tone: 'bad' });
  } else if (!maj && r === 'chair') {
    P.role = null;
    e.news({ kind: 'office', title: `Your party loses the majority, and with it your committee gavel`, tone: 'bad' });
  } else if (maj && r === 'minority') {
    P.role = { ...P.role, role: 'majority', since: e.s.year };
    e.news({ kind: 'office', title: `Your party wins the majority; you become Majority Leader`, tone: 'good' });
  }
  ensureLeadership(e, key);
}

const BG_COMMITTEE: Record<string, string> = { teacher: 'education', lawyer: 'judiciary', business: 'commerce', veteran: 'judiciary', doctor: 'health', activist: 'housing', farmer: 'energy', union: 'commerce', pastor: 'health', police: 'judiciary' };
export const defaultCommittees = (background: string) => [...new Set([BG_COMMITTEE[background] ?? 'commerce', 'finance'])];

export function setCommittees(e: Engine, list: string[]): ActionResult {
  const key = playerChamber(e);
  if (!key || isSmall(key)) return { ok: false, msg: 'Your body has no standing committees.' };
  if (e.s.month > 2) return { ok: false, msg: 'Committee assignments are made in January and February.' };
  const clean = [...new Set(list)].filter((c) => COMMITTEES.some((x) => x.key === c)).slice(0, 2);
  if (!clean.length) return { ok: false, msg: 'Pick at least one committee.' };
  const P = e.s.player;
  P.committees = clean;
  if (P.role?.role === 'chair' && !clean.includes(P.role.committee!)) {
    P.role = null;
    e.news({ kind: 'office', title: 'You gave up your committee gavel', tone: 'neutral' });
  }
  return { ok: true, msg: `Committees: ${clean.map(committeeLabel).join(', ')}.` };
}

// ------------------------------------------------------------------ the player's bills

export function billOptions(e: Engine) {
  const key = playerChamber(e);
  if (!key) return [];
  return billTemplatesFor(chamberScope(key) as any);
}

export function introduceBill(e: Engine, issue: string, dir: 1 | -1, templateId?: string): ActionResult {
  const key = playerChamber(e);
  if (!key) return { ok: false, msg: 'Only legislators introduce bills.' };
  const P = e.s.player;
  const me = e.player;
  const active = P.bills.filter((b) => b.stage !== 'law' && b.stage !== 'dead');
  if (active.length >= MAX_ACTIVE_BILLS) return { ok: false, msg: `You already have ${MAX_ACTIVE_BILLS} bills moving. Finish or withdraw one first.` };
  if (P.ap < 2) return { ok: false, msg: 'Drafting a bill takes 2 action points.' };
  const i = ISSUES.findIndex((x) => x.key === issue);
  if (i < 0 || (dir !== 1 && dir !== -1)) return { ok: false, msg: 'Pick an issue and a direction.' };
  const tpl = templateId ? billTemplate(templateId) : null;
  if (tpl && (tpl.issue !== issue || tpl.dir !== dir || !billOptions(e).some((b) => b.id === tpl.id))) return { ok: false, msg: 'That bill does not fit this body.' };
  if (tpl && active.some((b) => b.templateId === tpl.id)) return { ok: false, msg: 'You already have that bill moving.' };
  const iss = ISSUES[i];
  const groups: Record<string, number> = {};
  if (!tpl) for (const g of GROUPS) { const v = (g.pos as Record<string, number>)[issue]; if (v) groups[g.key] = Math.round(30 * Math.sign(v) * dir); }
  const small = isSmall(key);
  const committee = small ? null : committeeFor(issue);
  const l = ensureLeadership(e, key);
  const role = P.role?.chamber === key ? P.role : null;
  const fastTrack = !!role && (role.role === 'speaker' || role.role === 'majority' || (role.role === 'chair' && role.committee === committee));
  const now = { year: e.s.year, month: e.s.month };
  const b: Bill = {
    id: e.newId('b'),
    templateId: tpl?.id ?? null,
    issue, dir,
    title: tpl?.title.replace('{J}', e.def(me.officeId!)!.jurName) ?? `${iss.label} Act: ${dir < 0 ? iss.left : iss.right}`,
    body: tpl?.body ?? `Moves ${iss.label.toLowerCase()} policy ${dir < 0 ? 'to the left' : 'to the right'}: ${(dir < 0 ? iss.left : iss.right).toLowerCase()}.`,
    chamber: key, committee, stage: committee ? 'committee' : 'floor', introduced: now, stageSince: now, whipped: [],
    hearing: fastTrack || undefined,
    log: [{ ...now, text: committee ? `Introduced and referred to the ${committeeLabel(committee)} Committee${fastTrack ? ' (fast-tracked by leadership)' : ''}.` : 'Introduced and placed on the agenda.' }],
    metrics: tpl?.metrics, groups: tpl?.groups ?? groups,
  };
  P.bills.unshift(b);
  P.ap -= 2;
  me.pos[i] = Math.round(clamp(me.pos[i] + 0.03 * dir, -1, 1) * 100) / 100;
  P.emphasis[i] = clamp(P.emphasis[i] + 0.15);
  P.record.unshift({ year: now.year, month: now.month, title: b.title, choice: 'Introduced' });
  e.news({ kind: 'office', title: `${e.name(me)} introduces "${b.title}"`, body: committee ? `Referred to the ${committeeLabel(committee)} Committee, chaired by ${e.name(e.pol(l.chairs[committee]))}.` : undefined, tone: 'neutral' });
  return { ok: true, msg: `Introduced "${b.title}".` };
}

const monthsIn = (e: Engine, b: Bill) => (e.s.year - b.stageSince.year) * 12 + e.s.month - b.stageSince.month;
const enteredThisMonth = (e: Engine, b: Bill) => b.stageSince.year === e.s.year && b.stageSince.month === e.s.month;

function setStage(e: Engine, b: Bill, stage: Bill['stage'], text: string, tone?: 'good' | 'bad' | 'neutral') {
  b.stage = stage;
  b.stageSince = { year: e.s.year, month: e.s.month };
  b.log.push({ year: e.s.year, month: e.s.month, text, tone });
  if (stage === 'floor' || stage === 'second') b.lobbied = undefined;
}

export function hearingOdds(e: Engine, b: Bill): number {
  if (b.stage !== 'committee') return 0;
  if (b.hearing) return 1;
  const chair = committeeChair(e, b.chamber, b.committee);
  if (!chair) return 0.6 + (b.lobbied ?? 0);
  const me = e.player;
  const s = support(e, chair, b, me.party, b.chamber);
  return round2(clamp(0.25 + s * 1.2 + (chair.party === me.party ? 0.2 : -0.15) + e.s.player.partyStanding / 400 + (b.lobbied ?? 0), 0.03, 0.97));
}

/** The body whose votes matter at the bill's current stage. */
function stageBody(e: Engine, b: Bill): { key: string; committee?: string | null; twoThirds?: boolean; costMult: number } | null {
  switch (b.stage) {
    case 'committee': return { key: b.chamber, committee: b.committee, costMult: 1 };
    case 'floor': return { key: b.chamber, costMult: 1 };
    case 'second': { const o = otherChamber(b.chamber); return o ? { key: o, costMult: 2 } : null; }
    case 'vetoed': {
      const own = countVotes(e, b, b.chamber, { twoThirds: true });
      const o = otherChamber(b.chamber);
      if (own.passes && o) return { key: o, twoThirds: true, costMult: 2 };
      return { key: b.chamber, twoThirds: true, costMult: 1 };
    }
  }
  return null;
}

/** Whip count for the bill's current stage (for the UI). */
export function billCount(e: Engine, b: Bill): WhipCount | null {
  const body = stageBody(e, b);
  if (!body) return null;
  const r = countVotes(e, b, body.key, { committee: body.committee, twoThirds: body.twoThirds, label: body.committee ? `${committeeLabel(body.committee)} Committee` : undefined });
  return r.count;
}

export type BillAction = 'lobby' | 'whip' | 'vote' | 'override' | 'withdraw';

export function billAction(e: Engine, billId: string, action: BillAction): ActionResult {
  const P = e.s.player;
  const me = e.player;
  const b = P.bills.find((x) => x.id === billId);
  if (!b || b.stage === 'law' || b.stage === 'dead') return { ok: false, msg: 'That bill is no longer moving.' };
  if (playerChamber(e) !== b.chamber) return { ok: false, msg: 'You no longer sit in that chamber.' };
  const now = { year: e.s.year, month: e.s.month };
  const role = P.role?.chamber === b.chamber ? P.role.role : null;
  switch (action) {
    case 'withdraw':
      setStage(e, b, 'dead', 'Withdrawn by the sponsor.', 'bad');
      return { ok: true, msg: `Withdrew "${b.title}".` };
    case 'lobby': {
      if (b.stage !== 'committee' || b.hearing) return { ok: false, msg: 'The bill is not waiting on a hearing.' };
      if ((b.lobbied ?? 0) >= 0.6) return { ok: false, msg: 'You have pressed the chair as far as you can.' };
      if (P.ap < 1) return { ok: false, msg: 'Not enough action points.' };
      if (!spendFavors(e, 2)) return { ok: false, msg: 'You need 2 favors (or 6 party standing) to lean on the chair.' };
      P.ap -= 1;
      b.lobbied = (b.lobbied ?? 0) + 0.3;
      b.log.push({ ...now, text: 'You lobbied the committee chair for a hearing.' });
      return { ok: true, msg: `You leaned on the chair. Hearing odds this month: ${Math.round(hearingOdds(e, b) * 100)}%.` };
    }
    case 'whip': {
      const body = stageBody(e, b);
      if (!body || b.stage === 'desk') return { ok: false, msg: 'Nothing to whip at this stage.' };
      if (b.stage === 'committee' && !b.hearing) return { ok: false, msg: 'Get a hearing first.' };
      if (P.ap < 1) return { ok: false, msg: 'Not enough action points.' };
      const r = countVotes(e, b, body.key, { committee: body.committee, twoThirds: body.twoThirds });
      if (r.passes) return { ok: false, msg: `You already have the votes (${r.count.yes} of ${r.count.needed} needed).` };
      if (!r.persuadable.length) return { ok: false, msg: 'Nobody left who can be persuaded.' };
      P.ap -= 1;
      const rng = e.rng;
      const got: string[] = [];
      let spent = 0, tried = 0;
      for (const { p, s } of r.persuadable) {
        if (tried >= 3 || r.count.yes + got.length >= r.count.needed) break;
        tried++;
        const cost = Math.max(1, Math.round((p.party === me.party ? 1 : 2) * body.costMult * (role === 'whip' ? 0.5 : 1)));
        const pr = clamp(0.65 + me.skills.charisma / 400 + (role === 'whip' ? 0.15 : role ? 0.08 : 0) + s, 0.2, 0.95);
        if (!rng.chance(pr)) continue;
        if (!spendFavors(e, cost)) break;
        b.whipped.push(p.id);
        got.push(e.name(p));
        spent += cost;
      }
      const msg = got.length ? `Won over ${got.join(', ')} (${spent} favor${spent === 1 ? '' : 's'}).` : tried ? 'Nobody budged this time.' : 'You are out of favors and party standing to trade.';
      b.log.push({ ...now, text: `Whipping: ${msg}` });
      const after = countVotes(e, b, body.key, { committee: body.committee, twoThirds: body.twoThirds });
      return { ok: got.length > 0, msg: `${msg} Count: ${after.count.yes}/${after.count.needed}.` };
    }
    case 'vote': {
      if (b.stage !== 'floor') return { ok: false, msg: 'The bill is not on the floor.' };
      if (P.ap < 1) return { ok: false, msg: 'Not enough action points.' };
      P.ap -= 1;
      return { ok: true, msg: floorVote(e, b) };
    }
    case 'override': {
      if (b.stage !== 'vetoed') return { ok: false, msg: 'There is no veto to override.' };
      if (P.ap < 1) return { ok: false, msg: 'Not enough action points.' };
      P.ap -= 1;
      const own = countVotes(e, b, b.chamber, { twoThirds: true });
      const o = otherChamber(b.chamber);
      const other = o ? countVotes(e, b, o, { twoThirds: true }) : null;
      const tally = `${own.count.yes}–${own.count.total - own.count.yes}${other ? `, ${other.count.yes}–${other.count.total - other.count.yes}` : ''}`;
      if (own.passes && (!other || other.passes)) {
        b.lastVote = { label: 'Override', yes: own.count.yes, no: own.count.total - own.count.yes, needed: own.count.needed };
        enact(e, b, `Veto overridden (${tally}).`);
        P.partyStanding = clamp(P.partyStanding + 3, 0, 100);
        return { ok: true, msg: `Override succeeded (${tally}). "${b.title}" is law.` };
      }
      setStage(e, b, 'dead', `Override failed (${tally}; two-thirds needed).`, 'bad');
      e.news({ kind: 'office', title: `Override of veto on "${b.title}" falls short`, tone: 'bad' });
      return { ok: false, msg: `Override failed (${tally}).` };
    }
  }
  return { ok: false, msg: 'Unknown action.' };
}

function floorVote(e: Engine, b: Bill): string {
  const r = countVotes(e, b, b.chamber);
  b.lastVote = { label: 'Floor', yes: r.count.yes, no: r.count.no, needed: r.count.needed };
  const P = e.s.player;
  if (!r.passes) {
    setStage(e, b, 'dead', `Failed on the floor, ${r.count.yes}–${r.count.no}.`, 'bad');
    P.metrics.effectiveness = (P.metrics.effectiveness ?? 50) - 2;
    e.news({ kind: 'office', title: `"${b.title}" fails ${r.count.yes}–${r.count.no}`, tone: 'bad' });
    return `The bill failed ${r.count.yes}–${r.count.no}.`;
  }
  P.metrics.effectiveness = (P.metrics.effectiveness ?? 50) + 1;
  const o = otherChamber(b.chamber);
  if (o) {
    setStage(e, b, 'second', `Passed the floor ${r.count.yes}–${r.count.no}; sent to the ${chamberLabel(e, o)}.`, 'good');
    return `Passed ${r.count.yes}–${r.count.no}. On to the ${chamberLabel(e, o)}.`;
  }
  if (executiveOf(b.chamber, e)) {
    setStage(e, b, 'desk', `Passed ${r.count.yes}–${r.count.no}; sent to the ${e.def(executiveOf(b.chamber, e)!)?.title.replace(/ of .*$/, '') ?? 'executive'}.`, 'good');
    return `Passed ${r.count.yes}–${r.count.no}. Now it needs a signature.`;
  }
  enact(e, b, `Adopted ${r.count.yes}–${r.count.no}.`);
  return `Adopted ${r.count.yes}–${r.count.no}. "${b.title}" takes effect.`;
}

/** Economic weight of a body's laws on the national economy. */
export function econWeight(e: Engine, key: string) {
  const scope = chamberScope(key);
  if (scope === 'federal') return 1;
  if (scope !== 'state') return 0;
  const st = key.split(':')[1];
  const us = Object.values(e.data.states).reduce((a, s) => a + s.pop, 0);
  return ((e.data.states[st]?.pop ?? 0) / us) * 1.5;
}

/** A player bill becomes law. */
function enact(e: Engine, b: Bill, text: string) {
  const P = e.s.player;
  const me = e.player;
  setStage(e, b, 'law', text, 'good');
  P.metrics.effectiveness = (P.metrics.effectiveness ?? 50) + 4;
  const i = ISSUES.findIndex((x) => x.key === b.issue);
  const partyDir = Math.sign(PARTY_BASE[me.party][i]);
  P.partyStanding = clamp(P.partyStanding + (b.dir === partyDir ? 3 : -1), 0, 100);
  for (const [g, v] of Object.entries(b.groups ?? {})) P.groups[g] = clamp((P.groups[g] ?? 0) + v * 0.5, -100, 100);
  if (b.metrics) P.policies.unshift({ id: b.id, title: b.title, year: e.s.year, metrics: b.metrics });
  if (P.policies && P.policies.length > 30) P.policies.length = 30;
  const def = e.def(me.officeId!);
  if (def) e.bumpRec(e.jurKey(def), 0.03);
  addShift(e.s.world, lawEcon(b.issue, b.dir, econWeight(e, b.chamber)));
  const si = ISSUES.findIndex((x) => x.key === b.issue);
  if (chamberScope(b.chamber) !== 'local') e.s.world.salience[si] = clamp(e.s.world.salience[si] + 0.04);
  P.record.unshift({ year: e.s.year, month: e.s.month, title: b.title, choice: 'Enacted (sponsor)' });
  e.news({ kind: 'office', title: `"${b.title}" becomes law`, body: `Sponsored by ${e.name(me)}. ${describeGroupEffects(b.groups)}`, tone: 'good' });
}

/** End of month: committees, the other chamber and the executive act on the player's bills. */
export function processBills(e: Engine) {
  const P = e.s.player;
  if (!P.bills.length) return;
  const rng = new Rng(`${e.s.seed}|bills|${e.s.year}|${e.s.month}`);
  const seat = playerChamber(e);
  for (const b of P.bills) {
    if (b.stage === 'law' || b.stage === 'dead') continue;
    if (seat !== b.chamber) { setStage(e, b, 'dead', 'Died when its sponsor left the chamber.', 'bad'); continue; }
    switch (b.stage) {
      case 'committee': {
        if (!b.hearing) {
          const odds = hearingOdds(e, b);
          if (rng.chance(odds)) {
            b.hearing = true;
            b.log.push({ year: e.s.year, month: e.s.month, text: `The chair scheduled a hearing. The committee votes next month.`, tone: 'good' });
            b.lobbied = undefined;
          } else if (monthsIn(e, b) >= 3) {
            const chair = committeeChair(e, b.chamber, b.committee);
            setStage(e, b, 'dead', `Died in committee: ${chair ? e.name(chair) : 'the chair'} never gave it a hearing.`, 'bad');
            e.news({ kind: 'office', title: `"${b.title}" dies in committee`, tone: 'bad' });
          } else b.lobbied = Math.max(0, (b.lobbied ?? 0) - 0.15) || undefined;
          break;
        }
        const r = countVotes(e, b, b.chamber, { committee: b.committee });
        b.lastVote = { label: 'Committee', yes: r.count.yes, no: r.count.no, needed: r.count.needed };
        if (r.passes) setStage(e, b, 'floor', `Reported out of committee ${r.count.yes}–${r.count.no}. Awaiting a floor vote.`, 'good');
        else {
          setStage(e, b, 'dead', `Voted down in committee ${r.count.yes}–${r.count.no}.`, 'bad');
          e.news({ kind: 'office', title: `"${b.title}" voted down in committee`, tone: 'bad' });
        }
        break;
      }
      case 'floor':
        // leadership schedules the vote if the sponsor sits on it
        if (monthsIn(e, b) >= 3) {
          floorVote(e, b);
          const last = b.log[b.log.length - 1];
          if (last) last.text += ' (Leadership called the vote.)';
        }
        break;
      case 'second': {
        if (enteredThisMonth(e, b)) break;
        const o = otherChamber(b.chamber)!;
        const r = countVotes(e, b, o);
        b.lastVote = { label: chamberLabel(e, o), yes: r.count.yes, no: r.count.no, needed: r.count.needed };
        if (!r.passes) {
          setStage(e, b, 'dead', `Failed in the ${chamberLabel(e, o)}, ${r.count.yes}–${r.count.no}.`, 'bad');
          e.news({ kind: 'office', title: `"${b.title}" dies in the ${chamberLabel(e, o)}`, tone: 'bad' });
        } else if (executiveOf(b.chamber, e)) setStage(e, b, 'desk', `Passed the ${chamberLabel(e, o)} ${r.count.yes}–${r.count.no}; sent to the executive.`, 'good');
        else enact(e, b, `Passed the ${chamberLabel(e, o)} ${r.count.yes}–${r.count.no}.`);
        break;
      }
      case 'desk': {
        if (enteredThisMonth(e, b)) break;
        const x = executiveSigns(e, executiveOf(b.chamber, e), b.issue, b.dir, b.id);
        if (!x || x.signs) enact(e, b, x ? `Signed by ${x.title} ${x.name}.` : 'Took effect.');
        else {
          setStage(e, b, 'vetoed', `Vetoed by ${x.title} ${x.name}. An override needs two-thirds of ${otherChamber(b.chamber) ? 'both chambers' : 'the body'}.`, 'bad');
          e.news({ kind: 'office', title: `${x.title} ${x.name} vetoes "${b.title}"`, tone: 'bad' });
        }
        break;
      }
      case 'vetoed':
        if (monthsIn(e, b) >= 2) setStage(e, b, 'dead', 'No override attempt; the veto stands.', 'bad');
        break;
    }
  }
  // keep the 8 most recent finished bills
  let done = 0;
  P.bills = P.bills.filter((b) => b.stage !== 'law' && b.stage !== 'dead' ? true : ++done <= 8);
}

/** Speakers can keep a bill off the floor; a chair can bury bills in their committee. */
export function addLeadershipOptions(e: Engine, ds: Decision[], billIssue: (id: string) => { issue: string; dir: number } | null) {
  const P = e.s.player;
  const key = playerChamber(e);
  if (!P.role || !key || P.role.chamber !== key) return;
  for (const d of ds) {
    const bill = billIssue(d.templateId);
    if (!bill || d.meta) continue;
    const r = P.role.role;
    if (r === 'speaker' || r === 'majority') d.options.splice(2, 0, { label: 'Keep it off the floor', detail: 'Kills the bill without a recorded vote. Its backers will remember.', kill: true });
    else if (r === 'chair' && P.role.committee === committeeFor(bill.issue)) d.options.splice(2, 0, { label: 'Bury it in committee', detail: 'The bill never gets a hearing. Its backers will remember.', kill: true });
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;
