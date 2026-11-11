import type { CountyData, DistrictData, StateData, Town, TownRow } from './types';
import { townFrom } from './types';

/** Loads and caches the static game data. Works in the main thread and in the worker. */
export class DataStore {
  states!: Record<string, StateData>;
  counties!: Record<string, CountyData>;
  districts!: Record<string, DistrictData>;
  private towns = new Map<string, Town[]>();
  private townById = new Map<string, Town>();
  private pending = new Map<string, Promise<Town[]>>();
  stateByFips: Record<string, string> = {};

  constructor(private base: string) {}

  url(rel: string) {
    return new URL(`data/${rel}`, this.base).href;
  }

  async json<T>(rel: string): Promise<T> {
    const res = await fetch(this.url(rel));
    if (!res.ok) throw new Error(`Failed to load ${rel}: ${res.status}`);
    return res.json();
  }

  async loadCore() {
    [this.states, this.counties, this.districts] = await Promise.all([
      this.json<Record<string, StateData>>('states.json'),
      this.json<Record<string, CountyData>>('counties.json'),
      this.json<Record<string, DistrictData>>('districts.json'),
    ]);
    for (const [st, s] of Object.entries(this.states)) this.stateByFips[s.fips] = st;
  }

  async townsOf(st: string): Promise<Town[]> {
    const have = this.towns.get(st);
    if (have) return have;
    if (!this.pending.has(st)) {
      this.pending.set(
        st,
        this.json<TownRow[]>(`places/${st}.json`).then((rows) => {
          const list = rows.map((r) => townFrom(st, r));
          this.towns.set(st, list);
          for (const t of list) this.townById.set(t.id, t);
          return list;
        }),
      );
    }
    return this.pending.get(st)!;
  }

  /** Town ids encode the state FIPS at chars 1-2 (P{st}{place} or M{st}{county}{cousub}). */
  async town(id: string): Promise<Town | undefined> {
    const hit = this.townById.get(id);
    if (hit) return hit;
    const st = this.stateByFips[id.slice(1, 3)];
    if (!st) return undefined;
    await this.townsOf(st);
    return this.townById.get(id);
  }

  townSync(id: string) {
    return this.townById.get(id);
  }

  loadedTowns(st: string) {
    return this.towns.get(st);
  }
}
