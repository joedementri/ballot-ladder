/**
 * Game engine: owns the GameState and advances it month by month.
 * Runs inside a Web Worker; the UI talks to it through Comlink (see workers/sim.worker.ts).
 */
import { DataStore } from '../data/store';
import { demoFrom, type Party, type Town } from '../data/types';
import { BLOCS, ISSUES, N_BLOCS, N_ISSUES, PARTY_BASE, blocIdeal, blocSalience, blocShares, issueDistance, type Positions } from './issues';
import { generateName } from './names';
import {
  EV, GOVERNORS, GOV_LIMIT, LEVEL, SALARY, TOP_TWO, TYPE_LABEL, expectedSpend, filingMonth, isUp, nextElection, officeDef,
  officesForTown, primaryMonth, seedOfficeIds, shortTownName, type OfficeDef,
} from './offices';
import type {
  Campaign, Decision, GameState, NewCharacter, NewsItem, OfficeState, Politician, PollPoint, ResultSummary, Skills,
} from './model';
import { Rng, clamp, expit, logit } from './rng';
import { calibrate, runElection, syntheticPrecincts, unitShares, quickDShare, type Candidate, type RaceCtx, type Unit } from './vote';
import { envLogit, initialWorld, stepWorld } from './world';
import { ACTIONS, BACKGROUNDS, GROUPS, STAFF_ROLES, apMaxFor, groupAlignment, staffCost } from './campaign';
import { METRIC_INFO, billIssue, generateDecisions } from './governing';

export const SAVE_VERSION = 1;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m: number) => MONTHS[m - 1];
const BLOC_D = BLOCS.map((b) => logit(b.dShare));
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Typical recognition for an incumbent by office type. */
const INC_REC: Record<string, number> = { council: 0.3, mayor: 0.55, county: 0.25, sldl: 0.22, sldu: 0.28, house: 0.45, governor: 0.85, senate: 0.75, president: 0.98 };

export interface ActionResult {
  ok: boolean;
  msg: string;
}

export class Engine {
  data: DataStore;
  s!: GameState;
  private rng!: Rng;
  private defCache = new Map<string, OfficeDef | null>();

  constructor(base: string) {
    this.data = new DataStore(base);
  }

  async init() {
    await this.data.loadCore();
  }

  // ------------------------------------------------------------------ basics

  def(id: string): OfficeDef | null {
    if (!this.defCache.has(id) || this.defCache.get(id) === null) this.defCache.set(id, officeDef(id, this.data));
    return this.defCache.get(id)!;
  }
  pol(id: string | null | undefined): Politician | undefined {
    return id ? this.s.politicians[id] : undefined;
  }
  get player(): Politician {
    return this.s.politicians[this.s.player.id];
  }
  private newId(prefix = 'p') {
    return `${prefix}${(this.s.nextId++).toString(36)}`;
  }
  private news(item: Omit<NewsItem, 'id' | 'year' | 'month'> & { year?: number; month?: number }) {
    this.s.news.unshift({ id: this.s.nextId++, year: this.s.year, month: this.s.month, ...item });
    if (this.s.news.length > 250) this.s.news.length = 250;
  }
  age(p: Politician) {
    return this.s.year - p.birthYear;
  }
  name(p?: Politician) {
    return p ? `${p.first} ${p.last}` : 'Vacant';
  }

