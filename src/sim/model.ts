import type { Party } from '../data/types';
import type { Positions } from './issues';
import type { Gender } from './names';
import type { OfficeType } from './offices';

export interface Skills {
  charisma: number; // 0-100
  debate: number;
  fundraising: number;
  policy: number;
  integrity: number;
  organization: number;
}

export interface CareerEntry {
  year: number;
  officeId: string;
  title: string;
  result: 'won' | 'lost' | 'lost-primary' | 'took-office' | 'left-office' | 'withdrew' | 'appointed';
  share?: number;
}

export interface Politician {
  id: string;
  first: string;
  last: string;
  gender: Gender;
  birthYear: number;
  party: Party;
  pos: Positions;
  skills: Skills;
  /** Favorability among people who know them (0..1). */
  fav: number;
  /** Jurisdiction-wide recognition for their current office (0..1). */
  rec: number;
  scandal: number;
  home: string; // town id or state code
  officeId?: string;
  since?: number;
  terms: number;
  career: CareerEntry[];
  isPlayer?: boolean;
  // ---- M11 (optional so older saves load)
  /** Kept in the save after leaving office (rivals, presidential nominees). */
  notable?: boolean;
  /** Drive to climb (0..1). Stored for rivals; everyone else's is derived from their id (see careers.ts). */
  ambition?: number;
}

export interface OfficeState {
  id: string;
  holder: string | null;
  since: number;
  /** Two-party (or top-two) winning share at last election. */
  lastShare?: number;
  lastYear?: number;
}

export type Background = 'lawyer' | 'teacher' | 'business' | 'veteran' | 'doctor' | 'activist' | 'farmer' | 'union' | 'pastor' | 'police';

export interface Staff {
  manager: number; // 0-3 tiers
  comms: number;
  finance: number;
  field: number;
  policy: number;
}

export interface PlayerState {
  id: string; // politician id
  background: Background;
  cash: number; // campaign war chest
  personal: number; // personal savings
  ap: number; // action points left this month
  apMax: number;
  energy: number; // 0-100
  staff: Staff;
  /** Name recognition by unit id (county fips, town id). */
  rec: Record<string, number>;
  /** Approval among each bloc (0..1) — performance in office / public image. */
  blocApproval: number[];
  partyStanding: number; // 0-100
  /** Interest group relationships −100..100. */
  groups: Record<string, number>;
  /** Issues the player has emphasized (0..1, decays). */
  emphasis: Positions;
  /** Record of positions taken in office (shifts perceived positions). */
  record: { year: number; month: number; title: string; choice: string }[];
  /** Metrics for the jurisdiction the player governs (executives) or legislative effectiveness. */
  metrics: Record<string, number>;
  endorsements: string[];
  retired?: boolean;
  /** Recent player actions, newest first (also drives diminishing returns within a month). */
  log?: ActionLogEntry[];
  // ---- M9 governing (all optional so older saves load)
  /** Political capital inside a legislative body: earned monthly and by loyal votes, spent whipping votes and on leadership bids. */
  favors?: number;
  /** Leadership post the player holds in their chamber. */
  role?: Role | null;
  /** Pending bid for a leadership post (resolved at the end of January). */
  bid?: { role: RoleKind; committee?: string } | null;
  /** Committee assignments (legislators in large chambers). */
  committees?: string[];
  /** Bills the player sponsored (active and recent). */
  bills?: Bill[];
  /** Executive budget in force. */
  budget?: Budget | null;
  /** Laws enacted under the player's name or signature while in the current office (persistent metric effects). */
  policies?: Policy[];
}

export type YM = { year: number; month: number };
export type BillStage = 'committee' | 'floor' | 'second' | 'desk' | 'vetoed' | 'law' | 'dead';

