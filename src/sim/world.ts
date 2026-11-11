/** National environment: economy, presidential approval, generic ballot, issue salience, random events. */
import { ISSUES, N_ISSUES } from './issues';
import type { NewsItem, World } from './model';
import { Rng, clamp } from './rng';

/** Real-ish values at January 2025. */
export function initialWorld(): World {
  return {
    presParty: 'R',
    presApproval: 0.49,
    genericBallot: -1.5,
    unemployment: 4.0,
    inflation: 2.9,
    gdp: 2.4,
    sentiment: 71,
    rightTrack: 0.36,
    salience: [0.5, 0.3, 0.4, 0.6, 0.2, 0.25, 0.25, 0.3, 0.2, 0.35, 0.4, 0.2],
    honeymoon: 0,
  };
}

/** Environment in logit units, D-positive. One generic-ballot point ≈ 0.02 logit. */
export const envLogit = (w: World) => w.genericBallot / 50;

interface WorldEvent {
  title: string;
  body: string;
  p: number;
  apply: (w: World, rng: Rng) => void;
  tone: 'good' | 'bad' | 'neutral';
}

const sal = (w: World, key: string, d: number) => {
  const i = ISSUES.findIndex((x) => x.key === key);
  if (i >= 0) w.salience[i] = clamp(w.salience[i] + d);
};

const EVENTS: WorldEvent[] = [
  { title: 'Markets rally on strong jobs report', body: 'Hiring beat expectations for the third straight month.', p: 0.05, tone: 'good', apply: (w) => { w.unemployment -= 0.15; w.sentiment += 3; w.presApproval += 0.01; } },
  { title: 'Stocks slide amid recession fears', body: 'Analysts point to weak manufacturing data and tight credit.', p: 0.05, tone: 'bad', apply: (w) => { w.gdp -= 0.6; w.sentiment -= 5; w.presApproval -= 0.015; sal(w, 'taxes', 0.05); } },
  { title: 'Grocery prices jump', body: 'Food inflation hit its highest level in two years.', p: 0.04, tone: 'bad', apply: (w) => { w.inflation += 0.4; w.presApproval -= 0.012; sal(w, 'spending', 0.05); } },
  { title: 'Border crossings surge', body: 'A sharp rise in crossings dominates cable news coverage.', p: 0.04, tone: 'bad', apply: (w) => { sal(w, 'immigration', 0.15); w.presApproval -= w.presParty === 'D' ? 0.015 : 0.005; } },
  { title: 'Mass shooting renews gun debate', body: 'Vigils held nationwide as lawmakers trade accusations.', p: 0.04, tone: 'bad', apply: (w) => { sal(w, 'guns', 0.2); } },
  { title: 'Supreme Court issues major abortion ruling', body: 'Advocates on both sides vow to mobilize voters.', p: 0.02, tone: 'neutral', apply: (w) => { sal(w, 'abortion', 0.25); w.genericBallot += 1; } },
  { title: 'Record heat wave strains power grid', body: 'Rolling blackouts hit several states.', p: 0.03, tone: 'bad', apply: (w) => { sal(w, 'energy', 0.15); } },
  { title: 'Foreign crisis — nation rallies', body: 'The President addresses the nation from the Oval Office.', p: 0.025, tone: 'neutral', apply: (w) => { w.presApproval += 0.03; } },
  { title: 'Administration official resigns in scandal', body: 'An inspector general report details misuse of funds.', p: 0.03, tone: 'bad', apply: (w) => { w.presApproval -= 0.025; } },
  { title: 'Crime rates fall in major cities', body: 'New FBI data shows a broad decline in violent crime.', p: 0.03, tone: 'good', apply: (w) => { sal(w, 'crime', -0.1); } },
  { title: 'Violent crime spike in several cities', body: 'Mayors call for federal help.', p: 0.03, tone: 'bad', apply: (w) => { sal(w, 'crime', 0.15); } },
  { title: 'Housing costs hit new record', body: 'Median rent now exceeds a third of median income.', p: 0.04, tone: 'bad', apply: (w) => { sal(w, 'housing', 0.12); } },
  { title: 'Major union strike', body: 'Tens of thousands walk off the job demanding higher wages.', p: 0.025, tone: 'neutral', apply: (w) => { sal(w, 'labor', 0.15); } },
  { title: 'New tariffs announced', body: 'Trading partners threaten retaliation.', p: 0.03, tone: 'neutral', apply: (w) => { sal(w, 'trade', 0.15); w.inflation += 0.2; } },
  { title: 'Insurance premiums spike', body: 'Families face double-digit health premium increases.', p: 0.03, tone: 'bad', apply: (w) => { sal(w, 'health', 0.15); } },
  { title: 'Federal shutdown looms', body: 'Congress deadlocks over the budget.', p: 0.025, tone: 'bad', apply: (w) => { w.presApproval -= 0.01; sal(w, 'spending', 0.1); w.rightTrack -= 0.02; } },
  { title: 'Statewide test scores drop', body: 'Education officials blame chronic absenteeism.', p: 0.02, tone: 'bad', apply: (w) => { sal(w, 'education', 0.15); } },
];

