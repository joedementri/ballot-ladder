import { leanLabel, money, pct, sim, useGame } from '../../store/game';
import { ISSUES } from '../../sim/issues';
import type { PollPoint } from '../../sim/model';
import { monthName } from '../../sim/util';
import { Card, EChart, Empty, Meter, PartyTag, Stat, css } from '../kit';
import { Actions, useCandColors } from './Actions';
import { focusOn } from '../map/MapView';
import { DelegateRace, TicketsCard } from './DelegateRace';
import { ScandalWatch } from './ScandalWatch';
import { DebateCard } from './DebateCard';

export function CampaignPanel() {
  const { view, setTab, run } = useGame();
  const c = view?.campaign;
  const colors = useCandColors(c?.field);
  if (!view) return null;
  if (!c || c.stage === 'done')
    return (
      <div className="space-y-3">
        <Empty>
          You are not running for anything right now.
          <div className="mt-2">
            <button className="btn-primary" onClick={() => setTab('run')}>Find an office to run for</button>
          </div>
        </Empty>
        <ScandalWatch />
        <TicketsCard />
        <Actions />
      </div>
    );

  const me = c.field.find((f) => f.isPlayer)!;
  const months = c.stage === 'primary' ? c.monthsToPrimary! : c.monthsToGeneral;
  const stageLabel = c.stage === 'primary' && c.presRace
    ? `${view.me.party === 'D' ? 'Democratic' : 'Republican'} presidential nomination`
    : c.stage === 'primary'
    ? `${c.special ? 'Special ' : ''}${c.kind === 'top-two' ? 'top-two primary' : `${view.me.party === 'D' ? 'Democratic' : 'Republican'} primary`}`.replace(/^./, (x) => x.toUpperCase())
    : c.special ? 'Special election' : 'General election';
  const pollField = c.stage === 'primary' ? c.field.filter((f) => f.inMyPrimary) : c.field;
  const last = c.polls[c.polls.length - 1];
  const mainOpp = [...pollField].filter((f) => !f.isPlayer).sort((a, b) => (last?.shares[b.id] ?? 0) - (last?.shares[a.id] ?? 0))[0];
  const myShare = last?.shares[me.id] ?? 0;
  const media = c.mediaPolls;
  const oppShare = mainOpp ? last?.shares[mainOpp.id] ?? 0 : 0;

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="label">{stageLabel} · {c.year}</div>
            <h2 className="text-lg font-bold leading-tight">{c.title}</h2>
            <button className="muted text-xs underline-offset-2 hover:underline" onClick={() => focusOn(c.jurKind === 'nation' ? 'state' : (c.jurKind as any), c.jurKind === 'state' ? c.st! : c.jurId)}>{c.jurName} · {leanLabel(c.lean)}</button>
          </div>
          <div className="text-right">
            <div className="num text-2xl font-bold" style={{ color: months <= 1 ? 'var(--rep)' : 'var(--accent)' }}>{months}</div>
            <div className="muted text-[11px]">{months === 1 ? 'month left' : 'months left'}</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          <Stat label="Poll" value={last ? pct(myShare) : '—'} sub={mainOpp && last ? `vs ${pct(oppShare)}` : 'no poll yet'} tone={myShare >= oppShare ? 'good' : 'bad'} />
          <Stat label="Known by" value={pct(c.myRec)} />
          <Stat label="Raised" value={money(c.raised)} />
          <Stat label="Spent" value={money(c.spend[me.id] ?? 0)} sub={`typical ${money(c.expectedSpend)}`} />
        </div>
      </Card>

      <ScandalWatch />
      <DebateCard />
      {c.presRace && <DelegateRace race={c.presRace} colors={colors} />}

      <Card title="The field">
        <div className="space-y-2">
          {c.field.map((f) => (
            <div key={f.id} className="panel-2 p-2" style={{ borderLeft: `3px solid ${colors[f.id]}` }}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {f.name} {f.isPlayer && <span style={{ color: 'var(--accent)' }}>(you)</span>}
                    {f.rival && <span className="chip ml-1 align-middle" style={{ border: '1px solid var(--rep)', color: 'var(--rep)' }} title="One of your rivals (Career tab)">Rival</span>}
                  </div>
                  <div className="muted truncate text-[11px]">
                    {f.age} · {f.incumbent ? (f.incStrength < 0.6 ? 'Vulnerable incumbent' : 'Incumbent') : f.office ?? 'Challenger'}
                    {f.incumbent && f.incFactors.length > 0 && <span title={`Incumbency advantage ${Math.round(f.incStrength * 100)}%: ${f.incFactors.join(', ')}`}> · {f.incFactors.join(', ')}</span>}
                    {c.stage === 'primary' && !f.inMyPrimary && ' · other party primary'}
                    {f.scandal > 0.1 && <span style={{ color: 'var(--rep)' }}> · scandal</span>}
                    {f.presses && <span title={`Their campaign says you are out of step on ${f.presses.toLowerCase()}; the issue weighs more with voters in this race.`}> · hitting you on {f.presses.toLowerCase()}</span>}
                  </div>
                </div>
                <PartyTag party={f.party} />
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-2">
                <Meter small value={f.rec} label="Known" right={pct(f.rec)} color={colors[f.id]} />
                <Meter small value={f.fav} label="Favorable" right={pct(f.fav)} color={colors[f.id]} />
                <div className="text-xs"><div className="muted">Spent</div><div className="num font-medium">{money(f.spend)}</div></div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Polling" right={last && <span className="muted text-[11px] num">±{(last.moe * 100).toFixed(1)} pts · {last.label}</span>}>
        {c.pressed.length > 0 && <div className="muted mb-1 text-[11px]">The race is being fought on: {c.pressed.join(', ').toLowerCase()}.</div>}
        {c.polls.length === 0 ? (
          <div className="muted text-xs">Your first internal poll comes in at the end of this month.</div>
        ) : (
          <EChart
            height={170}
            option={{
              legend: { show: false },
              xAxis: { type: 'category', data: c.polls.map((p) => p.label) },
              yAxis: { type: 'value', min: 0, max: (v: any) => Math.min(1, Math.ceil(v.max * 10) / 10 + 0.05), axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } },
              tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(v * 100).toFixed(1)}%` },
              series: [...pollField.filter(() => media.length > 0).map((f) => ({ id: `m-${f.id}`, name: `${f.name} (media)`, type: 'line' as const, symbol: 'diamond', symbolSize: 9, showAllSymbol: true, lineStyle: { width: 0 }, data: c.polls.map((p) => media.find((m) => m.label === p.label)?.shares[f.id] ?? null), itemStyle: { color: f.isPlayer ? css('--accent') : colors[f.id], opacity: 0.75 } })), ...pollField.map((f) => ({ id: f.id, name: f.name, type: 'line' as const, smooth: true, symbolSize: 5, data: c.polls.map((p) => p.shares[f.id] ?? null), lineStyle: { width: f.isPlayer ? 3 : 2, color: f.isPlayer ? css('--accent') : colors[f.id] }, itemStyle: { color: f.isPlayer ? css('--accent') : colors[f.id] } })), { id: 'u', name: 'Undecided', type: 'line' as const, data: c.polls.map((p) => p.shares.undecided), lineStyle: { type: 'dashed' as const, color: '#94a3b8' }, itemStyle: { color: '#94a3b8' }, symbol: 'none' }],
            }}
          />
        )}
      </Card>

      {last?.blocs && <Crosstabs blocs={last.blocs} field={pollField} colors={colors} />}

      {mainOpp && (
        <Card title={`Issue contrast vs ${mainOpp.name}`}>
          <EChart
            height={220}
            option={{
              tooltip: { trigger: 'item' },
              radar: { radius: '62%', indicator: ISSUES.map((i) => ({ name: i.label, min: -1, max: 1 })), axisName: { color: css('--muted'), fontSize: 9 }, splitLine: { lineStyle: { color: css('--line') } }, splitArea: { show: false }, axisLine: { lineStyle: { color: css('--line') } } },
              series: [{ type: 'radar', data: [
                { name: 'You', value: me.pos, lineStyle: { color: css('--accent') }, itemStyle: { color: css('--accent') }, areaStyle: { opacity: 0.15, color: css('--accent') } },
                { name: mainOpp.name, value: mainOpp.pos, lineStyle: { color: colors[mainOpp.id] }, itemStyle: { color: colors[mainOpp.id] }, areaStyle: { opacity: 0.1, color: colors[mainOpp.id] } },
              ] }],
            }}
          />
          <div className="muted text-[11px]">Outer edge = conservative, center = progressive. Voters weigh issues differently by demographic group.</div>
        </Card>
      )}

      {c.debates.length > 0 && (
        <Card title="Debates">
          {c.debates.map((d, i) => (
            <div key={i} className="text-xs">
              {d.year ? `${monthName(d.month)} ${d.year}` : `Month ${d.month}`}{d.stage ? ` (${d.stage})` : ''}: {c.field.find((f) => f.id === d.winner)?.name ?? 'Unknown'} won
              {d.answers && <span className="muted"> · your answers: {d.answers.map((a) => `${ISSUES.find((x) => x.key === a.issue)?.label.toLowerCase()} ${a.answer ?? 'unprepared'} (${a.quality >= 0.12 ? 'landed' : a.quality >= 0 ? 'fine' : 'flat'})`).join(', ')}</span>}
            </div>
          ))}
        </Card>
      )}

      <Actions />

      <div className="flex justify-end">
        <button className="btn-ghost !text-xs" onClick={() => confirm('Withdraw from this race?') && run(() => sim.withdraw())}>Withdraw from race</button>
      </div>
    </div>
  );
}

/** Poll crosstabs (M16): the latest internal poll by voter group. Small groups carry big margins of error. */
function Crosstabs({ blocs, field, colors }: { blocs: NonNullable<PollPoint['blocs']>; field: { id: string; name: string; isPlayer: boolean }[]; colors: Record<string, string> }) {
  const shown = field.slice(0, 4);
  return (
    <Card title="Crosstabs" right={<span className="muted text-[11px]">latest poll, decided voters</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs num">
          <thead>
            <tr className="muted text-left">
              <th className="py-0.5 pr-2 font-normal">Group</th>
              <th className="py-0.5 pr-2 font-normal">Share</th>
              {shown.map((f) => <th key={f.id} className="py-0.5 pr-2 font-normal" style={{ color: colors[f.id] }}>{f.isPlayer ? 'You' : f.name.split(' ').slice(-1)[0]}</th>)}
              <th className="py-0.5 font-normal">±</th>
            </tr>
          </thead>
          <tbody>
            {blocs.map((b) => {
              const lead = shown.reduce((a, f) => ((b.shares[f.id] ?? 0) > (b.shares[a.id] ?? 0) ? f : a), shown[0]);
              return (
                <tr key={b.label} className="border-t" style={{ borderColor: 'var(--line)' }}>
                  <td className="py-0.5 pr-2">{b.label}</td>
                  <td className="muted py-0.5 pr-2">{pct(b.weight)}</td>
                  {shown.map((f) => <td key={f.id} className="py-0.5 pr-2" style={{ fontWeight: f.id === lead.id ? 600 : undefined }}>{pct(b.shares[f.id] ?? 0)}</td>)}
                  <td className="muted py-0.5">{Math.round(b.moe * 100)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted mt-1 text-[11px]">Under 30 and seniors overlap the other groups. A better campaign manager polls more people, so the margins shrink.</div>
    </Card>
  );
}
