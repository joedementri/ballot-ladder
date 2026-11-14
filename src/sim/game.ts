/**
 * Game engine: owns the GameState and advances it month by month.
 * Runs inside a Web Worker; the UI talks to it through Comlink (see workers/sim.worker.ts).
 */
import { DataStore } from '../data/store';
import { demoFrom, type Party, type Town } from '../data/types';
import { N_BLOCS, N_ISSUES, PARTY_BASE, type Positions } from './issues';
import { generateName } from './names';
import {
  GOVERNORS, GOV_LIMIT, JUDGE_RETIRE, LEVEL, LTGOV_TICKET, TYPE_LABEL, expectedSpend, filingMonth, isUp, nextElection, officeDef,
  officesForTown, seedOfficeIds, setApportionment, shortTownName, type OfficeDef,
} from './offices';
import { monthlyRivals, seedRivals } from './careers';
import { CENSUS, applyGeography, redistrictingMonth, retireSeats, stateMaps } from './redistricting';
import { conventions } from './primaries';
import type { Campaign, GameState, NewCharacter, NewsItem, OfficeState, Politician, ResultSummary, RoleKind, Skills, SpecialElection } from './model';
import { Rng, clamp, expit, logit } from './rng';
import type { Candidate, RaceCtx, Unit } from './vote';
import { envLogit, initialWorld, stepWorld } from './world';
import { BACKGROUNDS, apMaxFor } from './campaign';
import { METRIC_INFO, billIssue, generateDecisions } from './governing';
import { DIFFICULTY } from './difficulty';
import {
  addLeadershipOptions, billAction, chamberKey, defaultCommittees, ensureLeadership, introduceBill, isSmall, placeBid, playerChamber, processBills, resolveBid, reviewRole,
  setCommittees, type BillAction,
} from './legislature';
import { baselineBudget, type LeverKey } from './budget';
import { dropAppointmentCandidates, opportunities, processVacancies, rollVacancies, seekAppointment, vacate } from './vacancies';
import { CAREER_KEEP, INC_REC, genMonth, monthName, partyName, round2, round3 } from './util';
import { act, actionCost, actionNotes, fatigue } from './actions';
import { startCampaign, aiCampaign, maybeDebate, poll, resolvePrimary, resolveGeneral } from './races';
import { backgroundElections, nationalLawmaking, preludeTo2027 } from './background';
import { monthSummary, snapshot, summaryContext } from './summary';
import { approval, playerUpkeep, pushHistory } from './upkeep';
import { budgetDeadline, chamberSupport, decide, metricTargets, setBudget, setFiscal } from './office';
import { SAVE_VERSION, migrate } from './migrate';
import { advance } from './advance';
import { incumbencyStrength } from './incumbency';
import { scandalLapsed } from './scandals';
import { budgetView, holderMap, holderSummary, jurisdiction, legislature, national, targets, view } from './views';

export { DIFFICULTY };
export { monthName, partyName } from './util';
export { FATIGUE } from './actions';

export { SAVE_VERSION } from './migrate';

export interface ActionResult {
  ok: boolean;
  msg: string;
}

