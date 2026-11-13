/**
 * Month snapshots and the month summary shown after End Month.
 * Split out of game.ts (M12): functions take the Engine; Engine keeps one-line delegates for the public API.
 */
import { expectedSpend, shortTownName } from './offices';
import type { ActionLogEntry, Campaign, MonthSnapshot, MonthSummary, ResultSummary } from './model';
import { monthName, genMonth, fmtMoney } from './util';
import type { Engine } from './game';
import { EVENT_IDS } from './actions';
import { approval } from './upkeep';

/** What recognition and polls are measured against: the active race, else the office held, else the home town. */
export function summaryContext(e: Engine): { key: string; label: string; officeId?: string } {
  const c = e.s.campaign;
  const def = c && c.stage !== 'done' ? e.def(c.officeId) : e.player.officeId ? e.def(e.player.officeId) : null;
  if (def) return { key: e.jurKey(def), label: def.jurName, officeId: def.id };
  const t = e.data.townSync(e.player.home);
  return { key: e.player.home, label: t ? shortTownName(t.name) : 'your home town' };
}

export function pollPair(e: Engine, c: Campaign | null) {
  const last = c?.polls[c.polls.length - 1];
  if (!c || !last) return { me: undefined, rival: undefined, rivalId: undefined, point: undefined };
  const meId = e.s.player.id;
  const rivalId = Object.entries(last.shares).filter(([id]) => id !== meId && id !== 'undecided').sort((a, b) => b[1] - a[1])[0]?.[0];
  return { me: last.shares[meId], rival: rivalId ? last.shares[rivalId] : undefined, rivalId, point: last };
}

export function snapshot(e: Engine): MonthSnapshot {
  const ctx = summaryContext(e);
  const c = e.s.campaign && e.s.campaign.stage !== 'done' ? e.s.campaign : null;
  const pp = pollPair(e, c);
  return {
    year: e.s.year, month: e.s.month, cash: Math.round(e.s.player.cash), personal: Math.round(e.s.player.personal),
    rec: e.recIn(ctx.key), fav: e.player.fav, approval: approval(e), partyStanding: e.s.player.partyStanding,
    newsId: e.s.nextId, pollMe: pp.me, pollRival: pp.rival, officeId: ctx.officeId, recMap: { ...e.s.player.rec },
  };
}

