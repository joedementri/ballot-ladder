/** Player actions, interest groups, staff and AI campaign behaviour. */
import type { Background, Skills, Staff } from './model';
import { ISSUES } from './issues';

export type TargetKind = 'unit' | 'issue' | 'group' | 'opponent' | 'staff' | 'amount' | 'none';

export interface ActionDef {
  id: string;
  label: string;
  desc: string;
  category: 'Money' | 'Outreach' | 'Media' | 'Policy' | 'Organization' | 'Personal';
  ap: number;
  /** Cash cost as a fraction of the office's expected campaign spend (or flat dollars if `flat`). */
  cost?: number;
  flat?: number;
  target: TargetKind;
  needsCampaign?: boolean;
  needsOffice?: boolean;
}

export const ACTIONS: ActionDef[] = [
  { id: 'fund_small', label: 'Small-dollar fundraising', desc: 'Email, texts and house parties. Modest money, builds grassroots goodwill.', category: 'Money', ap: 2, target: 'none' },
  { id: 'fund_big', label: 'Major donor dinner', desc: 'High-dollar event with business leaders. Big money, but voters notice who you owe.', category: 'Money', ap: 3, target: 'none' },
  { id: 'fund_pac', label: 'Court an interest group PAC', desc: 'PAC money depends on how aligned you are with the group.', category: 'Money', ap: 2, target: 'group' },
  { id: 'self_fund', label: 'Self-fund', desc: 'Move personal savings into the campaign account.', category: 'Money', ap: 0, target: 'amount' },
  { id: 'town_hall', label: 'Town hall', desc: 'Take questions from voters. Builds recognition and favorability in that area.', category: 'Outreach', ap: 2, target: 'unit' },
  { id: 'canvass', label: 'Door-to-door canvass', desc: 'Most effective in small races. Raises recognition and turnout locally.', category: 'Outreach', ap: 3, flat: 300, target: 'unit' },
  { id: 'rally', label: 'Hold a rally', desc: 'Fires up the base and earns press coverage.', category: 'Outreach', ap: 2, cost: 0.01, target: 'unit', needsCampaign: true },
  { id: 'community', label: 'Community service', desc: 'Volunteer, attend church suppers and Little League games. Slow but steady goodwill.', category: 'Outreach', ap: 2, target: 'unit' },
  { id: 'ads_tv', label: 'TV ad buy', desc: 'Broad reach across the whole race. Expensive.', category: 'Media', ap: 1, cost: 0.12, target: 'none', needsCampaign: true },
  { id: 'ads_digital', label: 'Digital ad campaign', desc: 'Cheaper, targeted reach; stronger with younger voters.', category: 'Media', ap: 1, cost: 0.05, target: 'none', needsCampaign: true },
  { id: 'attack_ad', label: 'Attack ad', desc: 'Drag down an opponent. Some voters punish negativity.', category: 'Media', ap: 1, cost: 0.08, target: 'opponent', needsCampaign: true },
  { id: 'record', label: 'Run against the record', desc: "Make the incumbent's record the issue. Needs successful opposition research on them; hits harder the further they sit from the district.", category: 'Media', ap: 2, cost: 0.06, target: 'opponent', needsCampaign: true },
  { id: 'interview', label: 'Media interview', desc: 'Free coverage. Risk of a gaffe depends on your debate skill.', category: 'Media', ap: 1, target: 'none' },
  { id: 'speech', label: 'Policy speech', desc: 'Make an issue central to your message (raises its salience for voters).', category: 'Policy', ap: 2, target: 'issue' },
  { id: 'moderate', label: 'Shift toward center', desc: 'Soften a position. Helps in general elections, hurts in primaries and with your base.', category: 'Policy', ap: 2, target: 'issue' },
  { id: 'harden', label: 'Double down', desc: 'Take a harder line on an issue. Thrills the base, alienates swing voters.', category: 'Policy', ap: 2, target: 'issue' },
  { id: 'endorse', label: 'Seek endorsement', desc: 'Ask a group for its endorsement. Odds depend on alignment and standing.', category: 'Organization', ap: 2, target: 'group' },
  { id: 'party_event', label: 'Work the party circuit', desc: 'Show up at party dinners and help other candidates. Raises party standing.', category: 'Organization', ap: 2, target: 'none' },
  { id: 'hire', label: 'Hire / upgrade staff', desc: 'Better staff multiply everything. Paid monthly from campaign funds.', category: 'Organization', ap: 1, target: 'staff' },
  { id: 'party_backing', label: "Seek the party's backing", desc: 'Ask party leaders to clear your primary field. Once per race, before the primary month. Odds rise with party standing and how well known you are; a snub costs standing.', category: 'Organization', ap: 2, target: 'none', needsCampaign: true },
  { id: 'gotv', label: 'Get out the vote', desc: 'Final month only. Phone banks, door knocks and rides to the polls turn out the voter groups that favor you. Stronger with a field director; repeats this month have less effect.', category: 'Organization', ap: 3, cost: 0.05, target: 'none', needsCampaign: true },
  { id: 'oppo', label: 'Opposition research', desc: 'Dig for dirt on an opponent.', category: 'Organization', ap: 2, cost: 0.03, target: 'opponent', needsCampaign: true },
  { id: 'debate_prep', label: 'Debate prep', desc: 'Mock debates with staff before the next debate.', category: 'Personal', ap: 2, target: 'none', needsCampaign: true },
  { id: 'rest', label: 'Rest & recharge', desc: 'Restore energy. Burnout leads to mistakes.', category: 'Personal', ap: 1, target: 'none' },
];

