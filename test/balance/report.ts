/**
 * Balance report: npm run balance [-- n=40 profile=newcomer|climber|both difficulty=normal env=neutral|good|bad rungs=council,mayor,vs-incumbent strategies=balanced,fundraiser seed=1]
 * Plays n races per strategy per office rung and prints win rates and campaign stats.
 */
import { BASE } from '../setup';
import { Engine } from '../../src/sim/game';
import { RUNGS, STRATEGIES, runRung, summarize, townPool, type Env } from './harness';
import type { Difficulty } from '../../src/sim/model';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const n = Number(args.n ?? 40);
const profiles = (args.profile ?? 'both') === 'both' ? (['newcomer', 'climber'] as const) : [args.profile as 'newcomer' | 'climber'];
const difficulty = (args.difficulty ?? 'normal') as Difficulty;
const strategies = args.strategies ? STRATEGIES.filter((x) => args.strategies.split(',').includes(x)) : STRATEGIES;
const env = (args.env ?? 'neutral') as Env;
const rungs = args.rungs ? RUNGS.filter((r) => args.rungs.split(',').includes(r.key)) : RUNGS;

const e = new Engine(BASE);
await e.init();
const pool = await townPool(e);
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);
console.log(`n=${n} per cell, difficulty=${difficulty}, ${pool.length} candidate home towns\n`);
console.log('rung          profile   strategy    | win  prim.loss (open) backed | med share  spend/exp  rec   | vs inc (win)');
for (const rung of rungs) {
  for (const profile of profiles) {
    const t0 = Date.now();
    const rs = await runRung(e, pool, rung, { n, profile, difficulty, env, strategies, seed: Number(args.seed ?? 1) });
    for (const s of strategies) {
      const sub = rs.filter((r) => r.strategy === s);
      const m = summarize(sub);
      const inc = sub.filter((r) => r.vsIncumbent);
      console.log(
        `${rung.key.padEnd(13)} ${profile.padEnd(9)} ${s.padEnd(11)} | ${pct(m.win)} ${pct(m.primaryLoss)}    ${pct(m.openPrimaryLoss)}  ${pct(m.backed)} | ${pct(m.share)}     ${m.spendRatio.toFixed(2).padStart(5)}    ${pct(m.rec)} | ${String(inc.length).padStart(3)} (${pct(summarize(inc).win)})`,
      );
    }
    console.log(`   (${rs.length} races in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}