  /** Voting unit for an office's whole jurisdiction. */
  jurUnit(def: OfficeDef): Unit {
    const { kind, id } = def.jur;
    if (kind === 'town') {
      const t = this.data.townSync(id)!;
      return { id: t.id, label: shortTownName(t.name), pop: t.pop, lean: t.lean, demo: t.demo };
    }
    if (kind === 'county') {
      const c = this.data.counties[id];
      return { id, label: c.n, pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d) };
    }
    if (kind === 'state') {
      const s = this.data.states[id];
      return { id, label: s.n, pop: s.pop, lean: s.lean, demo: demoFrom(s.d) };
    }
    if (kind === 'nation') {
      const pop = Object.values(this.data.states).reduce((a, s) => a + s.pop, 0);
      const lean = Object.values(this.data.states).reduce((a, s) => a + s.pop * s.lean, 0) / pop;
      return { id: 'US', label: 'United States', pop, lean, demo: demoFrom([pop, 39, 75000, 0.58, 0.12, 0.06, 0.19, 0.35, 1000]) };
    }
    const d = this.data.districts[`${kind}:${id}`];
    return { id: `${kind}:${id}`, label: d.n, pop: d.pop, lean: d.lean, demo: demoFrom(d.d) };
  }
  /** Key into the player's recognition map for an office's jurisdiction. */
  jurKey(def: OfficeDef) {
    const { kind, id } = def.jur;
    return kind === 'town' || kind === 'county' || kind === 'state' ? id : kind === 'nation' ? 'US' : `${kind}:${id}`;
  }

  // ------------------------------------------------------------------ politicians

  private makeSkills(rng: Rng, quality: number): Skills {
    const s = () => Math.round(clamp(rng.normal(35 + quality * 35, 12), 5, 98));
    return { charisma: s(), debate: s(), fundraising: s(), policy: s(), integrity: Math.round(clamp(rng.normal(60, 18), 5, 98)), organization: s() };
  }

  /** Positions for a politician of `party` in a place with lean `lean` (more moderate in hostile territory). */
  private makePositions(rng: Rng, party: Party, lean: number, spread = 0.18): Positions {
    const local = (0.5 - lean) * 1.6; // +conservative in R areas
    const pull = party === 'I' ? 0.8 : 0.35;
    return PARTY_BASE[party].map((x) => round2(clamp(x * (1 - pull) + (x + local) * pull + rng.normal(0, spread), -1, 1)));
  }

  private genPolitician(rng: Rng, o: { party: Party; lean: number; demo?: Town['demo']; home: string; quality: number; ageMin?: number }): Politician {
    const nm = generateName(rng, o.demo);
    const age = Math.round(clamp(rng.normal(52 + o.quality * 4, 10), o.ageMin ?? 25, 84));
    const p: Politician = {
      id: this.newId(),
      first: nm.first,
      last: nm.last,
      gender: nm.gender,
      birthYear: this.s.year - age,
      party: o.party,
      pos: this.makePositions(rng, o.party, o.lean),
      skills: this.makeSkills(rng, o.quality),
      fav: round2(clamp(rng.normal(0.52 + o.quality * 0.05, 0.06), 0.3, 0.75)),
      rec: 0.1,
      scandal: 0,
      home: o.home,
      terms: 0,
      career: [],
    };
    this.s.politicians[p.id] = p;
    return p;
  }

  /** Real party for a seat at game start (or a draw from the district lean). */
  private seatParty(id: string, rng: Rng): Party {
    const [type, a, b] = id.split(':');
    if (type === 'pres') return 'R';
    if (type === 'gov') return GOVERNORS[a]?.party ?? 'R';
    if (type === 'sen') return (this.data.states[a]?.senators.find((s) => String(s.cls) === b)?.party ?? 'R') as Party;
    if (type === 'house') {
      const p = this.data.districts[`cd:${a}`]?.party;
      if (p) return p;
    }
    if (type === 'sldl' || type === 'sldu') {
      const p = this.data.districts[`${type}:${a}`]?.party;
      if (p) return p;
    }
    const def = this.def(id);
    const lean = def ? this.jurUnit(def).lean : 0.5;
    // sharpen: seats go to the majority party more often than the raw share suggests
    return rng.chance(expit(logit(lean) * 2.2)) ? 'D' : 'R';
  }

  /** Create the office state with an incumbent if it has never been materialized. */
  ensureOffice(id: string): OfficeState | null {
    const have = this.s.offices[id];
    if (have) return have;
    const def = this.def(id);
    if (!def) return null;
    const rng = new Rng(`${this.s.seed}|${id}`);
    const party = this.seatParty(id, rng);
    const unit = this.jurUnit(def);
    const home = def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US';
    const p = this.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home, quality: 0.3 + def.level * 0.08, ageMin: def.minAge + 2 });
    p.officeId = id;
    p.terms = rng.int(0, def.type === 'president' ? 0 : 3);
    // current term began at the last election before the game start (Jan 2025 for offices elected in Nov 2024)
    const lastElected = (() => { for (let y = this.s.year - 1; y > this.s.year - 8; y--) if (isUp(id, y, this.data)) return y; return this.s.year - def.term; })();
    p.since = lastElected + 1 - p.terms * def.term;
    p.rec = round2(clamp(INC_REC[def.type] + rng.normal(0, 0.08), 0.05, 0.99));
    const o: OfficeState = { id, holder: p.id, since: p.since, lastShare: round2(clamp(Math.abs(unit.lean - 0.5) + 0.5 + rng.normal(0.03, 0.04), 0.5, 0.95)) };
    this.s.offices[id] = o;
    return o;
  }

  // ------------------------------------------------------------------ new game

  async newGame(ch: NewCharacter) {
    const seed = ch.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.s = {
      version: SAVE_VERSION, seed, rng: seed, year: 2025, month: 1,
      player: null as any, politicians: {}, offices: {}, campaign: null, world: initialWorld(),
      news: [], decisions: [], results: [], history: [], nextId: 1, pendingNight: null, incoming: {}, lastNational: null,
    };
    this.rng = new Rng(seed);
    for (const id of seedOfficeIds(this.data)) this.ensureOffice(id);
    const home = await this.data.town(ch.homeTown);
    if (!home) throw new Error('Unknown home town');
    const bg = BACKGROUNDS[ch.background];
    const skills = { ...ch.skills };
    for (const [k, v] of Object.entries(bg.skills)) (skills as any)[k] = clamp((skills as any)[k] + v, 1, 99);
    const me: Politician = {
      id: this.newId('me'), first: ch.first, last: ch.last, gender: ch.gender, birthYear: 2025 - ch.age, party: ch.party,
      pos: ch.pos.map(round2), skills, fav: 0.5 + (skills.charisma - 50) / 500, rec: 0, scandal: 0, home: home.id, terms: 0, career: [], isPlayer: true,
    };
    this.s.politicians[me.id] = me;
    const staff = { manager: 0, comms: 0, finance: 0, field: 0, policy: 0 };
    this.s.player = {
      id: me.id, background: ch.background, cash: Math.round(bg.cash * 0.25), personal: bg.cash, ap: 0, apMax: apMaxFor(staff, skills), energy: 100,
      staff, rec: {}, blocApproval: new Array(N_BLOCS).fill(0.5), partyStanding: 40, groups: {}, emphasis: new Array(N_ISSUES).fill(0), record: [],
      metrics: {}, endorsements: [],
    };
    for (const [g, v] of Object.entries(bg.groups)) this.s.player.groups[g] = v as number;
    this.s.player.ap = this.s.player.apMax;
    this.bumpRec(home.id, 0.12);
    for (const o of officesForTown(home, this.data)) this.ensureOffice(o);
    this.news({ kind: 'player', title: `${ch.first} ${ch.last} enters public life in ${shortTownName(home.name)}, ${home.st}`, body: `A ${ch.age}-year-old ${bg.label.toLowerCase()} and ${partyName(ch.party)}, ${ch.first} has their eye on local office.`, tone: 'good' });
    this.news({ kind: 'national', title: 'New Congress sworn in; President inaugurated', body: `The ${partyName(this.s.world.presParty)} administration begins with ${Math.round(this.s.world.presApproval * 100)}% approval.` });
    this.pushHistory();
  }

  load(state: GameState) {
    this.s = state;
    this.rng = new Rng(state.rng);
    this.defCache.clear();
  }

  exportState(): GameState {
    this.s.rng = this.rng.state;
    return this.s;
  }

  // ------------------------------------------------------------------ recognition

  recIn(key: string): number {
    const r = this.s.player.rec[key];
    if (r != null) return r;
    return 0.02;
  }

  /** Increase recognition around a town/county/state, spilling into the jurisdictions that contain it. */
  bumpRec(unitId: string, amt: number) {
    const rec = this.s.player.rec;
    const add = (k: string, a: number) => (rec[k] = round3(clamp((rec[k] ?? 0.02) + a * (1 - (rec[k] ?? 0.02)), 0, 0.99)));
    const t = this.data.townSync(unitId);
    if (t) {
      add(t.id, amt);
      const cpop = this.data.counties[t.county]?.d[0] ?? t.pop;
      add(t.county, amt * Math.sqrt(Math.min(1, t.pop / cpop)));
      for (const k of [t.cd && `cd:${t.cd}`, t.sldu && `sldu:${t.sldu}`, t.sldl && `sldl:${t.sldl}`]) {
        if (!k) continue;
        const d = this.data.districts[k];
        if (d) add(k, amt * Math.sqrt(Math.min(1, t.pop / d.pop)));
      }
      const spop = this.data.states[t.st]?.pop ?? t.pop;
      add(t.st, amt * Math.sqrt(t.pop / spop) * 0.8);
      add('US', amt * Math.sqrt(t.pop / 3.35e8) * 0.5);
      return;
    }
    const c = this.data.counties[unitId];
    if (c) {
      add(unitId, amt);
      add(c.st, amt * Math.sqrt((c.d[0] ?? 0) / (this.data.states[c.st]?.pop || 1)));
      add('US', amt * Math.sqrt((c.d[0] ?? 0) / 3.35e8) * 0.5);
      return;
    }
    const s = this.data.states[unitId];
    if (s) {
      add(unitId, amt);
      add('US', amt * Math.sqrt(s.pop / 3.35e8));
      return;
    }
    add(unitId, amt);
  }

  // ------------------------------------------------------------------ offices the player can run for

  async availableOffices() {
    const home = await this.data.town(this.player.home);
    if (!home) return [];
    const out: { id: string; title: string; type: string; level: number; year: number; filingBy: string; holder: string; holderParty: Party | null; lean: number; pop: number; open: boolean; eligible: boolean; reason?: string }[] = [];
    for (const id of officesForTown(home, this.data)) {
      const def = this.def(id);
      if (!def) continue;
      const o = this.ensureOffice(id);
      let year = nextElection(id, this.s.year, this.data);
      if (year === this.s.year && this.s.month > filingMonth(def, year) && !(year === this.s.year && !def.partisan && this.s.month <= 8)) year = nextElection(id, this.s.year + 1, this.data);
      const h = this.pol(o?.holder);
      const age = this.age(this.player) + (year - this.s.year);
      let reason: string | undefined;
      if (age < def.minAge) reason = `Must be ${def.minAge}+`;
      if (this.player.officeId === id) reason = undefined;
      out.push({
        id, title: def.title, type: TYPE_LABEL[def.type], level: def.level, year,
        filingBy: def.partisan ? `${monthName(filingMonth(def, year))} ${year}` : `Aug ${year}`,
        holder: this.name(h), holderParty: h?.party ?? null, lean: this.jurUnit(def).lean, pop: def.pop, open: !h, eligible: !reason, reason,
      });
    }
    // collapse multi-seat bodies to the seat(s) up soonest
    const seen = new Map<string, (typeof out)[number]>();
    for (const o of out) {
      const body = o.id.split(':').slice(0, 2).join(':');
      const prev = seen.get(body);
      if (!prev || o.year < prev.year) seen.set(body, o);
    }
    return [...seen.values()].sort((a, b) => a.level - b.level || a.year - b.year);
  }

  async file(officeId: string): Promise<ActionResult> {
    if (this.s.campaign && this.s.campaign.stage !== 'done') return { ok: false, msg: 'You are already running for office.' };
    const def = this.def(officeId);
    if (!def) return { ok: false, msg: 'Unknown office.' };
    const opts = await this.availableOffices();
    const opt = opts.find((o) => o.id === officeId);
    if (!opt) return { ok: false, msg: 'You do not live in this district.' };
    if (!opt.eligible) return { ok: false, msg: opt.reason ?? 'Not eligible.' };
    await this.startCampaign(def, opt.year);
    return { ok: true, msg: `Filed for ${def.title} (${opt.year}).` };
  }

  private async startCampaign(def: OfficeDef, year: number) {
    const me = this.player;
    const o = this.ensureOffice(def.id)!;
    const rng = new Rng(`${this.s.seed}|camp|${def.id}|${year}`);
    const unit = this.jurUnit(def);
    const holder = this.pol(o.holder);
    const holderRuns = holder && !holder.isPlayer && this.willRunAgain(holder, def, rng);
    const kind: Campaign['kind'] = !def.partisan ? 'nonpartisan' : TOP_TWO.has(def.st ?? '') && def.type !== 'president' ? 'top-two' : 'partisan';
    const c: Campaign = {
      officeId: def.id, year, stage: kind === 'nonpartisan' ? 'general' : 'primary', primaryMonth: primaryMonth(def, year), kind,
      primaryField: [me.id], generalField: [], otherField: [], spend: { [me.id]: 0 }, raised: 0, endorse: {}, polls: [], debates: [], bias: {}, rec: {}, budget: {}, debatePrep: 0,
    };
    const exp = expectedSpend(def.type, def.pop);
    const addAI = (p: Politician, rec: number, quality: number, list: string[]) => {
      list.push(p.id);
      c.rec[p.id] = round2(rec);
      c.spend[p.id] = 0;
      c.budget[p.id] = Math.round(exp * clamp(quality, 0.15, 2.2));
    };
    const challenger = (party: Party, q: number, list: string[]) => {
      const p = this.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home: def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US', quality: q, ageMin: def.minAge });
      addAI(p, clamp(0.06 + q * 0.18 + rng.normal(0, 0.04), 0.03, 0.6), q * rng.range(0.5, 1.3), list);
      return p;
    };
    const mySideHolds = holder?.party === me.party;
    const partisanStrength = me.party === 'D' ? unit.lean : 1 - unit.lean;
    if (kind === 'nonpartisan') {
      c.generalField.push(me.id);
      if (holderRuns) addAI(holder!, holder!.rec, 1.1, c.generalField);
      const n = holderRuns ? rng.int(0, 1) : rng.int(1, 2);
      for (let i = 0; i < n; i++) challenger(rng.chance(unit.lean) ? 'D' : 'R', rng.range(0.3, 0.9), c.generalField);
    } else if (kind === 'top-two') {
      c.primaryField = [me.id];
      if (holderRuns) addAI(holder!, holder!.rec, 1.2, c.primaryField);
      const nSame = rng.int(0, mySideHolds && holderRuns ? 0 : 2);
      for (let i = 0; i < nSame; i++) challenger(me.party, rng.range(0.4, 1), c.primaryField);
      const other: Party = me.party === 'D' ? 'R' : 'D';
      if (!(holderRuns && holder!.party === other)) challenger(other, rng.range(0.4, 1.1), c.primaryField);
      if (rng.chance(0.4)) challenger(rng.chance(0.5) ? me.party : other, rng.range(0.2, 0.6), c.primaryField);
    } else {
      // my primary
      if (holderRuns && mySideHolds) addAI(holder!, holder!.rec, 1.3, c.primaryField);
      const contested = holderRuns && mySideHolds ? rng.int(0, 1) : partisanStrength > 0.55 ? rng.int(1, 3) : rng.int(0, 2);
      for (let i = 0; i < contested; i++) challenger(me.party, rng.range(0.35, 1.05), c.primaryField);
      // the other party's nominee pool
      const other: Party = me.party === 'D' ? 'R' : 'D';
      if (holderRuns && holder!.party === other) addAI(holder!, holder!.rec, 1.3, c.otherField);
      const n = c.otherField.length ? rng.int(0, 1) : rng.int(1, 3);
      for (let i = 0; i < n; i++) challenger(other, rng.range(0.35, 1.1) * (1 - partisanStrength + 0.5), c.otherField);
    }
    if (holder?.isPlayer) c.rec[me.id] = this.recIn(this.jurKey(def));
    this.s.campaign = c;
    const hasPrimary = c.stage === 'primary';
    this.news({
      kind: 'player',
      title: `${this.name(me)} files for ${def.title}`,
      body: hasPrimary
        ? `The ${monthName(c.primaryMonth)} ${year} ${kind === 'top-two' ? 'top-two primary' : `${partyName(me.party)} primary`} field: ${c.primaryField.map((id) => this.name(this.pol(id))).join(', ')}.`
        : `The November ${year} field: ${c.generalField.map((id) => this.name(this.pol(id))).join(', ')}.`,
      tone: 'good',
    });
  }

  withdraw(): ActionResult {
    const c = this.s.campaign;
    if (!c || c.stage === 'done') return { ok: false, msg: 'Not running.' };
    const def = this.def(c.officeId)!;
    this.player.career.push({ year: this.s.year, officeId: c.officeId, title: def.title, result: 'withdrew' });
    this.news({ kind: 'player', title: `${this.name(this.player)} drops out of the race for ${def.title}`, tone: 'bad' });
    this.player.fav = clamp(this.player.fav - 0.02);
    this.s.campaign = null;
    return { ok: true, msg: 'You withdrew from the race.' };
  }

  private willRunAgain(p: Politician, def: OfficeDef, rng: Rng) {
    const age = this.age(p);
    if (def.type === 'governor' && GOV_LIMIT(def.st!) && p.terms >= GOV_LIMIT(def.st!)) return false;
    if (def.type === 'president' && p.terms >= 2) return false;
    if (age > 78 && rng.chance(0.6)) return false;
    if (age > 70 && rng.chance(0.2)) return false;
    return !rng.chance(def.level >= 5 ? 0.06 : 0.12);
  }

  // ------------------------------------------------------------------ candidates & races

  private candidate(id: string, def: OfficeDef, c: Campaign | null): Candidate {
    const p = this.pol(id)!;
    const isMe = p.isPlayer;
    const rec = isMe ? this.recIn(this.jurKey(def)) : c?.rec[id] ?? p.rec;
    const sk = p.skills;
    return {
      id, name: this.name(p), party: p.party, pos: p.pos, rec, fav: p.fav, incumbent: p.officeId === def.id,
      spend: c?.spend[id] ?? 0, endorse: (c?.endorse[id] ?? 0) + (isMe ? this.s.player.endorsements.length : 0), scandal: p.scandal,
      skill: (sk.charisma + sk.debate) / 200, emphasis: isMe ? this.s.player.emphasis : undefined, bias: c?.bias[id] ?? 0,
    };
  }

  private ctxFor(def: OfficeDef, kind: RaceCtx['kind'], party?: Party): RaceCtx {
    const envWeight = def.level >= 5 ? 1 : def.level >= 3 ? 0.7 : 0.4;
    return { kind, party, env: envLogit(this.s.world), envWeight, natEmphasis: this.s.world.salience.map((x) => (x - 0.3) * 0.8), expectedSpend: expectedSpend(def.type, def.pop) };
  }

  /** Units that votes are counted in. Player recognition is localized per unit for state/national races. */
  private async raceUnits(def: OfficeDef, primary: boolean, rng: Rng): Promise<{ units: Unit[]; kind: ResultSummary['unitKind'] }> {
    const meId = this.s.player.id;
    const recFor = (k: string, fallbackKey: string) => ({ [meId]: Math.max(this.s.player.rec[k] ?? 0, this.recIn(fallbackKey) * 0.85) });
    const { kind, id } = def.jur;
    if (kind === 'state') {
      const units = Object.entries(this.data.counties)
        .filter(([, c]) => c.st === id)
        .map(([fips, c]) => ({ id: fips, label: c.n, pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d), rec: recFor(fips, id) }));
      return { units, kind: 'county' };
    }
    if (kind === 'nation') {
      if (primary) {
        const units = Object.entries(this.data.states).map(([st, s]) => ({ id: st, label: s.n, pop: s.pop, lean: s.lean, demo: demoFrom(s.d), rec: recFor(st, 'US') }));
        return { units, kind: 'state' };
      }
      const units = Object.entries(this.data.counties).map(([fips, c]) => ({ id: fips, label: `${c.n}, ${c.st}`, pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d), rec: recFor(c.st, 'US') }));
      return { units, kind: 'county' };
    }
    const base = this.jurUnit(def);
    base.rec = { [meId]: this.recIn(this.jurKey(def)) };
    let labels: string[] = [];
    let n = 8;
    if (kind === 'town') {
      n = clamp(Math.round(base.pop / 2500), 3, 30);
      labels = Array.from({ length: n }, (_, i) => `Ward ${i + 1}`);
    } else {
      const towns = await this.data.townsOf(def.st!);
      const inJur = towns.filter((t) => (kind === 'county' ? t.county === id : kind === 'cd' ? t.cd === id : kind === 'sldu' ? t.sldu === id : t.sldl === id));
      labels = inJur.slice(0, 60).map((t) => shortTownName(t.name));
      if (!labels.length) labels = ['Precinct'];
      n = clamp(Math.round(base.pop / 6000), 6, 60);
    }
    return { units: syntheticPrecincts(base, n, rng, labels), kind: 'precinct' };
  }

  private async runPlayerRace(stage: 'primary' | 'general'): Promise<ResultSummary> {
    const c = this.s.campaign!;
    const def = this.def(c.officeId)!;
    const me = this.player;
    const rng = new Rng(`${this.s.seed}|race|${def.id}|${c.year}|${stage}|${this.rng.next()}`);
    const field = stage === 'primary' ? c.primaryField : c.generalField;
    const kindCtx: RaceCtx['kind'] = c.kind === 'nonpartisan' ? 'nonpartisan' : stage === 'primary' && c.kind === 'partisan' ? 'primary' : c.kind === 'top-two' && stage === 'primary' ? 'nonpartisan' : 'general';
    const ctx = this.ctxFor(def, kindCtx, stage === 'primary' ? me.party : undefined);
    if (c.kind === 'top-two' && stage === 'primary') ctx.kind = 'general';
    const cands = field.map((id) => this.candidate(id, def, c));
    const { units, kind } = await this.raceUnits(def, stage === 'primary', rng);
    let out;
    if (cands.length === 1) {
      out = { cands: cands.map((x) => ({ id: x.id, name: x.name, party: x.party })), units: units.map((u) => ({ id: u.id, label: u.label, votes: [Math.round(u.pop * 0.1)] })), totals: [units.reduce((a, u) => a + Math.round(u.pop * 0.1), 0)], winner: 0, blocs: [] };
    } else out = runElection(units, cands, ctx, rng, { level: def.level, presYear: c.year % 4 === 0 });
    const summary: ResultSummary = {
      officeId: def.id, title: def.title, year: c.year, stage,
      cands: out.cands.map((x, i) => ({ ...x, votes: out.totals[i], isPlayer: x.id === me.id })),
      winnerId: out.cands[out.winner].id,
      units: rng ? [...out.units].sort(() => rng.next() - 0.5) : out.units,
      blocs: out.blocs.map((b) => ({ label: b.label, shares: b.shares })),
      unitKind: kind,
    };
    if (def.type === 'president' && stage === 'general') {
      const byState: Record<string, number[]> = {};
      for (const u of out.units) {
        const st = this.data.counties[u.id]?.st;
        if (!st) continue;
        const v = (byState[st] ??= new Array(cands.length).fill(0));
        u.votes.forEach((x, i) => (v[i] += x));
      }
      const ev: Record<string, number> = {};
      for (const [st, v] of Object.entries(byState)) {
        const w = v.indexOf(Math.max(...v));
        ev[cands[w].id] = (ev[cands[w].id] ?? 0) + (EV[st] ?? 0);
      }
      summary.electoral = ev;
      summary.winnerId = Object.entries(ev).sort((a, b) => b[1] - a[1])[0][0];
    }
    return summary;
  }

  // ------------------------------------------------------------------ actions

  actionCost(actionId: string): { ap: number; cash: number } {
    const a = ACTIONS.find((x) => x.id === actionId);
    if (!a) return { ap: 0, cash: 0 };
    const c = this.s.campaign;
    const def = c ? this.def(c.officeId) : this.player.officeId ? this.def(this.player.officeId) : null;
    const exp = def ? expectedSpend(def.type, def.pop) : 10000;
    return { ap: a.ap, cash: Math.round(a.flat ?? (a.cost ?? 0) * exp) };
  }

  async act(actionId: string, target?: string): Promise<ActionResult> {
    const a = ACTIONS.find((x) => x.id === actionId);
    if (!a) return { ok: false, msg: 'Unknown action' };
    const P = this.s.player;
    const me = this.player;
    const c = this.s.campaign && this.s.campaign.stage !== 'done' ? this.s.campaign : null;
    const def = c ? this.def(c.officeId)! : me.officeId ? this.def(me.officeId) : null;
    if (a.needsCampaign && !c) return { ok: false, msg: 'You need to be running for office.' };
    const { ap, cash } = this.actionCost(actionId);
    if (P.ap < ap) return { ok: false, msg: 'Not enough action points this month.' };
    if (P.cash < cash) return { ok: false, msg: `Costs $${cash.toLocaleString()} — not enough campaign cash.` };
    const rng = this.rng;
    const tired = P.energy < 25 ? 0.6 : 1;
    const sk = me.skills;
    const exp = def ? expectedSpend(def.type, def.pop) : 15000;
    const level = def?.level ?? 1;
    let msg = '';
    const spend = (amt: number) => {
      P.cash -= amt;
      if (c) c.spend[me.id] = (c.spend[me.id] ?? 0) + amt;
    };
    switch (actionId) {
      case 'fund_small': {
        const base = exp * 0.035 * (0.5 + sk.fundraising / 100) * (1 + P.staff.finance * 0.3) * (0.4 + this.recIn(def ? this.jurKey(def) : me.home)) * tired;
        const amt = Math.round(base * rng.range(0.7, 1.3) + 300);
        P.cash += amt;
        if (c) c.raised += amt;
        msg = `Raised $${amt.toLocaleString()} from small donors.`;
        break;
      }
      case 'fund_big': {
        const amt = Math.round(exp * 0.09 * (0.4 + sk.fundraising / 90) * (1 + P.staff.finance * 0.35) * rng.range(0.6, 1.4) * tired + 1000);
        P.cash += amt;
        if (c) c.raised += amt;
        P.groups.chamber = clamp((P.groups.chamber ?? 0) + 3, -100, 100);
        me.fav = clamp(me.fav - 0.004);
        if (rng.chance(0.04)) {
          me.scandal = clamp(me.scandal + 0.15);
          this.news({ kind: 'scandal', title: `Report: ${this.name(me)} donor tied to pay-to-play probe`, tone: 'bad' });
        }
        msg = `The dinner raised $${amt.toLocaleString()}.`;
        break;
      }
      case 'fund_pac': {
        const g = GROUPS.find((x) => x.key === target);
        if (!g) return { ok: false, msg: 'Pick a group.' };
        const align = groupAlignment(me.pos, g) + (P.groups[g.key] ?? 0) / 200;
        if (align < 0.05) {
          msg = `${g.label} declined — your positions don't line up.`;
          P.groups[g.key] = clamp((P.groups[g.key] ?? 0) - 2, -100, 100);
        } else {
          const amt = Math.round(exp * 0.1 * align * 2 * rng.range(0.6, 1.3) + 500);
          P.cash += amt;
          if (c) c.raised += amt;
          P.groups[g.key] = clamp((P.groups[g.key] ?? 0) + 5, -100, 100);
          msg = `${g.label} PAC contributed $${amt.toLocaleString()}.`;
        }
        break;
      }
      case 'self_fund': {
        const amt = Math.min(P.personal, Math.max(0, Math.round(Number(target) || 0)));
        if (amt <= 0) return { ok: false, msg: 'No personal funds to move.' };
        P.personal -= amt;
        P.cash += amt;
        msg = `Moved $${amt.toLocaleString()} into the campaign.`;
        break;
      }
      case 'town_hall':
      case 'canvass':
      case 'rally':
      case 'community': {
        if (!target) return { ok: false, msg: 'Pick a place.' };
        const mult = { town_hall: 0.08, canvass: 0.1, rally: 0.09, community: 0.05 }[actionId]!;
        const field = actionId === 'canvass' ? 1 + P.staff.field * 0.3 : 1;
        const smallRace = level <= 2 ? 1.6 : level <= 4 ? 1 : 0.5;
        this.bumpRec(target, mult * field * smallRace * tired * (0.6 + sk.charisma / 120));
        const favGain = actionId === 'community' ? 0.006 : actionId === 'town_hall' ? (sk.charisma - 45) / 6000 + (rng.chance(0.08) ? -0.01 : 0.003) : 0.002;
        me.fav = clamp(me.fav + favGain);
        if (actionId === 'rally' && c) c.bias[me.id] = (c.bias[me.id] ?? 0) + 0.01;
        if (actionId === 'canvass' && c) c.bias[me.id] = (c.bias[me.id] ?? 0) + 0.006 * smallRace;
        if (cash) spend(cash);
        const t = this.data.townSync(target);
        const placeName = t ? shortTownName(t.name) : this.data.counties[target]?.n ?? this.data.states[target]?.n ?? target;
        msg = `${a.label} in ${placeName} went ${favGain >= 0 ? 'well' : 'poorly — a heckler went viral'}.`;
        break;
      }
      case 'ads_tv':
      case 'ads_digital': {
        spend(cash);
        const k = this.jurKey(def!);
        const comms = 1 + P.staff.comms * 0.25;
        this.bumpRec(k, (actionId === 'ads_tv' ? 0.06 : 0.035) * comms);
        if (def!.jur.kind === 'state' || def!.jur.kind === 'nation') {
          // spread to sub-units so localized recognition rises too
          const subs = def!.jur.kind === 'state' ? Object.entries(this.data.counties).filter(([, x]) => x.st === def!.st).map(([f]) => f) : Object.keys(this.data.states);
          for (const sId of subs) this.s.player.rec[sId] = round3(clamp((this.s.player.rec[sId] ?? 0.02) + (actionId === 'ads_tv' ? 0.05 : 0.03) * comms * (1 - (this.s.player.rec[sId] ?? 0.02))));
        }
        me.fav = clamp(me.fav + 0.004 * comms);
        msg = `Ad flight launched ($${cash.toLocaleString()}).`;
        break;
      }
      case 'attack_ad': {
        const opp = this.pol(target);
        if (!opp || !c) return { ok: false, msg: 'Pick an opponent.' };
        spend(cash);
        opp.fav = clamp(opp.fav - 0.03 * (1 + P.staff.comms * 0.2));
        me.fav = clamp(me.fav - 0.008);
        msg = `Your ad hammered ${this.name(opp)}. Some voters found it nasty.`;
        break;
      }
      case 'interview': {
        const gaffe = rng.chance(0.14 - sk.debate / 1000 - P.staff.comms * 0.025);
        if (gaffe) {
          me.fav = clamp(me.fav - 0.02);
          this.news({ kind: 'player', title: `${this.name(me)} stumbles in interview`, body: 'Clip of an awkward answer circulates online.', tone: 'bad' });
          msg = 'Ouch — a gaffe. The clip is everywhere.';
        } else {
          this.bumpRec(def ? this.jurKey(def) : me.home, 0.03);
          me.fav = clamp(me.fav + 0.004);
          msg = 'Solid interview. Good exposure.';
        }
        break;
      }
      case 'speech': {
        const i = ISSUES.findIndex((x) => x.key === target);
        if (i < 0) return { ok: false, msg: 'Pick an issue.' };
        P.emphasis[i] = clamp(P.emphasis[i] + 0.35);
        this.bumpRec(def ? this.jurKey(def) : me.home, 0.015);
        msg = `You put ${ISSUES[i].label.toLowerCase()} at the center of your message.`;
        break;
      }
      case 'moderate':
      case 'harden': {
        const i = ISSUES.findIndex((x) => x.key === target);
        if (i < 0) return { ok: false, msg: 'Pick an issue.' };
        const base = PARTY_BASE[me.party][i];
        const dir = actionId === 'moderate' ? -Math.sign(me.pos[i] || base) : Math.sign(base || me.pos[i]);
        me.pos[i] = round2(clamp(me.pos[i] + dir * 0.15, -1, 1));
        P.partyStanding = clamp(P.partyStanding + (actionId === 'harden' ? 2 : -2), 0, 100);
        if (rng.chance(0.25)) {
          me.fav = clamp(me.fav - 0.01);
          this.news({ kind: 'player', title: `${this.name(me)} accused of flip-flopping on ${ISSUES[i].label.toLowerCase()}`, tone: 'bad' });
        }
        msg = `Your ${ISSUES[i].label.toLowerCase()} position is now ${describePos(me.pos[i])}.`;
        break;
      }
      case 'endorse': {
        const g = GROUPS.find((x) => x.key === target);
        if (!g) return { ok: false, msg: 'Pick a group.' };
        if (P.endorsements.includes(g.key)) return { ok: false, msg: 'Already endorsed you.' };
        const p = clamp(0.25 + groupAlignment(me.pos, g) * 1.2 + (P.groups[g.key] ?? 0) / 150 + (P.partyStanding - 50) / 300);
        if (rng.chance(p)) {
          P.endorsements.push(g.key);
          P.groups[g.key] = clamp((P.groups[g.key] ?? 0) + 10, -100, 100);
          this.news({ kind: 'player', title: `${g.label} endorses ${this.name(me)}`, tone: 'good' });
          msg = `${g.label} endorsed you!`;
        } else msg = `${g.label} is staying out of it for now (odds were ${Math.round(p * 100)}%).`;
        break;
      }
      case 'party_event': {
        P.partyStanding = clamp(P.partyStanding + 4 + sk.charisma / 40, 0, 100);
        msg = 'Party leaders appreciated you showing up.';
        break;
      }
      case 'hire': {
        const role = STAFF_ROLES.find((r) => r.key === target);
        if (!role) return { ok: false, msg: 'Pick a role.' };
        if (P.staff[role.key] >= 3) return { ok: false, msg: 'Already elite.' };
        const tier = P.staff[role.key] + 1;
        const monthly = staffCost(tier, level);
        if (P.cash < monthly) return { ok: false, msg: `Need $${monthly.toLocaleString()} for the first month's salary.` };
        P.staff[role.key] = tier;
        P.apMax = apMaxFor(P.staff, sk);
        msg = `Hired a ${['', 'volunteer', 'professional', 'elite'][tier]} ${role.label.toLowerCase()} ($${monthly.toLocaleString()}/mo).`;
        break;
      }
      case 'oppo': {
        const opp = this.pol(target);
        if (!opp || !c) return { ok: false, msg: 'Pick an opponent.' };
        spend(cash);
        if (rng.chance(0.25 + (100 - opp.skills.integrity) / 300)) {
          opp.scandal = clamp(opp.scandal + rng.range(0.15, 0.4));
          opp.fav = clamp(opp.fav - 0.04);
          this.news({ kind: 'scandal', title: `Records reveal ${this.name(opp)} ${rng.pick(['missed taxes on a rental property', 'steered contracts to a donor', 'padded a résumé', 'has a history of unpaid liens', 'used public funds for travel'])}`, tone: 'good' });
          msg = 'Your researchers found something — and it leaked.';
        } else msg = 'Nothing usable turned up.';
        break;
      }
      case 'debate_prep': {
        if (c) c.debatePrep = clamp(c.debatePrep + 0.25);
        msg = 'Mock debates sharpened your answers.';
        break;
      }
      case 'rest': {
        P.energy = clamp(P.energy + 30, 0, 100);
        msg = 'You took time off. Energy restored.';
        break;
      }
    }
    P.ap -= ap;
    if (actionId !== 'rest') P.energy = clamp(P.energy - ap * 3, 0, 100);
    return { ok: true, msg };
  }

  // ------------------------------------------------------------------ governing

  decide(decisionId: string, optionIdx: number): ActionResult {
    const d = this.s.decisions.find((x) => x.id === decisionId);
    if (!d) return { ok: false, msg: 'Decision not found.' };
    const opt = d.options[optionIdx];
    const P = this.s.player;
    const me = this.player;
    const def = me.officeId ? this.def(me.officeId) : null;
    // Position shift and bloc reactions derived from issue movement
    const unit = def ? this.jurUnit(def) : null;
    const delta = unit ? calibrate(unit) : 0;
    const before = BLOCS.map((b, i) => issueDistance(me.pos, blocIdeal(b.key), blocSalience(b.key), clamp(-delta * 0.22, -0.6, 0.6)));
    for (const [k, v] of Object.entries(opt.pos ?? {})) {
      const i = ISSUES.findIndex((x) => x.key === k);
      if (i >= 0) me.pos[i] = round2(clamp(me.pos[i] + (v ?? 0), -1, 1));
    }
    BLOCS.forEach((b, i) => {
      const after = issueDistance(me.pos, blocIdeal(b.key), blocSalience(b.key), clamp(-delta * 0.22, -0.6, 0.6));
      P.blocApproval[i] = clamp(P.blocApproval[i] + (before[i] - after) * 6 + (opt.bloc?.[b.key] ?? 0));
    });
    for (const [g, v] of Object.entries(opt.groups ?? {})) P.groups[g] = clamp((P.groups[g] ?? 0) + v * 0.5, -100, 100);
    let passed = true;
    const bill = billIssue(d.templateId);
    if (bill && def && !def.executive) {
      const yes = optionIdx === 0;
      const supp = this.chamberSupport(def, bill.issue, bill.dir, yes);
      passed = supp.yes > supp.no;
      if (def.level >= 3) this.news({ kind: 'office', title: `${d.title}: ${passed ? 'passes' : 'fails'} ${supp.yes}–${supp.no}`, body: `You voted ${yes ? 'yes' : optionIdx === 1 ? 'no' : 'present'}.`, tone: 'neutral' });
      const partyDir = Math.sign(PARTY_BASE[me.party][ISSUES.findIndex((x) => x.key === bill.issue)]);
      if (optionIdx < 2) P.partyStanding = clamp(P.partyStanding + ((yes ? bill.dir : -bill.dir) === partyDir ? 1.5 : -3), 0, 100);
      if (passed === yes && optionIdx < 2) P.metrics.effectiveness = (P.metrics.effectiveness ?? 50) + 1;
    } else if (bill && def?.executive) {
      const partyDir = Math.sign(PARTY_BASE[me.party][ISSUES.findIndex((x) => x.key === bill.issue)]);
      P.partyStanding = clamp(P.partyStanding + ((optionIdx === 0 ? bill.dir : -bill.dir) === partyDir ? 2 : -3), 0, 100);
      passed = optionIdx === 0;
    }
    if (def?.executive && passed) for (const [m, v] of Object.entries(opt.metrics ?? {})) P.metrics[m] = (P.metrics[m] ?? METRIC_INFO[m]?.base ?? 50) + v * (m === 'budget' ? 1 : 4);
    else if (!def?.executive && opt.metrics?.effectiveness) P.metrics.effectiveness = (P.metrics.effectiveness ?? 50) + opt.metrics.effectiveness * 4;
    if (opt.party) P.partyStanding = clamp(P.partyStanding + opt.party, 0, 100);
    if (opt.cash) {
      const amt = Math.round(opt.cash * (def ? expectedSpend(def.type, def.pop) : 10000));
      P.cash += amt;
    }
    if (opt.scandalRisk) P.metrics.scandalRisk = (P.metrics.scandalRisk ?? 0) + opt.scandalRisk;
    if (opt.rec && def) this.bumpRec(this.jurKey(def), opt.rec);
    P.record.unshift({ year: this.s.year, month: this.s.month, title: d.title, choice: opt.label });
    if (P.record.length > 120) P.record.length = 120;
    this.s.decisions = this.s.decisions.filter((x) => x.id !== decisionId);
    return { ok: true, msg: `${opt.label}${bill && def && !def.executive ? ` — the bill ${passed ? 'passed' : 'failed'}` : ''}.` };
  }

  /** Count yes/no in the player's chamber based on members' positions on the bill's issue. */
  chamberSupport(def: OfficeDef, issue: string, dir: number, playerYes: boolean) {
    const i = ISSUES.findIndex((x) => x.key === issue);
    let yes = 0, no = 0;
    const prefix = def.type === 'senate' ? 'sen:' : def.type === 'house' ? 'house:' : def.type === 'council' ? `council:${def.jur.id}:` : def.type === 'county' ? `county:${def.jur.id}:` : `${def.type}:`;
    for (const o of Object.values(this.s.offices)) {
      if (!o.id.startsWith(prefix) || !o.holder) continue;
      if ((def.type === 'sldl' || def.type === 'sldu') && this.def(o.id)?.st !== def.st) continue;
      const p = this.s.politicians[o.holder];
      if (p.isPlayer) { playerYes ? yes++ : no++; continue; }
      const lean = p.pos[i] * dir + (p.party === 'R' ? 0.05 : -0.05) * dir;
      lean > -0.05 ? yes++ : no++;
    }
    return { yes, no };
  }

  // ------------------------------------------------------------------ turn

  async endTurn() {
    if (this.s.pendingNight) return; // must view election night first
    const { year, month } = this.s;
    const c = this.s.campaign;
    // 1. Campaign month: AI activity, debates, polls
    if (c && c.stage !== 'done') {
      this.aiCampaign(c);
      await this.maybeDebate(c);
    }
    // 2. Expired decisions (skipped)
    for (const d of this.s.decisions.filter((x) => x.deadline.year < year || (x.deadline.year === year && x.deadline.month <= month))) {
      this.s.player.metrics.effectiveness = (this.s.player.metrics.effectiveness ?? 50) - 2;
      this.s.player.blocApproval = this.s.player.blocApproval.map((x) => clamp(x - 0.005));
      this.news({ kind: 'office', title: `You let "${d.title}" pass without action`, tone: 'bad' });
    }
    this.s.decisions = this.s.decisions.filter((x) => !(x.deadline.year < year || (x.deadline.year === year && x.deadline.month <= month)));
    // 3. Elections at the end of this month
    let night: ResultSummary | null = null;
    if (c && c.stage === 'primary' && c.year === year && c.primaryMonth === month) night = await this.resolvePrimary(c);
    if (c && c.stage === 'general' && c.year === year && month === 11) night = await this.resolveGeneral(c);
    if (month === 11) await this.backgroundElections(year);
    if (c && c.stage !== 'done') this.poll(c);
    // 4. Advance calendar
    this.s.month = month === 12 ? 1 : month + 1;
    if (month === 12) this.s.year++;
    if (this.s.month === 1) await this.newYear();
    // 5. World and player upkeep
    for (const n of stepWorld(this.s.world, this.rng, this.s.year, this.s.month, this.s.year % 4 === 2)) this.news(n);
    this.playerUpkeep();
    // 6. New decisions for officeholders
    const me = this.player;
    if (me.officeId) {
      const def = this.def(me.officeId)!;
      const ds = generateDecisions(this.rng, def.type, def.executive, def.jurName, this.s.year, this.s.month, this.s.decisions.map((d) => d.templateId));
      this.s.decisions.push(...ds);
    }
    this.pushHistory();
    if (night) this.s.pendingNight = night;
    this.s.rng = this.rng.state;
  }

  ackNight() {
    this.s.pendingNight = null;
  }

  private aiCampaign(c: Campaign) {
    const def = this.def(c.officeId)!;
    const monthsLeft = Math.max(1, (c.stage === 'primary' ? c.primaryMonth : 11) - this.s.month + 1 + (c.year - this.s.year) * 12);
    const ids = [...(c.stage === 'primary' ? c.primaryField : c.generalField), ...(c.stage === 'primary' ? c.otherField : [])];
    for (const id of ids) {
      const p = this.pol(id);
      if (!p || p.isPlayer) continue;
      const budget = c.budget[id] ?? 0;
      const left = Math.max(0, budget * (c.stage === 'primary' ? 0.4 : 1) - (c.spend[id] ?? 0));
      const urgency = monthsLeft <= 2 ? 0.6 : 1 / monthsLeft;
      c.spend[id] = Math.round((c.spend[id] ?? 0) + left * urgency);
      const gain = (0.012 + p.skills.organization / 3000 + p.skills.charisma / 4000) * (monthsLeft <= 3 ? 1.6 : 1);
      c.rec[id] = round2(clamp((c.rec[id] ?? p.rec) + gain * (1 - (c.rec[id] ?? p.rec))));
      // AI goes negative when trailing late
      const last = c.polls[c.polls.length - 1];
      if (last && monthsLeft <= 3 && (last.shares[id] ?? 0) < (last.shares[this.player.id] ?? 0) && this.rng.chance(0.35)) {
        this.player.fav = clamp(this.player.fav - 0.015);
        this.news({ kind: 'race', title: `${this.name(p)} launches attack ad against ${this.name(this.player)}`, tone: 'bad' });
      }
      c.endorse[id] = c.endorse[id] ?? (p.officeId === def.id ? 3 : this.rng.int(0, 2));
      if (this.rng.chance(0.08)) c.endorse[id]++;
    }
  }

  private async maybeDebate(c: Campaign) {
    const target = c.stage === 'primary' ? c.primaryMonth : 11;
    if (c.year !== this.s.year || this.s.month !== target - 1) return;
    const def = this.def(c.officeId)!;
    if (def.level < 2) return;
    const field = (c.stage === 'primary' ? c.primaryField : c.generalField).map((id) => this.pol(id)!);
    if (field.length < 2) return;
    const me = this.player;
    const scores = field.map((p) => p.skills.debate / 100 + p.skills.policy / 300 + (p.isPlayer ? c.debatePrep + this.s.player.staff.policy * 0.05 : 0) + this.rng.normal(0, 0.25));
    const best = scores.indexOf(Math.max(...scores));
    const winner = field[best];
    c.bias[winner.id] = (c.bias[winner.id] ?? 0) + 0.12;
    for (const p of field) if (p !== winner) c.bias[p.id] = (c.bias[p.id] ?? 0) - 0.03;
    c.debates.push({ month: this.s.month, winner: winner.id, swing: 0.12 });
    c.debatePrep = 0;
    this.news({ kind: 'race', title: `Debate: ${this.name(winner)} wins the night`, body: `Snap polls give ${winner.isPlayer ? 'you' : this.name(winner)} the edge in the ${def.title} ${c.stage} debate.`, tone: winner.isPlayer ? 'good' : me ? 'bad' : 'neutral' });
  }

  private poll(c: Campaign) {
    const def = this.def(c.officeId)!;
    const field = c.stage === 'primary' ? c.primaryField : c.generalField;
    if (field.length < 2) return;
    const kind: RaceCtx['kind'] = c.kind === 'nonpartisan' || (c.kind === 'top-two' && c.stage === 'primary') ? 'nonpartisan' : c.stage === 'primary' ? 'primary' : 'general';
    const ctx = this.ctxFor(def, kind === 'nonpartisan' && c.kind === 'top-two' ? 'general' : kind, this.player.party);
    const unit = this.jurUnit(def);
    unit.rec = { [this.s.player.id]: this.recIn(this.jurKey(def)) };
    const cands = field.map((id) => this.candidate(id, def, c));
    const { shares } = unitShares(unit, cands, ctx);
    const n = 400 + this.s.player.staff.manager * 200;
    const moe = 1 / Math.sqrt(n);
    const undecided = clamp(0.25 * (1 - Math.max(...cands.map((x) => x.rec))) + 0.03, 0.03, 0.3);
    const noisy = shares.map((s) => Math.max(0.005, s + this.rng.normal(0, moe / 2)));
    const tot = noisy.reduce((a, b) => a + b, 0);
    const point: PollPoint = { year: this.s.year, month: this.s.month, label: `${monthName(this.s.month)} ${String(this.s.year).slice(2)}`, shares: {}, moe: round3(moe * 2) };
    field.forEach((id, i) => (point.shares[id] = round3((noisy[i] / tot) * (1 - undecided))));
    point.shares.undecided = round3(undecided);
    c.polls.push(point);
  }

  private async resolvePrimary(c: Campaign): Promise<ResultSummary> {
    const def = this.def(c.officeId)!;
    const me = this.player;
    const r = await this.runPlayerRace('primary');
    c.resultPrimary = r;
    this.s.results.unshift(r);
    const order = [...r.cands].sort((a, b) => b.votes - a.votes);
    if (c.kind === 'top-two') {
      const top = order.slice(0, 2).map((x) => x.id);
      if (top.includes(me.id)) {
        c.generalField = top;
        c.stage = 'general';
        this.news({ kind: 'election', title: `${this.name(me)} advances from the top-two primary`, tone: 'good' });
      } else this.loseRace(c, def, 'lost-primary', r);
    } else {
      if (r.winnerId === me.id) {
        // other party's nominee: simulate their primary quickly
        const other = c.otherField.map((id) => this.pol(id)!);
        let nominee = other[0];
        if (other.length > 1) {
          const ctx = this.ctxFor(def, 'primary', other[0].party);
          const shares = unitShares(this.jurUnit(def), other.map((p) => this.candidate(p.id, def, c)), ctx).shares.map((s) => s + this.rng.normal(0, 0.05));
          nominee = other[shares.indexOf(Math.max(...shares))];
        }
        c.generalField = nominee ? [me.id, nominee.id] : [me.id];
        if (nominee) c.rec[nominee.id] = clamp((c.rec[nominee.id] ?? 0.1) + 0.08);
        c.stage = 'general';
        this.news({ kind: 'election', title: `${this.name(me)} wins the ${partyName(me.party)} primary for ${def.title}`, body: nominee ? `Faces ${this.name(nominee)} (${nominee.party}) in November.` : 'No opponent filed for November.', tone: 'good' });
        this.s.player.partyStanding = clamp(this.s.player.partyStanding + 8, 0, 100);
      } else this.loseRace(c, def, 'lost-primary', r);
    }
    return r;
  }

  private loseRace(c: Campaign, def: OfficeDef, result: 'lost' | 'lost-primary', r: ResultSummary) {
    const me = this.player;
    const tot = r.cands.reduce((a, x) => a + x.votes, 0) || 1;
    const share = (r.cands.find((x) => x.id === me.id)?.votes ?? 0) / tot;
    me.career.push({ year: c.year, officeId: def.id, title: def.title, result, share: round3(share) });
    const w = this.pol(r.winnerId);
    this.news({ kind: 'election', title: `${this.name(me)} ${result === 'lost-primary' ? 'loses primary' : 'defeated'} for ${def.title}`, body: `${this.name(w)} wins with ${Math.round(((r.cands.find((x) => x.id === r.winnerId)?.votes ?? 0) / tot) * 100)}%.`, tone: 'bad' });
    c.stage = 'done';
    this.s.player.partyStanding = clamp(this.s.player.partyStanding - 5, 0, 100);
    if (result === 'lost' && w) this.s.incoming[def.id] = w.id;
  }

  private async resolveGeneral(c: Campaign): Promise<ResultSummary> {
    const def = this.def(c.officeId)!;
    const me = this.player;
    const r = await this.runPlayerRace('general');
    c.resultGeneral = r;
    this.s.results.unshift(r);
    if (this.s.results.length > 20) this.s.results.length = 20;
    if (r.winnerId === me.id) {
      const tot = r.cands.reduce((a, x) => a + x.votes, 0) || 1;
      const share = (r.cands.find((x) => x.id === me.id)?.votes ?? 0) / tot;
      me.career.push({ year: c.year, officeId: def.id, title: def.title, result: 'won', share: round3(share) });
      this.s.incoming[def.id] = me.id;
      this.news({ kind: 'election', title: `${this.name(me)} wins election as ${def.title}!`, body: `${Math.round(share * 100)}% of the vote. Sworn in this January.`, tone: 'good' });
      this.s.player.partyStanding = clamp(this.s.player.partyStanding + 10, 0, 100);
      c.stage = 'done';
      const o = this.ensureOffice(def.id)!;
      o.lastShare = round3(share);
      o.lastYear = c.year;
    } else this.loseRace(c, def, 'lost', r);
    return r;
  }

  /** Resolve every other materialized race on the ballot this November. */
  private async backgroundElections(year: number) {
    const myOffice = this.s.campaign?.year === year ? this.s.campaign.officeId : null;
    const env = envLogit(this.s.world);
    const tally = { house: {} as Record<string, number>, senate: {} as Record<string, number>, gov: {} as Record<string, number> };
    const flips: string[] = [];
    let pres: ResultSummary | undefined;
    for (const o of Object.values(this.s.offices)) {
      if (o.id === myOffice || !isUp(o.id, year, this.data)) continue;
      const def = this.def(o.id);
      if (!def) continue;
      const rng = new Rng(`${this.s.seed}|bg|${o.id}|${year}`);
      const holder = this.pol(o.holder);
      if (holder?.isPlayer) {
        // player didn't file for re-election: seat opens
        if (!this.s.campaign || this.s.campaign.officeId !== o.id) {
          this.news({ kind: 'player', title: `${this.name(holder)} did not seek re-election as ${def.title}`, tone: 'neutral' });
        } else continue;
      }
      if (def.type === 'president') {
        pres = await this.backgroundPresident(def, year, holder, rng);
        continue;
      }
      const unit = this.jurUnit(def);
      const runs = holder && !holder.isPlayer && this.willRunAgain(holder, def, rng);
      const incParty: Party = holder?.party ?? (rng.chance(unit.lean) ? 'D' : 'R');
      const mk = (party: Party, q: number) => {
        const p = this.genPolitician(rng, { party, lean: unit.lean, demo: unit.demo, home: def.jur.kind === 'town' ? def.jur.id : def.st ?? 'US', quality: q, ageMin: def.minAge });
        p.rec = round2(clamp(0.1 + q * 0.25, 0.05, 0.7));
        return p;
      };
      const a = runs ? holder! : mk(incParty, rng.range(0.4, 1));
      const otherParty: Party = incParty === 'D' ? 'R' : 'D';
      const b = mk(def.partisan ? otherParty : rng.chance(0.5) ? 'D' : 'R', rng.range(0.2, 0.9));
      const ctx: RaceCtx = { ...this.ctxFor(def, def.partisan ? 'general' : 'nonpartisan'), env };
      const ca = this.candidate(a.id, def, null);
      const cb = this.candidate(b.id, def, null);
      ca.spend = expectedSpend(def.type, def.pop) * (runs ? 1.2 : 0.8);
      cb.spend = expectedSpend(def.type, def.pop) * rng.range(0.2, 0.9);
      const shareA = clamp(quickDShare(unit, ca, cb, { ...ctx, noise: { [a.id]: rng.normal(0, 0.15), [b.id]: rng.normal(0, 0.15) } }), 0, 1);
      // uncontested in lopsided seats
      const uncontested = def.partisan && (unit.lean > 0.78 || unit.lean < 0.22) && rng.chance(0.35);
      const winner = uncontested || shareA >= 0.5 ? a : b;
      const loser = winner === a ? b : a;
      if (!uncontested) loser.career.push({ year, officeId: o.id, title: def.title, result: 'lost' });
      winner.career.push({ year, officeId: o.id, title: def.title, result: 'won', share: round3(uncontested ? 1 : Math.max(shareA, 1 - shareA)) });
      o.lastShare = round3(uncontested ? 1 : Math.max(shareA, 1 - shareA));
      o.lastYear = year;
      if (winner !== holder) this.s.incoming[o.id] = winner.id;
      if (winner === holder) holder.terms++;
      if (def.partisan && holder && winner.party !== holder.party && def.level >= 5) flips.push(`${def.title.replace(/^U\.S\. (Representative|Senator from) /, '')} flips ${winner.party}`);
      const key = def.type === 'house' ? 'house' : def.type === 'senate' ? 'senate' : def.type === 'governor' ? 'gov' : null;
      if (key) tally[key][winner.party] = (tally[key][winner.party] ?? 0) + 1;
      // clean up losers that never held office to keep saves small
      if (!uncontested && loser !== holder && !loser.officeId && !loser.isPlayer) delete this.s.politicians[loser.id];
    }
    const sum = (r: Record<string, number>) => Object.entries(r).map(([p, n]) => `${p} ${n}`).join(', ');
    if (Object.keys(tally.house).length) this.news({ kind: 'election', title: `${year} results: House races ${sum(tally.house)}`, body: flips.slice(0, 12).join(' · ') || 'No major seats changed hands.' });
    if (Object.keys(tally.senate).length) this.news({ kind: 'election', title: `${year} Senate races: ${sum(tally.senate)}` });
    if (Object.keys(tally.gov).length) this.news({ kind: 'election', title: `${year} governor races: ${sum(tally.gov)}` });
    this.s.lastNational = { year, ...tally, pres };
  }

  private async backgroundPresident(def: OfficeDef, year: number, holder: Politician | undefined, rng: Rng): Promise<ResultSummary> {
    const runs = holder && this.willRunAgain(holder, def, rng);
    const incParty = this.s.world.presParty;
    const mk = (party: Party) => {
      const p = this.genPolitician(rng, { party, lean: 0.5, home: rng.pick(Object.keys(this.data.states)), quality: 1, ageMin: 40 });
      p.rec = 0.8;
      return p;
    };
    const a = runs ? holder! : mk(incParty);
    const b = mk(incParty === 'D' ? 'R' : 'D');
    const cands = [a, b].map((p) => ({ ...this.candidate(p.id, def, null), spend: 1e9, rec: 0.9 }));
    const { units } = await this.raceUnits(def, false, rng);
    units.forEach((u) => delete u.rec);
    const out = runElection(units, cands, this.ctxFor(def, 'general'), rng, { level: 7, presYear: true });
    const byState: Record<string, number[]> = {};
    for (const u of out.units) {
      const st = this.data.counties[u.id]?.st;
      if (!st) continue;
      const v = (byState[st] ??= [0, 0]);
      v[0] += u.votes[0];
      v[1] += u.votes[1];
    }
    const ev: Record<string, number> = {};
    for (const [st, v] of Object.entries(byState)) ev[v[0] >= v[1] ? a.id : b.id] = (ev[v[0] >= v[1] ? a.id : b.id] ?? 0) + (EV[st] ?? 0);
    const winner = (ev[a.id] ?? 0) >= 270 ? a : b;
    if (winner !== holder) this.s.incoming.pres = winner.id;
    else holder!.terms++;
    this.news({ kind: 'election', title: `${this.name(winner)} (${winner.party}) wins the presidency`, body: `Electoral votes: ${this.name(a)} ${ev[a.id] ?? 0}, ${this.name(b)} ${ev[b.id] ?? 0}.`, tone: 'neutral' });
    return {
      officeId: 'pres', title: def.title, year, stage: 'general',
      cands: out.cands.map((x, i) => ({ ...x, votes: out.totals[i] })), winnerId: winner.id,
      units: Object.entries(byState).map(([st, v]) => ({ id: st, label: st, votes: v })), blocs: out.blocs.map((x) => ({ label: x.label, shares: x.shares })), unitKind: 'state', electoral: ev,
    };
  }

  private async newYear() {
    // Swearing-in
    const me = this.player;
    for (const [officeId, pid] of Object.entries(this.s.incoming)) {
      const o = this.ensureOffice(officeId)!;
      const prev = this.pol(o.holder);
      const def = this.def(officeId)!;
      if (prev && prev.id !== pid) {
        prev.officeId = undefined;
        prev.career.push({ year: this.s.year, officeId, title: def.title, result: 'left-office' });
        if (prev.isPlayer) {
          this.news({ kind: 'player', title: `Your term as ${def.title} ends`, tone: 'neutral' });
          this.s.decisions = [];
        } else if (!prev.isPlayer) delete this.s.politicians[prev.id];
      }
      const p = this.pol(pid)!;
      // leaving a previous office for the new one opens a vacancy filled by appointment
      if (p.officeId && p.officeId !== officeId) {
        const old = this.ensureOffice(p.officeId)!;
        const oldDef = this.def(p.officeId)!;
        const rng = new Rng(`${this.s.seed}|appoint|${p.officeId}|${this.s.year}`);
        const unit = this.jurUnit(oldDef);
        const repl = this.genPolitician(rng, { party: p.party, lean: unit.lean, demo: unit.demo, home: oldDef.jur.kind === 'town' ? oldDef.jur.id : oldDef.st ?? 'US', quality: 0.6 });
        repl.officeId = p.officeId;
        repl.since = this.s.year;
        repl.rec = 0.15;
        old.holder = repl.id;
        old.since = this.s.year;
        p.career.push({ year: this.s.year, officeId: p.officeId, title: oldDef.title, result: 'left-office' });
      }
      p.officeId = officeId;
      p.since = this.s.year;
      p.terms = prev?.id === pid ? p.terms : 1;
      p.rec = Math.max(p.rec, INC_REC[def.type] * 0.7);
      o.holder = pid;
      o.since = this.s.year;
      if (p.isPlayer) {
        p.career.push({ year: this.s.year, officeId, title: def.title, result: 'took-office' });
        this.s.player.metrics = Object.fromEntries(Object.entries(METRIC_INFO).map(([k, v]) => [k, v.base]));
        this.s.player.blocApproval = new Array(N_BLOCS).fill(0.55);
        this.news({ kind: 'player', title: `${this.name(p)} sworn in as ${def.title}`, tone: 'good' });
        if (def.type === 'council' || def.type === 'county') {
          const prefix = officeId.split(':').slice(0, 2).join(':');
          const n = def.type === 'county' ? 5 : 13;
          for (let i = 0; i < n; i++) if (this.def(`${prefix}:${i}`) && (def.type === 'county' || i < 13)) this.ensureOffice(`${prefix}:${i}`);
        }
      }
      if (officeId === 'pres') {
        this.s.world.presParty = p.party;
        this.s.world.honeymoon = 0;
        this.s.world.presApproval = clamp(this.s.world.presApproval + 0.08, 0.4, 0.62);
      }
    }
    this.s.incoming = {};
    if (this.s.campaign?.stage === 'done') this.s.campaign = null;
    // Auto-file re-election if the player holds an office that is up this year
    if (me.officeId && !this.s.campaign && isUp(me.officeId, this.s.year, this.data)) {
      const def = this.def(me.officeId)!;
      const lim = def.type === 'governor' ? GOV_LIMIT(def.st!) : def.type === 'president' ? 2 : 0;
      if (!lim || me.terms < lim) {
        await this.startCampaign(def, this.s.year);
        this.news({ kind: 'player', title: `You are up for re-election as ${def.title} this year`, body: 'Your re-election campaign has been opened automatically. Withdraw from the Campaign tab to retire or run for something else.' });
      } else this.news({ kind: 'player', title: `You are term-limited as ${def.title}`, body: 'Time to run for something else — or retire.' });
    }
    // Upcoming elections reminder for unaffiliated player
    if (!me.officeId && !this.s.campaign) this.news({ kind: 'player', title: `${this.s.year}: Which office will you run for?`, body: 'Open the Run for Office panel to see seats on the ballot in your area.' });
  }

  private playerUpkeep() {
    const P = this.s.player;
    const me = this.player;
    const def = me.officeId ? this.def(me.officeId) : null;
    const level = Math.max(def?.level ?? 1, this.s.campaign ? this.def(this.s.campaign.officeId)!.level : 1);
    // Money
    if (def) P.personal += Math.round(SALARY[def.type] / 12 * 0.35);
    P.personal += P.background === 'business' || P.background === 'doctor' || P.background === 'lawyer' ? (def?.level ?? 0) >= 5 ? 0 : 2500 : 600;
    const payroll = STAFF_ROLES.reduce((a, r) => a + staffCost(P.staff[r.key], level), 0);
    P.cash -= payroll;
    if (P.cash < 0) {
      // Can't make payroll: staff quit from the top
      for (const r of [...STAFF_ROLES].reverse()) if (P.staff[r.key] > 0 && P.cash < 0) { P.staff[r.key]--; P.cash += staffCost(P.staff[r.key] + 1, level); }
      P.cash = Math.max(0, P.cash);
      this.news({ kind: 'player', title: 'Campaign can’t make payroll — staff leave', tone: 'bad' });
    }
    // Time and energy
    P.apMax = apMaxFor(P.staff, me.skills) - (def ? Math.ceil(def.level / 2) : 0);
    P.energy = clamp(P.energy + 25, 0, 100);
    P.ap = P.energy < 20 ? Math.ceil(P.apMax / 2) : P.apMax;
    P.emphasis = P.emphasis.map((x) => round3(x * 0.85));
    // Recognition decays slowly; officeholders get coverage in their jurisdiction
    for (const k of Object.keys(P.rec)) P.rec[k] = round3(Math.max(0.02, P.rec[k] * 0.995));
    if (def) {
      const target = INC_REC[def.type] + (P.metrics.effectiveness ?? 50) / 1000;
      const k = this.jurKey(def);
      if (this.recIn(k) < target) this.bumpRec(k, 0.025);
    }
    // Scandals
    me.scandal = round3(me.scandal * 0.88);
    const risk = 0.006 + (P.metrics.scandalRisk ?? 0) * 0.08 - me.skills.integrity / 20000;
    if (this.rng.chance(Math.max(0.001, risk))) {
      me.scandal = clamp(me.scandal + this.rng.range(0.2, 0.45));
      me.fav = clamp(me.fav - 0.05);
      P.metrics.scandalRisk = Math.max(0, (P.metrics.scandalRisk ?? 0) - 0.1);
      this.news({ kind: 'scandal', title: `Scandal: ${this.name(me)} ${this.rng.pick(['faces questions over a donor’s no-bid contract', 'caught in misleading statement about résumé', 'campaign accused of finance violations', 'under fire for leaked private remarks'])}`, tone: 'bad' });
    }
    // Approval and favorability
    if (def) this.updateApproval(def);
    else me.fav = clamp(me.fav + 0.03 * (0.5 + (me.skills.charisma - 50) / 400 - me.fav) - me.scandal * 0.02);
    // Metrics drift for executives
    for (const [k, info] of Object.entries(METRIC_INFO)) if (P.metrics[k] != null) P.metrics[k] = round2(P.metrics[k] + 0.06 * (info.base - P.metrics[k]) + this.rng.normal(0, k === 'budget' ? 0.15 : 0.6));
    // Age events
    if (this.age(me) > 80 && this.rng.chance(0.004)) this.s.gameOver = `${this.name(me)} retired from public life for health reasons at age ${this.age(me)}.`;
  }

  private updateApproval(def: OfficeDef) {
    const P = this.s.player;
    const me = this.player;
    const unit = this.jurUnit(def);
    const delta = calibrate(unit);
    const shift = clamp(-delta * 0.22, -0.6, 0.6);
    const perf = Object.entries(METRIC_INFO).reduce((a, [k, info]) => {
      const v = P.metrics[k];
      if (v == null || k === 'effectiveness') return a;
      const dev = k === 'budget' ? v * 2 : v - info.base;
      return a + (info.good === 'up' ? dev : -dev);
    }, 0) / 100;
    const eff = ((P.metrics.effectiveness ?? 50) - 50) / 200;
    const nat = def.level >= 5 ? (me.party === this.s.world.presParty ? 1 : -1) * (this.s.world.presApproval - 0.45) * 0.3 : 0;
    BLOCS.forEach((b, i) => {
      const pD = expit(BLOC_D[i] + delta);
      const partisan = def.partisan ? (me.party === 'D' ? pD : me.party === 'R' ? 1 - pD : 0.5) : 0.5 + (me.party === 'D' ? pD - 0.5 : 0.5 - pD) * 0.3;
      const fit = issueDistance(PARTY_BASE[me.party], blocIdeal(b.key), blocSalience(b.key), shift) - issueDistance(me.pos, blocIdeal(b.key), blocSalience(b.key), shift);
      const target = clamp(0.22 + 0.5 * partisan + fit * 1.5 + perf + eff + nat - me.scandal * 0.3, 0.05, 0.95);
      P.blocApproval[i] = round3(clamp(P.blocApproval[i] + 0.15 * (target - P.blocApproval[i])));
    });
    const w = blocShares(unit.demo);
    const approval = P.blocApproval.reduce((a, x, i) => a + x * w[i], 0) / w.reduce((a, b) => a + b, 0);
    me.fav = round3(clamp(me.fav + 0.25 * (approval - me.fav)));
    if (def.type === 'president') this.s.world.presApproval = clamp(0.5 * this.s.world.presApproval + 0.5 * approval);
  }

  approval(): number {
    const me = this.player;
    const def = me.officeId ? this.def(me.officeId) : null;
    if (!def) return me.fav;
    const w = blocShares(this.jurUnit(def).demo);
    return this.s.player.blocApproval.reduce((a, x, i) => a + x * w[i], 0) / w.reduce((a, b) => a + b, 0);
  }

  private pushHistory() {
    const me = this.player;
    const c = this.s.campaign;
    const def = c ? this.def(c.officeId) : me.officeId ? this.def(me.officeId) : null;
    this.s.history.push({
      year: this.s.year, month: this.s.month, approval: round3(this.approval()), rec: round3(def ? this.recIn(this.jurKey(def)) : this.recIn(me.home)),
      cash: Math.round(this.s.player.cash), presApproval: round3(this.s.world.presApproval), generic: round2(this.s.world.genericBallot),
      unemployment: round2(this.s.world.unemployment), inflation: round2(this.s.world.inflation),
    });
    if (this.s.history.length > 600) this.s.history.shift();
  }

  // ------------------------------------------------------------------ queries for the UI

  holderSummary(officeId: string) {
    const o = this.ensureOffice(officeId);
    const def = this.def(officeId);
    if (!o || !def) return null;
    const p = this.pol(o.holder);
    return {
      officeId, title: def.title, type: def.type, level: def.level,
      holder: p ? { id: p.id, name: this.name(p), party: p.party, age: this.age(p), since: p.since ?? o.since, terms: p.terms, ideology: p.pos.reduce((a, b) => a + b, 0) / p.pos.length, isPlayer: !!p.isPlayer, rec: p.rec, fav: p.fav, skills: p.skills, pos: p.pos } : null,
      lastShare: o.lastShare ?? null, nextElection: nextElection(officeId, this.s.year, this.data), partisan: def.partisan,
    };
  }

  /** Officeholders for a map selection. */
  async jurisdiction(kind: 'state' | 'county' | 'cd' | 'sldu' | 'sldl' | 'town', id: string) {
    const ids: string[] = [];
    if (kind === 'state') {
      ids.push(`gov:${id}`);
      for (const s of this.data.states[id]?.senators ?? []) ids.push(`sen:${id}:${s.cls}`);
    } else if (kind === 'county') {
      const c = this.data.counties[id];
      if (c && c.st !== 'CT' && c.st !== 'RI') for (let i = 0; i < 5; i++) ids.push(`county:${id}:${i}`);
    } else if (kind === 'cd') ids.push(`house:${id}`);
    else if (kind === 'sldu') ids.push(`sldu:${id}`);
    else if (kind === 'sldl') ids.push(`sldl:${id}`);
    else if (kind === 'town') {
      const t = await this.data.town(id);
      if (t) {
        ids.push(`mayor:${id}`);
        const seats = t.pop < 2500 ? 5 : t.pop < 50000 ? 7 : t.pop < 500000 ? 9 : 13;
        for (let i = 0; i < seats; i++) ids.push(`council:${id}:${i}`);
      }
    }
    const offices = ids.map((x) => this.holderSummary(x)).filter(Boolean);
    let chambers: Record<string, Record<string, number>> | undefined;
    if (kind === 'state') {
      chambers = { 'State Senate': {}, 'State House': {}, 'U.S. House delegation': {} };
      for (const o of Object.values(this.s.offices)) {
        const p = this.pol(o.holder);
        if (!p) continue;
        const [t, g] = o.id.split(':');
        const st = t === 'house' || t === 'sldu' || t === 'sldl' ? this.data.districts[`${t === 'house' ? 'cd' : t}:${g}`]?.st : null;
        if (st !== id) continue;
        const ch = t === 'sldu' ? 'State Senate' : t === 'sldl' ? 'State House' : 'U.S. House delegation';
        chambers[ch][p.party] = (chambers[ch][p.party] ?? 0) + 1;
      }
      if (id === 'NE') delete chambers['State House'];
    }
    return { offices, chambers };
  }

  /** Party of current holder for every feature in a map layer. */
  holderMap(layer: 'states' | 'counties' | 'cd' | 'sldu' | 'sldl'): Record<string, Party> {
    const out: Record<string, Party> = {};
    for (const o of Object.values(this.s.offices)) {
      const p = this.pol(o.holder);
      if (!p) continue;
      const [t, a] = o.id.split(':');
      if (layer === 'states' && t === 'gov') out[this.data.states[a]?.fips] = p.party;
      else if (layer === 'cd' && t === 'house') out[a] = p.party;
      else if (layer === t) out[a] = p.party;
    }
    if (layer === 'counties') {
      const count: Record<string, Record<string, number>> = {};
      for (const o of Object.values(this.s.offices)) {
        const [t, a] = o.id.split(':');
        const p = this.pol(o.holder);
        if (t !== 'county' || !p) continue;
        (count[a] ??= {})[p.party] = (count[a][p.party] ?? 0) + 1;
      }
      for (const [a, c] of Object.entries(count)) out[a] = (c.D ?? 0) >= (c.R ?? 0) ? 'D' : 'R';
    }
    return out;
  }

  national() {
    const count = (prefix: string) => {
      const r: Record<string, number> = {};
      for (const o of Object.values(this.s.offices)) if (o.id.startsWith(prefix)) { const p = this.pol(o.holder); if (p) r[p.party] = (r[p.party] ?? 0) + 1; }
      return r;
    };
    const legis: Record<string, string> = {};
    for (const st of Object.keys(this.data.states)) {
      if (st === 'DC') continue;
      const ch = { u: { D: 0, R: 0 } as Record<string, number>, l: { D: 0, R: 0 } as Record<string, number> };
      for (const o of Object.values(this.s.offices)) {
        const [t, g] = o.id.split(':');
        if (t !== 'sldu' && t !== 'sldl') continue;
        if (this.data.districts[`${t}:${g}`]?.st !== st) continue;
        const p = this.pol(o.holder);
        if (p) ch[t === 'sldu' ? 'u' : 'l'][p.party] = (ch[t === 'sldu' ? 'u' : 'l'][p.party] ?? 0) + 1;
      }
      const ctrl = (x: Record<string, number>) => (x.D > x.R ? 'D' : x.R > x.D ? 'R' : 'S');
      const u = ctrl(ch.u), l = st === 'NE' ? u : ctrl(ch.l);
      legis[st] = u === l ? u : 'S';
    }
    return { house: count('house:'), senate: count('sen:'), governors: count('gov:'), legislatures: legis, pres: this.holderSummary('pres') };
  }

  view() {
    const s = this.s;
    const me = this.player;
    const P = s.player;
    const c = s.campaign;
    const def = c ? this.def(c.officeId) : null;
    const officeDef = me.officeId ? this.def(me.officeId) : null;
    const home = this.data.townSync(me.home);
    const campaign = c && def
      ? {
          ...c,
          title: def.title, type: def.type, level: def.level, jurName: def.jurName, jurKind: def.jur.kind, jurId: def.jur.id, st: def.st,
          expectedSpend: expectedSpend(def.type, def.pop), lean: this.jurUnit(def).lean, myRec: this.recIn(this.jurKey(def)),
          monthsToPrimary: c.stage === 'primary' ? (c.year - s.year) * 12 + c.primaryMonth - s.month : null,
          monthsToGeneral: (c.year - s.year) * 12 + 11 - s.month,
          field: [...new Set([...(c.stage === 'primary' ? c.primaryField : c.generalField), ...(c.stage === 'primary' ? c.otherField : [])])].map((id) => {
            const p = this.pol(id)!;
            return {
              id, name: this.name(p), party: p.party, age: this.age(p), isPlayer: !!p.isPlayer, incumbent: p.officeId === c.officeId,
              rec: p.isPlayer ? this.recIn(this.jurKey(def)) : c.rec[id] ?? p.rec, fav: p.fav, spend: c.spend[id] ?? 0, scandal: p.scandal, pos: p.pos, skills: p.skills,
              office: p.officeId ? this.def(p.officeId)?.title ?? null : null, inMyPrimary: c.primaryField.includes(id) || c.stage === 'general', endorse: (c.endorse[id] ?? 0) + (p.isPlayer ? P.endorsements.length : 0),
            };
          }),
        }
      : null;
    return {
      year: s.year, month: s.month, monthName: monthName(s.month), seed: s.seed,
      me: {
        id: me.id, name: this.name(me), first: me.first, last: me.last, party: me.party, age: this.age(me), gender: me.gender, background: P.background,
        homeTown: home ? `${shortTownName(home.name)}, ${home.st}` : me.home, homeId: me.home, homeSt: home?.st ?? '', homeCounty: home?.county ?? '',
        office: officeDef ? { id: me.officeId!, title: officeDef.title, type: officeDef.type, level: officeDef.level, executive: officeDef.executive, since: me.since, jurName: officeDef.jurName, nextElection: nextElection(me.officeId!, s.year, this.data) } : null,
        pos: me.pos, skills: me.skills, fav: me.fav, scandal: me.scandal, approval: this.approval(), career: me.career, terms: me.terms,
      },
      player: { ...P, rec: undefined, recHome: this.recIn(me.home), recCounty: home ? this.recIn(home.county) : 0, recState: home ? this.recIn(home.st) : 0, recUS: this.recIn('US') },
      payroll: STAFF_ROLES.reduce((a, r) => a + staffCost(P.staff[r.key], Math.max(officeDef?.level ?? 1, def?.level ?? 1)), 0),
      campaign,
      world: s.world,
      news: s.news.slice(0, 80),
      decisions: s.decisions,
      history: s.history,
      results: s.results.slice(0, 10).map((r) => ({ ...r, units: [] })),
      pendingNight: s.pendingNight,
      lastNational: s.lastNational ? { ...s.lastNational, pres: s.lastNational.pres ? { ...s.lastNational.pres } : undefined } : null,
      gameOver: s.gameOver ?? null,
    };
  }

  recMap(): Record<string, number> {
    return this.s.player.rec;
  }

  /** Targets for unit-based actions in the current race (or home area). */
  async targets(): Promise<{ id: string; label: string; pop: number; rec: number }[]> {
    const me = this.player;
    const c = this.s.campaign;
    const def = c ? this.def(c.officeId)! : me.officeId ? this.def(me.officeId)! : null;
    const home = await this.data.town(me.home);
    if (!home) return [];
    const kind = def?.jur.kind ?? 'town';
    const r = (id: string) => this.recIn(id);
    if (kind === 'town') return [{ id: home.id, label: shortTownName(home.name), pop: home.pop, rec: r(home.id) }];
    if (kind === 'state' || kind === 'nation') {
      if (kind === 'nation') return Object.entries(this.data.states).map(([st, s]) => ({ id: st, label: s.n, pop: s.pop, rec: r(st) })).sort((a, b) => b.pop - a.pop);
      return Object.entries(this.data.counties).filter(([, x]) => x.st === def!.st).map(([f, x]) => ({ id: f, label: x.n, pop: x.d[0] ?? 0, rec: r(f) })).sort((a, b) => b.pop - a.pop);
    }
    const towns = await this.data.townsOf(home.st);
    const id = def!.jur.id;
    const inJur = towns.filter((t) => (kind === 'county' ? t.county === id : kind === 'cd' ? t.cd === id : kind === 'sldu' ? t.sldu === id : t.sldl === id));
    return inJur.slice(0, 150).map((t) => ({ id: t.id, label: shortTownName(t.name), pop: t.pop, rec: r(t.id) }));
  }

  /** Full result (with units) for election night replay. */
  result(idx: number) {
    return this.s.results[idx] ?? null;
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
export const partyName = (p: Party) => (p === 'D' ? 'Democrat' : p === 'R' ? 'Republican' : 'Independent');
function describePos(x: number) {
  return x < -0.6 ? 'strongly progressive' : x < -0.2 ? 'progressive' : x <= 0.2 ? 'moderate' : x <= 0.6 ? 'conservative' : 'strongly conservative';
}

export type GameView = ReturnType<Engine['view']>;
export type OfficeOption = Awaited<ReturnType<Engine['availableOffices']>>[number];
export type JurisdictionInfo = Awaited<ReturnType<Engine['jurisdiction']>>;
export type NationalInfo = ReturnType<Engine['national']>;
export type HolderSummary = NonNullable<ReturnType<Engine['holderSummary']>>;
export { LEVEL };
