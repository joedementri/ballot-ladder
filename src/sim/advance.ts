/**
 * Skip ahead (M13): run End Month repeatedly until something needs the player.
 * Stops on an election night or game over, a new decision, a campaign stage change or the last three months before
 * a vote, the last month to file for an office the player could step up to, or after `maxMonths`.
 * At least one month always passes, so pressing Skip during a stop condition still moves the game.
 */
import type { Engine } from './game';
import { genMonth, monthName } from './util';
import { mergeSummaries } from './summary';
import type { MonthSummary } from './model';

export type StopReason = 'night' | 'gameOver' | 'decision' | 'campaign' | 'election' | 'filing' | 'max';

export interface AdvanceResult {
  months: number;
  stopReason: StopReason;
  /** Plain-language reason, e.g. "Filing for Mayor of Lansdale closes this month". */
  stopText: string;
}

export const MAX_SKIP = 24;

/** Months left until the campaign's next vote (primary or general), or null when not running. */
function monthsToVote(e: Engine) {
  const c = e.s.campaign;
  if (!c || c.stage === 'done') return null;
  const m = c.stage === 'primary' ? c.primaryMonth : genMonth(c);
  return (c.year - e.s.year) * 12 + m - e.s.month;
}

/** Offices a step up for the player whose last filing month is now. */
async function filingNow(e: Engine) {
  const c = e.s.campaign;
  if (c && c.stage !== 'done') return [];
  const myLevel = e.player.officeId ? e.def(e.player.officeId)?.level ?? 0 : 0;
  return (await e.availableOffices()).filter((o) =>
    o.eligible && o.id !== e.player.officeId && o.level > myLevel && o.deadline.year === e.s.year && o.deadline.month === e.s.month);
}

export async function advance(e: Engine, maxMonths: number): Promise<AdvanceResult> {
  const limit = Math.max(1, Math.min(MAX_SKIP, Math.floor(maxMonths) || 1));
  const summaries: MonthSummary[] = [];
  const from = { year: e.s.year, month: e.s.month };
  let stop: { reason: StopReason; text: string } | null = null;
  let months = 0;
  while (!stop) {
    if (e.s.pendingNight || e.s.gameOver) break;
    const known = new Set(e.s.decisions.map((d) => d.id));
    const stage = e.s.campaign && e.s.campaign.stage !== 'done' ? `${e.s.campaign.officeId}|${e.s.campaign.stage}` : '';
    await e.endTurn();
    months++;
    if (e.s.lastSummary) summaries.push(e.s.lastSummary);
    const c = e.s.campaign && e.s.campaign.stage !== 'done' ? e.s.campaign : null;
    const stageNow = c ? `${c.officeId}|${c.stage}` : '';
    const toVote = monthsToVote(e);
    const fresh = e.s.decisions.filter((d) => !known.has(d.id));
    if (e.s.gameOver) stop = { reason: 'gameOver', text: 'Your career is over.' };
    else if (e.s.pendingNight) stop = { reason: 'night', text: 'The votes are in. Election night is ready.' };
    else if (fresh.length) stop = { reason: 'decision', text: fresh.length > 1 ? `${fresh.length} new decisions need you.` : `A new decision needs you: "${fresh[0].title}".` };
    else if (stageNow !== stage) {
      const title = c ? e.def(c.officeId)?.title ?? 'office' : '';
      stop = { reason: 'campaign', text: !c ? 'Your campaign ended.' : !stage ? `Your campaign for ${title} has started.` : `Your race for ${title} moved to the ${c.stage === 'general' ? 'general election' : c.stage}.` };
    } else if (toVote != null && toVote <= 3) stop = { reason: 'election', text: toVote === 0 ? 'The vote is at the end of this month.' : `The ${c!.stage} is ${toVote} month${toVote > 1 ? 's' : ''} away.` };
    else {
      const f = await filingNow(e);
      if (f.length) {
        const more = f.length > 1 ? ` and ${f.length - 1} other office${f.length > 2 ? 's' : ''}` : '';
        stop = { reason: 'filing', text: `Filing for ${f[0].title}${more} closes this month (${monthName(e.s.month)} ${e.s.year}).` };
      }
      else if (months >= limit) stop = { reason: 'max', text: `${months} month${months > 1 ? 's' : ''} passed with nothing that needed you.` };
    }
  }
  const result: AdvanceResult = { months, stopReason: stop?.reason ?? (e.s.gameOver ? 'gameOver' : 'night'), stopText: stop?.text ?? '' };
  if (summaries.length) e.s.lastSummary = mergeSummaries(summaries, { months, from, stop: result.stopText });
  return result;
}
