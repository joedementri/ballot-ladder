import type { Difficulty } from './model';

/**
 * Difficulty knobs (tuned with `npm run balance`).
 * cash: starting campaign cash · aiBudget: AI campaign budgets · aiRec: AI recognition growth · noise: election-day swing.
 */
export const DIFFICULTY: Record<Difficulty, { label: string; desc: string; cash: number; aiBudget: number; aiRec: number; noise: number }> = {
  story: { label: 'Story', desc: 'More starting money, weaker opponents, fewer upsets.', cash: 2, aiBudget: 0.7, aiRec: 0.75, noise: 0.7 },
  normal: { label: 'Normal', desc: 'The intended balance: good campaigns usually win, but not always.', cash: 1, aiBudget: 1, aiRec: 1, noise: 1 },
  hard: { label: 'Hard', desc: 'Lean budgets, well-funded opponents, more surprises.', cash: 0.6, aiBudget: 1.3, aiRec: 1.25, noise: 1.3 },
};
