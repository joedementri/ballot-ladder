/**
 * Governing: decisions and legislative votes for whatever office the player holds.
 * Templates are parameterized by office level and jurisdiction.
 */
import type { OfficeType } from './offices';
import type { Decision, DecisionOption } from './model';
import { Rng } from './rng';

type Scope = 'local' | 'county' | 'state' | 'federal';
export const scopeOf = (t: OfficeType): Scope =>
  t === 'council' || t === 'mayor' ? 'local' : t === 'county' ? 'county' : t === 'sldl' || t === 'sldu' || t === 'governor' ? 'state' : 'federal';

interface BillTemplate {
  id: string;
  scopes: Scope[];
  title: string; // {J} = jurisdiction name
  body: string;
  issue: string; // issue key the bill moves
  dir: 1 | -1; // +1 conservative, -1 progressive
  metrics?: Record<string, number>; // effect if it passes (for executives / jurisdiction)
  groups?: Record<string, number>; // groups that care (positive = supports bill)
}

/** Policy bills: legislators vote, executives sign/veto. */
const BILLS: BillTemplate[] = [
  { id: 'min_wage', scopes: ['local', 'state', 'federal'], title: 'Raise the minimum wage to $17/hour', body: 'Phased in over three years, indexed to inflation afterward.', issue: 'labor', dir: -1, metrics: { jobs: -0.3, cost: 0.2 }, groups: { labor: 30, chamber: -30 } },
  { id: 'rtw', scopes: ['state'], title: 'Right-to-work act', body: 'Bars contracts requiring union dues as a condition of employment.', issue: 'labor', dir: 1, metrics: { jobs: 0.3 }, groups: { labor: -40, chamber: 25 } },
  { id: 'tax_cut', scopes: ['state', 'federal'], title: 'Across-the-board income tax cut', body: 'Cuts rates for all brackets; scored as reducing revenue by 4%.', issue: 'taxes', dir: 1, metrics: { budget: -1.5, jobs: 0.2 }, groups: { taxpayers: 35, chamber: 20, teachers: -15 } },
  { id: 'millionaire', scopes: ['state', 'federal'], title: 'Millionaire surtax for schools & transit', body: 'A 4% surtax on income over $1M, dedicated to schools and transit.', issue: 'taxes', dir: -1, metrics: { budget: 1.2, schools: 1 }, groups: { teachers: 25, taxpayers: -35, chamber: -20 } },
  { id: 'prop_tax', scopes: ['local', 'county'], title: 'Property tax levy increase', body: 'A 1.5-mill increase to close the budget gap and fund road repair.', issue: 'taxes', dir: -1, metrics: { budget: 1.5, infrastructure: 1 }, groups: { taxpayers: -30 } },
  { id: 'prop_tax_cut', scopes: ['local', 'county'], title: 'Property tax rollback', body: 'Rolls back the last levy increase; departments must find 3% in savings.', issue: 'taxes', dir: 1, metrics: { budget: -1.2, infrastructure: -0.5 }, groups: { taxpayers: 30 } },
  { id: 'police_budget', scopes: ['local', 'county', 'state'], title: 'Hire 40 new police officers', body: 'Expands patrols in high-crime neighborhoods.', issue: 'crime', dir: 1, metrics: { crime: -1, budget: -0.6 }, groups: { police: 35 } },
  { id: 'police_reform', scopes: ['local', 'state', 'federal'], title: 'Police accountability & body-camera act', body: 'Creates a civilian review board and mandates body cameras.', issue: 'crime', dir: -1, metrics: { crime: 0.1 }, groups: { police: -30 } },
  { id: 'zoning', scopes: ['local', 'county', 'state'], title: 'Allow apartments near transit', body: 'Upzones land within half a mile of transit and main streets.', issue: 'housing', dir: -1, metrics: { housing: 1.2 }, groups: { housing: 35 } },
  { id: 'zoning_local', scopes: ['local', 'county'], title: 'Downzone residential neighborhoods', body: 'Limits new construction to single-family homes on large lots.', issue: 'housing', dir: 1, metrics: { housing: -1 }, groups: { housing: -35 } },
  { id: 'rent', scopes: ['local', 'state'], title: 'Rent stabilization ordinance', body: 'Caps annual rent increases at 5% plus inflation.', issue: 'housing', dir: -1, metrics: { housing: -0.3, cost: -0.3 }, groups: { housing: -10, chamber: -20 } },
  { id: 'vouchers', scopes: ['state', 'federal'], title: 'Universal school choice accounts', body: 'Gives families $8,000 per child to spend on private or home schooling.', issue: 'education', dir: 1, metrics: { schools: -0.4, budget: -0.8 }, groups: { teachers: -40 } },
  { id: 'teacher_pay', scopes: ['local', 'county', 'state'], title: 'Teacher pay raise', body: 'Raises starting teacher pay to $55,000.', issue: 'education', dir: -1, metrics: { schools: 1, budget: -0.8 }, groups: { teachers: 40 } },
  { id: 'carry', scopes: ['state', 'federal'], title: 'Permitless carry act', body: 'Allows adults to carry concealed handguns without a permit.', issue: 'guns', dir: 1, groups: { guns: 40, safety: -40, police: -5 } },
  { id: 'red_flag', scopes: ['state', 'federal'], title: 'Red-flag law & universal background checks', body: 'Lets courts temporarily remove guns from people deemed dangerous.', issue: 'guns', dir: -1, metrics: { crime: -0.2 }, groups: { guns: -40, safety: 40 } },
  { id: 'abortion_ban', scopes: ['state', 'federal'], title: 'Six-week abortion ban', body: 'Bans most abortions after cardiac activity is detected.', issue: 'abortion', dir: 1, groups: { life: 45, choice: -45 } },
  { id: 'abortion_protect', scopes: ['state', 'federal'], title: 'Codify abortion rights', body: 'Protects access to abortion until viability.', issue: 'abortion', dir: -1, groups: { life: -45, choice: 45 } },
  { id: 'clean_energy', scopes: ['local', 'state', 'federal'], title: 'Clean energy standard', body: 'Requires 80% clean electricity by 2040 with incentives for solar and wind.', issue: 'energy', dir: -1, metrics: { cost: 0.3, jobs: 0.1 }, groups: { green: 40, energy: -35 } },
  { id: 'drilling', scopes: ['state', 'federal'], title: 'Expand oil & gas leasing', body: 'Opens new public lands and offshore areas to drilling.', issue: 'energy', dir: 1, metrics: { jobs: 0.3, budget: 0.4 }, groups: { green: -40, energy: 40 } },
  { id: 'medicaid', scopes: ['state', 'federal'], title: 'Expand Medicaid / public health coverage', body: 'Extends coverage to low-income adults; federal funds cover most of the cost.', issue: 'health', dir: -1, metrics: { health: 1.2, budget: -0.4 }, groups: { seniors: 15 } },
  { id: 'work_req', scopes: ['state', 'federal'], title: 'Work requirements for public assistance', body: 'Requires 20 hours of work or training per week for benefits.', issue: 'spending', dir: 1, metrics: { budget: 0.5, health: -0.3 } },
  { id: 'sanctuary', scopes: ['local', 'county', 'state'], title: 'Limit cooperation with immigration detainers', body: 'Bars local jails from holding people solely on federal immigration requests.', issue: 'immigration', dir: -1, groups: { immigrant: 35, border: -35, police: -10 } },
  { id: 'everify', scopes: ['state', 'federal'], title: 'Mandatory E-Verify & border enforcement funding', body: 'Requires employers to verify work eligibility; funds new border agents.', issue: 'immigration', dir: 1, metrics: { jobs: -0.1 }, groups: { border: 40, immigrant: -40, farm: -10 } },
  { id: 'tariffs', scopes: ['federal'], title: 'Reciprocal tariff act', body: 'Imposes matching tariffs on countries that tax American exports.', issue: 'trade', dir: 1, metrics: { jobs: 0.1, cost: 0.4 }, groups: { farm: -20, labor: 15, chamber: -20 } },
  { id: 'trade_deal', scopes: ['federal'], title: 'Pacific trade agreement', body: 'Lowers tariffs with eleven Pacific nations.', issue: 'trade', dir: -1, metrics: { cost: -0.2 }, groups: { farm: 25, labor: -25, chamber: 25 } },
  { id: 'budget_cut', scopes: ['local', 'county', 'state', 'federal'], title: 'Balanced budget with 5% spending cuts', body: 'Across-the-board cuts except public safety.', issue: 'spending', dir: 1, metrics: { budget: 1.5, schools: -0.4, infrastructure: -0.4 }, groups: { taxpayers: 30, teachers: -20 } },
  { id: 'infra', scopes: ['local', 'county', 'state', 'federal'], title: 'Roads & water infrastructure bond', body: 'Borrows to repair roads, bridges and lead water pipes.', issue: 'spending', dir: -1, metrics: { infrastructure: 1.5, budget: -0.5, jobs: 0.2 }, groups: { labor: 25, taxpayers: -15 } },
];

