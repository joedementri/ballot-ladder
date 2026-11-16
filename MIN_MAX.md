# Ballot Ladder: Washington Township (NJ) to President, min-maxed

## Context
You asked for the fastest way to hold all 8 titles (Council, Mayor, State Rep, State Senator, Governor, U.S. House, U.S. Senate, President) starting in Washington Township, Gloucester County, NJ, on **Normal** difficulty. It uses everything the code allows, including bugs and exploits. This is a strategy guide. No code changes.

**Bottom line:** the fastest guaranteed route ends with your **election as President in Nov 2036** (sworn in Jan 2037). The New Jersey calendar is the limit, not the votes: every race in this guide becomes an 85–93% landslide.

---

## 1. Your seat and the calendar (from the data and `src/sim/offices.ts`)
- Town `M3401577180`: population 49,756, lean 0.529 D. The game calls the seats **"Township Board, Seat N"** (7 seats) and **"Township Supervisor of Washington"** (the mayor). Districts: Assembly `sldl:34004` (0.528 D), State Senate `sldu:34004` (0.528 D), U.S. House **NJ-1** (0.605 D, D-held), NJ statewide 0.567 D. Both U.S. senators are D.
- When each office is on the ballot (`isUp`, offices.ts:313-369):
  | Office | Years | Filing deadline |
  |---|---|---|
  | Council | odd years (even seats in 2025/2029, odd seats in 2027/2031) | August, nonpartisan |
  | Mayor | **2025, 2029, 2033 only** | August, nonpartisan |
  | Assembly (State Rep) | every odd year | March (June primary) |
  | State Senate | **2027, 2031 only** | March |
  | Governor | 2025, 2029, 2033 (age 30+) | March |
  | U.S. House | every even year | March |
  | U.S. Senate | 2026 & 2032 (class 2), 2030 (class 1) | March |
  | President | 2028, 2032, 2036 (age 35+) | January |
- You can only run one campaign at a time, so you get one November per year. Five offices are odd-year only (Council, Mayor, Assembly, State Senate, Governor), and they need five odd years: 2025, 2027, 2029, 2031, 2033. That pushes the presidency to 2036. **The one way to reach 2032** is to pick up a rung outside the calendar before Nov 2031 (§6).

