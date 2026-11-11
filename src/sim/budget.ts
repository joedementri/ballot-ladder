/**
 * Executive budgets and the economy.
 *
 * A budget sets five levers (1 = current-services baseline). Instead of one-off bumps, the levers move the
 * *targets* that jurisdiction metrics drift toward each month, so a budget's effects build up over a year.
 * Laws work the same way (persistent offsets, see `policyOffsets`), and state and federal policy shifts
 * the national economy's equilibrium in world.ts.
 */
import type { Budget, EconShift, Policy, World } from './model';
import { clamp } from './rng';

export type LeverKey = 'tax' | 'education' | 'safety' | 'infrastructure' | 'health';

export const LEVERS: { key: LeverKey; label: string; min: number; max: number; help: string }[] = [
  { key: 'tax', label: 'Tax rates', min: 0.8, max: 1.2, help: 'Higher taxes balance the books but slow job growth and raise living costs.' },
  { key: 'education', label: 'Schools', min: 0.7, max: 1.3, help: 'Moves school quality over the year.' },
  { key: 'safety', label: 'Public safety', min: 0.7, max: 1.3, help: 'Police, courts and emergency services. Moves the crime index.' },
  { key: 'infrastructure', label: 'Infrastructure', min: 0.7, max: 1.3, help: 'Roads, transit and water. Also supports jobs.' },
  { key: 'health', label: 'Health & services', min: 0.7, max: 1.3, help: 'Public health and social services. Moves health coverage.' },
];

export const baselineBudget = (year: number, month: number): Budget => ({ year, month, tax: 1, education: 1, safety: 1, infrastructure: 1, health: 1 });

export const spendIndex = (b: Budget) => (b.education + b.safety + b.infrastructure + b.health) / 4;

/**
 * Offsets from each metric's baseline that the budget pulls toward.
 * Tuned so that spending more is roughly paid for by the deficit it causes (budget balance counts double in approval),
 * so the trade-off is who you please, not a free lunch.
 */
export function budgetTargets(b: Budget | null | undefined): Record<string, number> {
  if (!b) return {};
  const d = { tax: b.tax - 1, edu: b.education - 1, safety: b.safety - 1, infra: b.infrastructure - 1, health: b.health - 1 };
  const spend = spendIndex(b) - 1;
  return {
    schools: 20 * d.edu,
    crime: -16 * d.safety,
    infrastructure: 20 * d.infra,
    health: 20 * d.health,
    budget: 30 * d.tax - 37 * spend,
    jobs: -25 * d.tax + 8 * d.infra,
    cost: 20 * d.tax,
  };
}

/** Persistent metric offsets from laws in force (scale: decision metric units ×3, capped). */
export function policyOffsets(policies: Policy[] | undefined, scale = 1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of policies ?? []) for (const [k, v] of Object.entries(p.metrics)) out[k] = (out[k] ?? 0) + v * 3 * scale;
  for (const k of Object.keys(out)) out[k] = clamp(out[k], k === 'budget' ? -6 : -15, k === 'budget' ? 6 : 15);
  return out;
}

/** How the national economy feeds into a jurisdiction's metrics. */
export function econOffsets(w: World): Record<string, number> {
  return { jobs: -6 * (w.unemployment - 4.4) + 1.5 * (w.gdp - 2.1), cost: 4 * (w.inflation - 2.6) };
}

/** Effect of the budget on the player's standing with interest groups (applied once, when enacted). */
export function budgetGroups(b: Budget): Record<string, number> {
  const spend = spendIndex(b) - 1;
  return {
    teachers: 80 * (b.education - 1),
    police: 80 * (b.safety - 1),
    labor: 50 * (b.infrastructure - 1),
    seniors: 50 * (b.health - 1),
    taxpayers: -120 * (b.tax - 1) - 80 * spend,
    chamber: -80 * (b.tax - 1),
  };
}

/** Shift of the player's perceived positions (spending, taxes) when a budget is enacted. */
export function budgetPositions(b: Budget): { spending: number; taxes: number } {
  return { spending: -0.15 * (spendIndex(b) - 1), taxes: -0.2 * (b.tax - 1) };
}

/**
 * Legislature's response to a budget. `control` is the share of seats the executive's party holds in each chamber.
 * A friendly legislature passes it; a hostile one pulls every lever back toward the baseline.
 */
export function legislateBudget(b: Budget, control: number[]): { budget: Budget; note?: string } {
  const worst = control.length ? Math.min(...control) : 1;
  const pull = worst >= 0.5 ? 0 : worst >= 0.42 ? 0.35 : 0.6;
  if (!pull) return { budget: b };
  const out = { ...b };
  for (const l of LEVERS) out[l.key] = round2(1 + (b[l.key] - 1) * (1 - pull));
  return { budget: out, note: `The opposition-controlled legislature cut your changes by ${Math.round(pull * 100)}%.` };
}

/** Fiscal stance of a budget as a shift to the national economy. `weight` = 1 for the President, state population share for a governor. */
export function fiscalShift(b: Budget | null | undefined, weight: number): EconShift {
  if (!b) return { unemployment: 0, inflation: 0, gdp: 0 };
  const impulse = spendIndex(b) - 1 - (b.tax - 1);
  return { unemployment: -0.8 * impulse * weight, inflation: 1.0 * impulse * weight, gdp: 1.5 * impulse * weight };
}

/** Economic effect of a law moving `issue` in direction `dir` (+1 conservative), per issue: [unemployment, inflation, gdp]. */
const LAW_ECON: Record<string, [number, number, number]> = {
  taxes: [-0.05, 0.08, 0.15],
  spending: [0.04, -0.1, -0.12],
  trade: [0.02, 0.25, -0.1],
  labor: [-0.04, -0.03, 0.05],
  energy: [-0.02, -0.08, 0.06],
  immigration: [0, 0.06, -0.08],
  housing: [0, 0.05, -0.02],
};
export function lawEcon(issue: string, dir: number, weight: number): EconShift | null {
  const e = LAW_ECON[issue];
  if (!e || !weight) return null;
  return { unemployment: e[0] * dir * weight, inflation: e[1] * dir * weight, gdp: e[2] * dir * weight };
}

export function addShift(w: World, s: EconShift | null) {
  if (!s) return;
  const p = (w.policy ??= { unemployment: 0, inflation: 0, gdp: 0 });
  p.unemployment = clamp(p.unemployment + s.unemployment, -1.5, 1.5);
  p.inflation = clamp(p.inflation + s.inflation, -1.5, 1.5);
  p.gdp = clamp(p.gdp + s.gdp, -2, 2);
}

const round2 = (x: number) => Math.round(x * 100) / 100;
