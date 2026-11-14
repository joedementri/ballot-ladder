/**
 * Save migrations. `Engine.load` runs every save through `migrate`, which upgrades it one version at a time to
 * SAVE_VERSION. Once a field is filled by a migration it can be required in the types, so engine code does not need
 * `?? {}` fallbacks for it.
 *
 * To change the save format: bump SAVE_VERSION, add a step `STEPS[old]` that turns a version `old` save into
 * `old + 1`, and add a fixture or test. Steps must be pure data changes: no engine calls and no randomness.
 *
 * Kept optional on purpose:
 * - `redistricting` stays undefined until the 2030 census. `Engine.restore` uses its absence to catch up pre-M11
 *   saves that are already past the census.
 * - `monthStart` / `lastSummary` are rebuilt on the next End Month.
 */
import type { GameState } from './model';

export const SAVE_VERSION = 3;

type AnySave = Record<string, any>;

const STEPS: Record<number, (s: AnySave) => void> = {
  // v1 -> v2 (M12): fill the fields added as optional in M7–M11.
  1: (s) => {
    s.difficulty ??= 'normal';
    s.startYear ??= 2025;
    s.leadership ??= {};
    s.vacancies ??= [];
    s.specials ??= [];
    s.tickets ??= null;
    // saves from before M11 start with no rivals; they follow whoever beats the player from now on
    s.rivals ??= {};
    s.lastSummary ??= null;
    const P = s.player;
    P.log ??= [];
    P.favors ??= 0;
    P.role ??= null;
    P.bid ??= null;
    P.committees ??= [];
    P.bills ??= [];
    P.budget ??= null;
    P.policies ??= [];
    s.world.policy ??= { unemployment: 0, inflation: 0, gdp: 0 };
  },
  // v2 -> v3 (M15): scandal stories. Older saves start with none; a scandal already in progress (Politician.scandal)
  // keeps fading as before.
  2: (s) => {
    s.scandals ??= [];
  },
};

/** Upgrade a save of any older version in place and return it. Throws for saves from a newer version of the game. */
export function migrate(save: AnySave): GameState {
  if (!save || typeof save !== 'object' || !save.player || !save.politicians) throw new Error('Not a Ballot Ladder save file');
  let v = Number(save.version) || 1;
  if (v > SAVE_VERSION) throw new Error(`This save is from a newer version of Ballot Ladder (save format ${v}; this game reads up to ${SAVE_VERSION}).`);
  while (v < SAVE_VERSION) {
    STEPS[v](save);
    v++;
  }
  save.version = SAVE_VERSION;
  return save as GameState;
}
