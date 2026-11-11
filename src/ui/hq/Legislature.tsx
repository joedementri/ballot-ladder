import { useEffect, useMemo, useState } from 'react';
import { partyColor, pct, sim, useGame } from '../../store/game';
import type { LegislatureInfo } from '../../sim/game';
import type { BillStage } from '../../sim/model';
import type { WhipCount } from '../../sim/legislature';
import { ISSUES } from '../../sim/issues';
import { Card, HelpLabel, PartyTag, Seg } from '../kit';

/** Fetch the legislature view whenever the game state changes. */
export function useLegislature() {
  const view = useGame((s) => s.view);
  const [leg, setLeg] = useState<LegislatureInfo | null>(null);
  useEffect(() => {
    let live = true;
    sim.legislature().then((x) => live && setLeg(x));
    return () => { live = false; };
  }, [view]);
  return leg;
}

/** Seats by party as a single stacked bar. */
export function Composition({ parties, seats }: { parties: Record<string, number>; seats: number }) {
  const order = ['D', 'I', 'R'];
  const filled = order.reduce((a, p) => a + (parties[p] ?? 0), 0);
  const vacant = Math.max(0, seats - filled);
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
        {order.map((p) => (parties[p] ? <div key={p} style={{ width: `${(parties[p] / seats) * 100}%`, background: partyColor(p) }} /> : null))}
      </div>
      <div className="mt-0.5 flex justify-between text-[11px] num">
        <span style={{ color: 'var(--dem)' }}>D {parties.D ?? 0}</span>
        <span className="muted">{parties.I ? `I ${parties.I} · ` : ''}{vacant ? `${vacant} vacant · ` : ''}majority {Math.floor(seats / 2) + 1}</span>
        <span style={{ color: 'var(--rep)' }}>R {parties.R ?? 0}</span>
      </div>
    </div>
  );
}

