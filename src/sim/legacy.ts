/**
 * M17 legacy, achievements and the end of a career.
 *
 * - The legacy score is computed on demand from the career log (`Politician.career`), the player's scandal stories
 *   and the running tallies in `GameState.stats` (months in office and approval, laws, overrides, leadership posts,
 *   and a record of each race since M17). Years in office and election results come from the career log, so saves
 *   from before M17 still score their whole career; the race bonuses (flips, incumbents beaten, underdog primaries)
 *   and average approval only count from M17 on.
 * - Achievements are checked at the end of every month (and on retirement). Each is earned once.
 * - Retiring from politics leaves office by the normal rules (`vacate`) and ends the game.
 */
import type { ActionResult, Engine } from './game';
import type { Campaign, CareerEntry, RaceRecord, ResultSummary, RoleKind } from './model';
import { LEVEL, type OfficeDef, type OfficeType } from './offices';
import { roleLabel, chamberKey } from './legislature';
import { vacate } from './vacancies';
import { approval } from './upkeep';
import { monthName, round3 } from './util';

/** Points per unit of office level: years in office and wins count much more the higher the office. */
export const LEVEL_WEIGHT = [0, 1, 2, 4, 6, 10, 16, 30];

const TYPE_OF: Record<string, OfficeType> = { gov: 'governor', sen: 'senate', pres: 'president' };
/** Level of an office id, even if its definition is gone (an eliminated district). */
export function levelOf(e: Engine, officeId: string): number {
  if (!officeId) return 0;
  const def = e.def(officeId);
  if (def) return def.level;
  const t = officeId.split(':')[0];
  return LEVEL[(TYPE_OF[t] ?? t) as OfficeType] ?? 1;
}
const W = (level: number) => LEVEL_WEIGHT[Math.max(0, Math.min(7, level))];

// ------------------------------------------------------------------ recording (called from races, laws, the turn)

/** Remember one of the player's races (resolvePrimary / resolveGeneral / presidential contests). */
export function recordPlayerRace(e: Engine, c: Campaign, def: OfficeDef, r: ResultSummary, stage: 'primary' | 'general', won: boolean, prevParty?: string | null) {
  const me = e.player;
  const tot = r.cands.reduce((a, x) => a + x.votes, 0) || 1;
  const mine = r.cands.find((x) => x.id === me.id)?.votes ?? 0;
  const best = Math.max(0, ...r.cands.filter((x) => x.id !== me.id).map((x) => x.votes));
  // the last internal poll before the vote (poll() runs after the election in the same month)
  const last = c.polls[c.polls.length - 1];
  const others = last ? Object.entries(last.shares).filter(([id]) => id !== me.id && r.cands.some((x) => x.id === id)) : [];
  const underdog = !!last && others.length > 0 && (last.shares[me.id] ?? 0) < Math.max(...others.map(([, v]) => v));
  const vsIncumbent = r.cands.some((x) => x.id !== me.id && e.pol(x.id)?.officeId === def.id);
  const rec: RaceRecord = {
    year: c.year, officeId: def.id, title: def.title, level: def.level, stage, won,
    share: round3(mine / tot), margin: round3((mine - best) / tot),
  };
  if (underdog) rec.underdog = true;
  if (vsIncumbent) rec.vsIncumbent = true;
  if (stage === 'general' && won && def.partisan && prevParty && prevParty !== me.party) rec.flip = true;
  if (r.electoral) rec.ev = r.electoral[me.id] ?? 0;
  e.s.stats.races.push(rec);
  if (e.s.stats.races.length > 120) e.s.stats.races.shift();
}

/** A law enacted under the player's name or signature. */
export function noteLaw(e: Engine, id: string, title: string) {
  const L = e.s.stats.laws;
  if (L.some((x) => x.id === id)) return;
  L.unshift({ id, title, year: e.s.year, level: levelOf(e, e.player.officeId ?? '') });
  if (L.length > 200) L.length = 200;
}

export function noteOverride(e: Engine) {
  e.s.stats.overrides++;
}

/** End of month: count the month in office and any new leadership post, then award achievements. */
export function legacyMonth(e: Engine) {
  const me = e.player;
  const S = e.s.stats;
  if (me.officeId) {
    S.officeMonths++;
    S.approvalSum = round3(S.approvalSum + approval(e));
  }
  const role = e.s.player.role;
  if (role) {
    const last = [...S.posts].reverse().find((p) => p.chamber === role.chamber);
    if (!last || last.role !== role.role) {
      const def = me.officeId ? e.def(me.officeId) : null;
      const maj = role.role !== 'minority';
      S.posts.push({ chamber: role.chamber, role: role.role, label: roleLabel(role.chamber, role.role, role.committee, maj), year: e.s.year, level: def && chamberKey(def) === role.chamber ? def.level : levelOf(e, me.officeId ?? '') });
    }
  }
  checkAchievements(e);
}

