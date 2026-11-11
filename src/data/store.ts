import type { Apportionment, CountyData, DistrictData, Res, StateData, StatePlans, Town, TownRow } from './types';
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
          this.overlayTowns(st, list);
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

  private houseHist?: Promise<Record<string, Record<string, Res>>>;
  /** U.S. House results by today's district (loaded on first use). */
  houseHistory() {
    return (this.houseHist ??= this.json<Record<string, Record<string, Res>>>('results/house.json').catch(() => ({}) as Record<string, Record<string, Res>>));
  }

  townSync(id: string) {
    return this.townById.get(id);
  }

  loadedTowns(st: string) {
    return this.towns.get(st);
  }

  // ------------------------------------------------------------------ redistricting (M11)

  /** Bumped whenever district lines change, so caches keyed on geography can tell. */
  planVersion = 0;
  /** Enacted plans by `${kind}:${ST}` ('fair' | 'D' | 'R'; maps that keep their lines aren't listed). */
  activePlans: Record<string, string> = {};
  private planFiles = new Map<string, Promise<StatePlans>>();
  /** Original district records replaced by a plan (undefined = the key didn't exist). */
  private baseDistricts = new Map<string, DistrictData | undefined>();
  /** Original district memberships of towns. */
  private baseTowns = new Map<string, Pick<Town, 'cd' | 'sldu' | 'sldl'>>();
  private apportion?: Promise<Apportionment>;

  statePlans(st: string): Promise<StatePlans> {
    let p = this.planFiles.get(st);
    if (!p) {
      p = this.json<StatePlans>(`redistrict/${st}.json`).catch(() => ({}) as StatePlans);
      this.planFiles.set(st, p);
      p.then((f) => this.loadedPlanFiles.set(st, f));
    }
    return p;
  }
  apportionment() {
    return (this.apportion ??= this.json<Apportionment>('redistrict/apportion.json'));
  }

  /** Replace district lines with the enacted plans (an empty map restores today's lines). */
  async applyPlans(plans: Record<string, string>) {
    const want = Object.entries(plans).filter(([, p]) => p !== 'keep');
    const files = new Map<string, StatePlans>();
    for (const st of new Set(want.map(([k]) => k.split(':')[1]))) files.set(st, await this.statePlans(st));
    // restore
    for (const [k, d] of this.baseDistricts) {
      if (d) this.districts[k] = d;
      else delete this.districts[k];
    }
    this.baseDistricts.clear();
    this.activePlans = {};
    const keep = (k: string) => { if (!this.baseDistricts.has(k)) this.baseDistricts.set(k, this.districts[k]); };
    for (const [key, plan] of want) {
      const [kind, st] = key.split(':');
      const m = files.get(st)?.[kind as 'cd'];
      const p = m?.plans?.[plan as 'fair'] ?? m?.plans?.fair;
      if (!m || m.keep || !p) continue;
      for (const [code, d] of Object.entries(p.d)) {
        const k = `${kind}:${code}`;
        keep(k);
        this.districts[k] = { n: d.n, st, kind: kind as 'cd', pop: d.pop, d: d.d, lean: d.lean, county: d.county, party: null };
      }
      for (const code of m.retired ?? []) {
        const k = `${kind}:${code}`;
        keep(k);
        if (this.districts[k]) this.districts[k] = { ...this.districts[k], retired: true };
      }
      this.activePlans[key] = plan;
    }
    for (const [st, list] of this.towns) this.overlayTowns(st, list, files.get(st));
    this.planVersion++;
  }

  /** Point towns at their districts under the enacted plans. */
  private overlayTowns(st: string, list: Town[], file?: StatePlans) {
    for (const t of list) {
      const b = this.baseTowns.get(t.id);
      if (b) Object.assign(t, b);
      else this.baseTowns.set(t.id, { cd: t.cd, sldu: t.sldu, sldl: t.sldl });
    }
    for (const kind of ['cd', 'sldu', 'sldl'] as const) {
      const plan = this.activePlans[`${kind}:${st}`];
      if (!plan) continue;
      const m = (file ?? this.planCache(st))?.[kind];
      const p = m?.plans?.[plan as 'fair'] ?? m?.plans?.fair;
      if (!m?.codes || !p || p.towns.length !== list.length) continue;
      list.forEach((t, i) => {
        const code = m.codes![p.towns[i]];
        if (code) t[kind] = code;
      });
    }
  }
  /** Plan files already loaded (towns of a state loaded after the plans were applied). */
  private loadedPlanFiles = new Map<string, StatePlans>();
  private planCache(st: string) {
    return this.loadedPlanFiles.get(st);
  }
}