export interface Bill {
  id: string;
  templateId: string | null;
  issue: string;
  /** +1 conservative, -1 progressive. */
  dir: 1 | -1;
  title: string;
  body: string;
  /** Chamber of origin (see legislature.ts chamber keys). */
  chamber: string;
  committee: string | null;
  stage: BillStage;
  introduced: YM;
  stageSince: YM;
  /** Members the player has whipped to yes (politician ids). */
  whipped: string[];
  /** The committee chair has agreed to a hearing. */
  hearing?: boolean;
  /** Extra hearing odds from lobbying the chair this stage. */
  lobbied?: number;
  log: { year: number; month: number; text: string; tone?: 'good' | 'bad' | 'neutral' }[];
  metrics?: Record<string, number>;
  groups?: Record<string, number>;
  lastVote?: { label: string; yes: number; no: number; needed: number };
}

export type RoleKind = 'speaker' | 'majority' | 'minority' | 'whip' | 'chair';
export interface Role {
  chamber: string;
  role: RoleKind;
  committee?: string;
  since: number;
}

/** Leadership of one chamber (politician ids). */
export interface Leadership {
  chamber: string;
  year: number;
  majorityParty: Party;
  speaker?: string;
  majority?: string;
  minority?: string;
  whip?: string;
  minorityWhip?: string;
  chairs: Record<string, string>;
}

/** Executive budget levers: 1 = current-services baseline. */
export interface Budget {
  year: number;
  month: number;
  tax: number;
  education: number;
  safety: number;
  infrastructure: number;
  health: number;
  /** How the legislature changed the proposal. */
  note?: string;
}

export interface Policy {
  id: string;
  title: string;
  year: number;
  metrics: Record<string, number>;
}

/** A seat emptied mid-term, waiting for an appointment. */
export interface Vacancy {
  officeId: string;
  year: number;
  month: number;
  reason: string;
  /** Party of the departed holder (appointees usually match it). */
  party: Party;
  /** Office id of the appointing authority, or 'caucus' / 'council'. */
  by: string;
  due: YM;
  playerSeeks?: boolean;
}

export interface SpecialElection {
  officeId: string;
  year: number;
  month: number;
  primaryMonth: number | null;
  reason: string;
  party: Party;
}


export interface ActionLogEntry {
  year: number;
  month: number;
  id: string;
  label: string;
  target?: string;
  msg: string;
  /** Change in campaign cash from this action. */
  cash: number;
}

/** Snapshot of the player's numbers at the start of a month (for the month summary). */
export interface MonthSnapshot {
  year: number;
  month: number;
  cash: number;
  personal: number;
  rec: number;
  fav: number;
  approval: number;
  partyStanding: number;
  newsId: number;
  pollMe?: number;
  pollRival?: number;
  officeId?: string;
  /** Copy of recognition by area, so the summary can measure whichever area is relevant at month end. */
  recMap?: Record<string, number>;
}

export interface MonthSummary {
  year: number;
  month: number;
  monthName: string;
  /** What the summary measures recognition and polls against (race or office). */
  context: string | null;
  actions: ActionLogEntry[];
  money: { label: string; amount: number }[];
  cash: [number, number];
  personal: [number, number];
  rec: [number, number];
  fav: [number, number];
  approval: [number, number] | null;
  partyStanding: [number, number];
  poll: { me: [number | null, number]; rival: [number | null, number]; rivalName: string; undecided: number } | null;
  /** Plain-language explanations of the biggest changes. */
  why: string[];
  events: { title: string; tone?: 'good' | 'bad' | 'neutral' }[];
  next: string[];
}

export interface PollPoint {
  year: number;
  month: number;
  label: string;
  shares: Record<string, number>; // candidate id -> share
  moe: number;
}

export interface Campaign {
  officeId: string;
  year: number;
  stage: 'primary' | 'general' | 'done';
  primaryMonth: number;
  kind: 'partisan' | 'top-two' | 'nonpartisan';
  primaryField: string[]; // politician ids incl. player
  generalField: string[];
  spend: Record<string, number>;
  raised: number;
  endorse: Record<string, number>;
  polls: PollPoint[];
  debates: { month: number; winner: string; swing: number }[];
  bias: Record<string, number>; // accumulated event effects per candidate
  /** Race-wide recognition of AI candidates. */
  rec: Record<string, number>;
  /** Total budget AI candidates will spend. */
  budget: Record<string, number>;
  debatePrep: number;
  /** Field shown for the other party primary (partisan races). */
  otherField: string[];
  resultPrimary?: ResultSummary;
  resultGeneral?: ResultSummary;
  /** Month of the general election (November unless this is a special election). */
  generalMonth?: number;
  /** Special election to fill a vacancy: the winner takes office immediately. */
  special?: boolean;
  /** Presidential nomination contest (state-by-state primaries and delegates). */
  pres?: PresPrimary;
  /** The player's running mate (presidential nominee only). */
  vp?: string | null;
}

