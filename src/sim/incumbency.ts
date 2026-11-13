/**
 * M14: beatable incumbents and a fairer primary path.
 *
 * - Incumbency is a strength (0..1) instead of a flag: narrow wins, scandals, long tenure and midterms in the
 *   President's party wear it down.
 * - An incumbent the player challenges is judged on their record: their favorability drifts toward an approval
 *   figure built from the national mood, so bad years make them vulnerable.
 * - "Run against the record" turns successful opposition research into a case against the incumbent.
 * - "Seek the party's backing" can clear a crowded primary before it starts.
 */
import { BLOCS, blocIdeal, blocSalience, blocShares, issueDistance } from './issues';
import type { OfficeDef } from './offices';
import type { Campaign, Politician } from './model';
import { clamp } from './rng';
import { calibrate } from './vote';
export { INCUMBENCY } from './vote';
import { partyName, round2, round3 } from './util';
import type { Engine } from './game';

/** Reasons an incumbent's advantage is reduced (for the UI and news). */
export function incumbencyFactors(e: Engine, p: Politician, def: OfficeDef, year = e.s.campaign?.officeId === def.id ? e.s.campaign.year : e.s.year) {
  const out: { label: string; cost: number }[] = [];
  if (p.officeId !== def.id) return out;
  const last = e.s.offices[def.id]?.lastShare;
  if (last != null && last < 0.54) out.push({ label: `won narrowly last time (${Math.round(last * 100)}%)`, cost: (0.54 - last) * 4 });
  if (p.scandal > 0.05) out.push({ label: 'scandal', cost: p.scandal * 0.5 });
  if (p.terms >= 3) out.push({ label: `${p.terms} terms in office`, cost: 0.1 * Math.min(p.terms - 2, 3) });
  if (def.partisan && def.level >= 5 && year % 4 === 2 && p.party === e.s.world.presParty) out.push({ label: 'midterm in the President’s party', cost: 0.15 });
  return out;
}

/** How much of the incumbency advantage a politician has in this office's race (0 when not the incumbent). */
export function incumbencyStrength(e: Engine, p: Politician, def: OfficeDef, year?: number): number {
  if (p.officeId !== def.id) return 0;
  return round3(clamp(1 - incumbencyFactors(e, p, def, year).reduce((a, f) => a + f.cost, 0)));
}

/**
 * The approval an officeholder's record earns in the current national mood: the President's standing rubs off on
 * their party (and against the other one), and the generic ballot carries the year's swing. Local offices feel the
 * national mood less. Centered on a typical incumbent's favorability, so a neutral year changes little.
 */
export function recordApproval(e: Engine, p: Politician, def: OfficeDef): number {
  const w = e.s.world;
  const reach = def.level >= 5 ? 1 : def.level >= 3 ? 0.6 : 0.3;
  const side = p.party === 'I' ? 0 : p.party === w.presParty ? 1 : -1;
  const pres = side * (w.presApproval - 0.46) * 0.3 * reach;
  const generic = (p.party === 'D' ? 1 : p.party === 'R' ? -1 : 0) * (w.genericBallot / 300) * reach;
  const person = (p.skills.integrity - 60) / 800 + (p.skills.charisma - 50) / 1000;
  // (scandals already cost votes directly in vote.ts; they aren't counted again here)
  return clamp(0.56 + pres + generic + person, 0.2, 0.75);
}

/** Monthly: an AI incumbent facing the player is judged on their record. */
export function judgeIncumbents(e: Engine, c: Campaign) {
  const def = e.def(c.officeId);
  if (!def) return;
  for (const id of new Set([...c.primaryField, ...c.generalField, ...c.otherField])) {
    const p = e.pol(id);
    if (!p || p.isPlayer || p.officeId !== def.id) continue;
    p.fav = round3(clamp(p.fav + 0.12 * (recordApproval(e, p, def) - p.fav)));
  }
}

/**
 * How far an incumbent's positions sit from the district's voters (bloc-weighted issue distance), relative to a
 * typical fit. Around 0 for a good fit, 0.1–0.3 for a partisan in a swing seat.
 */
