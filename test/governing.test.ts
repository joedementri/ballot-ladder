/**
 * M9 governing: the legislative session (bills, committees, whipping, vetoes and overrides), leadership posts,
 * executive budgets and the economy, and vacancies (appointments and special elections).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './setup';
import { Engine } from '../src/sim/game';
import { PARTY_BASE } from '../src/sim/issues';
import { budgetTargets } from '../src/sim/budget';
import { countVotes, ensureLeadership, members } from '../src/sim/legislature';
import { vacate } from '../src/sim/vacancies';
import type { Party, Town } from '../src/data/types';

let e: Engine;
beforeAll(async () => {
  e = new Engine(BASE);
  await e.init();
});

async function start(st: string, prefix: string, party: Party, seed = 11): Promise<Town> {
  const town = (await e.data.townsOf(st)).find((t) => t.name.startsWith(prefix))!;
  await e.newGame({
    first: 'Test', last: 'Player', gender: 'F', age: 45, party, homeTown: town.id, background: 'teacher',
    pos: PARTY_BASE[party].map((x) => x * 0.8), skills: { charisma: 60, debate: 55, fundraising: 50, policy: 55, integrity: 70, organization: 55 }, seed,
  });
  return town;
}
/** End turns (acknowledging election nights) until `done` or `max` months pass. */
async function advance(max: number, done: () => boolean = () => false) {
  for (let i = 0; i < max && !done(); i++) {
    if (e.s.pendingNight) e.ackNight();
    await e.endTurn();
  }
  if (e.s.pendingNight) e.ackNight();
}

describe('legislative session', () => {
  it('a majority-party bill moves from committee to the floor to the other chamber to the governor and into law', async () => {
    const town = await start('NY', 'Albany', 'D');
    e.installOffice(`sldl:${town.sldl}`, e.player.id);
    const leg = e.legislature()!;
    expect(leg.kind).toBe('legislator');
    expect(leg.chamber!.label).toContain('New York');
    expect(leg.chamber!.majorityParty).toBe('D');
    expect(leg.committees.length).toBe(7);
    expect(leg.leaders.some((l) => l.label === 'Speaker')).toBe(true);

    const r = e.introduceBill('labor', -1, 'min_wage');
    expect(r.ok).toBe(true);
    const bill = () => e.s.player.bills![0];
    expect(bill().stage).toBe('committee');
    // second copy of the same bill is refused
    e.s.player.ap = 10;
    expect(e.introduceBill('labor', -1, 'min_wage').ok).toBe(false);

    await advance(8, () => bill().stage !== 'committee');
    expect(bill().stage).toBe('floor');
    expect(bill().lastVote?.label).toBe('Committee');
    e.s.player.ap = 10;
    const v = e.billAction(bill().id, 'vote');
    expect(v.ok).toBe(true);
    expect(bill().stage).toBe('second');
    await advance(4, () => bill().stage === 'law' || bill().stage === 'dead' || bill().stage === 'vetoed');
    expect(bill().stage).toBe('law');
    expect(e.s.player.policies?.[0]?.title).toBe(bill().title);
    // a state law moves the national economy a little
    expect(e.s.world.policy!.unemployment).not.toBe(0);
    expect(bill().log.length).toBeGreaterThanOrEqual(5);
  }, 60000);

  it('whipping converts persuadable members by spending favors', async () => {
    const town = await start('TX', 'Austin', 'D', 12);
    e.installOffice(`sldl:${town.sldl}`, e.player.id);
    e.s.player.favors = 30;
    e.s.player.ap = 20;
    // a centrist bill the minority party sponsors: some majority members can be talked into it
    expect(e.introduceBill('spending', -1, 'infra').ok).toBe(true);
    const b = e.s.player.bills![0];
    b.stage = 'floor';
    const before = countVotes(e, b, b.chamber);
    expect(before.passes).toBe(false);
    expect(before.persuadable.length).toBeGreaterThan(0);
    for (let i = 0; i < 6 && !b.whipped.length; i++) e.billAction(b.id, 'whip');
    expect(b.whipped.length).toBeGreaterThan(0);
    expect(e.s.player.favors!).toBeLessThan(30);
    expect(countVotes(e, b, b.chamber).count.yes).toBeGreaterThan(before.count.yes);
  });

  it('a vetoed bill can be overridden only with two-thirds of both chambers', async () => {
    const town = await start('NY', 'Albany', 'D', 13);
    e.installOffice(`sldl:${town.sldl}`, e.player.id);
    e.s.player.ap = 10;
    expect(e.introduceBill('guns', -1, 'red_flag').ok).toBe(true);
    const b = e.s.player.bills![0];
    b.stage = 'vetoed';
    const own = countVotes(e, b, b.chamber, { twoThirds: true });
    expect(own.count.needed).toBe(Math.ceil((own.count.total * 2) / 3));
    const r = e.billAction(b.id, 'override');
    expect(['law', 'dead']).toContain(b.stage);
    expect(r.msg).toMatch(/Override/);
  });
});

