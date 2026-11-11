/**
 * Decision pools for independent elected officials (M10): sheriffs, prosecutors, school boards, row offices,
 * lieutenant governors, judges and the Vice President. They don't vote on bills or write budgets; their
 * choices move their own metrics, interest groups, party standing and voter blocs.
 */
import type { DecisionOption } from './model';
import type { OfficeType } from './offices';

export interface RoleEvent {
  id: string;
  roles: OfficeType[];
  title: string; // {J} = jurisdiction name
  body: string;
  options: DecisionOption[];
}

const ALL = { wcol: 0.01, wnon: 0.01, black: 0.01, hisp: 0.01, asian: 0.01, young: 0.01, senior: 0.01 };
const scale = (b: Record<string, number>, k: number) => Object.fromEntries(Object.entries(b).map(([x, v]) => [x, v * k]));

export const ROLE_EVENTS: RoleEvent[] = [
  // ---- sheriff
  {
    id: 'jail_crowding', roles: ['sheriff'], title: 'The {J} jail is over capacity', body: 'Inmates are sleeping on floors and a federal lawsuit is being prepared.',
    options: [
      { label: 'Ask for a jail expansion', detail: 'Costly; law-and-order voters approve.', metrics: { budget: -1, crime: -0.4 }, pos: { crime: 0.04 }, groups: { police: 10, taxpayers: -10 } },
      { label: 'Expand diversion and release low-risk detainees', detail: 'Cheaper; risky if someone reoffends.', metrics: { budget: 0.5, crime: 0.3 }, pos: { crime: -0.05 }, bloc: { black: 0.02, young: 0.02, wnon: -0.02 }, scandalRisk: 0.05 },
    ],
  },
  {
    id: 'detainers', roles: ['sheriff'], title: 'ICE asks {J} to join a 287(g) agreement', body: 'Deputies would screen inmates for immigration status and hold them for federal agents.',
    options: [
      { label: 'Sign the agreement', detail: 'Border hawks cheer; immigrant communities pull back from police.', pos: { immigration: 0.08 }, groups: { border: 25, immigrant: -30 }, bloc: { hisp: -0.04, wnon: 0.02 } },
      { label: 'Decline — local deputies do local work', detail: 'Immigrant groups approve; you will be called soft.', pos: { immigration: -0.06 }, groups: { border: -25, immigrant: 25 }, bloc: { hisp: 0.03, wnon: -0.02 } },
    ],
  },
  {
    id: 'bodycams', roles: ['sheriff'], title: 'Deputies want new body cameras — with a catch', body: 'The union will agree only if footage stays private unless the sheriff releases it.',
    options: [
      { label: 'Buy cameras, release footage within 30 days', detail: 'Transparency; the union is unhappy.', metrics: { budget: -0.4 }, groups: { police: -10 }, bloc: { black: 0.02, young: 0.02, wcol: 0.01 } },
      { label: 'Accept the union terms', detail: 'Keeps the department on side.', metrics: { budget: -0.4 }, groups: { police: 10 } },
      { label: 'Skip the cameras', detail: 'Saves money.', bloc: { black: -0.02, young: -0.01 } },
    ],
  },
  {
    id: 'drug_bust', roles: ['sheriff', 'da'], title: 'A fentanyl ring is operating in {J}', body: 'Overdoses are up and the press is asking what you will do.',
    options: [
      { label: 'Task force and a public crackdown', detail: 'Visible and popular; overtime is expensive.', metrics: { crime: -0.6, budget: -0.4 }, pos: { crime: 0.04 }, groups: { police: 10 }, rec: 0.05, bloc: { senior: 0.02, wnon: 0.02 } },
      { label: 'Pair arrests with treatment programs', detail: 'Slower results; reformers approve.', metrics: { crime: -0.3, health: 0.4 }, pos: { crime: -0.02 }, bloc: { wcol: 0.02, young: 0.01 } },
    ],
  },
  // ---- prosecutor
  {
    id: 'charging', roles: ['da'], title: 'Set a charging policy for low-level offenses', body: 'Shoplifting and drug possession cases are clogging the courts in {J}.',
    options: [
      { label: 'Prosecute everything to the full extent', detail: 'Tough-on-crime voters and police approve; courts back up.', metrics: { crime: -0.3, budget: -0.3 }, pos: { crime: 0.06 }, groups: { police: 15 }, bloc: { wnon: 0.02, senior: 0.02, young: -0.02 } },
      { label: 'Divert first offenders to treatment', detail: 'Reformers cheer; one bad case could define you.', metrics: { budget: 0.3 }, pos: { crime: -0.06 }, groups: { police: -10 }, bloc: { black: 0.03, young: 0.02 }, scandalRisk: 0.06 },
    ],
  },
  {
    id: 'officer_case', roles: ['da', 'ag'], title: 'Charge the officer in a fatal shooting?', body: 'Video of the shooting is ambiguous. Protesters and the police union are both outside your office.',
    options: [
      { label: 'File charges', detail: 'Reform advocates rally behind you; police are furious.', pos: { crime: -0.05 }, groups: { police: -30 }, bloc: { black: 0.05, young: 0.03, wnon: -0.03 }, rec: 0.06 },
      { label: 'Decline to charge, release the full report', detail: 'Transparent but unpopular with activists.', pos: { crime: 0.03 }, groups: { police: 10 }, bloc: { black: -0.04, wnon: 0.02 }, rec: 0.04 },
      { label: 'Send it to a grand jury', detail: 'Buys time; nobody fully trusts it.', bloc: scale(ALL, -0.3) },
    ],
  },
  {
    id: 'death_penalty', roles: ['da'], title: 'Seek the death penalty in a notorious murder case?', body: 'The victim’s family is asking for it; the trial would cost millions.',
    options: [
      { label: 'Seek death', detail: 'Popular with your base; years of appeals.', metrics: { budget: -0.5 }, pos: { crime: 0.05 }, bloc: { wnon: 0.02, senior: 0.01, wcol: -0.01 }, party: 2 },
      { label: 'Seek life without parole', detail: 'Faster and cheaper; some call it weak.', pos: { crime: -0.02 }, bloc: { wcol: 0.01, young: 0.01 } },
    ],
  },
  // ---- attorney general
  {
    id: 'multistate_suit', roles: ['ag'], title: 'Join a multistate lawsuit against the administration?', body: 'Attorneys general from your party are suing over a new federal rule.',
    options: [
      { label: 'Sign on and hold a press conference', detail: 'The base loves it; national profile rises.', party: 6, rec: 0.06, bloc: { wcol: -0.005, wnon: -0.005 } },
      { label: 'Stay out of it', detail: 'Looks independent; the party notices.', party: -4, bloc: { wcol: 0.01, wnon: 0.01 } },
    ],
  },
  {
    id: 'opioid_funds', roles: ['ag'], title: 'Spend the opioid settlement for {J}', body: 'A $300 million settlement arrived. Everyone has a plan for it.',
    options: [
      { label: 'Treatment and recovery centers', detail: 'Public health experts approve.', metrics: { health: 0.8 }, groups: { seniors: 5 }, bloc: { wnon: 0.02, wcol: 0.01 } },
      { label: 'Law enforcement grants', detail: 'Sheriffs and police are grateful.', metrics: { crime: -0.4 }, groups: { police: 15 } },
      { label: 'Plug the state budget', detail: 'Pragmatic; families of victims are angry.', metrics: { budget: 1 }, bloc: scale(ALL, -1) },
    ],
  },
  {
    id: 'consumer', roles: ['ag'], title: 'Sue a tech giant over children’s data?', body: 'Your consumer protection staff say a big app collects data on kids illegally.',
    options: [
      { label: 'File the suit', detail: 'Popular across the board; the company will spend to beat you.', rec: 0.05, groups: { chamber: -15 }, bloc: { senior: 0.02, wcol: 0.02, wnon: 0.01 } },
      { label: 'Negotiate a quiet settlement', detail: 'Money for the state, little credit.', cash: 0.02, metrics: { budget: 0.4 }, groups: { chamber: 5 } },
    ],
  },
  // ---- secretary of state
  {
    id: 'mail_ballots', roles: ['sos'], title: 'Send mail-ballot applications to every voter?', body: 'Turnout advocates want it; the other party calls it an invitation to fraud.',
    options: [
      { label: 'Mail them to everyone', detail: 'Your party’s activists cheer; the other side files suit.', party: 3, bloc: { young: 0.02, senior: 0.01, wnon: -0.01 } },
      { label: 'On request only', detail: 'The cautious middle.', bloc: { wcol: 0.005, wnon: 0.005 } },
    ],
  },
  {
    id: 'voter_rolls', roles: ['sos'], title: 'Clean up the voter rolls', body: 'An audit found thousands of outdated registrations. How aggressively do you remove them?',
    options: [
      { label: 'Aggressive purge', detail: 'Election-integrity groups approve; lawsuits are likely.', pos: { immigration: 0.03 }, party: 2, bloc: { black: -0.03, hisp: -0.02, wnon: 0.02 }, scandalRisk: 0.04 },
      { label: 'Follow the federal minimum process', detail: 'Slow and defensible.', bloc: { wcol: 0.01 } },
    ],
  },
  {
    id: 'certify', roles: ['sos'], title: 'Pressure to delay certifying a close election', body: 'Your party’s candidate lost narrowly in {J} and allies want you to hold off certification.',
    options: [
      { label: 'Certify on time', detail: 'The law is clear. Some in your party will never forgive you.', party: -8, rec: 0.08, bloc: { wcol: 0.04, wnon: 0.02, senior: 0.02, black: 0.02, hisp: 0.02 } },
      { label: 'Delay and order an extra review', detail: 'Your base approves; courts and editorial boards do not.', party: 6, scandalRisk: 0.15, bloc: { wcol: -0.05, black: -0.03, young: -0.03 } },
    ],
  },
  // ---- treasurer
  {
    id: 'pension_esg', roles: ['treas'], title: 'Divest the pension fund from fossil fuels?', body: 'Activists want the state’s pension fund out of oil and gas; the energy industry is lobbying hard.',
    options: [
      { label: 'Divest', detail: 'Environmental groups celebrate; returns may suffer.', pos: { energy: -0.06 }, groups: { green: 25, energy: -25 }, metrics: { budget: -0.3 } },
      { label: 'Ban “ESG” investing instead', detail: 'Conservatives cheer; asset managers grumble.', pos: { energy: 0.06 }, groups: { green: -20, energy: 20 }, party: 2 },
      { label: 'Returns only — no politics', detail: 'The fiduciary answer.', metrics: { budget: 0.2 } },
    ],
  },
  {
    id: 'bond_refi', roles: ['treas'], title: 'Refinance the state’s bonds?', body: 'Rates dipped. Refinancing saves money, but bankers want a big fee.',
    options: [
      { label: 'Refinance now', detail: 'Long-run savings.', metrics: { budget: 0.8 }, groups: { taxpayers: 10 } },
      { label: 'Wait for a better rate', detail: 'Might pay off; might not.', metrics: { budget: 0.1 } },
    ],
  },
  {
    id: 'baby_bonds', roles: ['treas'], title: 'Launch a “baby bonds” savings program', body: 'Seed every newborn in poverty with a state-held savings account.',
    options: [
      { label: 'Launch it', detail: 'Progressives love it; fiscal hawks don’t.', metrics: { budget: -0.5 }, pos: { spending: -0.04 }, bloc: { black: 0.02, young: 0.02 }, groups: { taxpayers: -10 } },
      { label: 'Pass', detail: 'No new spending.', groups: { taxpayers: 5 } },
    ],
  },
  // ---- lieutenant governor
  {
    id: 'tie_vote', roles: ['ltgov', 'vp'], title: 'You must break a tie in the Senate', body: 'A partisan bill is deadlocked and you cast the deciding vote.',
    options: [
      { label: 'Vote with your party', detail: 'Leadership is grateful.', party: 6, bloc: { wcol: -0.005, wnon: -0.005 }, rec: 0.03 },
      { label: 'Vote against it', detail: 'A maverick moment; your party is furious.', party: -10, bloc: { wcol: 0.02, wnon: 0.02 }, rec: 0.05 },
    ],
  },
  {
    id: 'acting', roles: ['ltgov'], title: 'Acting governor for a week', body: 'The governor is traveling abroad. A flood warning hits while you are in charge.',
    options: [
      { label: 'Declare an emergency and take charge', detail: 'You look like a leader; the governor may resent it.', rec: 0.06, bloc: scale(ALL, 2), party: -1 },
      { label: 'Wait for the governor', detail: 'Loyal and invisible.', party: 2, bloc: scale(ALL, -1) },
    ],
  },
  {
    id: 'ltgov_council', roles: ['ltgov'], title: 'Chair the state economic development council?', body: 'A thankless job that comes with a lot of ribbon cuttings.',
    options: [
      { label: 'Take it on', detail: 'More exposure and business contacts.', rec: 0.05, groups: { chamber: 10 }, metrics: { jobs: 0.3 } },
      { label: 'Decline politely', detail: 'Keeps your schedule free for campaigning.' },
    ],
  },
  // ---- judges
  {
    id: 'court_abortion', roles: ['judge'], title: 'The court hears a challenge to the state’s abortion law', body: 'You may write the deciding opinion.',
    options: [
      { label: 'Uphold the law as written', detail: 'Judicial restraint; one side is furious.', pos: { abortion: 0.05 }, groups: { life: 25, choice: -25 } },
      { label: 'Strike it down under the state constitution', detail: 'A landmark ruling; the other side vows to unseat you.', pos: { abortion: -0.05 }, groups: { life: -25, choice: 25 } },
      { label: 'Decide on narrow procedural grounds', detail: 'Lawyers respect it; nobody else notices.', metrics: { effectiveness: 0.4 } },
    ],
  },
  {
    id: 'court_maps', roles: ['judge'], title: 'A partisan gerrymandering case reaches the court', body: 'The legislature’s new maps favor the majority party.',
    options: [
      { label: 'Throw out the maps', detail: 'Reform groups cheer; the majority party targets you.', party: -4, bloc: { wcol: 0.02, young: 0.01 }, rec: 0.04 },
      { label: 'Leave map-drawing to the legislature', detail: 'Restraint; reformers are disappointed.', party: 3 },
    ],
  },
  {
    id: 'court_recusal', roles: ['judge'], title: 'Recuse yourself from a donor’s case?', body: 'A major contributor to your campaign is a party to a big commercial case.',
    options: [
      { label: 'Recuse', detail: 'Clean hands.', metrics: { effectiveness: 0.3 }, bloc: scale(ALL, 0.5) },
      { label: 'Hear the case', detail: 'You are confident in your impartiality; the press is not.', scandalRisk: 0.12, groups: { chamber: 5 } },
    ],
  },
  // ---- school board
  {
    id: 'book_policy', roles: ['school'], title: 'Parents demand removal of books from school libraries', body: 'A packed board meeting in {J} over a list of challenged titles.',
    options: [
      { label: 'Remove the challenged books', detail: 'Parental-rights groups approve; teachers and librarians object.', pos: { education: 0.05 }, groups: { teachers: -20 }, bloc: { wnon: 0.03, wcol: -0.03, young: -0.02 } },
      { label: 'Keep them; parents can opt their kids out', detail: 'A middle path.', bloc: { wcol: 0.01, wnon: 0.005 } },
      { label: 'Reject the challenges outright', detail: 'Teachers approve; the meeting turns ugly.', pos: { education: -0.04 }, groups: { teachers: 15 }, bloc: { wcol: 0.02, wnon: -0.03 } },
    ],
  },
  {
    id: 'school_closure', roles: ['school'], title: 'Close an under-enrolled school?', body: 'Enrollment is down and the district faces a deficit.',
    options: [
      { label: 'Close and consolidate', detail: 'Balances the budget; the neighborhood is furious.', metrics: { budget: 1.2, schools: -0.3 }, bloc: { wnon: -0.02, black: -0.02 }, groups: { taxpayers: 10 } },
      { label: 'Keep it open, cut elsewhere', detail: 'Popular locally; the deficit stays.', metrics: { budget: -0.6 }, bloc: { wnon: 0.01, black: 0.01 } },
    ],
  },
  {
    id: 'phones', roles: ['school'], title: 'Ban phones in class?', body: 'Teachers say phones are wrecking attention spans; some parents want to reach their kids.',
    options: [
      { label: 'Bell-to-bell ban', detail: 'Popular with teachers and most parents.', metrics: { schools: 0.5 }, groups: { teachers: 10 }, bloc: { senior: 0.02, wcol: 0.01, young: -0.01 } },
      { label: 'Leave it to each teacher', detail: 'No fight, no change.' },
    ],
  },
  {
    id: 'teacher_contract', roles: ['school'], title: 'Teacher contract negotiations stall', body: 'The union is threatening a strike over pay and class sizes.',
    options: [
      { label: 'Meet the union’s demands', detail: 'Labor peace; budget strain.', metrics: { schools: 0.6, budget: -1 }, groups: { teachers: 25, labor: 10, taxpayers: -10 } },
      { label: 'Hold firm', detail: 'Fiscal hawks approve; a strike is possible.', metrics: { budget: 0.4, schools: -0.3 }, groups: { teachers: -20, taxpayers: 15 } },
    ],
  },
  // ---- vice president
  {
    id: 'vp_trip', roles: ['vp'], title: 'The President asks you to lead a diplomatic trip', body: 'A two-week tour of allied capitals — and away from the cameras at home.',
    options: [
      { label: 'Go', detail: 'Statesmanlike; out of sight.', party: 3, rec: 0.02 },
      { label: 'Send the Secretary of State instead', detail: 'Stay home and build your own profile.', party: -3, rec: 0.03 },
    ],
  },
  {
    id: 'vp_portfolio', roles: ['vp'], title: 'Pick a signature issue for your vice presidency', body: 'The White House wants you to own one issue.',
    options: [
      { label: 'Border security', detail: 'High risk, high profile.', pos: { immigration: 0.04 }, rec: 0.04, scandalRisk: 0.05 },
      { label: 'Broadband and rural jobs', detail: 'Ribbon cuttings, few enemies.', metrics: { jobs: 0.2 }, bloc: { wnon: 0.02 } },
      { label: 'Cancer research moonshot', detail: 'Universally liked.', bloc: scale(ALL, 1.5) },
    ],
  },
];

/** Metrics each official answers for (shown on the Office tab; effectiveness is always shown). */
export const ROLE_METRICS: Partial<Record<OfficeType, string[]>> = {
  sheriff: ['crime', 'budget'], da: ['crime'], ag: ['crime', 'health', 'budget'], treas: ['budget'], ltgov: ['jobs'], school: ['schools', 'budget'],
};

/** Generic events officials can also draw (they have no bills or budgets). */
export const OFFICIAL_GENERIC = new Set(['press', 'scandal_staff']);