/** The delegate race for a presidential nomination. */
export interface PresPrimary {
  party: Party;
  /** Pledged delegates won so far, by candidate id. */
  delegates: Record<string, number>;
  /** Pledged delegates available in each state. */
  pool: Record<string, number>;
  total: number;
  /** A majority of pledged delegates clinches the nomination. */
  needed: number;
  /** Results by state: winner, delegates won and vote shares by candidate. */
  states: Record<string, { month: number; winner: string; delegates: Record<string, number>; shares: Record<string, number> }>;
  /** Candidates who dropped out, with the month they left. */
  dropped: { id: string; month: number }[];
  /** The nominee, once decided (also kept when the player loses, so November uses them). */
  nominee?: string;
  /** Home state of each candidate (a home-state boost). */
  homes: Record<string, string>;
}

/** Presidential tickets for a cycle, picked at the summer conventions (when the player isn't the nominee). */
export interface Tickets {
  year: number;
  D?: { pres: string; vp: string };
  R?: { pres: string; vp: string };
  /** The player was offered (and may have accepted) a spot on their party's ticket. */
  offered?: boolean;
}

export interface ResultSummary {
  officeId: string;
  title: string;
  year: number;
  stage: 'primary' | 'general';
  cands: { id: string; name: string; party: Party; votes: number; isPlayer?: boolean }[];
  winnerId: string;
  /** Unit-level results for election night (ordered by report time). `geo` anchors precincts to a town on the map. */
  units: { id: string; label: string; votes: number[]; geo?: string }[];
  blocs: { label: string; shares: number[] }[];
  unitKind: 'county' | 'precinct' | 'state';
  electoral?: Record<string, number>;
  /** Presidential primary nights: delegates won tonight and the running totals. */
  delegates?: { contest: string; won: Record<string, number>; total: Record<string, number>; needed: number; outcome?: string };
}

export interface World {
  presParty: Party;
  presApproval: number; // 0..1
  genericBallot: number; // D minus R, points
  unemployment: number;
  inflation: number;
  gdp: number;
  sentiment: number; // consumer sentiment index
  rightTrack: number; // 0..1
  salience: Positions; // national emphasis 0..1
  honeymoon: number; // months into term
  /** Lasting shifts to the economy's equilibrium from enacted laws (decay slowly). */
  policy?: EconShift;
  /** Current fiscal stance from the player's executive budget (recomputed monthly). */
  fiscal?: EconShift;
}

export interface EconShift {
  unemployment: number;
  inflation: number;
  gdp: number;
}

export interface NewsItem {
  id: number;
  year: number;
  month: number;
  kind: 'national' | 'race' | 'player' | 'office' | 'scandal' | 'election' | 'rival';
  title: string;
  body?: string;
  tone?: 'good' | 'bad' | 'neutral';
}

export interface DecisionOption {
  label: string;
  detail: string;
  /** Movement of the player's record per issue (−1..1 small steps). */
  pos?: Partial<Record<string, number>>;
  bloc?: Partial<Record<string, number>>; // bloc approval deltas (−0.1..0.1)
  metrics?: Record<string, number>;
  groups?: Record<string, number>;
  party?: number;
  cash?: number;
  scandalRisk?: number;
  rec?: number;
  /** Kill the bill (block it from the floor or bury it in committee). */
  kill?: boolean;
  /** Politician chosen by an appointment decision. */
  pick?: string;
}

export interface Decision {
  id: string;
  templateId: string;
  title: string;
  body: string;
  options: DecisionOption[];
  deadline: { year: number; month: number };
  /** For legislative votes: projected chamber support for the bill (0..1). */
  support?: number;
  /** Extra context for non-standard decisions (veto overrides, appointments). */
  meta?: { kind: 'override' | 'appoint' | 'vp' | 'ticket' | 'map'; map?: string; plans?: PlanKey[]; officeId?: string; issue?: string; dir?: number; title?: string; candidates?: string[] };
}