describe('leadership', () => {
  it('fills leadership from the majority and elects a qualified player in January', async () => {
    const town = await start('NY', 'Albany', 'D', 14);
    e.installOffice(`sldl:${town.sldl}`, e.player.id);
    const key = `sldl:NY`;
    const l = ensureLeadership(e, key);
    const party = (id?: string) => e.pol(id)?.party;
    expect(party(l.speaker)).toBe('D');
    expect(party(l.majority)).toBe('D');
    expect(party(l.minority)).toBe('R');
    expect(Object.values(l.chairs).every((id) => party(id) === 'D')).toBe(true);
    // a well-liked veteran member runs for whip
    e.player.since = e.s.year - 4;
    e.s.player.partyStanding = 90;
    e.s.player.favors = 30;
    const opt = e.legislature()!.bidOptions.find((o) => o.role === 'whip')!;
    expect(opt.ok).toBe(true);
    expect(opt.odds).toBeGreaterThan(0.8);
    expect(e.bidRole('whip').ok).toBe(true);
    await advance(1);
    expect(e.s.player.role?.role).toBe('whip');
    expect(ensureLeadership(e, key).whip).toBe(e.player.id);
    expect(e.legislature()!.favorsPerMonth).toBe(2);
    // a new member can't jump straight to Speaker
    e.player.since = e.s.year;
    expect(e.legislature()!.bidOptions.find((o) => o.role === 'speaker')?.ok).toBe(false);
  });
});

describe('executive budget', () => {
  it('a budget moves metric targets over the year and nudges the economy', async () => {
    await start('PA', 'Lansdale', 'D', 15);
    e.installOffice('gov:PA', e.player.id);
    e.s.player.ap = 10;
    const r = e.setBudget({ tax: 1, education: 1.3, safety: 1, infrastructure: 1.2, health: 1 });
    expect(r.ok).toBe(true);
    const b = e.s.player.budget!;
    expect(b.education).toBeGreaterThan(1);
    expect(e.setBudget({ tax: 1.1 }).ok).toBe(false); // one budget a year
    expect(budgetTargets(b).schools).toBeGreaterThan(0);
    expect(budgetTargets(b).budget).toBeLessThan(0);
    await advance(10);
    const m = e.s.player.metrics;
    expect(m.schools).toBeGreaterThan(50);
    expect(m.budget).toBeLessThan(0);
    expect(e.s.world.fiscal!.gdp).toBeGreaterThan(0);
  });

  it('without a budget, a continuing resolution kicks in after March', async () => {
    await start('PA', 'Lansdale', 'D', 16);
    e.installOffice('gov:PA', e.player.id);
    await advance(3);
    expect(e.s.player.budget?.note).toMatch(/Continuing/);
    e.s.player.ap = 10;
    expect(e.setBudget({ health: 1.2 }).ok).toBe(true);
  });
});

