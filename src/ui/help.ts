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

  // Incumbents and primaries (M14)
  'The field': "Everyone on the ballot in your current stage; in partisan races, the other party picks its nominee in its own primary. Incumbents start with an edge, but it wears down: a narrow last win, a scandal, three or more terms, or (for Congress and statewide offices) a midterm in the President's party. A challenged incumbent is judged on their record, so their favorability follows the national mood. Dig up dirt with opposition research, then run against their record. Before a crowded primary, ask for the party's backing to thin the field. As an incumbent, you draw a serious primary challenger if your party standing falls below 35 or your positions drift far from your party's base (or a rival announces one). Sitting officeholders of your party whose turf overlaps the race can endorse you, once each per race: odds rise with favors, standing and recognition and fall with the distance between your positions, and a governor or senator counts for more than a council member. Rivals never endorse you.",

  // Scandals (M15)
  'Scandal watch': "Stories about you and your opponents. Answer each new story the month it breaks: apologizing takes a smaller hit and ends it; denying costs nothing now but backfires if the story is true; attacking the press rallies your party and sours swing voters; lawyering up costs money and slows things down. Only true, serious stories escalate, to an investigation (a monthly drain) and then charges, when the party wants you to resign. Integrity lowers your risk, and risky decisions in office raise it. Opponents answer stories you dig up too: honest ones apologize, others deny or fight, and that decides how much damage it does.",

  // Congress (M18)
  Filibuster: 'In the U.S. Senate, a bill needs 60 votes to end debate, not just a majority. Committees, the House and state legislatures pass bills by simple majority. A Senate Majority Leader whose majority-backed bill dies to a filibuster can use the nuclear option (once a term) to abolish it for good, at a cost with the party and swing voters.',
  Reconciliation: 'Once a year, the Senate majority can pass one tax or spending bill by simple majority, getting around the filibuster. Leaders and the Finance chair can call for it freely; other members spend favors to get leadership to use it on their bill.',
  Cosponsor: 'A member of the other party who signs on to your bill. They vote yes, and colleagues of theirs who were close to yes are a little more open to it. Costs favors when someone agrees.',

  // Ballot measures (M19)
  'Ballot measures': "Yes-or-no votes on a single policy, decided in November of even years. About two dozen states let citizens put measures on the ballot (they qualify at the end of June), big towns vote on levies, bonds and charter changes, and governors and state legislators can ask the legislature to refer one. Voters judge a measure on its issue, not on party, so a policy can pass in a state that votes the other way for President. Campaigning for or against one moves the vote more the better known you are there, builds recognition and wins over the groups on your side, but it is a public stand on the issue. A measure that passes shifts the economy like a law, and if you are the governor (or mayor) it becomes one of the laws you carry out.",

  // Legacy (M17)
  Legacy: 'How history will remember your career. Years in office and election wins count most, and much more the higher the office; flipping a seat, beating an incumbent and winning a primary from behind add more. Laws, leadership posts and good approval in office help. Scandals (worse once investigators or prosecutors get involved), resignations and lost races count against you.',
  Achievements: 'Milestones in your career, each earned once. They also add a little to your legacy.',
  Score: 'Your legacy score, and the rank it earns.',

  // Rivals & redistricting (M11)
  Rivals: 'Politicians climbing the ladder alongside you: up-and-comers from both parties in your town and state, anyone who has beaten you, and some opponents who want a rematch. They run for open seats, can jump into your races, and make the news. From January to May they announce runs for that November: an open seat, a shot at an incumbent (sometimes in their own party’s primary), or your seat or race. An announced rival always files. Click one for their career and plans.',
  Redistricting: 'After the 2030 and 2040 censuses, House seats are reapportioned and every state redraws its maps the next year. Whoever holds the pen decides the map: commissions draw fair lines (a deadlocked one hands the job to a court, which draws its own), one-party governments draw gerrymanders (aggressive with a big majority, milder with a thin one). Gerrymanders can be sued and struck down, and a new trifecta can redraw a congressional map mid-decade. Expected seats come from each district’s lean.',

  // Campaign
  Poll: 'Your share in the latest poll (undecided excluded from the field). Polls have random error; see the margin of error.',
  'Known by': 'Name recognition: share of voters in this race who know who you are. Being known helps only if they like you.',
  Raised: 'Total raised for this race.',
  Spent: 'Total spent on campaign actions in this race. Spending matters relative to what races like this usually cost; extra money has diminishing returns.',
  Known: 'Name recognition among voters in this race.',
  Polling: 'Monthly internal polls of this race (lines), and in bigger races a public media poll every other month (diamonds), each from a pollster with its own slight lean. Every poll has sampling error (±MoE). Hiring a campaign manager means bigger, more accurate internal polls and unlocks crosstabs. When an opponent hits you on an issue, voters in this race weigh it more.',
  Crosstabs: "Your latest internal poll by voter group, among voters who have decided. Groups are small slices of the sample, so their margins of error are much bigger than the topline. Use them to see where to campaign and whom a get-out-the-vote drive would turn out.",
  'Debate prep': "The month before a debate, you get the three questions. A policy answer is strong when your position is close to this audience and costly when it isn't. A pivot steers to your best issue: safe but modest. An attack pays off when your opponent is out of step on the issue (more if your opposition research found something), but some negativity sticks to you, and attacking a fellow partisan in a primary costs party standing. Debate skill, prep and a policy director still count. Skip it and the debate comes down to skills and luck.",
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
