import type { GameView } from '../../sim/game';
import { data, useGame } from '../../store/game';
import { Card } from '../kit';
import { focusOn } from '../map/MapView';

type Pres = NonNullable<NonNullable<GameView['campaign']>['presRace']>;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

/** The presidential nomination: delegates won, the calendar, and the running mate. */
export function DelegateRace({ race, colors }: { race: Pres; colors: Record<string, string> }) {
  const max = Math.max(race.needed, ...race.candidates.map((c) => c.delegates)) * 1.05;
  const color = (id: string | null) => (id ? colors[id] ?? '#94a3b8' : 'var(--line)');
  const name = (id: string | null) => race.candidates.find((c) => c.id === id)?.name ?? '';
  return (
    <Card title="Delegate race" right={<span className="muted num text-[11px]">{race.needed.toLocaleString()} to clinch</span>} help={`A majority of pledged delegates (${race.needed.toLocaleString()} of ${race.total.toLocaleString()}) clinches the nomination. Democrats split each state's delegates proportionally (15% threshold); Republicans go winner-take-all from April, or earlier when someone tops 50%.`}>
      <div className="space-y-1.5">
        {race.candidates.map((c) => (
          <div key={c.id} className={c.out ? 'opacity-50' : ''}>
            <div className="flex justify-between gap-2 text-xs">
              <span className="truncate">
                <span className="font-medium" style={{ color: c.isPlayer ? 'var(--accent)' : undefined }}>{c.name}{c.isPlayer && ' (you)'}</span>
                <span className="muted"> · {c.home}{c.states ? ` · ${c.states} state${c.states > 1 ? 's' : ''} won` : ''}{c.out ? ` · withdrew ${MONTHS[c.out - 1]}` : ''}</span>
              </span>
              <span className="num shrink-0 font-semibold">{c.delegates.toLocaleString()}</span>
            </div>
            <div className="relative mt-0.5 h-2 rounded-full" style={{ background: 'var(--panel-2)' }}>
              <div className="h-2 rounded-full" style={{ width: `${(c.delegates / max) * 100}%`, background: c.isPlayer ? 'var(--accent)' : color(c.id) }} />
              <div className="absolute top-[-2px] h-3 w-px" style={{ left: `${(race.needed / max) * 100}%`, background: 'var(--text)' }} title={`${race.needed.toLocaleString()} to clinch`} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {race.calendar.map((m) => (
          <div key={m.month}>
            <div className="flex justify-between text-[11px]">
              <span className={m.done ? 'font-medium' : 'muted'}>{MONTHS[m.month - 1]} · {m.label}</span>
              <span className="muted num">{m.delegates.toLocaleString()} delegates</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {m.states.map((s) => (
                <button
                  key={s.st}
                  className="rounded px-1 text-[10px] font-semibold"
                  style={{ background: s.winner ? color(s.winner) : 'var(--panel-2)', color: s.winner ? '#fff' : 'var(--muted)', border: '1px solid var(--line)' }}
                  title={`${data.states[s.st]?.n ?? s.st}: ${s.delegates} delegates${s.winner ? ` · won by ${name(s.winner)}` : ''}`}
                  onClick={() => focusOn('state', s.st)}
                >
                  {s.st}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {race.vp && <div className="mt-3 text-xs">Running mate: <b>{race.vp.name}</b> <span className="muted">({race.vp.home})</span></div>}
    </Card>
  );
}

/** This cycle's presidential tickets (after the conventions). */
export function TicketsCard() {
  const { view } = useGame();
  if (!view?.tickets?.length) return null;
  return (
    <Card title={`${view.year} presidential tickets`}>
      <ul className="space-y-1 text-xs">
        {view.tickets.map((t) => (
          <li key={t.party} className="flex justify-between gap-2">
            <span style={{ color: t.party === 'D' ? 'var(--dem)' : 'var(--rep)' }} className="font-medium">{t.party === 'D' ? 'Democrats' : 'Republicans'}</span>
            <span className="truncate">{t.pres} / {t.mine ? <b style={{ color: 'var(--accent)' }}>you</b> : t.vp}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