export function recordGap(e: Engine, p: Politician, def: OfficeDef): number {
  const unit = e.jurUnit(def);
  const shift = clamp(-calibrate(unit) * 0.22, -0.6, 0.6);
  const w = blocShares(unit.demo);
  let d = 0, tot = 0;
  BLOCS.forEach((b, i) => {
    d += w[i] * issueDistance(p.pos, blocIdeal(b.key), blocSalience(b.key), shift);
    tot += w[i];
  });
  return Math.max(0, d / tot - 0.08);
}

/** Each repeat of "Run against the record" in a race lands this fraction as hard as the one before. */
export const FRESH = 0.5;

/** Incumbents the player can run against in this race: in the field, with dirt found by opposition research. */
export function recordTargets(e: Engine, c: Campaign | null): Politician[] {
  if (!c || c.stage === 'done') return [];
  const ids = new Set([...(c.stage === 'primary' ? [...c.primaryField, ...c.otherField] : c.generalField)]);
  return [...ids].map((id) => e.pol(id)!).filter((p) => p && !p.isPlayer && p.officeId === c.officeId && (c.oppoFound ?? []).includes(p.id));
}

/** Why "Run against the record" isn't available (null when it is). */
export function recordBlocked(e: Engine, c: Campaign | null): string | null {
  if (!c || c.stage === 'done') return 'You need to be running for office.';
  const ids = [...c.primaryField, ...c.generalField, ...c.otherField];
  if (!ids.some((id) => { const p = e.pol(id); return p && !p.isPlayer && p.officeId === c.officeId; })) return 'Only against a sitting incumbent.';
  if (!recordTargets(e, c).length) return 'Needs successful opposition research on the incumbent first.';
  return null;
}

/** Make the incumbent's record the issue: their favorability drops and voters lean your way, more for a poor fit. */
export function runAgainstRecord(e: Engine, c: Campaign, target?: string): { ok: boolean; msg: string } {
  const why = recordBlocked(e, c);
  if (why) return { ok: false, msg: why };
  const inc = recordTargets(e, c).find((p) => p.id === target) ?? recordTargets(e, c)[0];
  const def = e.def(c.officeId)!;
  const me = e.player;
  const P = e.s.player;
  const gap = recordGap(e, inc, def);
  // each new attack line is less fresh than the last
  const fresh = FRESH ** (c.recordRuns ?? 0);
  const comms = 1 + P.staff.comms * 0.15;
  inc.fav = round3(clamp(inc.fav - (0.012 + 0.04 * gap) * fresh * comms));
  c.bias[me.id] = round3((c.bias[me.id] ?? 0) + (0.012 + 0.06 * gap) * fresh * comms);
  c.recordRuns = (c.recordRuns ?? 0) + 1;
  const fit = gap > 0.15 ? 'out of step with the district' : gap > 0.06 ? 'too partisan for the district' : 'a creature of the capital';
  e.news({ kind: 'race', title: `${e.name(me)} hammers ${e.name(inc)}’s record`, body: `The campaign paints ${inc.last} as ${fit}.`, tone: 'good' });
  return { ok: true, msg: `You made ${e.name(inc)}’s record the issue (${fresh < 0.99 ? `${Math.round(fresh * 100)}% as fresh as the first time; ` : ''}they look ${fit}).` };
}

/** Same-party challengers in the player's primary (who the party could ask to step aside). */
function myPrimaryChallengers(e: Engine, c: Campaign) {
  const me = e.player;
  return c.primaryField.filter((id) => id !== me.id).map((id) => e.pol(id)!).filter((p) => p && p.party === me.party);
}

