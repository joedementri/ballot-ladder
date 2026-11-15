import { pct, useGame } from '../../store/game';
import type { MeasureView } from '../../sim/measures';
import { Card } from '../kit';

const ORIGIN: Record<string, string> = { initiative: 'Citizen initiative', referred: 'Referred by the legislature', local: 'Local measure' };

/** One ballot measure: label, title, projected or final yes share, and the player's side. */
export function MeasureRow({ m, compact }: { m: Omit<MeasureView, 'canCampaign'>; compact?: boolean }) {
  const share = m.result ? m.share! : m.support;
  const tone = m.result ? (m.result.passed ? 'var(--accent)' : 'var(--rep)') : 'var(--muted)';
  return (
    <li className="panel-2 p-2 text-xs" style={{ borderLeft: `3px solid ${m.result ? tone : 'var(--line)'}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold leading-snug">
            {m.town ? `${m.place} ` : ''}{m.label}: {m.title}
          </div>
          {!compact && (
            <div className="muted">
              {ORIGIN[m.origin]} · {m.issue} ({m.dir < 0 ? 'progressive' : 'conservative'})
              {m.sponsored && ' · your referral'}
              {m.playerSide && !m.sponsored && ` · you campaigned ${m.playerSide > 0 ? 'for' : 'against'} it`}
            </div>
          )}
        </div>
        <span className="chip shrink-0 num" style={{ border: `1px solid ${tone}`, color: tone }}>
          {m.result ? `${m.result.passed ? 'Passed' : 'Failed'} ${pct(share, 1)}` : `${pct(share)} yes`}
        </span>
      </div>
      {!compact && !m.result && m.groups && <div className="muted mt-0.5 text-[11px]">{m.groups}</div>}
      <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--line)' }} aria-hidden>
        <div className="h-full" style={{ width: `${Math.round(share * 100)}%`, background: m.result ? tone : 'var(--accent)', opacity: m.result ? 1 : 0.6 }} />
      </div>
    </li>
  );
}

/**
 * Ballot measures in the player's state (M19): this cycle's statewide and local measures with their projected
 * support, or last cycle's results. Campaigning on one is an action (Outreach).
 */
export function MeasuresCard() {
  const { view } = useGame();
  const ms = view?.measures;
  if (!ms?.list.length) return null;
  const decided = ms.list.every((m) => m.result);
  return (
    <Card title="Ballot measures" right={<span className="muted text-xs">{ms.st} · {ms.year}</span>}>
      <ul className="space-y-1.5">
        {ms.list.map((m) => <MeasureRow key={m.id} m={m} />)}
      </ul>
      <p className="muted mt-2 text-[11px]">
        {decided ? 'Results of the last ballot. New measures qualify at the end of June in even years.' : 'Projected support, before election-day swing. Use "Campaign on a ballot measure" (Outreach) to move it.'}
      </p>
    </Card>
  );
}