export function ChamberCard({ leg }: { leg: LegislatureInfo }) {
  const { run, busy } = useGame();
  const [bid, setBid] = useState('');
  const [picks, setPicks] = useState<string[] | null>(null);
  const c = leg.chamber!;
  const mine = leg.committees.filter((x) => x.mine).map((x) => x.key);
  const chosen = picks ?? mine;
  const open = leg.bidOptions;
  const sel = open.find((o) => `${o.role}|${o.committee ?? ''}` === bid) ?? open.find((o) => o.ok);
  return (
    <Card title="Your chamber" help="The body you serve in: who holds the majority, who leads it, and your place in it." right={<span className="chip num" style={{ border: '1px solid var(--line)' }} title="Favors"><HelpLabel label="Favors" />&nbsp;{Math.floor(leg.favors)} <span className="muted">+{leg.favorsPerMonth}/mo</span></span>}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="font-semibold">{c.label}</div>
        <div className="muted text-xs num">{c.seats} seats</div>
      </div>
      <Composition parties={c.parties} seats={c.seats} />
      <div className="muted mt-1 text-xs">
        {c.partisan ? <>Majority: <b style={{ color: partyColor(c.majorityParty) }}>{c.majorityParty === 'D' ? 'Democrats' : 'Republicans'}</b></> : 'Nonpartisan body'}
        {leg.other && <> · {leg.other.label}: <span style={{ color: partyColor(leg.other.majorityParty) }}>{leg.other.majorityParty}</span> majority</>}
        {leg.exec && <> · {leg.exec.title.replace(/ of .*$/, '')}: {leg.exec.name} {leg.exec.party && `(${leg.exec.party})`}</>}
      </div>

      <h4 className="label mt-3 mb-1"><HelpLabel label="Leadership" /></h4>
      <ul className="space-y-0.5 text-xs">
        {leg.leaders.map((l) => (
          <li key={l.label} className="flex justify-between gap-2">
            <span className="muted">{l.label}</span>
            <span className="truncate font-medium">{l.person!.isPlayer ? <b style={{ color: 'var(--accent)' }}>You</b> : l.person!.name} <PartyTag party={l.person!.party} /></span>
          </li>
        ))}
      </ul>

      <div className="panel-2 mt-3 p-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span><span className="muted">Your post:</span> <b>{leg.role?.label ?? 'Rank-and-file member'}</b></span>
          {leg.bid && <button className="btn-ghost !py-0.5 !text-[11px]" disabled={busy} onClick={() => run(() => sim.cancelBid())}>Drop bid</button>}
        </div>
        {leg.bid ? (
          <p className="muted mt-1">Running for <b style={{ color: 'var(--text)' }}>{leg.bid.label}</b>. The caucus votes at the end of January.</p>
        ) : open.length > 0 && (
          <div className="mt-2 flex gap-1.5">
            <select className="input !py-1 !text-xs" value={sel ? `${sel.role}|${sel.committee ?? ''}` : ''} onChange={(e) => setBid(e.target.value)} aria-label="Leadership post">
              {open.map((o) => (
                <option key={`${o.role}|${o.committee ?? ''}`} value={`${o.role}|${o.committee ?? ''}`} disabled={!o.ok}>
                  {o.label} — {o.ok ? `${pct(o.odds)} odds${o.rival ? ` vs ${o.rival}` : ''}` : o.reason}
                </option>
              ))}
            </select>
            <button className="btn-primary shrink-0 !py-1 !text-xs" disabled={busy || !sel?.ok} onClick={() => sel && run(() => sim.bidRole(sel.role, sel.committee))}>Run for it</button>
          </div>
        )}
      </div>

      {leg.committees.length > 0 && (
        <>
          <div className="mt-3 mb-1 flex items-center justify-between">
            <h4 className="label"><HelpLabel label="Committees" /></h4>
            {leg.canSetCommittees && picks && (
              <button className="btn-primary !py-0.5 !text-[11px]" disabled={busy || !picks.length} onClick={async () => { await run(() => sim.setCommittees(picks)); setPicks(null); }}>Save assignments</button>
            )}
          </div>
          <ul className="space-y-0.5 text-xs">
            {leg.committees.map((cm) => (
              <li key={cm.key} className="flex items-center justify-between gap-2">
                <label className="flex min-w-0 items-center gap-1.5">
                  {leg.canSetCommittees && (
                    <input type="checkbox" checked={chosen.includes(cm.key)} disabled={!chosen.includes(cm.key) && chosen.length >= 2}
                      onChange={(e) => setPicks(e.target.checked ? [...chosen, cm.key] : chosen.filter((x) => x !== cm.key))} />
                  )}
                  <span className={`truncate ${cm.mine ? 'font-semibold' : ''}`}>{cm.label}{cm.mine && <span className="muted"> · member</span>}</span>
                </label>
                <span className="muted shrink-0">chair {cm.chair?.isPlayer ? 'you' : cm.chair?.name.split(' ').slice(-1)[0]} ({cm.chair?.party})</span>
              </li>
            ))}
          </ul>
          {!leg.canSetCommittees && <p className="muted mt-1 text-[11px]">Assignments can be changed in January and February.</p>}
        </>
      )}
    </Card>
  );
}

const STAGES: { key: BillStage; label: string }[] = [
  { key: 'committee', label: 'Committee' },
  { key: 'floor', label: 'Floor' },
  { key: 'second', label: 'Other chamber' },
  { key: 'desk', label: 'Signature' },
  { key: 'law', label: 'Law' },
];

function Pipeline({ stage, small, bicameral, committee }: { stage: BillStage; small: boolean; bicameral: boolean; committee: boolean }) {
  const steps = STAGES.filter((s) => (s.key !== 'committee' || committee) && (s.key !== 'second' || bicameral) && (s.key !== 'desk' || !small || bicameral || stage === 'desk'));
  const at = stage === 'vetoed' ? steps.findIndex((s) => s.key === 'desk') : steps.findIndex((s) => s.key === stage);
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]">
      {steps.map((s, i) => {
        const done = stage === 'law' || (at >= 0 && i < at);
        const cur = i === at;
        const bad = cur && (stage === 'vetoed');
        return (
          <span key={s.key} className="flex items-center gap-1">
            <span className="rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide"
              style={{ background: bad ? 'var(--rep)' : cur || done ? 'var(--accent)' : 'var(--line)', color: bad || cur || done ? 'var(--panel)' : 'var(--muted)', opacity: done && !cur ? 0.6 : 1 }}>
              {bad ? 'Vetoed' : s.label}
            </span>
            {i < steps.length - 1 && <span className="muted">›</span>}
          </span>
        );
      })}
      {stage === 'dead' && <span className="rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide" style={{ background: 'var(--rep)', color: 'var(--panel)' }}>Dead</span>}
    </div>
  );
}

