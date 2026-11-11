/**
 * Result history for U.S. House districts and governors, plus optional newer results (e.g. the 2026 midterms).
 *   npm run data:history     (also run at the end of npm run data:build)
 *
 * Inputs (pipeline/raw/, downloaded by sources.ts unless noted):
 *   538_house.csv, 538_gov.csv   538 election-results (CC BY 4.0), 1998–2024
 *   ../supplement.csv            committed: races missing from 538's files (KY and MS 2023 governor), same layout, with sources
 *   results_2026.csv             optional, added by hand: any newer results in the same 538 column layout
 *                                (id, state_abbrev, office_name, office_seat_name, cycle, stage, special,
 *                                 candidate_name, politician_id, ballot_party, votes, ranked_choice_round, unopposed, winner)
 *
 * Outputs (public/data/):
 *   results/house.json   { [cd geoid]: { [year]: [dem, rep, total] } }   — keyed by today's district number
 *   states.json          adds `gov: { [year | "<year>s"]: [dem, rep, total] }` to each state (patched in place)
 *   results/latest.json  winners' parties from results_2026.csv, used for seat control in the 2027 start
 *   meta.json            adds `history` (source note) and `latest` (cycles found in results_2026.csv)
 *
 * Unopposed races without a vote count are stored as [1, 0, 0] or [0, 1, 0] (total 0 = uncontested).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW } from './sources.ts';
import { OUT, parseCsv, readRaw, writeJson } from './lib.ts';

type Res = [number, number, number];
type Row = Record<string, string>;

const MIN_YEAR = 1998;
const DEM = new Set(['DEM', 'DFL']);
const REP = new Set(['REP']);

/** Group rows into races and reduce each to [D, R, total] plus the winner's party. */
export function reduceRaces(rows: Row[], office: string) {
  const races = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.office_name !== office || +r.cycle < MIN_YEAR) continue;
    if (!['general', 'runoff', 'jungle primary'].includes(r.stage)) continue;
    const key = [r.state_abbrev, r.office_seat_name, r.cycle, r.special === 'true' ? 's' : ''].join('|');
    let list = races.get(key);
    if (!list) races.set(key, (list = []));
    list.push(r);
  }
  const out: { st: string; seat: string; year: string; special: boolean; res: Res; winner: 'D' | 'R' | 'I' | null }[] = [];
  for (const [key, list] of races) {
    const [st, seat, year, sp] = key.split('|');
    // a runoff decides the race when one was held; a jungle primary only when there was no November general
    const stage = ['runoff', 'general', 'jungle primary'].find((s) => list.some((r) => r.stage === s && (r.votes || r.unopposed === 'true')));
    if (!stage) continue;
    let rs = list.filter((r) => r.stage === stage);
    // ranked-choice tabulations: keep the final round
    const rounds = rs.map((r) => +(r.ranked_choice_round || 0));
    const last = Math.max(...rounds);
    if (last > 0) rs = rs.filter((r) => +(r.ranked_choice_round || 0) === last);
    // fusion voting (NY, CT): one candidate on several lines counts for their major party
    const cands = new Map<string, { party: 'D' | 'R' | 'I'; votes: number; winner: boolean; unopposed: boolean }>();
    let total = 0;
    for (const r of rs) {
      const v = +(r.votes || 0);
      total += v;
      const id = r.politician_id || r.candidate_name || `alt:${r.alt_result_text}`;
      const c = cands.get(id) ?? { party: 'I' as const, votes: 0, winner: false, unopposed: false };
      if (DEM.has(r.ballot_party)) c.party = 'D';
      else if (REP.has(r.ballot_party) && c.party !== 'D') c.party = 'R';
      c.votes += v;
      c.winner ||= r.winner === 'true';
      c.unopposed ||= r.unopposed === 'true';
      cands.set(id, c);
    }
    let d = 0, rep = 0;
    for (const c of cands.values()) {
      if (c.party === 'D') d += c.votes;
      else if (c.party === 'R') rep += c.votes;
    }
    const all = [...cands.values()];
    const w = all.find((c) => c.winner) ?? (total ? all.sort((a, b) => b.votes - a.votes)[0] : undefined);
    const res: Res = total ? [d, rep, total] : w ? [w.party === 'D' ? 1 : 0, w.party === 'R' ? 1 : 0, 0] : [0, 0, 0];
    if (!total && !w) continue;
    out.push({ st, seat, year, special: sp === 's', res, winner: w?.party ?? null });
  }
  return out;
}

