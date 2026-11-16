/**
 * Data loads on a flaky host: a static host can refuse a request under a burst of loads (503) or drop it. Loads retry
 * with backoff, a failed load isn't cached, a busy host never passes for "no redistricting plans", and a turn that
 * still fails leaves the game as it was before the turn, so ending the month again works.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { DataStore, DataLoadError } from '../src/data/store';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** Answer 503 for matching files, `times` times each (Infinity: always); count every request. */
function flaky(match: (path: string) => boolean, times: number) {
  const fails = new Map<string, number>();
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/data\//, '');
    calls.push(path);
    if (match(path) && (fails.get(path) ?? 0) < times) {
      fails.set(path, (fails.get(path) ?? 0) + 1);
      return { ok: false, status: 503, json: async () => null } as unknown as Response;
    }
    return realFetch(url);
  }) as typeof fetch;
  return calls;
}
function store() {
  const d = new DataStore(BASE);
  d.retryDelay = 1;
  return d;
}

describe('data loads', () => {
  it('retries a busy host until the file comes through', async () => {
    const calls = flaky((p) => p === 'places/CT.json', 3);
    const towns = await store().townsOf('CT');
    expect(towns.length).toBeGreaterThan(100);
    expect(calls.filter((p) => p === 'places/CT.json')).toHaveLength(4);
  });

  it("doesn't retry a missing file, and doesn't cache a failed load", async () => {
    const d = store();
    const calls = flaky(() => false, 0);
    await expect(d.json('places/XX.json')).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);

    flaky((p) => p === 'places/CT.json', Infinity);
    await expect(d.townsOf('CT')).rejects.toBeInstanceOf(DataLoadError);
    globalThis.fetch = realFetch;
    expect((await d.townsOf('CT')).length).toBeGreaterThan(100);
  });

  it('a busy host is an error for plan files, a missing one is "no plans"', async () => {
    const d = store();
    flaky((p) => p === 'redistrict/TX.json', Infinity);
    await expect(d.statePlans('TX')).rejects.toBeInstanceOf(DataLoadError);
    globalThis.fetch = realFetch;
    expect((await d.statePlans('TX')).cd?.seats).toBeGreaterThan(30);
    expect(await d.statePlans('DC')).toEqual({});
  });
});

describe('a turn that fails to load data', () => {
  it('rolls the game back to the start of the month, and the next try goes through', async () => {
    const e = new Engine(BASE);
    e.data.retryDelay = 1;
    await e.init();
    const town = (await e.data.townsOf('NJ')).find((t) => t.name.startsWith('Trenton'))!;
    await e.newGame({
      first: 'Test', last: 'Player', gender: 'F', age: 45, party: 'D', homeTown: town.id, background: 'lawyer',
      pos: PARTY_BASE.D.map((x) => x * 0.8), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed: 3,
    });
    // November of an election year, with no other state's towns loaded yet
    e.s.year = 2029;
    e.s.month = 11;
    const before = JSON.stringify(e.exportState());
    const calls = flaky((p) => p.startsWith('places/') && p !== 'places/NJ.json', Infinity);
    await expect(e.atomic(() => e.endTurn())).rejects.toBeInstanceOf(DataLoadError);
    expect(calls.some((p) => p.startsWith('places/') && p !== 'places/NJ.json')).toBe(true);
    expect(JSON.stringify(e.exportState())).toBe(before);

    globalThis.fetch = realFetch;
    await e.atomic(() => e.endTurn());
    expect(e.s.year * 12 + e.s.month).toBeGreaterThan(2029 * 12 + 11);
  });
});
