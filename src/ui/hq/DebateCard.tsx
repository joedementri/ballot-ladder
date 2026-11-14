import { sim, useGame } from '../../store/game';
import { Card } from '../kit';
import type { DebateAnswer } from '../../sim/model';

const ANSWERS: { key: DebateAnswer; label: string }[] = [
  { key: 'policy', label: 'Policy answer' },
  { key: 'pivot', label: 'Pivot' },
  { key: 'attack', label: 'Attack' },
];
const HINT_COLOR = { strong: 'var(--accent)', fair: 'var(--muted)', risky: 'var(--rep)' };

/** Where the audience, you and your opponent sit on one issue (−1 progressive … +1 conservative). */
function Scale({ audience, mine, opp }: { audience: number; mine: number; opp: number | null }) {
  const at = (x: number) => `${((x + 1) / 2) * 100}%`;
  const dot = (x: number, color: string, title: string, size = 10) => (
    <span title={title} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: at(x), width: size, height: size, background: color, border: '1px solid var(--panel)' }} />
  );
  return (
    <div className="relative my-1.5 h-3" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: 'var(--line)' }} />
      <span title={`Audience ${audience.toFixed(2)}`} className="absolute top-0 h-3 w-0.5 -translate-x-1/2" style={{ left: at(audience), background: 'var(--text, currentColor)' }} />
      {opp != null && dot(opp, '#94a3b8', `Opponent ${opp.toFixed(2)}`)}
      {dot(mine, 'var(--accent)', `You ${mine.toFixed(2)}`)}
    </div>
  );
}

/**
 * Debate prep (M16): the month before a debate, answer each of the three questions with a policy answer, a pivot to
 * your best issue, or an attack on the leading opponent. Unprepared debates fall back to a roll on skills and prep.
 */
export function DebateCard() {
  const { view, run, busy } = useGame();
  const plan = view?.campaign?.debatePlan;
  if (!plan) return null;
  const answered = plan.questions.filter((q) => q.answer).length;
  return (
    <Card title="Debate prep" right={<span className="muted text-[11px]">{answered}/3 answered · debate at month end</span>}>
      <div className="muted mb-2 text-[11px]">
        Bar: progressive ← → conservative. Line = this audience, <span style={{ color: 'var(--accent)' }}>●</span> you{plan.opponent && <>, <span style={{ color: '#94a3b8' }}>●</span> {plan.opponent}</>}.
        {!plan.staffed && ' Hire a policy director to see how each answer is likely to land.'}
      </div>
      <div className="space-y-2">
        {plan.questions.map((q, qi) => (
          <div key={q.issue} className="panel-2 p-2 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">Q{qi + 1}: {q.label}</span>
              <span className="muted text-[11px]">Pivot goes to {q.pivotLabel.toLowerCase()}</span>
            </div>
            <Scale audience={q.audience} mine={q.mine} opp={q.opp} />
            <div className="grid grid-cols-3 gap-1">
              {ANSWERS.map((a) => {
                const on = q.answer === a.key;
                const hint = q.hints?.[a.key];
                return (
                  <button
                    key={a.key} disabled={busy || (a.key === 'attack' && q.opp == null)} aria-pressed={on}
                    onClick={() => run(() => sim.answerDebate(qi, a.key))}
                    className="btn-ghost !block !px-1.5 !py-1 !text-center !text-[11px]"
                    style={on ? { background: 'var(--accent)', color: 'var(--panel)', borderColor: 'var(--accent)' } : undefined}
                  >
                    <span className="block font-medium">{a.label}</span>
                    {hint && <span className="block text-[10px]" style={{ color: on ? undefined : HINT_COLOR[hint] }}>{hint}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
