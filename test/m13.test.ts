/**
 * M13 quality of life: skip ahead (Engine.advance), merged month summaries, and save files (gzip or plain JSON).
 * Save slots live in IndexedDB on the main thread and are covered by the smoke test.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { decodeSave, encodeSave, isGzip } from '../src/store/saves';
import type { GameState } from '../src/sim/model';

async function newEngine(seed = 7, age = 30) {
  const e = new Engine(BASE);
  await e.init();
  const town = (await e.data.townsOf('PA')).find((t) => t.name.startsWith('Lansdale'))!;
  await e.newGame({
    first: 'Skip', last: 'Ahead', gender: 'F', age, party: 'D', homeTown: town.id, background: 'teacher', difficulty: 'story',
    pos: PARTY_BASE.D.map((x) => x * 0.7), skills: { charisma: 60, debate: 60, fundraising: 60, policy: 60, integrity: 60, organization: 60 }, seed,
  });
  return { e, town };
}

const hash = (st: GameState) => {
  const { lastSummary: _drop, ...rest } = st;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
};

describe('skip ahead', () => {
  it('is the same as ending the months one by one', async () => {
    const a = (await newEngine()).e;
    const b = (await newEngine()).e;
    let months = 0;
    for (let i = 0; i < 4; i++) {
      const r = await a.advance(12);
      months += r.months;
      if (a.s.pendingNight) a.ackNight();
    }
    for (let i = 0; i < months; i++) {
      await b.endTurn();
      if (b.s.pendingNight) b.ackNight();
    }
    expect(months).toBeGreaterThan(4);
    expect(hash(a.exportState())).toBe(hash(b.exportState()));
  }, 120000);

  it('stops at the last month to file, and always moves at least one month', async () => {
    const { e } = await newEngine();
    const r = await e.advance(12);
    expect(r.stopReason).toBe('filing');
    const deadline = (await e.availableOffices()).filter((o) => o.eligible && o.deadline.year === e.s.year && o.deadline.month === e.s.month);
    expect(deadline.length).toBeGreaterThan(0);
    expect(r.stopText).toContain(deadline[0].title);
    // pressing skip again during the stop month still advances
    const at = e.s.year * 12 + e.s.month;
    const r2 = await e.advance(1);
    expect(r2.months).toBe(1);
    expect(e.s.year * 12 + e.s.month).toBe(at + 1);
  }, 60000);

  it('can pass a full year in one call and merges the summary', async () => {
    const { e } = await newEngine();
    let r = await e.advance(12);
    for (let i = 0; i < 10 && r.stopReason !== 'max'; i++) {
      if (e.s.pendingNight) e.ackNight();
      r = await e.advance(12);
    }
    expect(r.stopReason).toBe('max');
    expect(r.months).toBe(12);
    const s = e.s.lastSummary!;
    expect(s.span?.months).toBe(12);
    expect(s.span?.stop).toContain('12 months');
    // money lines still reconcile with the cash change over the whole span
    const total = s.money.reduce((a, m) => a + m.amount, 0);
    expect(Math.abs(total - (s.cash[1] - s.cash[0]))).toBeLessThanOrEqual(s.money.length);
    expect(s.events.length).toBeGreaterThan(0);
  }, 120000);

  it('stops for a campaign as the vote approaches, and for new decisions in office', async () => {
    const { e, town } = await newEngine();
    const opt = (await e.availableOffices()).filter((o) => o.eligible).sort((a, b) => a.year - b.year)[0];
    await e.file(opt.id);
    const r = await e.advance(24);
    expect(['election', 'campaign', 'night']).toContain(r.stopReason);
    expect(r.months).toBeLessThan(24);

    const { e: gov } = await newEngine(11, 50);
    gov.installOffice('gov:PA', gov.player.id);
    expect(town.st).toBe('PA');
    let saw = false;
    for (let i = 0; i < 6 && !saw; i++) {
      for (const d of [...gov.s.decisions]) gov.decide(d.id, 0);
      const r2 = await gov.advance(12);
      if (gov.s.pendingNight) gov.ackNight();
      saw = r2.stopReason === 'decision';
      if (saw) expect(gov.s.decisions.length).toBeGreaterThan(0);
    }
    expect(saw).toBe(true);
  }, 120000);
});

describe('save files', () => {
  it('round-trips gzip and plain JSON, and rejects other files', async () => {
    const { e } = await newEngine();
    const st = e.exportState();
    const gz = await encodeSave(st);
    const bytes = new Uint8Array(await gz.arrayBuffer());
    expect(isGzip(bytes)).toBe(true);
    const plain = new Blob([JSON.stringify(st)]);
    expect(bytes.length).toBeLessThan(plain.size / 3);
    const back = (await decodeSave(gz)) as GameState;
    expect(hash(back)).toBe(hash(JSON.parse(JSON.stringify(st))));
    expect(((await decodeSave(plain)) as GameState).seed).toBe(st.seed);
    await expect(decodeSave(new Blob(['{"hello":1}']))).rejects.toThrow(/save file/);
    await expect(decodeSave(new Blob(['not json']))).rejects.toThrow(/save file/);
  }, 60000);
});
