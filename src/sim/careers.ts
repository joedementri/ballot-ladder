/**
 * AI careers and rivals (M11).
 *
 * Officeholders now climb the ladder too. When a seat opens (the incumbent retires, is term-limited or moved on),
 * the parties' nominees are usually drawn from the "bench": ambitious officeholders whose own jurisdiction overlaps
 * the open seat, one to three rungs down (a state senator runs for the open U.S. House seat, a congresswoman for
 * governor). If their own seat is on the same ballot they give it up, which opens it for the next rung down; if it
 * isn't, it's a free shot. Winners move up in January and their old seat is filled by its own rules.
 * Presidential nominees come from sitting governors, senators and the Vice President.
 *
 * Rivals are a handful of these politicians the game follows for the player: up-and-comers from both parties in the
 * player's town and state, plus anyone who beats the player (a nemesis) and some of the players' strong losing
 * opponents (who want a rematch). Rivals are kept in the save when out of office, can jump into the player's races,
 * and get their own news coverage.
 */
import type { Engine } from './game';
import type { Politician, ResultSummary, RivalInfo, RivalTag } from './model';
import type { OfficeDef, OfficeType } from './offices';
import type { Party, Town } from '../data/types';
import { officesForTown, shortTownName } from './offices';
import { ideologyScore } from './issues';
import { Rng, clamp, hashStr } from './rng';

const round2 = (x: number) => Math.round(x * 100) / 100;
/** Active rivals the game follows at most (the least relevant are dropped). */
const MAX_RIVALS = 10;

// ------------------------------------------------------------------ ambition & titles

/** Drive to climb: stored for rivals, otherwise a stable draw from the politician's id (younger = hungrier). */
export function ambition(e: Engine, p: Politician): number {
  if (p.ambition != null) return p.ambition;
  const base = hashStr(`${e.s.seed}|amb|${p.id}`) / 4294967296;
  const age = e.age(p);
  return clamp(base * 0.8 + (age < 45 ? 0.2 : age < 55 ? 0.1 : 0) - (age > 65 ? 0.2 : 0));
}

export const isRival = (e: Engine, id: string | null | undefined) => !!id && !!e.s.rivals[id] && !e.s.rivals[id].retired;
export const activeRivals = (e: Engine) => Object.entries(e.s.rivals).filter(([id, r]) => !r.retired && e.pol(id));

const SHORT: Record<OfficeType, string> = {
  council: 'Council member', mayor: 'Mayor', county: 'County commissioner', sldl: 'State Rep.', sldu: 'State Sen.', house: 'Rep.', governor: 'Gov.',
  senate: 'Sen.', president: 'President', school: 'School board member', sheriff: 'Sheriff', da: 'Prosecutor', cexec: 'County executive',
  ltgov: 'Lt. Gov.', ag: 'Attorney General', sos: 'Secretary of State', treas: 'Treasurer', judge: 'Justice', vp: 'Vice President',
};
/** "State Sen. Jane Doe (D)", "former Rep. John Roe (R)" or "Jane Doe (D)". */
export function styled(e: Engine, p: Politician): string {
  const def = p.officeId ? e.def(p.officeId) : null;
  if (def) return `${SHORT[def.type]} ${e.name(p)} (${p.party})`;
  const last = [...p.career].reverse().find((c) => c.result === 'won' || c.result === 'took-office' || c.result === 'appointed');
  const t = last ? (e.def(last.officeId)?.type as OfficeType | undefined) : undefined;
  return `${t ? `former ${SHORT[t]} ` : ''}${e.name(p)} (${p.party})`;
}

// ------------------------------------------------------------------ geography

/**
 * Which jurisdictions overlap, per state: for each town/county/district key, every key that shares a town with it.
 * Built from the state's towns (so it follows redistricting), cached per plan version.
 */
const coverCache = new WeakMap<Engine, Map<string, Map<string, Set<string>>>>();
export async function cover(e: Engine, st: string): Promise<Map<string, Set<string>>> {
  let m = coverCache.get(e);
  if (!m) coverCache.set(e, (m = new Map()));
  const key = `${st}|${e.data.planVersion}`;
  const hit = m.get(key);
  if (hit) return hit;
  const c = new Map<string, Set<string>>();
  for (const t of await e.data.townsOf(st)) {
    const ks = townKeys(t);
    for (const k of ks) {
      let s = c.get(k);
      if (!s) c.set(k, (s = new Set()));
      for (const k2 of ks) s.add(k2);
    }
  }
  m.set(key, c);
  return c;
}
const townKeys = (t: Town) => [t.id, t.county, t.cd && `cd:${t.cd}`, t.sldu && `sldu:${t.sldu}`, t.sldl && `sldl:${t.sldl}`].filter(Boolean) as string[];