interface EventTemplate {
  id: string;
  scopes: Scope[];
  executiveOnly?: boolean;
  title: string;
  body: string;
  options: DecisionOption[];
}

/** Non-bill decisions: crises, appointments, management. */
const EVENTS: EventTemplate[] = [
  {
    id: 'storm', scopes: ['local', 'county', 'state'], executiveOnly: true, title: 'Severe storm hits {J}', body: 'Flooding and downed power lines. Residents want a fast response.',
    options: [
      { label: 'Declare emergency, spend reserves', detail: 'Visible leadership; drains the budget.', metrics: { budget: -1, infrastructure: 0.5 }, bloc: { wcol: 0.02, wnon: 0.02, black: 0.02, hisp: 0.02, asian: 0.02, senior: 0.03 }, rec: 0.05 },
      { label: 'Request outside aid, wait', detail: 'Saves money, but looks slow.', bloc: { wcol: -0.02, wnon: -0.03, black: -0.02, hisp: -0.02, senior: -0.03 } },
    ],
  },
  {
    id: 'pothole', scopes: ['local', 'county'], title: 'Residents furious about road conditions', body: 'A viral video of a car swallowed by a pothole is making the rounds.',
    options: [
      { label: 'Emergency paving blitz', detail: 'Costs money; residents notice.', metrics: { infrastructure: 1, budget: -0.5 }, bloc: { wnon: 0.02, senior: 0.02 } },
      { label: 'Blame the previous administration', detail: 'Cheap, mildly effective with partisans.', party: 2, bloc: { wcol: -0.01 } },
    ],
  },
  {
    id: 'developer', scopes: ['local', 'county', 'state'], title: 'Developer offers campaign help', body: 'A major developer seeking a zoning variance offers to host a fundraiser for you.',
    options: [
      { label: 'Accept the fundraiser', detail: 'Big money now. Risk of a pay-to-play story later.', cash: 0.15, scandalRisk: 0.12, groups: { chamber: 10 } },
      { label: 'Decline politely', detail: 'No money, clean hands.', groups: { chamber: -5 } },
      { label: 'Publicly refuse and call for ethics reform', detail: 'Wins reform-minded voters, angers business.', bloc: { wcol: 0.03, young: 0.02 }, groups: { chamber: -15 }, rec: 0.03 },
    ],
  },
  {
    id: 'scandal_staff', scopes: ['local', 'county', 'state', 'federal'], title: 'Staffer accused of misconduct', body: 'A reporter is asking about allegations against a senior member of your staff.',
    options: [
      { label: 'Fire them immediately', detail: 'Decisive; lose a capable aide.', bloc: { wcol: 0.01 }, metrics: { effectiveness: -0.5 } },
      { label: 'Launch an independent investigation', detail: 'Measured; the story lingers.', scandalRisk: 0.03 },
      { label: 'Stand by them', detail: 'Loyalty — but if the allegations hold up, it is on you.', scandalRisk: 0.15, party: 1 },
    ],
  },
  {
    id: 'party_ask', scopes: ['county', 'state', 'federal'], title: 'Party leadership asks for a favor', body: 'Leadership wants you to campaign for a vulnerable colleague whose positions you dislike.',
    options: [
      { label: 'Hit the trail for them', detail: 'Leadership remembers loyalty.', party: 8, bloc: { wcol: -0.005 } },
      { label: 'Stay out of it', detail: 'Independence costs you inside the caucus.', party: -6, bloc: { wcol: 0.01, wnon: 0.01 } },
    ],
  },
  {
    id: 'budget', scopes: ['local', 'county', 'state', 'federal'], executiveOnly: true, title: 'Annual budget for {J}', body: 'Revenue forecasts are in. How do you balance priorities?',
    options: [
      { label: 'Invest: schools and infrastructure', detail: 'Popular services; deficit grows.', metrics: { schools: 0.8, infrastructure: 0.8, budget: -1.2 }, pos: { spending: -0.05 }, groups: { teachers: 10, labor: 10, taxpayers: -10 } },
      { label: 'Hold the line', detail: 'Status quo budget.', metrics: { budget: 0.2 } },
      { label: 'Austerity: cut and rebuild reserves', detail: 'Fiscal hawks cheer; services suffer.', metrics: { budget: 1.5, schools: -0.5, infrastructure: -0.5 }, pos: { spending: 0.05 }, groups: { taxpayers: 15, teachers: -10 } },
    ],
  },
  {
    id: 'plant', scopes: ['local', 'county', 'state'], executiveOnly: true, title: 'Factory wants tax incentives to open in {J}', body: 'The company promises 800 jobs in exchange for a 10-year tax abatement.',
    options: [
      { label: 'Offer the incentives', detail: 'Jobs headline now; lost revenue later.', metrics: { jobs: 1, budget: -0.6 }, groups: { chamber: 15, labor: 10 }, rec: 0.04 },
      { label: 'Negotiate a smaller package', detail: 'They might walk.', metrics: { jobs: 0.4 } },
      { label: 'Refuse corporate welfare', detail: 'Principled, but the jobs go elsewhere.', groups: { taxpayers: 10, chamber: -10 }, metrics: { jobs: -0.2 } },
    ],
  },
  {
    id: 'protest', scopes: ['local', 'state', 'federal'], title: 'Protests over a police shooting', body: 'Demonstrators gather nightly. Both activists and police unions are watching your response.',
    options: [
      { label: 'Meet with protesters, call for review', detail: 'Wins trust with reform advocates.', pos: { crime: -0.04 }, bloc: { black: 0.04, young: 0.03, wnon: -0.02 }, groups: { police: -15 } },
      { label: 'Back the police, call for calm', detail: 'Reassures law-and-order voters.', pos: { crime: 0.04 }, bloc: { wnon: 0.03, senior: 0.02, black: -0.04, young: -0.02 }, groups: { police: 15 } },
      { label: 'Say as little as possible', detail: 'Nobody is happy.', bloc: { wcol: -0.01, black: -0.01 } },
    ],
  },
  {
    id: 'press', scopes: ['local', 'county', 'state', 'federal'], title: 'Local paper requests an in-depth interview', body: 'The editorial board wants an hour to discuss your record.',
    options: [
      { label: 'Sit down for the full hour', detail: 'Good exposure; your policy chops will be tested.', rec: 0.04 },
      { label: 'Send a written statement', detail: 'Safe and forgettable.' },
    ],
  },
  {
    id: 'appoint', scopes: ['state', 'federal'], executiveOnly: true, title: 'Key vacancy to fill', body: 'You must appoint a new agency head. Your party wants a loyalist; experts want a technocrat.',
    options: [
      { label: 'Appoint a party loyalist', detail: 'Keeps the base happy.', party: 6, metrics: { effectiveness: -0.3 } },
      { label: 'Appoint a respected technocrat', detail: 'Better results, grumbling in the party.', party: -3, metrics: { effectiveness: 0.6 } },
    ],
  },
];

