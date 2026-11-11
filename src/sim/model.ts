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
  result: 'won' | 'lost' | 'lost-primary' | 'took-office' | 'left-office' | 'withdrew';
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
}

export interface ResultSummary {
  officeId: string;
  title: string;
  year: number;
  stage: 'primary' | 'general';
  cands: { id: string; name: string; party: Party; votes: number; isPlayer?: boolean }[];
  winnerId: string;
  /** Unit-level results for election night (ordered by report time). */
  units: { id: string; label: string; votes: number[] }[];
  blocs: { label: string; shares: number[] }[];
  unitKind: 'county' | 'precinct' | 'state';
  electoral?: Record<string, number>;
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
}

export interface NewsItem {
  id: number;
  year: number;
  month: number;
  kind: 'national' | 'race' | 'player' | 'office' | 'scandal' | 'election';
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
}

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
}

export type { OfficeType };