/** Why "Seek the party's backing" isn't available (null when it is). */
export function backingBlocked(e: Engine, c: Campaign | null): string | null {
  if (!c || c.stage === 'done') return 'You need to be running for office.';
  if (c.kind === 'nonpartisan') return 'Nonpartisan races have no party primary.';
  if (c.pres) return 'Presidential nominations are won with delegates.';
  if (c.backing) return c.backing === 'won' ? 'The party is already behind you.' : 'The party turned you down this race.';
  if (c.stage !== 'primary' || c.year < e.s.year || (c.year === e.s.year && e.s.month >= c.primaryMonth)) return 'Only before the primary month.';
  const rivals = myPrimaryChallengers(e, c);
  if (rivals.some((p) => p.officeId === c.officeId)) return 'The party backs its own incumbent.';
  if (!rivals.length) return 'Nobody is challenging you in the primary.';
  return null;
}

/** Odds that party leaders clear the primary field for the player. */
export function backingOdds(e: Engine, c: Campaign): number {
  const def = e.def(c.officeId)!;
  const P = e.s.player;
  const rec = e.recIn(e.jurKey(def));
  const sitting = e.player.officeId ? (e.def(e.player.officeId)?.level ?? 0) >= def.level - 2 : false;
  return round2(clamp(0.12 + (P.partyStanding - 40) / 80 + rec * 0.6 + (sitting ? 0.1 : 0) - Math.max(0, def.level - 2) * 0.04, 0.03, 0.9));
}

/**
 * Ask party leaders to back you. Success: the weakest primary challengers drop out (at most one, the strongest,
 * stays in; none in a race the party controls tightly), and party figures endorse you. Failure costs standing.
 */
export function seekBacking(e: Engine, c: Campaign): { ok: boolean; msg: string } {
  const why = backingBlocked(e, c);
  if (why) return { ok: false, msg: why };
  const P = e.s.player;
  const me = e.player;
  const def = e.def(c.officeId)!;
  const p = backingOdds(e, c);
  if (!e.rng.chance(p)) {
    c.backing = 'lost';
    P.partyStanding = clamp(P.partyStanding - 6, 0, 100);
    e.news({ kind: 'player', title: `Party leaders stay neutral in the ${def.title} primary`, body: `A snub for ${e.name(me)}, who had asked for their support.`, tone: 'bad' });
    return { ok: true, msg: `Party leaders declined to take sides (odds were ${Math.round(p * 100)}%). It cost you some standing.` };
  }
  c.backing = 'won';
  const strength = (x: Politician) => (c.budget[x.id] ?? 0) / Math.max(1, ...Object.values(c.budget)) + (c.rec[x.id] ?? x.rec) + (x.officeId ? 0.3 : 0) + (x.notable ? 0.2 : 0);
  const ranked = myPrimaryChallengers(e, c).sort((a, b) => strength(b) - strength(a));
  // a strong backing (good odds) clears the field entirely half the time
  const keep = p >= 0.5 && e.rng.chance(0.5) ? 0 : 1;
  const out = ranked.slice(keep);
  for (const x of out) {
    c.primaryField = c.primaryField.filter((id) => id !== x.id);
    delete c.spend[x.id];
    delete c.budget[x.id];
    delete c.rec[x.id];
    delete c.endorse[x.id];
    delete c.bias[x.id];
    e.discard(x.id);
  }
  c.endorse[me.id] = (c.endorse[me.id] ?? 0) + 2;
  P.partyStanding = clamp(P.partyStanding + 3, 0, 100);
  const names = out.map((x) => `${x.first} ${x.last}`);
  e.news({
    kind: 'player',
    title: `${partyName(me.party)} leaders line up behind ${e.name(me)} for ${def.title}`,
    body: names.length ? `${names.join(', ')} ${names.length === 1 ? 'drops' : 'drop'} out of the primary.${ranked.length > out.length ? ` ${ranked[0].first} ${ranked[0].last} stays in.` : ''}` : 'The field stays as it is, but the endorsements roll in.',
    tone: 'good',
  });
  return { ok: true, msg: names.length ? `The party is behind you: ${names.join(', ')} dropped out${ranked.length > out.length ? `, but ${ranked[0].last} is staying in` : ' and the primary is yours to lose'}.` : 'The party endorsed you.' };
}