export function monthSummary(
  e: Engine, start: MonthSnapshot, ctx: { key: string; label: string; officeId?: string }, c: Campaign | null,
  upkeep: { payroll: number; staffLeft: boolean }, year: number, month: number, night: ResultSummary | null,
): MonthSummary {
  const P = e.s.player;
  const me = e.player;
  const actions = P.log.filter((x) => x.year === year && x.month === month).reverse();
  const sum = (f: (x: ActionLogEntry) => boolean) => actions.filter(f).reduce((a, x) => a + x.cash, 0);
  const raised = sum((x) => x.id.startsWith('fund_'));
  const moved = sum((x) => x.id === 'self_fund');
  const spent = sum((x) => x.cash < 0);
  const money: MonthSummary['money'] = [];
  if (raised) money.push({ label: 'Raised from donors', amount: raised });
  if (moved) money.push({ label: 'Moved from personal savings', amount: moved });
  if (spent) money.push({ label: 'Spent on campaign actions', amount: spent });
  if (upkeep.payroll) money.push({ label: 'Staff payroll', amount: -upkeep.payroll });
  const cashEnd = Math.round(P.cash);
  const other = cashEnd - start.cash - raised - moved - spent + upkeep.payroll;
  if (Math.abs(other) >= 1) money.push({ label: 'Other (office decisions, staff changes)', amount: Math.round(other) });

  const recEnd = e.recIn(ctx.key);
  const recStart = start.recMap ? start.recMap[ctx.key] ?? 0.02 : start.officeId === ctx.officeId ? start.rec : recEnd;
  const race = c && (c.stage !== 'done' || c.year === year) ? c : null;
  const pp = pollPair(e, race);
  const fresh = pp.point && pp.point.year === year && pp.point.month === month;
  const poll = fresh && pp.me != null && pp.rival != null && !night
    ? { me: [start.pollMe ?? null, pp.me] as [number | null, number], rival: [start.pollRival ?? null, pp.rival] as [number | null, number], rivalName: e.name(e.pol(pp.rivalId)), undecided: pp.point!.shares.undecided ?? 0 }
    : null;

  const events = e.s.news
    .filter((n) => n.id >= start.newsId && n.kind !== 'national')
    .slice(0, 8)
    .map((n) => ({ title: n.title, tone: n.tone }));

  // Plain-language reasons for the biggest changes
  const why: string[] = [];
  const nEvents = actions.filter((x) => EVENT_IDS.has(x.id)).length;
  const nAds = actions.filter((x) => x.id === 'ads_tv' || x.id === 'ads_digital').length;
  const dRec = recEnd - recStart;
  if (Math.abs(dRec) >= 0.005) {
    const src = [nEvents && `${nEvents} event${nEvents > 1 ? 's' : ''}`, nAds && `${nAds} ad flight${nAds > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
    why.push(dRec > 0
      ? `Name recognition in ${ctx.label} rose ${Math.round(dRec * 100)} pts${src ? ` from your ${src}` : ''}.`
      : `Name recognition in ${ctx.label} slipped ${Math.round(-dRec * 100)} pts. Recognition fades a little every month you don't campaign.`);
  } else if (!actions.length) why.push('You took no actions this month, so nothing moved in your favor.');
  const repeats = actions.filter((x) => x.msg.includes('Repeat this month')).length;
  if (repeats) why.push(`${repeats} action${repeats > 1 ? 's were repeats' : ' was a repeat'} with diminishing returns. Spread events across places and mix action types.`);
  if (upkeep.payroll && upkeep.payroll > raised) why.push(`Payroll (${fmtMoney(upkeep.payroll)}) cost more than you raised (${fmtMoney(raised)}). Staff multiply your actions, but they're paid every month.`);
  if (upkeep.staffLeft) why.push('You ran out of cash for payroll, so staff quit.');
  if (poll && poll.me[0] != null && poll.rival[0] != null) {
    const d = Math.round((poll.me[1] - poll.rival[1] - (poll.me[0] - poll.rival[0])) * 100);
    if (Math.abs(d) >= 2) {
      const reasons: string[] = [];
      if (events.some((ev) => ev.title.includes('attack ad against'))) reasons.push('an opponent attack ad');
      if (events.some((ev) => ev.title.startsWith('Debate:'))) reasons.push('the debate');
      if (events.some((ev) => ev.title.startsWith('Scandal') || ev.title.includes('stumbles'))) reasons.push('bad press');
      if (dRec > 0.02) reasons.push('your rising recognition');
      why.push(`You ${d > 0 ? 'gained' : 'lost'} ${Math.abs(d)} pts on ${poll.rivalName} in the polls${reasons.length ? ` (${reasons.join(', ')})` : ''}. Polls carry a margin of error of about ±${Math.round(pp.point!.moe * 100)} pts.`);
    }
  }
  const dFav = me.fav - start.fav;
  if (Math.abs(dFav) >= 0.01) why.push(`Your favorability ${dFav > 0 ? 'rose' : 'fell'} ${Math.round(Math.abs(dFav) * 100)} pts${dFav < 0 && events.some((ev) => ev.tone === 'bad') ? ' after negative coverage' : ''}.`);
  const live = c && c.stage !== 'done' ? c : null;
  if (live) {
    const def = e.def(live.officeId)!;
    const exp = expectedSpend(def.type, def.pop);
    const monthsLeft = (live.year - e.s.year) * 12 + (live.stage === 'primary' ? live.primaryMonth : genMonth(live)) - e.s.month;
    if (monthsLeft >= 0 && monthsLeft <= 3 && P.cash > exp * 0.25) why.push(`You have ${fmtMoney(P.cash)} unspent with the ${live.stage} ${monthsLeft === 0 ? 'this month' : `in ${monthsLeft} month${monthsLeft > 1 ? 's' : ''}`}. Money in the bank doesn't win votes; spend it on ads, rallies and canvassing.`);
  }
  if (P.energy < 30) why.push('Your energy is low. Rest, or your actions lose effect.');

  const next: string[] = [];
  if (night) next.push('Results are in. Election night is next.');
  if (live) {
    const def = e.def(live.officeId)!;
    const mPrim = live.stage === 'primary' ? (live.year - e.s.year) * 12 + live.primaryMonth - e.s.month : null;
    const mGen = (live.year - e.s.year) * 12 + genMonth(live) - e.s.month;
    if (mPrim != null) next.push(mPrim === 0 ? `The primary for ${def.title} is at the end of this month.` : `Primary in ${mPrim} month${mPrim > 1 ? 's' : ''} (${monthName(live.primaryMonth)} ${live.year}).`);
    else next.push(mGen === 0 ? `Election day for ${def.title} is at the end of this month.` : `${live.special ? 'Special' : 'General'} election in ${mGen} month${mGen > 1 ? 's' : ''} (${monthName(genMonth(live))} ${live.year}).`);
  } else if (!me.officeId && !night) next.push("You aren't running for anything. Open the Run tab to file for a seat.");
  if (e.s.decisions.length) next.push(`${e.s.decisions.length} decision${e.s.decisions.length > 1 ? 's' : ''} waiting on your desk.`);

  return {
    year, month, monthName: monthName(month), context: ctx.label, actions,
    money, cash: [start.cash, cashEnd], personal: [start.personal, Math.round(P.personal)],
    rec: [recStart, recEnd], fav: [start.fav, me.fav], approval: me.officeId ? [start.approval, approval(e)] : null,
    partyStanding: [start.partyStanding, P.partyStanding], poll, why, events, next,
  };
}