function main() {
  const states = JSON.parse(readFileSync(join(OUT, 'states.json'), 'utf8')) as Record<string, any>;
  const districts = JSON.parse(readFileSync(join(OUT, 'districts.json'), 'utf8')) as Record<string, { kind: string; st: string }>;
  const fips: Record<string, string> = Object.fromEntries(Object.entries(states).map(([st, s]) => [st, s.fips]));
  const latestRows = existsSync(join(RAW, 'results_2026.csv')) ? parseCsv(readRaw('results_2026.csv')) : [];

  /** "District 7" -> today's CD geoid (at-large states use 00). */
  const cdGeoid = (st: string, seat: string) => {
    const n = parseInt(seat.replace(/\D+/g, ''), 10) || 1;
    const f = fips[st];
    if (!f) return null;
    if (districts[`cd:${f}00`]) return n === 1 || n === 0 ? `${f}00` : null;
    const id = `${f}${String(n).padStart(2, '0')}`;
    return districts[`cd:${id}`] ? id : null;
  };

  // ---- U.S. House
  const houseRows = [...parseCsv(readRaw('538_house.csv')), ...latestRows];
  const house: Record<string, Record<string, Res>> = {};
  let nHouse = 0;
  for (const r of reduceRaces(houseRows, 'U.S. House')) {
    if (r.special || +r.year % 2) continue;
    const id = cdGeoid(r.st, r.seat);
    if (!id) continue;
    (house[id] ??= {})[r.year] = r.res;
    nHouse++;
  }
  writeJson('results/house.json', house);

  // ---- Governors (odd-year states and specials included; specials keyed "<year>s" like Senate)
  const supplement = parseCsv(readFileSync(join(import.meta.dirname, 'supplement.csv'), 'utf8'));
  const govRows = [...parseCsv(readRaw('538_gov.csv')), ...supplement, ...latestRows];
  for (const s of Object.values(states)) s.gov = {};
  let nGov = 0;
  for (const r of reduceRaces(govRows, 'Governor')) {
    if (!states[r.st]) continue;
    states[r.st].gov[`${r.year}${r.special ? 's' : ''}`] = r.res;
    nGov++;
  }
  writeFileSync(join(OUT, 'states.json'), JSON.stringify(states));

  // ---- Newer results for seat control (2027 start)
  const latest: { cycles: number[]; house: Record<string, string>; senate: Record<string, string>; gov: Record<string, string> } = { cycles: [], house: {}, senate: {}, gov: {} };
  if (latestRows.length) {
    const cycles = new Set<number>();
    for (const r of reduceRaces(latestRows, 'U.S. House')) {
      const id = cdGeoid(r.st, r.seat);
      if (id && r.winner) { latest.house[id] = r.winner; cycles.add(+r.year); }
    }
    for (const r of reduceRaces(latestRows, 'U.S. Senate')) {
      // seat names look like "Class II"; the game keys Senate seats by class number
      const cls = /III/.test(r.seat) ? 3 : /II/.test(r.seat) ? 2 : /I/.test(r.seat) ? 1 : parseInt(r.seat, 10);
      if (cls && r.winner) { latest.senate[`${r.st}:${cls}`] = r.winner; cycles.add(+r.year); }
    }
    for (const r of reduceRaces(latestRows, 'Governor')) if (r.winner) { latest.gov[r.st] = r.winner; cycles.add(+r.year); }
    latest.cycles = [...cycles].sort();
  }
  writeJson('results/latest.json', latest);

  const metaPath = join(OUT, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
  meta.history = '538 election-results (CC BY 4.0): U.S. House and Governor results 1998–2024';
  meta.latest = latest.cycles;
  writeFileSync(metaPath, JSON.stringify(meta));

  const years = new Set(Object.values(house).flatMap((h) => Object.keys(h)));
  console.log(`house: ${Object.keys(house).length} districts, ${nHouse} races, years ${[...years].sort().join(' ')}`);
  console.log(`governor: ${nGov} races`);
  console.log(`latest results: ${latestRows.length ? `${latest.cycles.join(', ')} (${Object.keys(latest.house).length} House, ${Object.keys(latest.senate).length} Senate, ${Object.keys(latest.gov).length} Governor)` : 'none (add pipeline/raw/results_2026.csv)'}`);
}

if (process.argv[1]?.endsWith('history.ts')) main();
export { main as buildHistory };