// ------------------------------------------------------------------ years in office

export interface Tenure {
  officeId: string;
  title: string;
  level: number;
  from: number;
  to: number | null;
  years: number;
}

/** Spans in office rebuilt from the career log (took office / appointed → left, resigned, removed or retired). */
export function tenures(e: Engine): Tenure[] {
  const me = e.player;
  const now = e.s.year + (e.s.month - 1) / 12;
  const out: Tenure[] = [];
  let open: Tenure | null = null;
  const close = (year: number) => {
    if (!open) return;
    open.to = year;
    open.years = Math.max(0, year - open.from);
    out.push(open);
    open = null;
  };
  for (const c of me.career) {
    if (c.result === 'took-office' || c.result === 'appointed') {
      close(c.year);
      open = { officeId: c.officeId, title: c.title, level: levelOf(e, c.officeId), from: c.year, to: null, years: 0 };
    } else if ((c.result === 'left-office' || c.result === 'resigned' || c.result === 'removed') && open && (open as Tenure).officeId === c.officeId) close(c.year);
    else if (c.result === 'retired') close(c.year);
  }
  if (open) {
    const o = open as Tenure;
    o.years = Math.max(0, now - o.from);
    out.push(o);
  }
  return out;
}

// ------------------------------------------------------------------ the score

const POST_POINTS: Record<RoleKind, number> = { speaker: 8, majority: 5, minority: 5, whip: 3, chair: 2 };
export const RANKS: { min: number; label: string }[] = [
  { min: 0, label: 'Footnote' },
  { min: 25, label: 'Local fixture' },
  { min: 75, label: 'Statehouse name' },
  { min: 160, label: 'Power broker' },
  { min: 300, label: 'National figure' },
  { min: 550, label: 'Statesman' },
  { min: 900, label: 'Historic' },
];
export function rankFor(score: number) {
  let i = 0;
  while (i + 1 < RANKS.length && score >= RANKS[i + 1].min) i++;
  return { label: RANKS[i].label, next: RANKS[i + 1] ?? null };
}

export interface LegacyPart {
  key: string;
  label: string;
  points: number;
  detail: string;
}

const isWin = (c: CareerEntry) => c.result === 'won';
const isLoss = (c: CareerEntry) => c.result === 'lost' || c.result === 'lost-primary';

export function legacyScore(e: Engine): { score: number; parts: LegacyPart[] } {
  const me = e.player;
  const S = e.s.stats;
  const parts: LegacyPart[] = [];
  const add = (key: string, label: string, points: number, detail: string) => parts.push({ key, label, points: Math.round(points), detail });

  const ts = tenures(e);
  const years = ts.reduce((a, t) => a + t.years, 0);
  add('office', 'Years in office', ts.reduce((a, t) => a + t.years * W(t.level) * 2, 0), `${years.toFixed(1)} years across ${new Set(ts.map((t) => t.officeId)).size} office${ts.length === 1 ? '' : 's'}`);

  // general-election wins from the career log, with bonuses from the race record (M17 on)
  const wins = me.career.filter(isWin);
  let winPts = 0, flips = 0, upsets = 0;
  for (const w of wins) {
    const lvl = levelOf(e, w.officeId);
    const r = S.races.find((x) => x.stage === 'general' && x.won && x.year === w.year && x.officeId === w.officeId);
    let mult = 1;
    if (r?.flip) { mult += 0.5; flips++; }
    if (r?.vsIncumbent) { mult += 0.5; upsets++; }
    winPts += 4 * W(lvl) * mult;
  }
  for (const r of S.races) if (r.stage === 'primary' && r.won) winPts += W(r.level) * (r.underdog ? 2 : 1) * (r.vsIncumbent ? 1.5 : 1);
  add('wins', 'Elections won', winPts, `${wins.length} general${wins.length === 1 ? '' : 's'}${flips ? `, ${flips} flip${flips > 1 ? 's' : ''}` : ''}${upsets ? `, ${upsets} incumbent${upsets > 1 ? 's' : ''} beaten` : ''}`);

  add('laws', 'Laws enacted', S.laws.reduce((a, l) => a + 3 + W(l.level), 0) + S.overrides * 4, `${S.laws.length} law${S.laws.length === 1 ? '' : 's'}${S.overrides ? `, ${S.overrides} veto override${S.overrides > 1 ? 's' : ''}` : ''}`);

  if (S.posts.length) add('posts', 'Leadership', S.posts.reduce((a, p) => a + POST_POINTS[p.role] * W(p.level), 0), S.posts.map((p) => p.label).join(', '));

  if (S.officeMonths >= 6) {
    const avg = S.approvalSum / S.officeMonths;
    add('approval', 'Approval in office', (avg - 0.5) * 200 * Math.min(1, S.officeMonths / 48), `${Math.round(avg * 100)}% average over ${S.officeMonths} months`);
  }

  const mine = e.s.scandals.filter((s) => s.who === me.id);
  let scandalPts = 0;
  for (const s of mine) {
    scandalPts -= 3 + 10 * s.severity;
    if (s.stage === 'investigation' || s.stage === 'charges') scandalPts -= 10;
    if (s.stage === 'charges') scandalPts -= 20;
  }
  const resigned = me.career.filter((c) => c.result === 'resigned').length;
  const removed = me.career.filter((c) => c.result === 'removed').length;
  scandalPts -= resigned * 30 + removed * 50;
  if (mine.length || resigned || removed) add('scandals', 'Scandals', scandalPts, `${mine.length} stor${mine.length === 1 ? 'y' : 'ies'}${resigned ? `, resigned ${resigned}×` : ''}${removed ? `, removed ${removed}×` : ''}`);

  const losses = me.career.filter(isLoss);
  if (losses.length) add('losses', 'Races lost', -losses.reduce((a, c) => a + (c.result === 'lost' ? 3 : 2), 0), `${losses.length} loss${losses.length === 1 ? '' : 'es'}`);

  const n = e.s.achievements.length;
  if (n) add('achievements', 'Achievements', n * 5, `${n} earned`);

  return { score: Math.max(0, parts.reduce((a, p) => a + p.points, 0)), parts };
}

