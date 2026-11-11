import { pct, sim, useGame } from '../../store/game';
import { BLOCS } from '../../sim/issues';
import { METRIC_INFO } from '../../sim/governing';
import { Card, EChart, Empty, Meter, Stat } from '../kit';
import { Actions } from './Actions';

export function OfficePanel() {
  const { view, run, busy, setTab } = useGame();
  if (!view) return null;
  const o = view.me.office;
  if (!o)
    return (
      <Empty>
        You don't hold office yet. Win an election to govern.
        <div className="mt-2"><button className="btn-primary" onClick={() => setTab('run')}>Run for office</button></div>
      </Empty>
    );
  const P = view.player;
  const approval = view.me.approval;
  const hist = view.history.filter((h) => h.year * 12 + h.month >= (o.since ?? view.year) * 12 + 1);

  return (
    <div className="space-y-3">
      <Card>
        <div className="label">In office since {o.since}</div>
        <h2 className="text-lg font-bold">{o.title}</h2>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Approval" value={pct(approval)} tone={approval >= 0.5 ? 'good' : 'bad'} />
          <Stat label="Party standing" value={Math.round(P.partyStanding)} sub="of 100" />
          <Stat label="Next election" value={o.nextElection} />
        </div>
        {hist.length > 1 && (
          <EChart
            height={110}
            option={{
              xAxis: { type: 'category', data: hist.map((h) => `${h.month}/${String(h.year).slice(2)}`) },
              yAxis: { type: 'value', min: 0.2, max: 0.8, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } },
              tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(v * 100).toFixed(1)}%` },
              series: [{ type: 'line', name: 'Approval', smooth: true, symbol: 'none', data: hist.map((h) => h.approval), areaStyle: { opacity: 0.12 }, markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0.5 }], lineStyle: { type: 'dashed', color: '#94a3b8' } } }],
            }}
          />
        )}
      </Card>

      <Card title={`Decisions (${view.decisions.length})`}>
        {view.decisions.length === 0 && <div className="muted text-xs">Nothing on your desk. New bills and events arrive each month.</div>}
        <div className="space-y-2">
          {view.decisions.map((d) => (
            <div key={d.id} className="panel-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold leading-snug">{d.title}</div>
                <span className="chip shrink-0" style={{ border: '1px solid var(--line)' }}>due {d.deadline.month}/{String(d.deadline.year).slice(2)}</span>
              </div>
              <p className="muted mt-1 text-xs">{d.body}</p>
              <div className="mt-2 grid gap-1.5">
                {d.options.map((opt, i) => (
                  <button key={i} disabled={busy} onClick={() => run(() => sim.decide(d.id, i))} className="btn-ghost !justify-between !text-left !text-xs">
                    <span className="font-medium">{opt.label}</span>
                    <span className="muted truncate pl-2 text-[11px]">{P.staff.policy >= 1 || i < 2 ? opt.detail : 'Hire a policy director to preview'}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Approval by voter group">
        <div className="space-y-1.5">
          {BLOCS.map((b, i) => (
            <Meter key={b.key} value={P.blocApproval[i]} label={b.label} right={pct(P.blocApproval[i])} color={P.blocApproval[i] >= 0.5 ? 'var(--accent)' : 'var(--rep)'} />
          ))}
        </div>
      </Card>

      <Card title={o.executive ? 'Jurisdiction performance' : 'Legislative performance'}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {Object.entries(METRIC_INFO)
            .filter(([k]) => P.metrics[k] != null && (o.executive || k === 'effectiveness'))
            .map(([k, info]) => {
              const v = P.metrics[k];
              const good = k === 'budget' ? v >= 0 : info.good === 'up' ? v >= info.base : v <= info.base;
              const disp = k === 'budget' ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : v.toFixed(0);
              return <Meter key={k} small value={k === 'budget' ? (v + 10) / 20 : v / 100} label={info.label} right={disp} color={good ? 'var(--accent)' : 'var(--rep)'} />;
            })}
        </div>
      </Card>

      {P.record.length > 0 && (
        <Card title="Your record">
          <ul className="space-y-1 text-xs">
            {P.record.slice(0, 12).map((r, i) => (
              <li key={i} className="flex justify-between gap-2 border-b pb-1 hairline">
                <span className="truncate">{r.title}</span>
                <span className="muted shrink-0">{r.choice} · {r.month}/{String(r.year).slice(2)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Actions />
    </div>
  );
}
