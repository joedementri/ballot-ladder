/**
 * Writes a save from after the 2040 redraw (M22) for the smoke test to import:  npx tsx test/smoke-save.ts <file>
 * A Texas player in October 2041: the 2040 census is in and every state has its 2041 maps.
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';

const out = process.argv[2] ?? 'smoke-out/m22-save.json.gz';
const e = new Engine(BASE);
await e.init();
const town = (await e.data.townsOf('TX')).find((t) => t.name.startsWith('Austin'))!;
await e.newGame({
  first: 'Map', last: 'Maker', gender: 'F', age: 30, party: 'R', homeTown: town.id, background: 'lawyer',
  pos: PARTY_BASE.R.map((x) => x * 0.8), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed: 5,
});
const step = async (y: number, m: number) => {
  e.s.year = y;
  e.s.month = m;
  if (e.s.pendingNight) e.ackNight();
  await e.endTurn();
  if (e.s.pendingNight) e.ackNight();
};
await step(2030, 12);
await step(2031, 9);
await step(2032, 12);
await step(2040, 12);
await step(2041, 9);
writeFileSync(out, gzipSync(JSON.stringify(e.exportState())));
console.log(`wrote ${out}: ${e.s.year}-${e.s.month}, TX congressional map ${e.data.activePlans['cd:TX']}`);