/** Advance the world one month. Returns national news generated. */
export function stepWorld(w: World, rng: Rng, year: number, month: number, isMidtermYear: boolean): Omit<NewsItem, 'id'>[] {
  const news: Omit<NewsItem, 'id'>[] = [];
  // Economy: mean-reverting with shocks
  w.unemployment = clamp(w.unemployment + 0.08 * (4.4 - w.unemployment) + rng.normal(0, 0.12), 2.5, 15);
  w.inflation = clamp(w.inflation + 0.1 * (2.6 - w.inflation) + rng.normal(0, 0.15), -1, 12);
  w.gdp = clamp(w.gdp + 0.15 * (2.1 - w.gdp) + rng.normal(0, 0.35), -8, 8);
  w.sentiment = clamp(w.sentiment + 0.1 * (95 - 3 * w.unemployment - 4 * w.inflation + 2 * w.gdp - w.sentiment) + rng.normal(0, 1.5), 40, 110);
  // Approval: honeymoon decay toward economy-driven equilibrium
  w.honeymoon++;
  const econ = 0.47 - (w.unemployment - 4.5) * 0.02 - (w.inflation - 2.5) * 0.015 + (w.gdp - 2) * 0.008;
  const target = clamp(econ - Math.min(w.honeymoon, 18) * 0.003 + 0.015, 0.25, 0.7);
  w.presApproval = clamp(w.presApproval + 0.12 * (target - w.presApproval) + rng.normal(0, 0.008), 0.15, 0.85);
  w.rightTrack = clamp(w.rightTrack + 0.1 * (w.presApproval - 0.12 - w.rightTrack) + rng.normal(0, 0.01), 0.1, 0.8);
  // Generic ballot: president's party penalized by low approval, extra midterm penalty
  const sign = w.presParty === 'D' ? 1 : -1;
  const midterm = isMidtermYear ? -2.5 : 0;
  const gbTarget = sign * ((w.presApproval - 0.47) * 45 + midterm);
  w.genericBallot = clamp(w.genericBallot + 0.15 * (gbTarget - w.genericBallot) + rng.normal(0, 0.5), -15, 15);
  // Salience decays to baseline
  for (let i = 0; i < N_ISSUES; i++) w.salience[i] = clamp(w.salience[i] + 0.06 * (0.3 - w.salience[i]));
  // Events
  for (const e of EVENTS) {
    if (rng.chance(e.p)) {
      e.apply(w, rng);
      news.push({ year, month, kind: 'national', title: e.title, body: e.body, tone: e.tone });
    }
  }
  w.presApproval = clamp(w.presApproval, 0.15, 0.85);
  return news;
}
