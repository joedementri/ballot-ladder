import { useEffect, useMemo, useState } from 'react';
import { pct, sim, useGame } from '../../store/game';
import type { BudgetInfo, LegislatureInfo } from '../../sim/game';
import { LEVERS, baselineBudget, budgetTargets, type LeverKey } from '../../sim/budget';
import { METRIC_INFO } from '../../sim/governing';
import { Card, HelpLabel, PartyTag } from '../kit';
import { Composition } from './Legislature';

type Levers = Record<LeverKey, number>;

export function useBudget() {
  const view = useGame((s) => s.view);
  const [b, setB] = useState<BudgetInfo | null>(null);
  useEffect(() => {
    let live = true;
    sim.budgetView().then((x) => live && setB(x));
    return () => { live = false; };
  }, [view]);
  return b;
}

const fmtPct = (x: number) => (Math.abs(x - 1) < 0.001 ? 'Baseline' : `${x > 1 ? '+' : '−'}${Math.round(Math.abs(x - 1) * 100)}%`);

export function BudgetCard({ info }: { info: BudgetInfo }) {
  const { run, busy, view } = useGame();
  const current = info.budget;
  const start = (): Levers => Object.fromEntries(LEVERS.map((l) => [l.key, current?.[l.key] ?? 1])) as Levers;
  const [draft, setDraft] = useState<Levers>(start);
  useEffect(() => setDraft(start()), [current?.year, current?.month]);
  const year = view?.year ?? 0;
  const projected = useMemo(() => budgetTargets({ ...baselineBudget(year, 1), ...draft }), [draft, year]);
  const hostile = info.control.filter((c) => c.share < 0.5);
  const enacted = current && current.year >= year && !current.note?.startsWith('Continuing');
  const rows = Object.entries(projected).filter(([, v]) => Math.abs(v) >= 0.5);
  return (
    <Card title={`${year} budget`} help="Set spending and tax levels for the year. The budget sets where your jurisdiction's numbers drift over the coming months, so effects build up slowly. Spending more is popular with the groups that benefit, but deficits count against you.">
      <div className="mb-2 text-xs">
        {enacted ? (
          <span>Enacted {current!.month}/{String(current!.year).slice(2)}.{current!.note && <span className="muted"> {current!.note}</span>} <span className="muted">Next budget in January.</span></span>
        ) : current?.note?.startsWith('Continuing') ? (
          <span style={{ color: 'var(--rep)' }}>Running on a continuing resolution. You can still pass a budget this year.</span>
        ) : (
          <span>Not yet submitted. Due by the end of March, or last year's levels carry over.</span>
        )}
      </div>
      <div className="space-y-2">
        {LEVERS.map((l) => (
          <label key={l.key} className="block">
            <div className="flex justify-between text-xs">
              <span className="muted"><HelpLabel label={l.label} help={l.help} /></span>
              <span className="num font-medium">{fmtPct(draft[l.key])}</span>
            </div>
            <input type="range" className="w-full" min={l.min} max={l.max} step={0.05} value={draft[l.key]} disabled={!info.canSubmit || busy}
              onChange={(e) => setDraft({ ...draft, [l.key]: Number(e.target.value) })} aria-label={l.label} />
          </label>
        ))}
      </div>
      <div className="panel-2 mt-2 p-2">
        <div className="label mb-1">Where this budget pulls your numbers</div>
        {rows.length ? (
          <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {rows.map(([k, v]) => {
              const info = METRIC_INFO[k];
              const good = info.good === 'up' ? v > 0 : v < 0;
              return (
                <li key={k} className="flex justify-between gap-2">
                  <span className="muted truncate">{info.label}</span>
                  <span className="num font-medium" style={{ color: good ? 'var(--accent)' : 'var(--rep)' }}>{v > 0 ? '+' : '−'}{Math.abs(v).toFixed(k === 'budget' ? 1 : 0)}{k === 'budget' ? '%' : ''}</span>
                </li>
              );
            })}
          </ul>
        ) : <p className="muted text-xs">A baseline budget keeps things where they are.</p>}
      </div>
      {hostile.length > 0 && info.canSubmit && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--rep)' }}>
          The other party controls the {hostile.map((h) => `${h.label} (you hold ${pct(h.share)})`).join(' and ')}. Expect them to scale your changes back.
        </p>
      )}
      <button className="btn-primary mt-2 w-full !py-1 !text-xs" disabled={busy || !info.canSubmit || (view?.player.ap ?? 0) < 2} onClick={() => run(() => sim.setBudget(draft))}>
        {info.canSubmit ? 'Submit budget (2 AP)' : 'Budget enacted for this year'}
      </button>
    </Card>
  );
}

/** For executives: the legislature they have to work with. */
export function ExecLegislatureCard({ leg }: { leg: LegislatureInfo }) {
  if (!leg.chambers.length) return null;
  return (
    <Card title="Your legislature" help="The body that sends you bills and votes on your budget. If the other party has two-thirds, it can override your vetoes.">
      <div className="space-y-2">
        {leg.chambers.map((c) => {
          const total = Object.values(c.parties).reduce((a, b) => a + b, 0) || 1;
          const top = Math.max(...Object.values(c.parties));
          return (
            <div key={c.key}>
              <div className="flex justify-between text-xs">
                <span className="font-medium">{c.label}</span>
                <span className="muted">{c.partisan ? `${c.majorityParty} majority${top / total >= 2 / 3 ? ' (veto-proof)' : ''}` : 'nonpartisan'}</span>
              </div>
              <Composition parties={c.parties} seats={c.seats} />
            </div>
          );
        })}
      </div>
      {leg.leaders.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {leg.leaders.map((l) => (
            <li key={l.label} className="flex justify-between gap-2"><span className="muted truncate">{l.label}</span><span className="shrink-0">{l.person?.name} <PartyTag party={l.person?.party} /></span></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Laws in force under the player's name or signature, and what they push. */
export function LawsCard({ policies }: { policies: { id: string; title: string; year: number; metrics: Record<string, number> }[] }) {
  if (!policies.length) return null;
  return (
    <Card title="Laws in effect" help="Laws you sponsored or signed keep pushing your jurisdiction's numbers for as long as you hold this office.">
      <ul className="space-y-1 text-xs">
        {policies.slice(0, 10).map((p) => (
          <li key={p.id} className="flex justify-between gap-2 border-b pb-1 hairline">
            <span className="truncate">{p.title}</span>
            <span className="muted shrink-0">
              {Object.entries(p.metrics).map(([k, v]) => `${METRIC_INFO[k]?.label.split(' ')[0] ?? k} ${v > 0 ? '+' : '−'}`).join(' · ')} · {p.year}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