/** Yes / whipped / persuadable / no, with the line needed to pass. */
export function WhipBar({ c }: { c: WhipCount }) {
  const w = (n: number) => `${(n / Math.max(1, c.total)) * 100}%`;
  const firm = c.yes - c.whipped;
  return (
    <div>
      <div className="relative flex h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
        <div style={{ width: w(firm), background: 'var(--accent)' }} />
        <div style={{ width: w(c.whipped), background: 'var(--accent)', opacity: 0.55 }} />
        <div style={{ width: w(c.persuadable), background: '#f59e0b', opacity: 0.8 }} />
        <div className="absolute top-0 h-full w-0.5" style={{ left: w(c.needed), background: 'var(--text)' }} title="Votes needed" />
      </div>
      <div className="mt-0.5 flex justify-between text-[11px] num">
        <span><b style={{ color: c.yes >= c.needed ? 'var(--accent)' : undefined }}>{c.yes}</b> yes{c.whipped ? ` (${c.whipped} whipped)` : ''} · need {c.needed}</span>
        <span className="muted">{c.persuadable} persuadable · {c.no - c.persuadable} firm no</span>
      </div>
      <div className="muted text-[10px]">{c.body}</div>
    </div>
  );
}

export function BillsCard({ leg }: { leg: LegislatureInfo }) {
  const { run, busy, view } = useGame();
  const [issue, setIssue] = useState<string>(ISSUES[0].key);
  const partyDir = view?.me.party === 'R' ? 1 : -1;
  const [dir, setDir] = useState<1 | -1>(partyDir as 1 | -1);
  const [tpl, setTpl] = useState('');
  const [showDone, setShowDone] = useState(false);
  const iss = ISSUES.find((x) => x.key === issue)!;
  const matching = useMemo(() => leg.templates.filter((t) => t.issue === issue && t.dir === dir), [leg.templates, issue, dir]);
  const chosenTpl = matching.find((t) => t.id === tpl);
  const active = leg.bills.filter((b) => b.stage !== 'law' && b.stage !== 'dead');
  const done = leg.bills.filter((b) => b.stage === 'law' || b.stage === 'dead');
  const ap = view?.player.ap ?? 0;
  const small = !!leg.chamber?.small;
  const act = (id: string, a: Parameters<typeof sim.billAction>[1]) => run(() => sim.billAction(id, a));
  return (
    <Card title={`Legislation (${active.length}/${leg.maxBills} active)`} help="Write bills, get them through committee and the floor, and whip the votes you are missing. Laws you pass raise your effectiveness and keep shaping your district.">
      <div className="panel-2 space-y-1.5 p-2">
        <div className="flex gap-1.5">
          <select className="input !py-1 !text-xs" value={issue} onChange={(e) => { setIssue(e.target.value); setTpl(''); }} aria-label="Bill issue">
            {ISSUES.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
          </select>
          <Seg size="xs" value={String(dir) as '1' | '-1'} onChange={(v) => { setDir(Number(v) as 1 | -1); setTpl(''); }} options={[{ value: '-1', label: 'Progressive' }, { value: '1', label: 'Conservative' }]} />
        </div>
        <select className="input !py-1 !text-xs" value={chosenTpl?.id ?? ''} onChange={(e) => setTpl(e.target.value)} aria-label="Bill">
          <option value="">Draft your own: {dir < 0 ? iss.left : iss.right}</option>
          {matching.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        {chosenTpl && <p className="muted text-[11px] leading-snug">{chosenTpl.body}</p>}
        <button className="btn-primary w-full !py-1 !text-xs" disabled={busy || ap < 2 || active.length >= leg.maxBills} onClick={() => run(() => sim.introduceBill(issue, dir, chosenTpl?.id))}>
          Introduce bill (2 AP)
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {active.map((b) => (
          <div key={b.id} className="panel-2 space-y-1.5 p-2">
            <div className="text-sm font-semibold leading-snug">{b.title}</div>
            <Pipeline stage={b.stage} small={small} bicameral={!!leg.other} committee={!!b.committee} />
            {b.stage === 'committee' && (
              <div className="text-xs">
                <span className="muted">{b.committeeLabel} · chair </span>{b.chair?.isPlayer ? 'you' : b.chair?.name} <PartyTag party={b.chair?.party} />
                <span className="muted"> · {b.hearing ? 'hearing scheduled; committee votes at month end' : `hearing odds ${pct(b.hearingOdds ?? 0)} this month`}</span>
              </div>
            )}
            {b.count && b.stage !== 'committee' && <WhipBar c={b.count} />}
            {b.count && b.stage === 'committee' && b.hearing && <WhipBar c={b.count} />}
            {b.stage === 'desk' && <p className="muted text-xs">Waiting on the {leg.exec?.title.replace(/ of .*$/, '').toLowerCase() ?? 'executive'} ({leg.exec?.name}). They decide at month end.</p>}
            {b.stage === 'second' && <p className="muted text-xs">The other chamber votes at month end. Whipping there costs double.</p>}
            <div className="flex flex-wrap gap-1">
              {b.stage === 'committee' && !b.hearing && <button className="btn-ghost !py-0.5 !text-[11px]" disabled={busy || ap < 1} onClick={() => act(b.id, 'lobby')} title="1 AP and 2 favors">Lobby the chair</button>}
              {(b.stage === 'floor' || b.stage === 'second' || b.stage === 'vetoed' || (b.stage === 'committee' && b.hearing)) && (
                <button className="btn-ghost !py-0.5 !text-[11px]" disabled={busy || ap < 1 || !b.count?.persuadable || (b.count?.yes ?? 0) >= (b.count?.needed ?? 0)} onClick={() => act(b.id, 'whip')} title="1 AP; each vote costs 1 favor (2 from the other party, double in the other chamber)">Whip votes</button>
              )}
              {b.stage === 'floor' && <button className="btn-primary !py-0.5 !text-[11px]" disabled={busy || ap < 1} onClick={() => act(b.id, 'vote')}>Call the vote</button>}
              {b.stage === 'vetoed' && <button className="btn-primary !py-0.5 !text-[11px]" disabled={busy || ap < 1} onClick={() => act(b.id, 'override')}>Attempt override</button>}
              <button className="btn-ghost ml-auto !py-0.5 !text-[11px]" disabled={busy} onClick={() => act(b.id, 'withdraw')}>Withdraw</button>
            </div>
            <ul className="muted space-y-0.5 border-t pt-1 text-[11px] hairline">
              {b.log.slice(-3).map((l, i) => <li key={i}><span className="num">{l.month}/{String(l.year).slice(2)}</span> {l.text}</li>)}
            </ul>
          </div>
        ))}
        {!active.length && <p className="muted text-xs">No bills moving. Pick an issue above to write one.</p>}
      </div>

      {done.length > 0 && (
        <div className="mt-2 border-t pt-2 hairline">
          <button className="label underline-offset-2 hover:underline" onClick={() => setShowDone(!showDone)}>{showDone ? '▾' : '▸'} Finished bills ({done.length})</button>
          {showDone && (
            <ul className="mt-1 space-y-0.5 text-xs">
              {done.map((b) => (
                <li key={b.id} className="flex justify-between gap-2">
                  <span className="truncate" title={b.log[b.log.length - 1]?.text}>{b.title}</span>
                  <span className="shrink-0 font-semibold" style={{ color: b.stage === 'law' ? 'var(--accent)' : 'var(--rep)' }}>{b.stage === 'law' ? 'Law' : 'Dead'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