## 2. The exploits, ranked by impact
1. **Interview spam.** `interview` (actions.ts:191-203) costs 1 AP and no money. It has no repeat penalty (it isn't in `fatigue`, actions.ts:25-31). Each one adds **+0.03 × (1−rec)** recognition across your current race's whole district (your office if you aren't running, your home town if you're neither) and +0.004 favorability. The gaffe chance is `0.14 − debate/1000 − comms×0.025`, which is **0** with debate 99 and a Professional comms director.
2. **Valence math** (vote.ts:91-99). Recognition and favorability are worth up to about +2 on the vote-model's logit scale. Simulated with the real vote model: a 0.4-recognition candidate is a coin flip, while **recognition 0.99, favorability 1.0 and 8 endorsements wins about 91% of a general election and 93% of a primary.** Out of office, favorability drifts only 3% a month toward its target (upkeep.ts:56), so interviews pin it near **1.0**. In office it chases your approval (25% a month), so interviews keep it at about approval + 0.2.
3. **"Presidential piggy bank."** Fundraising scales with the expected spending of the race you're running in (actions.ts:95, 121-136). File for **President** as a private citizen in Jan 2025 and each PAC ask returns about **$30–90M**, because the base is $1B. Then **withdraw** (game.ts:430). Withdrawing costs only 0.02 favorability, and you keep the cash. You can repeat this in any month you aren't in a real race.
4. **Permanent, global group endorsements.** `P.endorsements` never resets. It is added to every race's endorsement count (game.ts:461) and capped at 8 in the vote model (+0.48). Retries are unlimited and free (actions.ts:227-239). Collect 8 once and you're set for your whole career. **After that, officeholder endorsements and party backing add nothing to this term**, so stop asking for them.
5. **Free party standing.** `party_event` (2 AP) gives +4 + charisma/40, with no cap and no repeat penalty. Standing raises your odds on endorsements, party backing and appointments, and keeping it at 35 or above blocks primary challenges (careers.ts:403).
6. **Guaranteed debate wins.** Four `debate_prep` actions (8 AP) add +1.0 to your debate score (debates.ts:177). Opponents score about 0.7–0.9, so you always win: +0.12 for you and −0.03 for everyone else.
7. **Stacking opposition research.** Each hit adds 0.12–0.48 scandal to an opponent (scandals.ts:406-436), and scandal costs −1.8 per point in the vote model. It lands about 38% of the time, costs 0.03 × the race's expected spending, and stacks up to 1.0. Opponents' scandals fade 12% a month, so **spam it in the month of the vote.** A hit also unlocks "Run against the record" on incumbents.
8. **Save-scumming.** The game autosaves **only** on End Turn, Skip, election-night acknowledge and Retire (store/game.ts:228-245). Every roll uses the saved main random stream, and so does the election result (races.ts:167).
   - **To reroll a bad action** (failed endorsement, failed oppo, gaffe): refresh the page, Continue, and do one extra Interview first. That shifts the random stream, then retry.
   - **To reroll an election:** in the election month, **Export save** just before End Turn. If you lose, Import it, add one Interview to shift the stream, then End Turn again.
9. **Re-filing resets the field.** A race's opponents are seeded from the office and year (races.ts:23). Withdrawing and re-filing brings back the same opponents with their **starting recognition**, a fresh party-backing attempt and a fresh endorsement ask list. Use it to scout whether an incumbent runs, then withdraw if you don't like what you see.
10. **TV ads beat interviews once you're rich.** With an Elite comms director, a TV ad (actions.ts:167-181, 1 AP) gives +0.079 recognition and +0.007 favorability, **and** counts the full 0.12 × expected spending toward your money score. In statewide and national races it also raises every county's or state's recognition by +0.0875. The repeat penalty is 0.75× per extra ad in a month, so run 3–5 ads a month and fill the rest with interviews.
11. **Not used:** `fund_big` has a 4% scandal chance and you won't need it. Skip Ahead wastes action points, so never use it.

## 3. Character creation (exact settings)
- **Start:** January 2025 · **Difficulty:** Normal · **Party:** Democrat · **Age: 32** (you must be 35 in 2028 to file the presidential piggy-bank campaign) · **Home:** NJ → Washington township (Gloucester).
- **Background: Attorney (lawyer).** +15 debate, +8 fundraising, $60k savings.
- **Skills** (pool 60, each slider 20–90; lowering one below 40 frees points):

  | Skill | Slider | After background bonus |
  |---|---|---|
  | Charisma | 90 | 90 |
  | Debate | 84 | 99 (the cap) |
  | Integrity | 66 | 66 |
  | Organization | 20 | 20 |
  | Fundraising | 20 | 28 |
  | Policy | 20 | 20 |

  Charisma 90 + debate 99 gives the maximum skill bonus (about +0.18 in every race). Integrity cuts scandal risk (scandals.ts:283). Organization is better bought: an Elite manager adds +6 AP. Fundraising doesn't affect PAC money. Policy barely matters once you prep for debates.
- **Platform: 0.6 × party line.** Simulated against the real model, this is the best balance between primaries and general elections. Set these values by hand: taxes −0.33, spending −0.30, health −0.36, immigration −0.27, guns −0.36, abortion −0.42, energy −0.36, crime −0.21, education −0.30, trade −0.06, housing −0.18, labor −0.33. Your drift from the party line stays at 0.19, under the 0.35 that triggers a primary challenge.

## 4. The monthly routine (every month, never skip)
- Spend **all** action points. Energy: each action costs 3 per AP, you regain 25 a month, and Rest (1 AP) restores 30. **One Rest a month** covers about 18 AP of other actions. End each month with energy at 20 or more, or next month's AP is halved (upkeep.ts:40-41).
- **Staff** (`hire`, 1 AP per tier; monthly cost = tier cost × office multiplier, campaign.ts:90): Elite **manager** (+6 AP), Elite **comms** (ads ×1.75, no gaffes), Elite **field** (GOTV ×2.2), Professional **policy** (debate hints). Skip finance. The piggy bank pays for all of it.
- **In office:** answer every decision. A lapsed decision costs −2 effectiveness and −0.005 approval. Pick options with positive voter-group effects and no scandal risk.
  - **As an executive** (Mayor, Governor), set the budget by March: **Tax 1.2, Schools 1.3, Public safety 0.7, Infrastructure 1.3, Health 1.3**. Under budget.ts:31-44 this is the approval-maximizing corner, about +7.5 approval points.
  - **As a legislator,** introduce bills on issues where you match the district to raise effectiveness. It feeds approval and the recognition you hold passively.
- **Group endorsements:** keep 8 (seniors, labor, teachers, farm, gun safety, choice, conservation, housing or immigrant). With your platform and standing 100, the odds run about 99% / 64% / 63% / 40% / ~37% / ~27%. Do PAC asks to those groups first (+5 relationship each) to raise the odds.

## 5. Race playbook (every race)
1. **File late enough to limit opponents' growth.** Opponents in your race gain recognition every month (races.ts:230; doubled for Council and Mayor). Local races: file in **August**. Partisan races: file in **December of the year before**, right after your November win. Use the months before filing to farm recognition (interviews, or a Canvass on your home town for local races).
2. Every month: 3–5 TV ads, then interviews with the rest. Once your recognition is above about 0.95, add town halls or community service for favorability.
3. **Before the primary** (if the seat is open): "Seek the party's backing" (up to 90% odds, incumbency.ts:139-190). With odds of 50% or more it clears the whole field half the time, and an unopposed primary is an automatic win. If an incumbent of your party is running, backing is blocked. Instead, land oppo on them early, then "Run against the record" 1–2 times.
4. **The month before each vote** (the debate month): 4× Debate prep, then answer the questions using the policy director's "strong" hints.
5. **The month of the vote:** oppo research 3–6 times on the strongest opponent, GOTV ×2 (generals only, trail.ts:111-155), 1–2 attack ads in big-money races, interviews and ads with the rest. **Export save → End Turn.** Reload and reroll if needed.

## 6. Timeline (President in 2036)
| When | Race / move | Notes |
|---|---|---|
| **Jan–Feb 2025** | **File for President 2028** (piggy bank) | PAC asks (seniors, labor, teachers) and small-dollar fundraising. A 0.8× repeat penalty applies across all fundraising in a month, so do about 5 a month. Target **$300M+**. Hire the Elite manager and comms after the first haul. Do Party events. |
| Mar 2025 | **Withdraw** | Party events until standing reaches 100, then endorsement asks until you have 8. Interviews now hit your home town, which is the Council race's district. |
| Aug → **Nov 2025** | **Council (Township Board)** | Nonpartisan, no debate. Run ads and canvass; GOTV and oppo in November. Your favorability is about 1.0 here, so expect about 90%. |
| 2026 | Serve on Council | Answer decisions and interview. Optionally file early for the Assembly, farm district recognition, then withdraw (§2.9). |
| Dec 2026 → **Nov 2027** | **Assembly LD4** | June primary. The D incumbent's recognition is only about 0.22, so it's easy. |
| 2028 | Serve in the Assembly | In **Jan 2029** the game auto-files your re-election. **Withdraw it.** |
| Jan 2029 | Scout | File for **Governor 2029**, check whether the incumbent is running, then withdraw. **If the seat is open, swap:** Governor 2029 and Mayor 2033. |
| Aug → **Nov 2029** | **Mayor (Township Supervisor)** | Canvass the town Jan–Jul to rebuild town recognition (a canvass with an Elite field director is about +0.10). |
| Dec 2029 | Scout the U.S. Senate (class 1, 2030) | If the seat is open, take **U.S. Senate 2030** and move the House to 2032. Otherwise file for the **House**. |
| **Nov 2030** | **U.S. House NJ-1** | D incumbent's recognition about 0.45. Oppo in June. |
| Dec 2030 → **Nov 2031** | **State Senate LD4** | Incumbent's recognition about 0.28. |
| Dec 2031 | Piggy bank again | File for President 2032, raise money, withdraw, then file for the **U.S. Senate (class 2)**. |
| **Nov 2032** | **U.S. Senate** | Hardest race so far: the D incumbent has about 0.75 recognition. TV ads raise every county's recognition, which gets past the 0.85× limit on county recognition that interviews hit (races.ts:126-131). Spam oppo in June. Modeled margin is about +1.1 on the logit scale. |
| **Nov 2033** | **Governor** (or Mayor if you swapped) | Same statewide playbook. |
| 2034–35 | Governor | **File for President 2036** to farm national recognition. Nationwide TV ads push every state's recognition up. Then withdraw so opponents' recognition resets. |
| Dec 2035 → **Nov 2036** | **President** | Contests run January to June; you need a majority of delegates, and Democrats split them proportionally above 15% (primaries.ts:45-66). Pick a **swing-state moderate** running mate. In November: 4× debate prep in October, then GOTV, oppo and attack ads. Export your save before the vote. |

**Shortcut to President 2032:** check Run → Opportunities every month. Any of these before Nov 2031 frees an odd-year slot:
- a Council vacancy in 2025, while you hold no office;
- an Assembly or State Senate vacancy in LD4;
- an NJ-1 special election;
- a Senate vacancy that a D governor fills.

Appointment odds reach up to **85%** with standing 100, high recognition and favors (vacancies.ts:292-300). If you get one, re-plan so the remaining odd-year offices fit 2025–2031 and run for President in 2032.

## 7. Risk control
- **Scandals:** choose **Apologize**. The truth chance is about 44% at integrity 66, and a denial that falls apart makes it much worse. Skip decision options that carry scandal risk.
- **Primary challenges:** keep standing at 35 or above (Party events) and ideology drift at 0.35 or below.
- **National environment** (federal races): you can't control it, so a bigger margin and save-scumming are your insurance.

## 8. Nuclear option (save editing)
Import accepts plain JSON, and the only checks are that `version`, `player` and `politicians` exist (saves.ts `decodeSave`, migrate.ts:58). Export, gunzip and edit:
- `player.cash`
- `player.partyStanding: 100`
- `player.endorsements` (list of 8 group keys)
- `player.staff` (all tiers set to 3)
- `player.rec` (0.99 for `"M3401577180"`, `"sldl:34004"`, `"sldu:34004"`, `"cd:3401"`, `"NJ"`, `"US"`, each NJ county code and each state code)
- the player's `fav: 1` and skills `99` under `politicians.<player.id>`

Then Import. This skips the game rather than playing it, so use it only if a run goes wrong.

## Verification
- The vote-model numbers above came from a scratch script that runs the real `unitShares` in `src/sim/vote.ts` for the Washington Township, LD4, NJ-1, NJ and US units: `C:\Users\JDEMEN~1\AppData\Local\Temp\claude\020373cc9f19d595\92a0fe25-bbfd-4c9f-985d-d96bf7d6ef0f\scratchpad\calc.ts` (run it with `npx tsx`).
- In game, check each step on the Campaign tab: the recognition and favorability readouts, the polls, and the action cards' odds notes (backing, oppo, GOTV, endorsers).
