/**
 * Officeholder endorsements (M20): the player asks sitting officeholders of their party whose turf overlaps the race
 * for their endorsement. Odds come from favors, party standing, recognition and how close the two are on the issues;
 * a yes adds endorsement weight by the endorser's level. Rivals never endorse the player, and each officeholder is
 * asked once per race.
 */
import type { Engine } from './game';
import type { Campaign, Politician } from './model';
import type { OfficeDef } from './offices';
import { coverSync, isRival, styled } from './careers';
import { ideologyScore } from './issues';
import { clamp } from './rng';
import { round2 } from './util';

/** Odds are clamped to this range; at most `list` officeholders are offered at once. */
export const ENDORSE = { min: 0.05, max: 0.85, list: 8 };

/** Endorsement weight (in the vote model's endorsement units, 0.06 logit each) by the endorser's level. */
export const endorserWeight = (level: number) => (level >= 7 ? 2 : level >= 5 ? 1.5 : level >= 3 ? 1 : 0.5);

export interface EndorserTarget { p: Politician; def: OfficeDef; odds: number }

/** Officeholders of the player's party who could endorse them in this race, highest office first. */
export function endorserTargets(e: Engine, c: Campaign | null): EndorserTarget[] {
  if (!c || c.stage === 'done') return [];
  const race = e.def(c.officeId);
  if (!race) return [];
  const me = e.player;
  const skip = new Set([...c.primaryField, ...c.generalField, ...c.otherField, ...(c.asked ?? [])]);
  const raceKey = e.jurKey(race);
  const cov = race.st && race.jur.kind !== 'state' ? coverSync(e, race.st) : undefined;
  const out: EndorserTarget[] = [];
  for (const o of Object.values(e.s.offices)) {
    const p = e.pol(o.holder);
    if (!p || p.isPlayer || p.party !== me.party || skip.has(p.id) || isRival(e, p.id)) continue;
    const def = e.def(o.id);
    if (!def || def.type === 'judge' || def.level < race.level - 2 || def.level > race.level + 3) continue;
    if (def.jur.kind === 'nation') {
      if (race.level < 5) continue; // the President and VP only weigh in on big races
    } else if (race.jur.kind === 'nation') {
      if (def.level < 5) continue;
    } else if (def.st !== race.st) continue;
    else if (race.jur.kind === 'state') {
      if (def.level < 3) continue;
    } else if (def.jur.kind !== 'state' && !cov?.get(e.jurKey(def))?.has(raceKey)) continue;
    out.push({ p, def, odds: endorserOdds(e, c, race, p, def) });
  }
  return out.sort((a, b) => b.def.level - a.def.level || b.p.rec - a.p.rec || (a.p.id < b.p.id ? -1 : 1)).slice(0, ENDORSE.list);
}

/** Odds that an officeholder endorses the player. */
export function endorserOdds(e: Engine, c: Campaign, race: OfficeDef, p: Politician, def: OfficeDef): number {
  const P = e.s.player;
  const me = e.player;
  const dist = Math.abs(ideologyScore(me.pos) - ideologyScore(p.pos));
  // in a contested primary, colleagues stay neutral more often; a sitting incumbent gets the benefit of the doubt
  const contested = c.stage === 'primary' && c.kind !== 'nonpartisan' && c.primaryField.some((id) => id !== me.id && e.pol(id)?.party === me.party);
  const incumbent = me.officeId === race.id;
  const x = 0.35 + (P.partyStanding - 50) / 150 + Math.min(0.15, P.favors * 0.03) + e.recIn(e.jurKey(race)) * 0.2 - dist * 0.4
    - Math.max(0, def.level - race.level) * 0.025 + (me.skills.charisma - 50) / 400 - (contested ? 0.08 : 0) + (incumbent ? 0.1 : 0);
  return round2(clamp(x, ENDORSE.min, ENDORSE.max));
}

/** Why "Seek an officeholder's endorsement" isn't available (null when it is). */
export function endorseBlocked(e: Engine, c: Campaign | null): string | null {
  if (!c || c.stage === 'done') return 'You need to be running for office.';
  if (!endorserTargets(e, c).length) return (c.asked ?? []).length ? 'You have asked every officeholder who could help in this race.' : 'No officeholders from your party cover this race.';
  return null;
}

/** Ask an officeholder for their endorsement (once per race). */
export function seekEndorsement(e: Engine, c: Campaign, targetId?: string): { ok: boolean; msg: string } {
  const why = endorseBlocked(e, c);
  if (why) return { ok: false, msg: why };
  const t = endorserTargets(e, c).find((x) => x.p.id === targetId);
  if (!t) return { ok: false, msg: 'Pick an officeholder from your party who covers this race.' };
  const race = e.def(c.officeId)!;
  const me = e.player;
  const P = e.s.player;
  (c.asked ??= []).push(t.p.id);
  if (!e.rng.chance(t.odds)) return { ok: true, msg: `${styled(e, t.p)} is staying out of it (odds were ${Math.round(t.odds * 100)}%).` };
  const w = endorserWeight(t.def.level);
  c.endorse[me.id] = round2((c.endorse[me.id] ?? 0) + w);
  (c.endorsers ??= []).push(t.p.id);
  // the endorsement is a favor called in
  if (P.favors >= 1) P.favors -= 1;
  e.news({ kind: 'race', title: `${styled(e, t.p)} endorses ${e.name(me)} for ${race.title}`, tone: 'good' });
  return { ok: true, msg: `${styled(e, t.p)} endorsed you (+${w} endorsement weight).` };
}