/** Does a politician based at `key` (their office's jurisdiction, or home town) sit inside or overlap `def`? */
function overlaps(e: Engine, cov: Map<string, Set<string>> | undefined, key: string | null, st: string | null, def: OfficeDef) {
  if (def.jur.kind === 'nation') return true;
  if (def.jur.kind === 'state') return st === def.st;
  return !!key && !!cov?.get(key)?.has(e.jurKey(def));
}

// ------------------------------------------------------------------ the bench

interface BenchEntry { p: Politician; level: number; key: string | null; st: string | null }

/** Officeholders (and active rivals out of office) by state. Judges and national officers aren't on the bench. */
function benchIndex(e: Engine): Map<string, BenchEntry[]> {
  const out = new Map<string, BenchEntry[]>();
  const push = (st: string, b: BenchEntry) => (out.get(st) ?? out.set(st, []).get(st)!).push(b);
  for (const o of Object.values(e.s.offices)) {
    const p = e.pol(o.holder);
    if (!p || p.isPlayer) continue;
    const def = e.def(o.id);
    if (!def?.st || def.type === 'judge') continue;
    push(def.st, { p, level: def.level, key: e.jurKey(def), st: def.st });
  }
  for (const [id] of activeRivals(e)) {
    const p = e.pol(id)!;
    if (p.officeId) continue;
    const t = e.data.townSync(p.home);
    const st = t?.st ?? (e.data.states[p.home] ? p.home : null);
    if (st) push(st, { p, level: 0, key: t?.id ?? null, st });
  }
  return out;
}

/** People who mustn't be pulled into other races: the player's race and anyone already moving in January. */
function guardedIds(e: Engine): Set<string> {
  const g = new Set<string>(Object.values(e.s.incoming));
  const c = e.s.campaign;
  if (c && c.stage !== 'done') for (const id of [...c.primaryField, ...c.generalField, ...c.otherField]) g.add(id);
  for (const t of [e.s.tickets?.D, e.s.tickets?.R]) if (t) { g.add(t.pres); g.add(t.vp); }
  return g;
}

/** The strongest willing candidate for `def` from `party` (any party for nonpartisan seats), or null. */
function pickBench(e: Engine, bench: Map<string, BenchEntry[]>, def: OfficeDef, party: Party | null, taken: Set<string>, guard: Set<string>, rng: Rng, cov?: Map<string, Set<string>>, year = e.s.year): Politician | null {
  const list = def.st ? bench.get(def.st) ?? [] : [...bench.values()].flat();
  let best: Politician | null = null, bs = -Infinity, bestRival = false;
  for (const b of list) {
    const p = b.p;
    if (taken.has(p.id) || guard.has(p.id) || (party && p.party !== party)) continue;
    const rival = isRival(e, p.id);
    // at most three rungs up (someone out of office counts as the first rung)
    if (b.level >= def.level || def.level - Math.max(b.level, 1) > 3) continue;
    const age = year - p.birthYear;
    if (age < def.minAge || age > 72) continue;
    if (!overlaps(e, cov, b.key, b.st, def)) continue;
    const sk = (p.skills.charisma + p.skills.fundraising + p.skills.organization) / 300;
    const score = ambition(e, p) * 0.45 + p.rec * 0.25 + sk * 0.2 + (rival ? 0.3 : 0) - (def.level - b.level) * 0.03 + rng.normal(0, 0.08) - (age > 62 ? 0.12 : 0) - p.scandal * 0.5;
    if (score > bs) { bs = score; best = p; bestRival = rival; }
  }
  if (!best) return null;
  return bestRival || rng.chance(clamp(0.15 + bs * 0.75)) ? best : null;
}

export interface BgRace { id: string; def: OfficeDef; holder?: Politician; runs: boolean; lean: number }
export type Draft = Partial<Record<Party | 'any', Politician>>;
const draftable = (def: OfficeDef) => def.level >= 2 && !['judge', 'vp', 'president'].includes(def.type);