export const GROUPS = [
  { key: 'chamber', label: 'Chamber of Commerce', pos: { taxes: 0.6, spending: 0.4, labor: 0.7, trade: -0.4 } },
  { key: 'labor', label: 'Building Trades & Labor Council', pos: { labor: -0.8, trade: 0.4, spending: -0.3 } },
  { key: 'teachers', label: 'Teachers Association', pos: { education: -0.9, spending: -0.5, labor: -0.5 } },
  { key: 'police', label: 'Fraternal Order of Police', pos: { crime: 0.8, guns: 0.3 } },
  { key: 'guns', label: 'Gun Owners Alliance', pos: { guns: 0.95 } },
  { key: 'safety', label: 'Moms for Gun Safety', pos: { guns: -0.9 } },
  { key: 'life', label: 'Right to Life Coalition', pos: { abortion: 0.95 } },
  { key: 'choice', label: 'Reproductive Freedom PAC', pos: { abortion: -0.95 } },
  { key: 'green', label: 'Conservation Voters', pos: { energy: -0.9 } },
  { key: 'energy', label: 'Energy Producers Association', pos: { energy: 0.85, taxes: 0.3 } },
  { key: 'farm', label: 'Farm Bureau', pos: { trade: -0.2, energy: 0.3, taxes: 0.4 } },
  { key: 'seniors', label: 'Retired Persons Council', pos: { health: -0.4, spending: -0.3 } },
  { key: 'border', label: 'Secure Borders Coalition', pos: { immigration: 0.9 } },
  { key: 'immigrant', label: 'Immigrant Rights Network', pos: { immigration: -0.9 } },
  { key: 'taxpayers', label: 'Taxpayers Union', pos: { taxes: 0.9, spending: 0.9 } },
  { key: 'housing', label: 'Housing Now YIMBY', pos: { housing: -0.8 } },
] as const;
export type GroupKey = (typeof GROUPS)[number]['key'];

/** Alignment of a position vector with a group (−1..1). */
export function groupAlignment(pos: number[], group: (typeof GROUPS)[number]): number {
  let s = 0, n = 0;
  for (const [k, v] of Object.entries(group.pos)) {
    const i = ISSUES.findIndex((x) => x.key === k);
    s += 1 - Math.abs(pos[i] - (v as number));
    n++;
  }
  return n ? s / n - 0.5 : 0;
}

export const STAFF_ROLES: { key: keyof Staff; label: string; desc: string }[] = [
  { key: 'manager', label: 'Campaign manager', desc: '+Action points each month, better AI-proof planning' },
  { key: 'comms', label: 'Communications director', desc: 'Stronger ads and interviews, fewer gaffes' },
  { key: 'finance', label: 'Finance director', desc: 'Bigger fundraising hauls' },
  { key: 'field', label: 'Field director', desc: 'More effective canvassing and turnout' },
  { key: 'policy', label: 'Policy director', desc: 'Better governing previews and debate performance' },
];
export const STAFF_TIER = ['None', 'Volunteer', 'Professional', 'Elite'];
/** Monthly cost of a staff tier, scaled by office level. */
export const staffCost = (tier: number, level: number) => [0, 250, 2500, 9000][tier] * [1, 1, 1.5, 3, 5, 10, 18, 50][level];

export const BACKGROUNDS: Record<Background, { label: string; desc: string; skills: Partial<Skills>; cash: number; groups: Partial<Record<GroupKey, number>> }> = {
  lawyer: { label: 'Attorney', desc: 'Sharp debater with deep-pocketed colleagues.', skills: { debate: 15, fundraising: 8 }, cash: 60000, groups: { chamber: 10 } },
  teacher: { label: 'Teacher', desc: 'Trusted in the community and backed by educators.', skills: { charisma: 8, policy: 8, integrity: 8 }, cash: 15000, groups: { teachers: 35 } },
  business: { label: 'Small business owner', desc: 'Knows payroll and donors; seen as practical.', skills: { fundraising: 15, organization: 6 }, cash: 120000, groups: { chamber: 30, taxpayers: 10 } },
  veteran: { label: 'Military veteran', desc: 'Disciplined and respected across the aisle.', skills: { integrity: 12, organization: 10, charisma: 4 }, cash: 30000, groups: { police: 10, guns: 10 } },
  doctor: { label: 'Physician', desc: 'Credible on healthcare with a comfortable nest egg.', skills: { policy: 14, integrity: 6 }, cash: 150000, groups: { seniors: 15 } },
  activist: { label: 'Community organizer', desc: 'A grassroots network and a knack for turnout.', skills: { organization: 14, charisma: 8 }, cash: 8000, groups: { housing: 15, immigrant: 15 } },
  farmer: { label: 'Farmer / rancher', desc: 'Rooted in rural America.', skills: { integrity: 10, charisma: 6 }, cash: 80000, groups: { farm: 35 } },
  union: { label: 'Union electrician', desc: 'Working-class credibility and a union hall behind you.', skills: { organization: 10, charisma: 6 }, cash: 20000, groups: { labor: 40 } },
  pastor: { label: 'Pastor', desc: 'A congregation that turns out and a moral voice.', skills: { charisma: 14, integrity: 8 }, cash: 12000, groups: { life: 25 } },
  police: { label: 'Police officer', desc: 'Public-safety credentials.', skills: { integrity: 6, organization: 8 }, cash: 25000, groups: { police: 40 } },
};

/** Base action points per month. */
export const apMaxFor = (staff: Staff, skills: Skills) => 8 + staff.manager * 2 + Math.round(skills.organization / 25);