export class Engine {
  data: DataStore;
  s!: GameState;
  rng!: Rng;
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
  get diff() {
    return DIFFICULTY[this.s.difficulty];
  }
  newId(prefix = 'p') {
    return `${prefix}${(this.s.nextId++).toString(36)}`;
  }
  news(item: Omit<NewsItem, 'id' | 'year' | 'month'> & { year?: number; month?: number }) {
    this.s.news.unshift({ id: this.s.nextId++, year: this.s.year, month: this.s.month, ...item });
    if (this.s.news.length > 250) this.s.news.length = 250;
  }
  age(p: Politician) {
    return this.s.year - p.birthYear;
  }
  name(p?: Politician) {
    return p ? `${p.first} ${p.last}` : 'Vacant';
  }
  /**
   * Drop a politician who is out of office from the save, unless the game still follows them (the player, rivals
   * and other notables, or someone about to be sworn in elsewhere).
   */
  discard(id: string) {
    const p = this.s.politicians[id];
    if (!p || p.isPlayer || p.officeId || p.notable || Object.values(this.s.incoming).includes(id)) return;
    delete this.s.politicians[id];
  }
  /** District lines changed (redistricting): office definitions are rebuilt. */
  geographyChanged() {
    this.defCache.clear();
  }
  /** The player lost their office outside the normal flow (an eliminated district). */
  playerLeftOffice() {
    this.leftOffice();
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

  genPolitician(rng: Rng, o: { party: Party; lean: number; demo?: Town['demo']; home: string; quality: number; ageMin?: number }): Politician {
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
    if (type === 'pres' || type === 'vp') return 'R';
    if (type === 'gov') return GOVERNORS[a]?.party ?? 'R';
    // lieutenant governors elected on a joint ticket share the governor's party
    if (type === 'ltgov' && LTGOV_TICKET.has(a)) return GOVERNORS[a]?.party ?? 'R';
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
    p.terms = rng.int(0, def.type === 'president' || def.type === 'vp' ? 0 : 3);
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
      difficulty: ch.difficulty ?? 'normal', startYear: ch.start ?? 2025,
      leadership: {}, vacancies: [], specials: [], tickets: null, rivals: {}, scandals: [],
    };
    const start = ch.start ?? 2025;
    this.rng = new Rng(seed);
    // a previous game in this session may have redrawn the map
    setApportionment(null);
    await this.data.applyPlans({});
    this.geographyChanged();
    for (const id of seedOfficeIds(this.data)) this.ensureOffice(id);
    const home = await this.data.town(ch.homeTown);
    if (!home) throw new Error('Unknown home town');
    const bg = BACKGROUNDS[ch.background];
    const skills = { ...ch.skills };
    for (const [k, v] of Object.entries(bg.skills)) (skills as any)[k] = clamp((skills as any)[k] + v, 1, 99);
    const me: Politician = {
      id: this.newId('me'), first: ch.first, last: ch.last, gender: ch.gender, birthYear: start - ch.age, party: ch.party,
      pos: ch.pos.map(round2), skills, fav: 0.5 + (skills.charisma - 50) / 500, rec: 0, scandal: 0, home: home.id, terms: 0, career: [], isPlayer: true,
    };
    this.s.politicians[me.id] = me;
    const staff = { manager: 0, comms: 0, finance: 0, field: 0, policy: 0 };
    this.s.player = {
      id: me.id, background: ch.background, cash: Math.round(bg.cash * 0.1 * this.diff.cash), personal: bg.cash, ap: 0, apMax: apMaxFor(staff, skills), energy: 100,
      staff, rec: {}, blocApproval: new Array(N_BLOCS).fill(0.5), partyStanding: 40, groups: {}, emphasis: new Array(N_ISSUES).fill(0), record: [],
      metrics: {}, endorsements: [], log: [], favors: 0, role: null, bid: null, committees: [], bills: [], budget: null, policies: [],
    };
    for (const [g, v] of Object.entries(bg.groups)) this.s.player.groups[g] = v as number;
    this.s.player.ap = this.s.player.apMax;
    const prelude = start === 2027 ? await preludeTo2027(this) : null;
    this.bumpRec(home.id, 0.12);
    for (const o of officesForTown(home, this.data)) this.ensureOffice(o);
    seedRivals(this, home);
    this.news({ kind: 'player', title: `${ch.first} ${ch.last} enters public life in ${shortTownName(home.name)}, ${home.st}`, body: `A ${ch.age}-year-old ${bg.label.toLowerCase()} and ${partyName(ch.party)}, ${ch.first} has their eye on local office.`, tone: 'good' });
    if (prelude) this.news({ kind: 'national', title: 'The new Congress is sworn in after the 2026 midterms', body: prelude });
    else this.news({ kind: 'national', title: 'New Congress sworn in; President inaugurated', body: `The ${partyName(this.s.world.presParty)} administration begins with ${Math.round(this.s.world.presApproval * 100)}% approval.` });
    pushHistory(this);
    this.s.monthStart = snapshot(this);
  }

