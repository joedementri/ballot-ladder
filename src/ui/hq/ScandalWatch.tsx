import { sim, useGame } from '../../store/game';
import { Card } from '../kit';

const STAGES = ['story', 'investigation', 'charges'] as const;
const STAGE_LABEL = { story: 'Story', investigation: 'Investigation', charges: 'Charges' };
const RESPONSE_LABEL: Record<string, string> = { apologize: 'Apologized', deny: 'Denied', attack: 'Attacked the press', lawyer: 'Lawyered up', silent: 'No comment' };
const END_LABEL: Record<string, string> = {
  faded: 'Faded', apologized: 'Ended with an apology', vindicated: 'Vindicated', cleared: 'Cleared', resigned: 'Resigned', pleaded: 'Plea deal', acquitted: 'Acquitted', convicted: 'Convicted',
};

/**
 * Scandal watch (M15): the player's stories with their stage and pending response, and open stories about opponents
 * in the race. Scandal decisions are answered here (the Office tab's decision list leaves them out).
 */
export function ScandalWatch() {
  const { view, run, busy } = useGame();
  const list = view?.scandals ?? [];
  if (!list.length) return null;
  return (
    <Card title="Scandal watch">
      <div className="space-y-2">
        {list.map((s) => {
          const at = STAGES.indexOf(s.stage);
          const d = s.decision;
          return (
            <div key={s.id} className="panel-2 p-2 text-xs" style={{ borderLeft: `3px solid ${s.ended ? 'var(--line)' : s.isPlayer ? 'var(--rep)' : 'var(--accent)'}`, opacity: s.ended ? 0.75 : 1 }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold leading-snug">{s.isPlayer ? 'You' : s.name}: {s.title}</div>
                  <div className="muted">
                    {s.severity} · since {s.since.month}/{String(s.since.year).slice(2)}
                    {s.response && ` · ${RESPONSE_LABEL[s.response]}`}
                    {s.exposed && <span style={{ color: s.isPlayer ? 'var(--rep)' : 'var(--accent)' }}> · denial exposed</span>}
                    {s.trial && !s.ended && ` · verdict ${s.trial.month}/${String(s.trial.year).slice(2)}`}
                  </div>
                </div>
                {s.ended && <span className="chip shrink-0" style={{ border: '1px solid var(--line)' }}>{END_LABEL[s.ended.how]}</span>}
              </div>
              {!s.ended && s.isPlayer && (
                <div className="mt-1.5 flex gap-1" aria-label={`Stage: ${STAGE_LABEL[s.stage]}`}>
                  {STAGES.map((st, i) => (
                    <span key={st} className="chip flex-1 justify-center text-center" style={{ background: i <= at ? 'var(--rep)' : 'transparent', color: i <= at ? 'var(--panel)' : undefined, border: '1px solid var(--line)', opacity: i === at ? 1 : 0.7 }}>
                      {STAGE_LABEL[st]}
                    </span>
                  ))}
                </div>
              )}
              {s.log.length > 0 && (
                <ul className="muted mt-1.5 space-y-0.5">
                  {s.log.slice(-3).map((l, i) => <li key={i}>{l.month}/{String(l.year).slice(2)}: {l.text}</li>)}
                </ul>
              )}
              {d && (
                <div className="mt-2">
                  <div className="mb-1 font-medium">{d.body}</div>
                  <div className="grid gap-1.5">
                    {d.options.map((opt, i) => (
                      <button key={i} disabled={busy} onClick={() => run(() => sim.decide(d.id, i))} className="btn-ghost !block w-full !text-left !text-xs">
                        <span className="block font-medium">{opt.label}</span>
                        <span className="muted block whitespace-normal text-[11px] font-normal">{opt.detail}</span>
                      </button>
                    ))}
                  </div>
                  <div className="muted mt-1 text-[11px]">Due {d.deadline.month}/{String(d.deadline.year).slice(2)}. {s.stage === 'charges' ? 'No answer means you fight the charges.' : 'No answer means no comment.'}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
