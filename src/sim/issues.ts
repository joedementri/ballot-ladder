/**
 * Policy space. Each position is in [-1, 1]: -1 = most progressive, +1 = most conservative.
 * Voter blocs have ideal points and salience weights over these issues.
 */
import type { Demo, Party } from '../data/types';
import { clamp } from './rng';

export const ISSUES = [
  { key: 'taxes', label: 'Taxes', left: 'Raise taxes on high earners', right: 'Cut taxes across the board' },
  { key: 'spending', label: 'Spending', left: 'Expand public programs', right: 'Cut spending, shrink government' },
  { key: 'health', label: 'Healthcare', left: 'Public option / single payer', right: 'Market-based, deregulated' },
  { key: 'immigration', label: 'Immigration', left: 'Path to citizenship', right: 'Strict enforcement, border wall' },
  { key: 'guns', label: 'Guns', left: 'Universal checks, assault ban', right: 'Protect gun rights, carry' },
  { key: 'abortion', label: 'Abortion', left: 'Protect access', right: 'Restrict / ban' },
  { key: 'energy', label: 'Energy & Climate', left: 'Clean energy transition', right: 'Expand oil, gas & coal' },
  { key: 'crime', label: 'Crime & Policing', left: 'Reform & accountability', right: 'Tough on crime, fund police' },
  { key: 'education', label: 'Education', left: 'Fund public schools', right: 'School choice & vouchers' },
  { key: 'trade', label: 'Trade', left: 'Free trade agreements', right: 'Tariffs, protect industry' },
  { key: 'housing', label: 'Housing', left: 'Build more, rent protections', right: 'Local control, limit density' },
  { key: 'labor', label: 'Labor', left: 'Pro-union, raise minimum wage', right: 'Right-to-work, flexible labor' },
] as const;
export type IssueKey = (typeof ISSUES)[number]['key'];
export const N_ISSUES = ISSUES.length;
export type Positions = number[]; // length N_ISSUES

/** Median party positions (rough, contemporary). */
export const PARTY_BASE: Record<Party, Positions> = {
  D: [-0.55, -0.5, -0.6, -0.45, -0.6, -0.7, -0.6, -0.35, -0.5, -0.1, -0.3, -0.55],
  R: [0.6, 0.55, 0.55, 0.7, 0.7, 0.55, 0.6, 0.6, 0.5, 0.45, 0.25, 0.5],
  I: [0, 0, -0.1, 0.1, 0, -0.1, 0, 0.1, 0, 0.1, 0, 0],
};

/** Voter blocs. Shares come from demographics; partisanship is a national baseline (D two-party share). */
export const BLOCS = [
  { key: 'wcol', label: 'White college', dShare: 0.56 },
  { key: 'wnon', label: 'White non-college', dShare: 0.33 },
  { key: 'black', label: 'Black', dShare: 0.86 },
  { key: 'hisp', label: 'Hispanic', dShare: 0.53 },
  { key: 'asian', label: 'Asian', dShare: 0.6 },
  { key: 'young', label: 'Under 30', dShare: 0.57 },
  { key: 'senior', label: 'Seniors 65+', dShare: 0.44 },
] as const;
export type BlocKey = (typeof BLOCS)[number]['key'];
export const N_BLOCS = BLOCS.length;

/** Bloc ideal points relative to national center; shifted by local lean later. */
const BLOC_IDEAL: Record<BlocKey, Positions> = {
  wcol: [-0.1, -0.05, -0.15, -0.15, -0.25, -0.35, -0.3, -0.1, -0.15, -0.25, -0.1, 0.05],
  wnon: [0.25, 0.3, 0.15, 0.4, 0.45, 0.2, 0.35, 0.35, 0.2, 0.3, 0.15, 0.1],
  black: [-0.35, -0.45, -0.5, -0.1, -0.25, -0.1, -0.25, -0.35, -0.3, 0.0, -0.4, -0.45],
  hisp: [-0.15, -0.25, -0.35, -0.25, -0.05, 0.05, -0.15, 0.1, -0.1, 0.05, -0.3, -0.3],
  asian: [-0.1, -0.15, -0.3, -0.25, -0.35, -0.25, -0.3, 0.05, 0.0, -0.2, -0.2, -0.1],
  young: [-0.3, -0.3, -0.4, -0.3, -0.3, -0.45, -0.5, -0.35, -0.2, -0.1, -0.5, -0.35],
  senior: [0.1, 0.05, 0.0, 0.25, 0.2, 0.15, 0.15, 0.3, 0.05, 0.15, 0.2, 0.0],
};