  /** Load a save of any version (migrate.ts upgrades older formats in place). Call restore() next. */
  load(state: GameState) {
    this.s = migrate(state);
    this.rng = new Rng(state.rng);
    this.defCache.clear();
    // today's lines and electoral votes until restore() applies the save's redistricting (synchronous when empty)
    setApportionment(null);
    void this.data.applyPlans({});
  }

  /** After load(): bring back the save's census apportionment and district maps. */
  async restore() {
    // the home town's state (views show the home town by name)
    await this.data.town(this.player.home);
    const R = this.s.redistricting;
    if (R?.apportioned) setApportionment((await this.data.apportionment()).ev);
    if (R) await applyGeography(this);
    // saves from before M11 that already passed the census catch up now
    if (!R && (this.s.year > CENSUS || (this.s.year === CENSUS && this.s.month === 12))) await redistrictingMonth(this);
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
    const out: { id: string; title: string; type: string; level: number; year: number; filingBy: string; deadline: { year: number; month: number }; holder: string; holderParty: Party | null; lean: number; pop: number; open: boolean; eligible: boolean; reason?: string; special?: string }[] = [];
    for (const id of officesForTown(home, this.data)) {
      const def = this.def(id);
      if (!def) continue;
      const o = this.ensureOffice(id);
      let year = nextElection(id, this.s.year, this.data);
      if (year === this.s.year && this.s.month > filingMonth(def, year) && !(year === this.s.year && !def.partisan && this.s.month <= 8)) year = nextElection(id, this.s.year + 1, this.data);
      // a special election comes first if it is still open for filing
      const sp = this.openSpecial(id);
      const deadline = { year, month: def.partisan ? filingMonth(def, year) : 8 };
      if (sp) {
        year = sp.year;
        deadline.year = sp.year;
        deadline.month = Math.max(1, (sp.primaryMonth ?? sp.month) - 1);
      }
      const filingBy = `${monthName(deadline.month)} ${deadline.year}`;
      const h = this.pol(o?.holder);
      const age = this.age(this.player) + (year - this.s.year);
      let reason: string | undefined;
      if (age < def.minAge) reason = `Must be ${def.minAge}+`;
      else if (def.type === 'judge' && this.s.player.background !== 'lawyer') reason = 'Justices must be lawyers';
      if (this.player.officeId === id) reason = undefined;
      out.push({
        id, title: def.title, type: TYPE_LABEL[def.type], level: def.level, year, filingBy, deadline,
        holder: this.name(h), holderParty: h?.party ?? null, lean: this.jurUnit(def).lean, pop: def.pop, open: !h, eligible: !reason, reason,
        special: sp ? `Special election ${monthName(sp.month)} ${sp.year}` : undefined,
      });
    }
    // collapse multi-seat bodies to the seat(s) up soonest
    const seen = new Map<string, (typeof out)[number]>();
    for (const o of out) {
      const body = o.id.split(':').slice(0, 2).join(':');
      const prev = seen.get(body);
      if (!prev || o.year < prev.year || (o.special && !prev.special && o.year === prev.year)) seen.set(body, o);
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
    const sp = opt.special ? this.openSpecial(officeId) : null;
    await startCampaign(this, def, opt.year, sp ?? undefined);
    return { ok: true, msg: `Filed for ${def.title} (${sp ? 'special election, ' : ''}${opt.year}).` };
  }

  /** A scheduled special election for this office that is still open for filing. */
  openSpecial(officeId: string): SpecialElection | null {
    const sp = this.s.specials.find((x) => x.officeId === officeId);
    if (!sp) return null;
    const cutoff = sp.primaryMonth ?? sp.month;
    return sp.year > this.s.year || (sp.year === this.s.year && this.s.month < cutoff) ? sp : null;
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

  willRunAgain(p: Politician, def: OfficeDef, rng: Rng) {
    const age = this.age(p);
    if (def.type === 'governor' && GOV_LIMIT(def.st!) && p.terms >= GOV_LIMIT(def.st!)) return false;
    if (def.type === 'president' && p.terms >= 2) return false;
    if (def.type === 'judge' && age + 1 >= JUDGE_RETIRE) return false;
    if (age > 78 && rng.chance(0.6)) return false;
    if (age > 70 && rng.chance(0.2)) return false;
    return !rng.chance(def.level >= 5 ? 0.06 : 0.12);
  }

  // ------------------------------------------------------------------ candidates & races

  candidate(id: string, def: OfficeDef, c: Campaign | null): Candidate {
    const p = this.pol(id)!;
    const isMe = p.isPlayer;
    const rec = isMe ? this.recIn(this.jurKey(def)) : c?.rec[id] ?? p.rec;
    const sk = p.skills;
    return {
      id, name: this.name(p), party: p.party, pos: p.pos, rec, fav: p.fav, incumbent: incumbencyStrength(this, p, def, c?.officeId === def.id ? c.year : undefined),
      spend: c?.spend[id] ?? 0, endorse: (c?.endorse[id] ?? 0) + (isMe ? this.s.player.endorsements.length : 0), scandal: p.scandal,
      skill: (sk.charisma + sk.debate) / 200, emphasis: isMe ? this.s.player.emphasis : undefined, bias: c?.bias[id] ?? 0,
    };
  }

  ctxFor(def: OfficeDef, kind: RaceCtx['kind'], party?: Party): RaceCtx {
    const envWeight = def.level >= 5 ? 1 : def.level >= 3 ? 0.7 : 0.4;
    return { kind, party, env: envLogit(this.s.world), envWeight, natEmphasis: this.s.world.salience.map((x) => (x - 0.3) * 0.8), expectedSpend: expectedSpend(def.type, def.pop), noiseScale: this.diff.noise };
  }

  // ------------------------------------------------------------------ actions (actions.ts) and governing (office.ts)

  fatigue(actionId: string, target?: string) {
    return fatigue(this, actionId, target);
  }
  actionCost(actionId: string) {
    return actionCost(this, actionId);
  }
  actionNotes() {
    return actionNotes(this);
  }
  act(actionId: string, target?: string) {
    return act(this, actionId, target);
  }
  decide(decisionId: string, optionIdx: number) {
    return decide(this, decisionId, optionIdx);
  }
  chamberSupport(def: OfficeDef, issue: string, dir: number, vote: 'yes' | 'no' | 'present', tag: string) {
    return chamberSupport(this, def, issue, dir, vote, tag);
  }
  setBudget(levers: Partial<Record<LeverKey, number>>) {
    return setBudget(this, levers);
  }
  metricTargets(def: OfficeDef | null) {
    return metricTargets(this, def);
  }
  approval() {
    return approval(this);
  }

  // ------------------------------------------------------------------ turn

  async endTurn() {
    if (this.s.pendingNight) return; // must view election night first
    const { year, month } = this.s;
    const c = this.s.campaign;
    const start = this.s.monthStart?.year === year && this.s.monthStart.month === month ? this.s.monthStart : snapshot(this);
    const ctx = summaryContext(this);
    // 1. Campaign month: AI activity, debates, polls
    if (c && c.stage !== 'done') {
      aiCampaign(this, c);
      await maybeDebate(this, c);
    }
    // 2. Expired decisions (skipped)
    for (const d of this.s.decisions.filter((x) => x.deadline.year < year || (x.deadline.year === year && x.deadline.month <= month))) {
      // an unanswered scandal is "no comment" (or, once charged, fighting it), not a missed vote
      if (d.meta?.kind === 'scandal') {
        scandalLapsed(this, d);
        continue;
      }
      this.s.player.metrics.effectiveness = (this.s.player.metrics.effectiveness ?? 50) - 2;
      this.s.player.blocApproval = this.s.player.blocApproval.map((x) => clamp(x - 0.005));
      this.news({ kind: 'office', title: `You let "${d.title}" pass without action`, tone: 'bad' });
      dropAppointmentCandidates(this, d);
    }
    this.s.decisions = this.s.decisions.filter((x) => !(x.deadline.year < year || (x.deadline.year === year && x.deadline.month <= month)));
    // 2b. Governing: the player's bills move, the caucus votes on leadership bids (January), budgets lapse into a
    // continuing resolution (March), seats empty and get filled.
    processBills(this);
    if (month === 1) resolveBid(this);
    budgetDeadline(this);
    processVacancies(this);
    rollVacancies(this);
    conventions(this);
    // 3. Elections at the end of this month
    let night: ResultSummary | null = null;
    if (c && c.stage === 'primary' && c.year === year && c.primaryMonth === month) night = await resolvePrimary(this, c);
    if (c && c.stage === 'general' && c.year === year && month === genMonth(c)) night = await resolveGeneral(this, c);
    if (month === 11) await backgroundElections(this, year);
    // the census, new maps and court rulings (2030 on)
    await redistrictingMonth(this);
    if (c && c.stage !== 'done') poll(this, c);
    // 4. Advance calendar
    this.s.month = month === 12 ? 1 : month + 1;
    if (month === 12) this.s.year++;
    if (this.s.month === 1) await this.newYear();
    monthlyRivals(this);
    // 5. World and player upkeep (the player's executive budget and national laws shift the economy)
    setFiscal(this);
    nationalLawmaking(this);
    for (const n of stepWorld(this.s.world, this.rng, this.s.year, this.s.month, this.s.year % 4 === 2)) this.news(n);
    const upkeep = playerUpkeep(this);
    // 6. New decisions for officeholders
    const me = this.player;
    if (me.officeId) {
      const def = this.def(me.officeId)!;
      const ds = generateDecisions(this.rng, def.type, def.executive, def.jurName, this.s.year, this.s.month, this.s.decisions.map((d) => d.templateId), () => this.newId('d'));
      addLeadershipOptions(this, ds, billIssue);
      this.s.decisions.push(...ds);
    }
    pushHistory(this);
    if (night) this.s.pendingNight = night;
    this.s.lastSummary = monthSummary(this, start, ctx, c, upkeep, year, month, night);
    this.s.monthStart = snapshot(this);
    this.s.rng = this.rng.state;
  }

  ackNight() {
    this.s.pendingNight = null;
  }

  /** Skip ahead: end months until something needs the player (advance.ts). */
  advance(maxMonths: number) {
    return advance(this, maxMonths);
  }

  private async newYear() {
    // Swearing-in
    const me = this.player;
    // the President is sworn in before the Vice President, so a VP-elect who also holds a seat leaves it cleanly
    const order = Object.entries(this.s.incoming).sort(([a], [b]) => (a === 'pres' ? -1 : b === 'pres' ? 1 : 0));
    for (const [officeId, pid] of order) if (this.pol(pid)) this.installOffice(officeId, pid, 'elected');
    this.s.incoming = {};
    // House seats lost in reapportionment end with the old Congress
    retireSeats(this);
    // keep saves lean: background officeholders keep only their recent career (rivals and the player keep it all)
    for (const p of Object.values(this.s.politicians)) if (p.career.length > CAREER_KEEP && !p.notable && !p.isPlayer) p.career = p.career.slice(-CAREER_KEEP);
    if (this.s.tickets && this.s.tickets.year < this.s.year) this.s.tickets = null;
    if (this.s.campaign?.stage === 'done') this.s.campaign = null;
    // New sessions: leadership posts are confirmed or change hands
    reviewRole(this);
    const ch = playerChamber(this);
    if (ch) ensureLeadership(this, ch).year = this.s.year;
    const odef = me.officeId ? this.def(me.officeId) : null;
    if (odef?.executive) this.news({ kind: 'office', title: `Budget season: submit the ${this.s.year} budget for ${odef.jurName}`, body: 'Set your priorities on the Office tab by March, or spending continues at last year’s levels.' });
    if (ch && !isSmall(ch) && this.s.player.committees.length) this.news({ kind: 'office', title: 'The new session organizes', body: 'You can change committee assignments through February, and run for a leadership post. The caucus votes at the end of January.' });
    // Auto-file re-election if the player holds an office that is up this year
    if (me.officeId && !this.s.campaign && isUp(me.officeId, this.s.year, this.data)) {
      const def = this.def(me.officeId)!;
      const lim = def.type === 'governor' ? GOV_LIMIT(def.st!) : def.type === 'president' ? 2 : 0;
      if (!lim || me.terms < lim) {
        await startCampaign(this, def, this.s.year);
        this.news({ kind: 'player', title: `You are up for re-election as ${def.title} this year`, body: 'Your re-election campaign has been opened automatically. Withdraw from the Campaign tab to retire or run for something else.' });
      } else this.news({ kind: 'player', title: `You are term-limited as ${def.title}`, body: 'Time to run for something else — or retire.' });
    }
    // Upcoming elections reminder for unaffiliated player
    if (!me.officeId && !this.s.campaign) this.news({ kind: 'player', title: `${this.s.year}: Which office will you run for?`, body: 'Open the Run for Office panel to see seats on the ballot in your area.' });
  }

  /**
   * Put a politician in an office now (January swearing-in, appointments, successions, special elections).
   * Whoever held it leaves; if the newcomer held another office, that seat is vacated and filled by its own rules.
   */
  installOffice(officeId: string, pid: string, how: 'elected' | 'appointed' | 'succeeded' = 'elected') {
    const o = this.ensureOffice(officeId)!;
    const def = this.def(officeId)!;
    const prev = this.pol(o.holder);
    const again = prev?.id === pid;
    if (prev && !again) {
      prev.officeId = undefined;
      prev.career.push({ year: this.s.year, officeId, title: def.title, result: 'left-office' });
      if (prev.isPlayer) {
        this.news({ kind: 'player', title: `Your term as ${def.title} ends`, tone: 'neutral' });
        this.leftOffice();
      } else this.discard(prev.id);
    }
    const p = this.pol(pid)!;
    if (p.officeId && p.officeId !== officeId) {
      const old = p.officeId;
      if (p.isPlayer) this.leftOffice();
      const oldO = this.s.offices[old];
      if (this.s.incoming[old] && this.s.incoming[old] !== pid) {
        // a successor was already elected in November; the seat just waits for them
        const oldDef = this.def(old)!;
        p.career.push({ year: this.s.year, officeId: old, title: oldDef.title, result: 'left-office' });
        p.officeId = undefined;
        if (oldO) oldO.holder = null;
      } else vacate(this, old, `left to become ${def.title}`, { keepHolder: true });
    }
    p.officeId = officeId;
    if (again) p.terms++;
    else {
      p.since = this.s.year;
      p.terms = 1;
    }
    p.rec = Math.max(p.rec, INC_REC[def.type] * 0.7);
    o.holder = pid;
    if (!again) o.since = this.s.year;
    if (p.isPlayer) {
      const P = this.s.player;
      if (again) this.news({ kind: 'player', title: `${this.name(p)} sworn in for another term as ${def.title}`, tone: 'good' });
      else {
        p.career.push({ year: this.s.year, officeId, title: def.title, result: how === 'appointed' ? 'appointed' : 'took-office' });
        P.metrics = Object.fromEntries(Object.entries(METRIC_INFO).map(([k, v]) => [k, v.base]));
        P.blocApproval = new Array(N_BLOCS).fill(0.55);
        const ch = chamberKey(def);
        P.favors = ch ? 3 : 0;
        P.committees = ch && !isSmall(ch) ? defaultCommittees(P.background) : [];
        P.role = null;
        P.bid = null;
        P.policies = [];
        P.budget = def.executive ? baselineBudget(this.s.year - 1, 12) : null;
        this.news({ kind: 'player', title: `${this.name(p)} ${how === 'appointed' ? 'appointed and sworn in' : 'sworn in'} as ${def.title}`, tone: 'good' });
        if (def.type === 'council' || def.type === 'county' || def.type === 'cexec') {
          const prefix = def.type === 'cexec' ? `county:${def.jur.id}` : officeId.split(':').slice(0, 2).join(':');
          const n = def.type === 'council' ? 13 : 5;
          for (let i = 0; i < n; i++) if (this.def(`${prefix}:${i}`)) this.ensureOffice(`${prefix}:${i}`);
        }
        if (ch) ensureLeadership(this, ch);
      }
    }
    if (officeId === 'pres') {
      this.s.world.presParty = p.party;
      if (how !== 'succeeded') {
        this.s.world.honeymoon = 0;
        this.s.world.presApproval = clamp(this.s.world.presApproval + 0.08, 0.4, 0.62);
      }
    }
  }

  /** The player is leaving their office: their bills die, posts lapse, and pending business goes with them. */
  private leftOffice() {
    const P = this.s.player;
    for (const d of this.s.decisions) dropAppointmentCandidates(this, d);
    // scandals follow the person, not the office
    this.s.decisions = this.s.decisions.filter((d) => d.meta?.kind === 'scandal');
    for (const b of P.bills) if (b.stage !== 'law' && b.stage !== 'dead') {
      b.stage = 'dead';
      b.log.push({ year: this.s.year, month: this.s.month, text: 'Died when its sponsor left the chamber.', tone: 'bad' });
    }
    P.role = null;
    P.bid = null;
    P.budget = null;
    P.policies = [];
    P.favors = 0;
  }

  // ------------------------------------------------------------------ queries for the UI (views.ts)

  view() {
    return view(this);
  }
  holderSummary(officeId: string) {
    return holderSummary(this, officeId);
  }
  jurisdiction(kind: 'state' | 'county' | 'cd' | 'sldu' | 'sldl' | 'town', id: string) {
    return jurisdiction(this, kind, id);
  }
  holderMap(layer: 'states' | 'counties' | 'cd' | 'sldu' | 'sldl') {
    return holderMap(this, layer);
  }
  national() {
    return national(this);
  }
  legislature() {
    return legislature(this);
  }
  budgetView() {
    return budgetView(this);
  }
  targets() {
    return targets(this);
  }

  // ------------------------------------------------------------------ governing actions (M9)

  introduceBill(issue: string, dir: 1 | -1, templateId?: string) {
    return introduceBill(this, issue, dir, templateId);
  }
  billAction(billId: string, action: BillAction) {
    return billAction(this, billId, action);
  }
  bidRole(role: RoleKind, committee?: string) {
    return placeBid(this, role, committee);
  }
  cancelBid(): ActionResult {
    if (!this.s.player.bid) return { ok: false, msg: 'No bid to withdraw.' };
    this.s.player.bid = null;
    return { ok: true, msg: 'You dropped your leadership bid.' };
  }
  setCommittees(list: string[]) {
    return setCommittees(this, list);
  }
  seekAppointment(officeId: string) {
    return seekAppointment(this, officeId);
  }
  opportunities() {
    return opportunities(this);
  }

  recMap(): Record<string, number> {
    return this.s.player.rec;
  }

  /** Redistricting rows for the state inspector. */
  stateMaps(st: string) {
    return stateMaps(this, st);
  }

  /** Full result (with units) for election night replay. */
  result(idx: number) {
    return this.s.results[idx] ?? null;
  }
}

export type GameView = ReturnType<Engine['view']>;
export type OfficeOption = Awaited<ReturnType<Engine['availableOffices']>>[number];
export type JurisdictionInfo = Awaited<ReturnType<Engine['jurisdiction']>>;
export type NationalInfo = ReturnType<Engine['national']>;
export type HolderSummary = NonNullable<ReturnType<Engine['holderSummary']>>;
export type LegislatureInfo = NonNullable<ReturnType<Engine['legislature']>>;
export type BudgetInfo = NonNullable<ReturnType<Engine['budgetView']>>;
export type Opportunity = ReturnType<Engine['opportunities']>[number];
export type StateMaps = Awaited<ReturnType<Engine['stateMaps']>>;
export { LEVEL };