/** The highest office the player has held (ties: the latest). */
export function peakOffice(e: Engine): { title: string; level: number } | null {
  let best: { title: string; level: number } | null = null;
  for (const t of tenures(e)) if (!best || t.level >= best.level) best = { title: t.title, level: t.level };
  return best;
}

// ------------------------------------------------------------------ achievements

export interface AchievementDef {
  id: string;
  label: string;
  desc: string;
  test: (e: Engine) => boolean;
}

const races = (e: Engine) => e.s.stats.races;
const heldType = (e: Engine, prefix: string) => tenures(e).some((t) => t.officeId.startsWith(prefix));
const inOffice = (e: Engine) => tenures(e).reduce((a, t) => a + t.years, 0);

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_win', label: 'First victory', desc: 'Win your first election.', test: (e) => e.player.career.some(isWin) },
  { id: 'flip', label: 'Flipped it', desc: 'Win a seat the other party held.', test: (e) => races(e).some((r) => r.flip) },
  { id: 'giant_killer', label: 'Giant killer', desc: 'Defeat a sitting incumbent.', test: (e) => races(e).some((r) => r.won && r.vsIncumbent) },
  { id: 'underdog', label: 'Underdog', desc: 'Win a primary you trailed in the last poll.', test: (e) => races(e).some((r) => r.stage === 'primary' && r.won && r.underdog) },
  { id: 'landslide', label: 'Landslide', desc: 'Win a contested general election with 60% or more.', test: (e) => races(e).some((r) => r.stage === 'general' && r.won && r.share >= 0.6 && r.share < 1) },
  { id: 'lawmaker', label: 'Lawmaker', desc: 'Get a law enacted under your name or signature.', test: (e) => e.s.stats.laws.length > 0 },
  { id: 'override', label: 'Overruled', desc: 'Override a veto.', test: (e) => e.s.stats.overrides > 0 },
  { id: 'leader', label: 'In leadership', desc: 'Hold a leadership post or a committee gavel.', test: (e) => e.s.stats.posts.length > 0 || !!e.s.player.role },
  { id: 'speaker', label: 'The gavel', desc: 'Be elected Speaker (or presiding officer) of your chamber.', test: (e) => e.s.stats.posts.some((p) => p.role === 'speaker') || e.s.player.role?.role === 'speaker' },
  { id: 'capitol', label: 'Capitol Hill', desc: 'Serve in the U.S. House or Senate.', test: (e) => heldType(e, 'house:') || heldType(e, 'sen:') },
  { id: 'governor', label: 'Governor', desc: 'Serve as governor of your state.', test: (e) => heldType(e, 'gov:') },
  { id: 'president', label: '270', desc: 'Win 270 electoral votes.', test: (e) => races(e).some((r) => (r.ev ?? 0) >= 270) || e.player.career.some((c) => isWin(c) && c.officeId === 'pres') },
  { id: 'survivor', label: 'Survivor', desc: 'Come through a scandal investigation still standing.', test: (e) => e.s.scandals.some((s) => s.who === e.player.id && (s.stage === 'investigation' || s.stage === 'charges') && (s.ended?.how === 'cleared' || s.ended?.how === 'acquitted')) },
  {
    id: 'mapmaker', label: 'Mapmaker', desc: 'Draw your own district map.',
    test: (e) => {
      const R = e.s.redistricting;
      if (!R?.calls) return false;
      return Object.entries(R.calls).some(([st, plan]) => plan !== 'keep' && Object.entries(R.plans).some(([k, c]) => k.endsWith(`:${st}`) && c.plan === plan && !c.struck));
    },
  },
  { id: 'decade', label: 'Decade of service', desc: 'Spend ten years in office.', test: (e) => inOffice(e) >= 10 },
];