export interface HistoryPoint {
  year: number;
  month: number;
  approval: number;
  rec: number;
  cash: number;
  presApproval: number;
  generic: number;
  unemployment: number;
  inflation: number;
}

export interface GameState {
  version: number;
  seed: number;
  rng: number;
  year: number;
  month: number;
  player: PlayerState;
  politicians: Record<string, Politician>;
  offices: Record<string, OfficeState>;
  campaign: Campaign | null;
  world: World;
  news: NewsItem[];
  decisions: Decision[];
  results: ResultSummary[];
  history: HistoryPoint[];
  nextId: number;
  pendingNight: ResultSummary | null;
  /** Election winners waiting to be sworn in (officeId -> politician id). */
  incoming: Record<string, string>;
  /** National results of the most recent general election for other races. */
  lastNational: { year: number; house: Record<string, number>; senate: Record<string, number>; gov: Record<string, number>; pres?: ResultSummary } | null;
  gameOver?: string;
  /** Missing in saves made before difficulty existed (treated as normal). */
  difficulty?: Difficulty;
  monthStart?: MonthSnapshot;
  lastSummary?: MonthSummary | null;
  /** Leadership of chambers the player has served in (by chamber key). */
  leadership?: Record<string, Leadership>;
  /** Seats waiting for an appointment. */
  vacancies?: Vacancy[];
  /** Scheduled special elections. */
  specials?: SpecialElection[];
  // ---- M10 (optional so older saves load)
  /** Year the scenario started (2025, or 2027 after the midterms). */
  startYear?: number;
  /** This cycle's presidential tickets once the conventions pick them. */
  tickets?: Tickets | null;
  // ---- M11 (optional so older saves load)
  /** AI politicians the game follows as the player's rivals (politician id -> why). */
  rivals?: Record<string, RivalInfo>;
  /** Reapportionment and new district maps after the 2030 census. */
  redistricting?: Redistricting;
}

export type RivalTag = 'party' | 'opposition' | 'star' | 'nemesis' | 'comeback';
export interface RivalInfo {
  tag: RivalTag;
  note: string;
  since: number;
  /** Races against the player. */
  record: { year: number; officeId: string; title: string; stage: 'primary' | 'general'; playerWon: boolean }[];
  /** Year they left politics. */
  retired?: number;
}

/** Which plan a map uses: a party's gerrymander, the neutral plan, or the old lines. */
export type PlanKey = 'fair' | 'D' | 'R' | 'keep';
export type MapKind = 'cd' | 'sldu' | 'sldl';
export interface PlanChoice {
  plan: PlanKey;
  /** Who drew it, for the inspector and news ("Republican legislature", "independent commission", "court"). */
  by: string;
  year: number;
  month: number;
  /** A court threw out the original plan and imposed this one. */
  struck?: boolean;
  /** The plan the court replaced. */
  was?: PlanKey;
}
export interface Redistricting {
  census: number;
  /** Census results (seat counts and electoral votes) are in effect. */
  apportioned: boolean;
  /** Enacted maps by `${kind}:${ST}`. */
  plans: Record<string, PlanChoice>;
  /** Pending court challenges: map key -> month the ruling comes (year after the census + 1). */
  challenges?: Record<string, number>;
  /** House seats eliminated by reapportionment (office ids), removed when the new Congress is sworn in. */
  retired?: string[];
  /** The player's call on a state's maps (as governor or legislator), by state. */
  calls?: Record<string, PlanKey>;
}

/** Difficulty: scales starting cash, AI opponents' money and campaigning, and election-day randomness. */
export type Difficulty = 'story' | 'normal' | 'hard';

export interface NewCharacter {
  first: string;
  last: string;
  gender: Gender;
  age: number;
  party: Party;
  homeTown: string;
  background: Background;
  pos: Positions;
  skills: Skills;
  seed?: number;
  difficulty?: Difficulty;
  /** Scenario start: January 2025 (default) or January 2027, after the 2026 midterms. */
  start?: 2025 | 2027;
}

export type { OfficeType };