/**
 * November background races: ambitious officeholders file for open seats, highest offices first. Someone who files
 * for a seat while their own is on the same ballot gives theirs up (it then opens for the next rung down).
 * Ambitious officeholders also take free shots at incumbents in competitive seats.
 */
export async function draftCandidates(e: Engine, races: BgRace[], year: number): Promise<Map<string, Draft>> {
  const out = new Map<string, Draft>();
  const rng = new Rng(`${e.s.seed}|draft|${year}`);
  const byId = new Map(races.map((r) => [r.id, r]));
  const covs = new Map<string, Map<string, Set<string>>>();
  for (const r of races) {
    const st = r.def.st;
    if (st && draftable(r.def) && r.def.jur.kind !== 'state' && !covs.has(st)) covs.set(st, await cover(e, st));
  }
  const bench = benchIndex(e);
  const guard = guardedIds(e);
  const taken = new Set<string>();
  const byLevel = (a: BgRace, b: BgRace) => b.def.level - a.def.level;
  const queue = races.filter((r) => !r.runs && draftable(r.def)).sort(byLevel);
  for (let i = 0; i < queue.length; i++) {
    const r = queue[i];
    const slot: Draft = {};
    for (const party of (r.def.partisan ? ['D', 'R'] : [null]) as (Party | null)[]) {
      const share = party === 'D' ? r.lean : party === 'R' ? 1 - r.lean : 0.5;
      // few ambitious politicians waste a career on a hopeless seat
      if (share < 0.32 && !rng.chance(0.2)) continue;
      const p = pickBench(e, bench, r.def, party, taken, guard, rng, covs.get(r.def.st ?? ''), year);
      if (!p) continue;
      if (party) slot[party] = p;
      else slot.any = p;
      taken.add(p.id);
      const own = p.officeId ? byId.get(p.officeId) : undefined;
      if (own && own.holder === p && own.runs) {
        own.runs = false;
        if (draftable(own.def)) queue.splice(i + 1, queue.length, ...[...queue.slice(i + 1), own].sort(byLevel));
      }
    }
    if (slot.D || slot.R || slot.any) out.set(r.id, slot);
  }
  for (const r of races) {
    if (!r.runs || !r.holder || !r.def.partisan || r.def.level < 4 || !draftable(r.def) || Math.abs(r.lean - 0.5) > 0.08 || !rng.chance(0.45)) continue;
    const other: Party = r.holder.party === 'D' ? 'R' : 'D';
    const p = pickBench(e, bench, r.def, other, taken, guard, rng, covs.get(r.def.st ?? ''), year);
    if (!p || (p.officeId && byId.has(p.officeId))) continue; // free shots only
    out.set(r.id, { ...(out.get(r.id) ?? {}), [other]: p });
    taken.add(p.id);
  }
  return out;
}

/** An appointee for a vacancy at level 4+, sometimes from the bench (a sitting officeholder moves up). */
export function benchAppointee(e: Engine, def: OfficeDef, party: Party, rng: Rng): Politician | null {
  if (def.level < 4 || !draftable(def) || !rng.chance(0.5)) return null;
  const covP = def.st ? coverSync(e, def.st) : undefined;
  if (def.jur.kind !== 'state' && def.jur.kind !== 'nation' && !covP) return null;
  return pickBench(e, benchIndex(e), def, def.partisan ? party : null, new Set(), guardedIds(e), rng, covP);
}
function coverSync(e: Engine, st: string) {
  return coverCache.get(e)?.get(`${st}|${e.data.planVersion}`);
}