let nextDecision = 1;

/** Generate this month's decisions for a player in office. */
export function generateDecisions(rng: Rng, type: OfficeType, executive: boolean, jurName: string, year: number, month: number, alreadyIds: string[]): Decision[] {
  const scope = scopeOf(type);
  const out: Decision[] = [];
  const legislatingMonth = month <= 6 || month >= 9;
  const nBills = legislatingMonth ? (rng.chance(executive ? 0.7 : 0.9) ? 1 : 0) + (rng.chance(0.35) ? 1 : 0) : rng.chance(0.3) ? 1 : 0;
  const nEvents = rng.chance(executive ? 0.6 : 0.35) ? 1 : 0;
  const deadline = { year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1 };
  const bills = BILLS.filter((b) => b.scopes.includes(scope) && !alreadyIds.includes(b.id));
  for (let i = 0; i < nBills && bills.length; i++) {
    const b = bills.splice(Math.floor(rng.next() * bills.length), 1)[0];
    const yesLabel = executive ? 'Sign it' : 'Vote yes';
    const noLabel = executive ? 'Veto it' : 'Vote no';
    const pos = { [b.issue]: 0.06 * b.dir };
    const neg = { [b.issue]: -0.03 * b.dir };
    const negGroups = Object.fromEntries(Object.entries(b.groups ?? {}).map(([k, v]) => [k, -v * 0.7]));
    out.push({
      id: `d${Date.now() % 100000}-${nextDecision++}`,
      templateId: b.id,
      title: b.title.replace('{J}', jurName),
      body: `${b.body}${executive ? ' The bill has reached your desk.' : ' The bill is up for a floor vote.'}`,
      options: [
        { label: yesLabel, detail: describeGroups(b.groups), pos, metrics: b.metrics, groups: b.groups },
        { label: noLabel, detail: describeGroups(negGroups), pos: neg, groups: negGroups },
        ...(executive ? [] : [{ label: 'Skip the vote', detail: 'Avoids taking a stand. Looks evasive.', bloc: { wcol: -0.005, wnon: -0.005 }, metrics: { effectiveness: -0.2 } } as DecisionOption]),
      ],
      deadline,
    });
  }
  const events = EVENTS.filter((e) => e.scopes.includes(scope) && (!e.executiveOnly || executive) && !alreadyIds.includes(e.id));
  if ((month === 2 && executive) || (nEvents && events.length)) {
    const e = month === 2 && executive ? EVENTS.find((x) => x.id === 'budget')! : events[Math.floor(rng.next() * events.length)];
    out.push({ id: `d${Date.now() % 100000}-${nextDecision++}`, templateId: e.id, title: e.title.replace('{J}', jurName), body: e.body, options: e.options, deadline });
  }
  return out;
}

