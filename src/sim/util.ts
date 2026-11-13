/** Small helpers shared by the engine modules. */
import type { Party } from '../data/types';
import type { Campaign } from './model';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m: number) => MONTHS[m - 1];
export const partyName = (p: Party) => (p === 'D' ? 'Democrat' : p === 'R' ? 'Republican' : 'Independent');
export const round2 = (x: number) => Math.round(x * 100) / 100;
export const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** Month of a campaign's general election (November unless it is a special). */
export const genMonth = (c: Campaign) => c.generalMonth ?? 11;
export const fmtMoney = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n).toLocaleString('en-US')}`);

/** Typical recognition for an incumbent by office type. */
export const INC_REC: Record<string, number> = {
  council: 0.38, mayor: 0.55, county: 0.25, sldl: 0.22, sldu: 0.28, house: 0.45, governor: 0.85, senate: 0.75, president: 0.98,
  school: 0.2, sheriff: 0.45, da: 0.3, cexec: 0.5, ltgov: 0.3, ag: 0.35, sos: 0.3, treas: 0.2, judge: 0.15, vp: 0.9,
};
/** Career entries kept for background politicians. */
export const CAREER_KEEP = 6;