/** National figures for a presidential ticket: governors, senators, the VP and rivals at level 5+. */
export function nationalContender(e: Engine, party: Party, rng: Rng, exclude: Set<string> = new Set(), year = e.s.year): Politician | null {
  const guard = guardedIds(e);
  let best: Politician | null = null, bs = -Infinity;
  const consider = (p: Politician | undefined, level: number) => {
    if (!p || p.isPlayer || p.party !== party || exclude.has(p.id) || guard.has(p.id)) return;
    const age = year - p.birthYear;
    if (age < 40 || age > 76) return;
    const rival = isRival(e, p.id);
    const sk = (p.skills.charisma + p.skills.debate + p.skills.fundraising) / 300;
    const s = ambition(e, p) * 0.4 + p.rec * 0.35 + sk * 0.25 + (rival ? 0.2 : 0) + (level >= 6 ? 0.1 : 0) + rng.normal(0, 0.1) - p.scandal;
    if (s > bs) { bs = s; best = p; }
  };
  for (const o of Object.values(e.s.offices)) {
    const t = o.id.split(':')[0];
    if (t === 'gov' || t === 'sen' || t === 'vp') consider(e.pol(o.holder), 6);
  }
  for (const [id] of activeRivals(e)) {
    const p = e.pol(id)!;
    const lvl = p.officeId ? e.def(p.officeId)?.level ?? 0 : 0;
    if (lvl >= 5) consider(p, lvl);
  }
  if (!best || !rng.chance(0.85)) return null;
  (best as Politician).notable = true;
  return best;
}

/** A rival who'd jump into the player's race for `def` (same party, overlapping area, a step up for them). */
export async function rivalFor(e: Engine, def: OfficeDef, party: Party, exclude: Set<string>): Promise<Politician | null> {
  if (def.jur.kind === 'nation') return null;
  const cov = def.st && def.jur.kind !== 'state' ? await cover(e, def.st) : undefined;
  const guard = guardedIds(e);
  for (const [id] of activeRivals(e)) {
    const p = e.pol(id)!;
    if (p.party !== party || exclude.has(id) || guard.has(id) || p.officeId === def.id) continue;
    const odef = p.officeId ? e.def(p.officeId) : null;
    if ((odef?.level ?? 0) >= def.level || def.level - Math.max(odef?.level ?? 0, 1) > 3) continue;
    if (e.age(p) < def.minAge || e.age(p) > 72 || (def.type === 'judge')) continue;
    const t = e.data.townSync(p.home);
    const key = odef ? e.jurKey(odef) : t?.id ?? null;
    const st = odef?.st ?? t?.st ?? null;
    if (overlaps(e, cov, key, st, def)) return p;
  }
  return null;
}

/** Recognition a drafted officeholder brings to a bigger race. */
export const draftedRec = (p: Politician) => clamp(p.rec * 0.75 + 0.05, 0.05, 0.85);

// ------------------------------------------------------------------ rivals

function addRival(e: Engine, p: Politician, tag: RivalTag, note: string, rng: Rng) {
  const rivals = e.s.rivals;
  if (rivals[p.id] && !rivals[p.id].retired) return;
  p.notable = true;
  p.ambition = round2(Math.max(p.ambition ?? 0, rng.range(0.72, 0.95)));
  rivals[p.id] = { tag, note, since: e.s.year, record: rivals[p.id]?.record ?? [] };
  // keep the list manageable: drop the longest-retired, then the oldest out-of-office rival
  const active = activeRivals(e);
  if (active.length > MAX_RIVALS) {
    const drop = active
      .filter(([id]) => id !== p.id)
      .sort(([a], [b]) => relevance(e, a) - relevance(e, b))[0];
    if (drop) drop[1].retired = e.s.year;
  }
}
function relevance(e: Engine, id: string) {
  const p = e.pol(id)!;
  const r = e.s.rivals[id];
  return (p.officeId ? 2 : 0) + r.record.length * 0.5 + (r.tag === 'nemesis' ? 1.5 : 0) - Math.max(0, e.age(p) - 60) * 0.05;
}