/** Salience weights (how much each bloc cares about each issue); rows roughly sum to 1. */
const BLOC_SAL: Record<BlocKey, Positions> = {
  wcol: [0.08, 0.06, 0.1, 0.07, 0.07, 0.12, 0.1, 0.06, 0.1, 0.04, 0.12, 0.08],
  wnon: [0.12, 0.08, 0.09, 0.14, 0.12, 0.07, 0.08, 0.09, 0.05, 0.07, 0.04, 0.05],
  black: [0.06, 0.1, 0.13, 0.04, 0.06, 0.05, 0.03, 0.15, 0.13, 0.03, 0.1, 0.12],
  hisp: [0.08, 0.08, 0.13, 0.15, 0.04, 0.06, 0.04, 0.09, 0.1, 0.04, 0.1, 0.09],
  asian: [0.1, 0.07, 0.1, 0.1, 0.05, 0.07, 0.06, 0.12, 0.15, 0.06, 0.08, 0.04],
  young: [0.05, 0.06, 0.1, 0.07, 0.08, 0.12, 0.14, 0.08, 0.06, 0.02, 0.16, 0.06],
  senior: [0.12, 0.1, 0.2, 0.1, 0.07, 0.06, 0.04, 0.12, 0.04, 0.05, 0.04, 0.06],
};

export const blocIdeal = (b: BlocKey) => BLOC_IDEAL[b];
export const blocSalience = (b: BlocKey) => BLOC_SAL[b];

/**
 * Bloc shares of the electorate for a place. Race/edu blocs partition the electorate;
 * age blocs (young/senior) are overlays given a smaller weight. Turnout differences are applied.
 */
export function blocShares(d: Demo): number[] {
  const white = clamp(d.white), black = clamp(d.black), hisp = clamp(d.hispanic), asian = clamp(d.asian);
  const other = clamp(1 - white - black - hisp - asian);
  // whites' college rate is a bit higher than the overall rate
  const wcolRate = clamp(d.college * 1.12, 0.05, 0.9);
  const turn = { wcol: 0.78, wnon: 0.62, black: 0.58, hisp: 0.47, asian: 0.55 };
  const base = [
    white * wcolRate * turn.wcol,
    (white * (1 - wcolRate) + other * 0.6) * turn.wnon,
    black * turn.black,
    (hisp + other * 0.2) * turn.hisp,
    (asian + other * 0.2) * turn.asian,
  ];
  // age overlays: younger median age -> more young voters
  const youngShare = clamp(0.17 + (38 - d.age) * 0.008, 0.06, 0.35) * 0.35;
  const seniorShare = clamp(0.22 + (d.age - 38) * 0.012, 0.08, 0.5) * 0.35;
  const sum = base.reduce((a, b) => a + b, 0) || 1;
  const scale = 1 - youngShare - seniorShare;
  return [...base.map((x) => (x / sum) * scale), youngShare, seniorShare];
}

/** Weighted squared distance between a candidate's positions and an ideal point. */
export function issueDistance(pos: Positions, ideal: Positions, sal: Positions, shift: number, emphasis?: Positions): number {
  let s = 0;
  for (let i = 0; i < N_ISSUES; i++) {
    const w = sal[i] * (emphasis ? 1 + emphasis[i] : 1);
    const diff = pos[i] - clamp(ideal[i] + shift, -1, 1);
    s += w * diff * diff;
  }
  return s;
}

/** Ideology summary: weighted mean position, -1..1. */
export const ideologyScore = (p: Positions) => p.reduce((a, b) => a + b, 0) / p.length;

export function ideologyLabel(x: number): string {
  if (x < -0.6) return 'Progressive';
  if (x < -0.3) return 'Liberal';
  if (x < -0.1) return 'Center-left';
  if (x <= 0.1) return 'Centrist';
  if (x <= 0.3) return 'Center-right';
  if (x <= 0.6) return 'Conservative';
  return 'Hard-right';
}