describe('vacancies', () => {
  it('a U.S. House vacancy goes to a special election and the winner is seated right away', async () => {
    await start('PA', 'Lansdale', 'D', 17);
    e.s.month = 3;
    vacate(e, 'house:4207', 'resigned for health reasons');
    expect(e.s.offices['house:4207'].holder).toBeNull();
    const sp = e.s.specials!.find((x) => x.officeId === 'house:4207')!;
    expect(sp.month).toBe(7);
    await advance(6, () => !!e.s.offices['house:4207'].holder);
    expect(e.s.offices['house:4207'].holder).not.toBeNull();
    expect(e.s.specials!.some((x) => x.officeId === 'house:4207')).toBe(false);
  });

  it('the governor appoints a U.S. Senate replacement from their party', async () => {
    await start('OH', 'Dublin', 'D', 18);
    e.s.month = 4;
    vacate(e, 'sen:OH:1', 'resigned to join the administration');
    expect(e.s.vacancies!.some((v) => v.officeId === 'sen:OH:1' && v.by === 'gov:OH')).toBe(true);
    expect(e.s.specials!.some((x) => x.officeId === 'sen:OH:1' && x.month === 11)).toBe(true);
    // the appointment is due next month, leaving a month for people to seek it
    await advance(1);
    expect(e.s.offices['sen:OH:1'].holder).toBeNull();
    await advance(1);
    const p = e.pol(e.s.offices['sen:OH:1'].holder)!;
    expect(p.party).toBe('R'); // Ohio's governor is a Republican
    expect(e.s.vacancies!.some((v) => v.officeId === 'sen:OH:1')).toBe(false);
  });

  it('a player governor chooses the appointee', async () => {
    await start('PA', 'Lansdale', 'D', 19);
    e.installOffice('gov:PA', e.player.id);
    e.s.month = 4;
    vacate(e, 'sen:PA:1', 'died in office');
    const d = e.s.decisions.find((x) => x.meta?.kind === 'appoint')!;
    expect(d.options.length).toBe(4); // three candidates and "appoint yourself"
    const pick = d.options[1].pick!;
    e.decide(d.id, 1);
    expect(e.s.offices['sen:PA:1'].holder).toBe(pick);
    for (const id of d.meta!.candidates!) if (id !== pick) expect(e.s.politicians[id]).toBeUndefined();
    await advance(1);
    expect(e.s.offices['sen:PA:1'].holder).toBe(pick);
  });

  it('a player can seek an appointment and a special election shows up on the Run tab', async () => {
    const town = await start('PA', 'Lansdale', 'D', 20);
    e.installOffice(`sldl:${town.sldl}`, e.player.id);
    e.s.month = 4;
    vacate(e, 'sen:PA:3', 'resigned to lead a university');
    const opp = e.opportunities().find((o) => o.officeId === 'sen:PA:3' && o.kind === 'appointment')!;
    expect(opp.ok).toBe(true);
    expect(opp.odds).toBeGreaterThan(0);
    e.s.player.ap = 10;
    expect(e.seekAppointment('sen:PA:3').ok).toBe(true);
    expect(e.seekAppointment('sen:PA:3').ok).toBe(false); // once is enough
    await advance(2);
    const holder = e.pol(e.s.offices['sen:PA:3'].holder)!;
    expect(holder).toBeTruthy();
    if (holder.isPlayer) {
      expect(e.player.career.some((c) => c.result === 'appointed')).toBe(true);
      // the state house seat the player left is being filled
      expect(e.s.offices[`sldl:${town.sldl}`].holder === null || e.s.offices[`sldl:${town.sldl}`].holder !== e.player.id).toBe(true);
    }
    // a House special in the player's district can be filed for like any race
    vacate(e, `house:${town.cd}`, 'resigned for health reasons');
    const opts = await e.availableOffices();
    const house = opts.find((o) => o.id === `house:${town.cd}`)!;
    expect(house.special).toMatch(/Special election/);
  });

  it('a player who wins a special election takes office immediately', async () => {
    const town = await start('PA', 'Lansdale', 'D', 21);
    e.s.month = 2;
    const id = `house:${town.cd}`;
    vacate(e, id, 'resigned for health reasons');
    const sp = e.s.specials!.find((x) => x.officeId === id)!;
    const filed = await e.file(id);
    expect(filed.ok).toBe(true);
    expect(e.s.campaign!.special).toBe(true);
    expect(e.s.campaign!.generalMonth).toBe(sp.month);
    expect(e.s.campaign!.primaryMonth).toBe(sp.primaryMonth);
    await advance(8, () => e.s.campaign?.stage === 'done');
    expect(e.s.campaign!.stage).toBe('done');
    if (e.s.campaign!.resultGeneral) {
      // the seat is filled the month of the special, not next January
      expect(e.s.offices[id].holder).toBe(e.s.campaign!.resultGeneral.winnerId);
      expect(e.s.month).toBe(sp.month === 12 ? 1 : sp.month + 1);
    }
  }, 60000);
});

describe('saves', () => {
  it('loads saves made before M9 and keeps playing', async () => {
    const town = await start('NY', 'Albany', 'D', 22);
    e.installOffice(`sldl:${town.sldl}`, e.player.id);
    const st = JSON.parse(JSON.stringify(e.exportState()));
    for (const k of ['leadership', 'vacancies', 'specials']) delete st[k];
    for (const k of ['favors', 'role', 'bid', 'committees', 'bills', 'budget', 'policies']) delete st.player[k];
    delete st.world.policy;
    e.load(st);
    expect(e.legislature()!.chamber!.seats).toBeGreaterThan(100);
    await advance(2);
    expect(e.s.player.favors).toBeGreaterThan(0);
    expect(members(e, 'sldl:NY').length).toBeGreaterThan(100);
  });
});