/** New game: a few up-and-comers from both parties in the player's town and state. */
export function seedRivals(e: Engine, home: Town) {
  const me = e.player;
  const rng = new Rng(`${e.s.seed}|rivals`);
  e.s.rivals = {};
  const other: Party = me.party === 'D' ? 'R' : 'D';
  const town = shortTownName(home.name);
  const stName = e.data.states[home.st]?.n ?? home.st;
  const holders = (ids: string[]) => ids.map((id) => e.pol(e.s.offices[id]?.holder)).filter((p): p is Politician => !!p && !p.isPlayer);
  const best = (ps: Politician[], party: Party, maxAge: number) =>
    ps.filter((p) => p.party === party && e.age(p) <= maxAge && !e.s.rivals[p.id])
      .sort((a, b) => score(b) - score(a))[0];
  const score = (p: Politician) => (p.skills.charisma + p.skills.organization + p.skills.fundraising) / 300 + p.rec - e.age(p) / 100;
  const local = holders(officesForTown(home, e.data).filter((id) => /^(council|school|county|mayor|cexec|da|sheriff):/.test(id)));
  const statewide = holders(Object.keys(e.s.offices).filter((id) => /^(sldl|sldu|house):/.test(id) && e.def(id)?.st === home.st));
  for (const [party, tag] of [[me.party, 'party'], [other, 'opposition']] as const) {
    let p = best(local, party, 52);
    let note: string;
    if (p) note = `${styled(e, p)} in ${town}${tag === 'party' ? ': young, ambitious, and in your party' : `: the ${party === 'D' ? 'Democrats' : 'Republicans'}' local up-and-comer`}.`;
    else {
      // nobody local fits: a newcomer with the same idea as the player
      p = e.genPolitician(rng, { party, lean: home.lean, demo: home.demo, home: home.id, quality: 0.8, ageMin: 26 });
      p.birthYear = e.s.year - rng.int(27, 40);
      p.rec = 0.06;
      note = `A ${e.age(p)}-year-old ${party === 'D' ? 'Democrat' : 'Republican'} in ${town} with an eye on office, just like you.`;
    }
    addRival(e, p, tag, note, rng);
    const s = best(statewide, party, 50) ?? best(statewide, party, 60);
    if (s) addRival(e, s, 'star', `${styled(e, s)}: a rising ${party === 'D' ? 'Democratic' : 'Republican'} star in ${stName}.`, rng);
  }
  const names = activeRivals(e).map(([id]) => styled(e, e.pol(id)!));
  if (names.length) e.news({ kind: 'rival', title: 'Politicians to watch', body: `${names.join(' · ')}. They want to climb too; follow them on the Career tab.` });
}

/** After one of the player's races: update head-to-head records, and remember who beat (or nearly beat) the player. */
export function recordRace(e: Engine, r: ResultSummary, playerWon: boolean) {
  const me = e.player;
  if (!r.cands.some((c) => c.isPlayer)) return;
  const tot = r.cands.reduce((a, c) => a + c.votes, 0) || 1;
  const rng = new Rng(`${e.s.seed}|rec|${r.officeId}|${r.year}|${r.stage}`);
  for (const c of r.cands) {
    if (c.id === me.id) continue;
    const p = e.pol(c.id);
    if (!p) continue;
    if (!isRival(e, p.id) && e.age(p) < 70) {
      if (!playerWon && c.id === r.winnerId) addRival(e, p, 'nemesis', `Beat you for ${r.title} in the ${r.year} ${r.stage}.`, rng);
      else if (playerWon && c.votes / tot > 0.4 && e.age(p) < 58 && rng.chance(0.5)) addRival(e, p, 'comeback', `Lost to you for ${r.title} in the ${r.year} ${r.stage}, and wants a rematch.`, rng);
    }
    const info = e.s.rivals[p.id];
    if (info && !info.retired) info.record.push({ year: r.year, officeId: r.officeId, title: r.title, stage: r.stage, playerWon });
  }
}

/** A rival filed for the player's race. */
export function rivalJoins(e: Engine, p: Politician, def: OfficeDef, year: number) {
  e.news({ kind: 'rival', title: `${styled(e, p)} jumps into the race for ${def.title}`, body: `Your rival files for the ${year} race. ${e.s.rivals[p.id]?.record.length ? 'Another round between you two.' : 'Your paths finally cross.'}`, tone: 'bad' });
}

/** Coverage of background races: rivals always, other moves up the ladder in the player's state. */
export function raceNews(e: Engine, def: OfficeDef, winner: Politician, loser: Politician | null, share: number, year: number, drafted: Set<string>) {
  const pct = `${Math.round(share * 100)}%`;
  for (const p of [winner, loser]) {
    if (!p || !isRival(e, p.id)) continue;
    const won = p === winner;
    e.news({
      kind: 'rival',
      title: `${styled(e, p)} ${won ? 'wins' : 'loses'} ${drafted.has(p.id) || !p.officeId || p.officeId !== def.id ? 'the race for' : 're-election as'} ${def.title}`,
      body: won ? `${pct} of the vote.${loser ? ` Beat ${e.name(loser)} (${loser.party}).` : ''}` : `${e.name(winner)} (${winner.party}) won with ${pct}.`,
      tone: 'neutral',
    });
  }
  if (isRival(e, winner.id) || !drafted.has(winner.id) || def.level < 5) return;
  const home = e.data.townSync(e.player.home);
  if (def.st !== home?.st && def.level < 6) return;
  e.news({ kind: 'election', title: `${styled(e, winner)} moves up: wins ${def.title}`, body: `${pct} of the vote.`, tone: 'neutral' });
}

