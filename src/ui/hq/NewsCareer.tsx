import { useState } from 'react';
import { money, pct, sim, useGame } from '../../store/game';
import { GROUPS, STAFF_ROLES, STAFF_TIER } from '../../sim/campaign';
import { ISSUES, ideologyLabel, ideologyScore } from '../../sim/issues';
import { Card, EChart, Empty, Meter, Seg, Stat, css } from '../kit';

const KIND_LABEL: Record<string, string> = { national: 'National', race: 'Race', player: 'You', office: 'Office', scandal: 'Scandal', election: 'Election' };

export function NewsPanel() {
  const { view } = useGame();
  const [filter, setFilter] = useState<'all' | 'mine' | 'national' | 'election'>('all');
  if (!view) return null;
  const items = view.news.filter((n) => filter === 'all' || (filter === 'mine' ? ['player', 'race', 'office', 'scandal'].includes(n.kind) : n.kind === filter));
  return (
    <div className="space-y-3">
      <Seg value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'My career' }, { value: 'national', label: 'National' }, { value: 'election', label: 'Elections' }]} />
      {items.length === 0 && <Empty>No news yet.</Empty>}
      <ul className="space-y-2">
        {items.map((n) => (
          <li key={n.id} className="panel rise p-3" style={{ borderLeft: `3px solid ${n.tone === 'good' ? 'var(--accent)' : n.tone === 'bad' ? 'var(--rep)' : 'var(--line)'}` }}>
            <div className="label flex justify-between">
              <span>{KIND_LABEL[n.kind]}</span>
              <span className="num">{n.month}/{n.year}</span>
            </div>
            <div className="mt-0.5 text-sm font-semibold leading-snug">{n.title}</div>
            {n.body && <p className="muted mt-0.5 text-xs leading-relaxed">{n.body}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CareerPanel() {
  const { view } = useGame();
  if (!view) return null;
  const me = view.me;
  const P = view.player;
  const ideo = ideologyScore(me.pos);
  return (
    <div className="space-y-3">
      <Card>
        <div className="label">{me.party === 'D' ? 'Democrat' : me.party === 'R' ? 'Republican' : 'Independent'} · {me.homeTown}</div>
        <h2 className="text-lg font-bold">{me.name}</h2>
        <div className="mt-2 grid grid-cols-4 gap-2">
          <Stat label="Age" value={me.age} />
          <Stat label="Ideology" value={<span className="text-sm">{ideologyLabel(ideo)}</span>} />
          <Stat label="Savings" value={money(P.personal)} />
          <Stat label="Favorable" value={pct(me.fav)} />
        </div>
      </Card>

      <Card title="Name recognition">
        <div className="space-y-1.5">
          <Meter value={P.recHome} label="Home town" right={pct(P.recHome)} />
          <Meter value={P.recCounty} label="Home county" right={pct(P.recCounty)} />
          <Meter value={P.recState} label="Home state" right={pct(P.recState)} />
          <Meter value={P.recUS} label="Nationally" right={pct(P.recUS)} />
        </div>
      </Card>

      <Card title="Career">
        {me.career.length === 0 ? (
          <div className="muted text-xs">Your story starts now.</div>
        ) : (
          <ol className="relative space-y-2 border-l pl-4 hairline">
            {[...me.career].reverse().map((c, i) => (
              <li key={i} className="text-xs">
                <span className="absolute -left-[5px] mt-1 h-2.5 w-2.5 rounded-full" style={{ background: c.result === 'won' || c.result === 'took-office' || c.result === 'appointed' ? 'var(--accent)' : c.result.startsWith('lost') ? 'var(--rep)' : 'var(--muted)' }} />
                <div className="font-medium">{c.year} · {c.title}</div>
                <div className="muted">{{ won: 'Won election', lost: 'Lost general', 'lost-primary': 'Lost primary', 'took-office': 'Took office', 'left-office': 'Left office', withdrew: 'Withdrew', appointed: 'Appointed' }[c.result]}{c.share != null && c.share < 1 ? ` · ${pct(c.share, 1)}` : ''}</div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title="Skills">
        <EChart
          height={200}
          option={{
            radar: { radius: '62%', indicator: Object.keys(me.skills).map((k) => ({ name: k[0].toUpperCase() + k.slice(1), max: 100 })), axisName: { color: css('--muted'), fontSize: 10 }, splitLine: { lineStyle: { color: css('--line') } }, splitArea: { show: false }, axisLine: { lineStyle: { color: css('--line') } } },
            series: [{ type: 'radar', data: [{ value: Object.values(me.skills), lineStyle: { color: css('--accent') }, itemStyle: { color: css('--accent') }, areaStyle: { opacity: 0.18, color: css('--accent') } }] }],
          }}
        />
      </Card>

      <Card title="Platform">
        <div className="space-y-1">
          {ISSUES.map((iss, i) => (
            <div key={iss.key} className="grid grid-cols-[100px_1fr] items-center gap-2 text-xs">
              <span className="truncate">{iss.label}</span>
              <div className="relative h-2 rounded-full" style={{ background: 'linear-gradient(90deg, #3b82f655, var(--line), #ef444455)' }}>
                <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: `${(me.pos[i] + 1) * 50}%`, background: 'var(--panel)', borderColor: 'var(--accent)' }} title={me.pos[i].toFixed(2)} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Staff & relationships">
        <div className="mb-3 grid grid-cols-2 gap-1 text-xs">
          {STAFF_ROLES.map((r) => (
            <div key={r.key} className="flex justify-between border-b pb-0.5 hairline"><span className="muted">{r.label}</span><span className="font-medium">{STAFF_TIER[P.staff[r.key]]}</span></div>
          ))}
          <div className="col-span-2 muted mt-1">Payroll {money(view.payroll)}/month</div>
        </div>
        <div className="space-y-1">
          {GROUPS.filter((g) => P.groups[g.key] != null || P.endorsements.includes(g.key)).map((g) => (
            <div key={g.key} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{g.label} {P.endorsements.includes(g.key) && <span className="chip" style={{ background: 'var(--accent)', color: 'var(--panel)' }}>endorsed</span>}</span>
              <span className="num" style={{ color: (P.groups[g.key] ?? 0) >= 0 ? 'var(--accent)' : 'var(--rep)' }}>{Math.round(P.groups[g.key] ?? 0)}</span>
            </div>
          ))}
        </div>
      </Card>

      <ResultsList />
    </div>
  );
}

function ResultsList() {
  const { view } = useGame();
  const [replay, setReplay] = useState<number | null>(null);
  if (!view?.results.length) return null;
  return (
    <Card title="Past elections">
      <ul className="space-y-1.5">
        {view.results.map((r, i) => {
          const tot = r.cands.reduce((a, c) => a + c.votes, 0) || 1;
          const w = r.cands.find((c) => c.id === r.winnerId);
          return (
            <li key={i} className="panel-2 flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium">{r.year} {r.stage} · {r.title}</div>
                <div className="muted truncate">{w?.name} won with {pct((w?.votes ?? 0) / tot, 1)}</div>
              </div>
              <button className="btn-ghost !py-0.5 !text-[11px]" disabled={replay === i} onClick={async () => { setReplay(i); const full = await sim.result(i); if (full) useGame.setState({ view: { ...view, pendingNight: { ...full, replay: true } as any } }); setReplay(null); }}>Replay</button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
