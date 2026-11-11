/**
 * Hover/tap help for every stat label in the UI. Keys match the visible label exactly;
 * Stat, Meter, Card and the top bar look labels up here automatically.
 */
export const HELP: Record<string, string> = {
  // Top bar
  Date: 'One turn is one month. Primaries fall on real state dates; general elections are the first Tuesday of November.',
  Status: 'Your next election, or the office you hold. Election nights happen at the end of the month shown.',
  Cash: "Campaign war chest. Raise it with fundraising actions; spend it on ads, rallies and canvassing. Staff payroll comes out monthly. Unspent money doesn't win votes.",
  Actions: 'Action points (AP) left this month. They refill each month. A campaign manager and the Organization skill give you more.',
  Energy: 'Every action costs energy. Below 25, actions lose effect; below 20 at month start, you only get half your AP. Rest to recover. You also regain 25 each month.',
  Favorable: 'Share of people who know you and view you favorably. Events, ads and good interviews raise it; attack ads, gaffes and scandals lower it.',
  Approval: 'Job approval in your jurisdiction, weighted across voter groups. It is driven by your decisions, results in office and party fit, and it becomes your favorability when you run again.',

  // Campaign
  Poll: 'Your share in the latest poll (undecided excluded from the field). Polls have random error; see the margin of error.',
  'Known by': 'Name recognition: share of voters in this race who know who you are. Being known helps only if they like you.',
  Raised: 'Total raised for this race.',
  Spent: 'Total spent on campaign actions in this race. Spending matters relative to what races like this usually cost; extra money has diminishing returns.',
  Known: 'Name recognition among voters in this race.',
  'The field': 'Everyone on the ballot in your current stage. In partisan races, the other party picks its nominee in its own primary.',
  Polling: 'Monthly polls of this race. Each has sampling error (±MoE). Hiring a campaign manager means bigger, more accurate polls.',
  Debates: 'Debates happen the month before each election in races for mayor, county commission and up. Debate skill, prep and a policy director help.',

  // Office
  'Party standing': "How party leaders see you (0–100). It affects your endorsement odds. Voting against the party line and losing races lower it; party events and wins raise it.",
  'Next election': 'When your seat is next on the ballot. You are filed for re-election automatically in January of that year.',
  'Approval by voter group': 'How each demographic group rates you. It moves with your decisions and how well your positions fit what they want.',
  'Your record': 'Decisions you have made in office. Opponents can use them, and they shift your positions.',
  Favors: 'Political capital inside your chamber. You earn one a month (more with a leadership post) and a little for voting with your party. Spend them to whip votes or lean on a committee chair. When you run out, whipping costs party standing instead.',
  Leadership: "Your chamber's leaders. The majority party holds the gavel and every committee chair. Leaders and chairs can fast-track their own bills, and Speakers and chairs can kill bills before a vote.",
  Committees: 'Bills go to the committee for their issue. The chair decides whether a bill gets a hearing at all; then the committee votes. You sit on up to two committees, and can chair one if your party has the majority.',
  'Laws in effect': 'Laws you sponsored or signed keep pushing your jurisdiction’s numbers for as long as you hold this office.',
  Openings: 'Seats emptied mid-term in your area.',

  // Career / profile
  Age: 'Your age. Some offices have minimum ages (25 for the U.S. House, 30 for the Senate, 35 for President).',
  Ideology: 'Average of your issue positions, from progressive to conservative.',
  Savings: 'Personal money, separate from campaign cash. Your salary and day job add to it. Self-fund to move it into the campaign.',
  'Name recognition': 'How well known you are in each area. Events build it locally, and it spills over into the larger areas around a town. It fades slowly if you stop campaigning.',
  'Home town': 'Name recognition in your home town.',
  'Home county': 'Name recognition in your home county.',
  'Home state': 'Name recognition statewide.',
  Nationally: 'Name recognition across the country.',
  Skills: 'Set at creation. They scale the effect of related actions.',
  'Staff & relationships': 'Staff multiply your actions but cost money every month. Interest-group relationships affect PAC money and endorsements.',

  // National
  'Pres. approval': "The President's approval rating. It drives the national environment that lifts or sinks the President's party in federal races.",
  'Generic ballot': 'National congressional preference (D minus R, points). It shifts all partisan races, most strongly at the federal level.',
  'Right track': 'Share of Americans who think the country is on the right track.',
  Unemployment: 'National unemployment rate.',
  Inflation: 'Year-over-year inflation.',
  'GDP growth': 'Annualized real GDP growth.',
  'What voters care about': 'National issue salience. Issues voters care about more weigh more in every race. Policy speeches raise an issue in your own race.',

  // Inspector
  Population: 'Residents (Census ACS 2019–2023).',
  Lean: 'Partisan lean from recent presidential results (D+ or R+ margin of the two-party vote). Sub-county areas are modeled from demographics.',
  Density: 'People per square mile.',
};
