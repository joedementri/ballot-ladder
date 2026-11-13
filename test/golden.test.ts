/**
 * Golden replay: a fixed seed and home town play a scripted 36-month career (file → act → decide option 0 →
 * end turn) on Story difficulty, and a hash of the exported save is snapshotted. Any change to engine behavior
 * changes the hash, so refactors that should not change gameplay are checked exactly.
 *
 * If a change is meant to alter gameplay, update the snapshot (`npx vitest run test/golden.test.ts -u`) in its own
 * commit and say why. History of intentional updates:
 * - M12 step 4: player votes on AI bills now count with legislature.ts `support()` (Engine.chamberSupport).
 * - M12 step 5: new games start with the save-version-2 defaults (empty leadership, vacancies, specials, rivals…).
 * - M14: incumbency is a strength (narrow wins, scandals, long tenure and midterms wear it down) in every race,
 *   challenged incumbents are judged on their record, and AI candidates' scandals fade during the player's races.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import type { GameState } from '../src/sim/model';

/** Fields that can change without any change in gameplay. */
const VOLATILE: (keyof GameState)[] = ['version'];

function stateHash(st: GameState): string {
  const copy: Record<string, unknown> = { ...st };
  for (const k of VOLATILE) delete copy[k];
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex').slice(0, 16);
}

async function scriptedCareer(months: number, seed = 1234) {
  const e = new Engine(BASE);
  await e.init();
  const town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))!;
  await e.newGame({
    first: 'Golden', last: 'Replay', gender: 'F', age: 38, party: 'D', homeTown: town.id, background: 'teacher', difficulty: 'story',
    pos: PARTY_BASE.D.map((x) => x * 0.7), skills: { charisma: 62, debate: 58, fundraising: 55, policy: 56, integrity: 72, organization: 58 }, seed,
  });
  for (let i = 0; i < months; i++) {
    if (e.s.pendingNight) e.ackNight();
    if (e.s.gameOver) break;
    // file for the next step up whenever not running
    const c = e.s.campaign;
    if (!c || c.stage === 'done') {
      const level = e.player.officeId ? e.def(e.player.officeId)!.level : 0;
      const opts = (await e.availableOffices()).filter((o) => o.eligible && o.level > level).sort((a, b) => a.year - b.year || a.level - b.level || (a.id < b.id ? -1 : 1));
      if (opts[0]) await e.file(opts[0].id);
    }
    const target = (await e.targets())[0]?.id ?? town.id;
    for (const [a, t] of [['fund_small'], ['canvass', target], ['town_hall', target], ['ads_digital'], ['fund_big']] as [string, string?][]) await e.act(a, t);
    for (const d of [...e.s.decisions]) e.decide(d.id, 0);
    await e.endTurn();
  }
  if (e.s.pendingNight) e.ackNight();
  return e;
}

describe('golden replay', () => {
  it('a scripted 36-month career produces the same save', async () => {
    const e = await scriptedCareer(36);
    const st = e.exportState();
    const summary = {
      date: `${st.year}-${st.month}`,
      office: e.player.officeId ?? null,
      career: e.player.career.map((c) => `${c.year} ${c.officeId} ${c.result}`),
      politicians: Object.keys(st.politicians).length,
      decisionsMade: st.player.record.length,
      nextId: st.nextId,
      hash: stateHash(st),
    };
    console.log('golden:', JSON.stringify(summary));
    expect(summary).toMatchSnapshot();
  }, 180000);

  // Officeholders exercise the legislature, vetoes, budgets and the economy, which the career above may not reach.
  for (const [label, office] of [['state representative', 'sldl'], ['governor', 'gov']] as const) {
    it(`a ${label} governs for 24 months with the same result`, async () => {
      const e = new Engine(BASE);
      await e.init();
      const town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))!;
      await e.newGame({
        first: 'Golden', last: 'Office', gender: 'M', age: 50, party: 'D', homeTown: town.id, background: 'lawyer', difficulty: 'story',
        pos: PARTY_BASE.D.map((x) => x * 0.8), skills: { charisma: 60, debate: 60, fundraising: 60, policy: 60, integrity: 70, organization: 60 }, seed: 99,
      });
      e.installOffice(office === 'sldl' ? `sldl:${town.sldl}` : 'gov:PA', e.player.id);
      for (let i = 0; i < 24; i++) {
        if (e.s.pendingNight) e.ackNight();
        if (office === 'gov' && e.view().player.budget?.year !== e.s.year) e.setBudget({ tax: 0.95, education: 1.1, safety: 1.05 });
        if (office === 'sldl' && (e.s.player.bills ?? []).length < 1) e.introduceBill('education', -1);
        for (const b of e.s.player.bills ?? []) if (b.stage === 'floor') e.billAction(b.id, 'vote');
        // alternate yes and no so both the pass and the veto/override paths run
        e.s.decisions.slice().forEach((d, j) => e.decide(d.id, (i + j) % 2));
        await e.endTurn();
      }
      const st = e.exportState();
      const summary = { date: `${st.year}-${st.month}`, office: e.player.officeId ?? null, decisionsMade: st.player.record.length, nextId: st.nextId, hash: stateHash(st) };
      console.log(`golden ${label}:`, JSON.stringify(summary));
      expect(summary).toMatchSnapshot();
    }, 120000);
  }
});