function describeGroups(g?: Record<string, number>) {
  if (!g) return '';
  const pos = Object.entries(g).filter(([, v]) => v > 0).map(([k]) => k);
  const neg = Object.entries(g).filter(([, v]) => v < 0).map(([k]) => k);
  return [pos.length ? `Pleases: ${pos.join(', ')}` : '', neg.length ? `Angers: ${neg.join(', ')}` : ''].filter(Boolean).join(' · ');
}

export function billIssue(templateId: string): { issue: string; dir: number } | null {
  const b = BILLS.find((x) => x.id === templateId);
  return b ? { issue: b.issue, dir: b.dir } : null;
}

/** Baseline values for jurisdiction metrics (0-100 indices except budget which is surplus % of budget). */
export const METRIC_INFO: Record<string, { label: string; base: number; good: 'up' | 'down' }> = {
  budget: { label: 'Budget balance', base: 0, good: 'up' },
  jobs: { label: 'Job growth index', base: 50, good: 'up' },
  crime: { label: 'Crime index', base: 50, good: 'down' },
  schools: { label: 'School quality', base: 50, good: 'up' },
  infrastructure: { label: 'Infrastructure', base: 50, good: 'up' },
  housing: { label: 'Housing supply', base: 50, good: 'up' },
  health: { label: 'Health coverage', base: 50, good: 'up' },
  cost: { label: 'Cost of living', base: 50, good: 'down' },
  effectiveness: { label: 'Effectiveness', base: 50, good: 'up' },
};