/** A rival left office mid-term (resignation, scandal, death). */
export function rivalLeft(e: Engine, p: Politician, title: string, reason: string) {
  if (!isRival(e, p.id)) return;
  e.news({ kind: 'rival', title: `${e.name(p)} (${p.party}) ${reason}`, body: `Your rival leaves the post of ${title}.`, tone: 'neutral' });
  if (reason.includes('died')) e.s.rivals[p.id].retired = e.s.year;
}

/** Monthly: rival scandals and retirements (January). */
export function monthlyRivals(e: Engine) {
  const rng = new Rng(`${e.s.seed}|rivalm|${e.s.year}|${e.s.month}`);
  for (const [id, info] of activeRivals(e)) {
    const p = e.pol(id)!;
    if (p.officeId && rng.chance(0.004 + (100 - p.skills.integrity) / 30000)) {
      p.scandal = clamp(p.scandal + rng.range(0.2, 0.4));
      p.fav = clamp(p.fav - 0.05);
      e.news({ kind: 'rival', title: `Scandal: ${styled(e, p)} ${rng.pick(['faces an ethics complaint over campaign spending', 'is under fire for a donor’s no-bid contract', 'is caught in a misleading statement about their record', 'apologizes for leaked private remarks'])}`, tone: 'good' });
    }
    if (e.s.month !== 1 || p.officeId) continue;
    const lastOffice = Math.max(0, ...p.career.filter((c) => c.result === 'left-office' || c.result === 'won' || c.result === 'took-office').map((c) => c.year));
    const out = lastOffice ? e.s.year - lastOffice : e.s.year - info.since;
    if (e.age(p) >= 70 || out >= 6) {
      info.retired = e.s.year;
      e.news({ kind: 'rival', title: `${styled(e, p)} retires from politics`, body: `${info.record.length ? `Your record against them: ${info.record.filter((x) => x.playerWon).length}–${info.record.filter((x) => !x.playerWon).length}.` : 'You never faced each other at the ballot box.'}`, tone: 'neutral' });
    }
  }
}

// ------------------------------------------------------------------ view

const JUR_SEL: Record<string, 'state' | 'county' | 'cd' | 'sldu' | 'sldl' | 'town' | undefined> = { state: 'state', county: 'county', cd: 'cd', sldu: 'sldu', sldl: 'sldl', town: 'town' };

export function rivalsView(e: Engine) {
  return Object.entries(e.s.rivals)
    .map(([id, r]: [string, RivalInfo]) => {
      const p = e.pol(id);
      if (!p) return null;
      const def = p.officeId ? e.def(p.officeId) : null;
      const t = e.data.townSync(p.home);
      const jur = def ? { kind: JUR_SEL[def.jur.kind], id: def.jur.id } : t ? { kind: 'town' as const, id: t.id } : null;
      return {
        id, name: e.name(p), styled: styled(e, p), party: p.party, age: e.age(p), tag: r.tag, note: r.note, since: r.since, retired: r.retired ?? null,
        office: def?.title ?? null, level: def?.level ?? 0, rec: p.rec, fav: p.fav, scandal: p.scandal, ideology: ideologyScore(p.pos), ambition: ambition(e, p),
        wins: r.record.filter((x) => x.playerWon).length, losses: r.record.filter((x) => !x.playerWon).length, record: r.record.slice(-4),
        career: p.career.slice(-6), home: t ? `${shortTownName(t.name)}, ${t.st}` : e.data.states[p.home]?.n ?? '',
        jur: jur?.kind ? { kind: jur.kind, id: jur.id, name: def?.jurName ?? (t ? `${shortTownName(t.name)}, ${t.st}` : '') } : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => Number(!!a.retired) - Number(!!b.retired) || b.level - a.level);
}
export type RivalView = ReturnType<typeof rivalsView>[number];