/** Award every achievement the career now qualifies for (each once), with a news item. Returns the new ids. */
export function checkAchievements(e: Engine): string[] {
  const have = new Set(e.s.achievements.map((a) => a.id));
  const got: string[] = [];
  for (const a of ACHIEVEMENTS) {
    if (have.has(a.id) || !a.test(e)) continue;
    e.s.achievements.push({ id: a.id, year: e.s.year, month: e.s.month });
    e.news({ kind: 'player', title: `Achievement: ${a.label}`, body: a.desc, tone: 'good' });
    got.push(a.id);
  }
  return got;
}

// ------------------------------------------------------------------ retirement

export function retire(e: Engine): ActionResult {
  if (e.s.gameOver) return { ok: false, msg: 'Your career is already over.' };
  if (e.s.pendingNight) return { ok: false, msg: 'Watch election night first.' };
  const me = e.player;
  const P = e.s.player;
  const c = e.s.campaign;
  if (c && c.stage !== 'done') {
    me.career.push({ year: e.s.year, officeId: c.officeId, title: e.def(c.officeId)?.title ?? 'Campaign', result: 'withdrew' });
    e.s.campaign = null;
  }
  // a seat won but not yet taken goes unclaimed; the outgoing holder stays on
  for (const [k, v] of Object.entries(e.s.incoming)) if (v === me.id) delete e.s.incoming[k];
  const held = me.officeId ? e.def(me.officeId) : null;
  if (me.officeId) {
    vacate(e, me.officeId, 'retired from politics');
    e.playerLeftOffice();
  }
  me.career.push({ year: e.s.year, officeId: '', title: 'Retired from politics', result: 'retired' });
  e.s.decisions = [];
  P.retired = true;
  const years = tenures(e).reduce((a, t) => a + t.years, 0);
  const peak = peakOffice(e);
  e.news({ kind: 'player', title: `${e.name(me)} retires from politics`, body: held ? `Steps down as ${held.title}.` : undefined, tone: 'neutral' });
  checkAchievements(e);
  e.s.gameOver = `${e.name(me)} retired from politics in ${monthName(e.s.month)} ${e.s.year}${years >= 1 ? ` after ${Math.round(years)} year${Math.round(years) === 1 ? '' : 's'} in office` : ''}${peak ? `, having served as ${peak.title}` : ''}.`;
  e.s.rng = e.rng.state;
  return { ok: true, msg: 'You retired from politics.' };
}

// ------------------------------------------------------------------ view

export function legacyView(e: Engine) {
  const { score, parts } = legacyScore(e);
  const rank = rankFor(score);
  const S = e.s.stats;
  const me = e.player;
  const earned = new Map(e.s.achievements.map((a) => [a.id, a]));
  const lvl = (c: CareerEntry) => levelOf(e, c.officeId);
  const flags = (c: CareerEntry) => {
    const r = S.races.find((x) => x.stage === 'general' && x.year === c.year && x.officeId === c.officeId);
    return { flip: !!r?.flip, vsIncumbent: !!r?.vsIncumbent };
  };
  const results = me.career.filter((c) => isWin(c) || isLoss(c));
  const bigWins = results.filter(isWin).sort((a, b) => lvl(b) - lvl(a) || (b.share ?? 0) - (a.share ?? 0)).slice(0, 3).map((c) => ({ ...c, level: lvl(c), ...flags(c) }));
  const bigLosses = results.filter(isLoss).sort((a, b) => lvl(b) - lvl(a) || (b.share ?? 0) - (a.share ?? 0)).slice(0, 3).map((c) => ({ ...c, level: lvl(c), ...flags(c) }));
  const ts = tenures(e);
  const first = me.career[0]?.year ?? e.s.startYear;
  return {
    score, rank: rank.label, next: rank.next, parts,
    peak: peakOffice(e),
    yearsInOffice: ts.reduce((a, t) => a + t.years, 0),
    yearsActive: Math.max(0, e.s.year - Math.min(first, e.s.startYear)),
    avgApproval: S.officeMonths ? S.approvalSum / S.officeMonths : null,
    wins: results.filter(isWin).length,
    losses: results.filter(isLoss).length,
    laws: S.laws.slice(0, 10),
    lawCount: S.laws.length,
    posts: S.posts,
    bigWins, bigLosses,
    achievements: ACHIEVEMENTS.map((a) => ({ id: a.id, label: a.label, desc: a.desc, earned: earned.get(a.id) ?? null })),
  };
}
export type LegacyView = ReturnType<typeof legacyView>;
