import { useEffect, useState } from 'react';
import { pct, sim, useGame } from '../../store/game';
import type { Opportunity } from '../../sim/game';
import { Card } from '../kit';

/** Seats emptied mid-term in the player's area: appointments to seek and special elections to run in. */
export function Opportunities() {
  const { view, run, busy } = useGame();
  const [list, setList] = useState<Opportunity[]>([]);
  useEffect(() => {
    let live = true;
    sim.opportunities().then((x) => live && setList(x));
    return () => { live = false; };
  }, [view]);
  if (!list.length) return null;
  return (
    <Card title="Openings" help="Officeholders sometimes leave mid-term. Most seats are filled by appointment (seek it if you are in the right party and it would be a step up); U.S. House seats, and Senate seats after an appointment, go to a special election.">
      <ul className="space-y-2">
        {list.map((o) => (
          <li key={`${o.kind}-${o.officeId}`} className="panel-2 p-2 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="label">{o.kind === 'appointment' ? `Appointment · ${o.by}` : 'Special election'}</div>
                <div className="truncate text-sm font-semibold">{o.title}</div>
                <div className="muted">The incumbent {o.reason}. {o.kind === 'appointment' ? `Decision ${o.when}.` : `Election ${o.when}.`}</div>
              </div>
              {o.kind === 'appointment' && (
                <div className="shrink-0 text-right">
                  {o.sought ? <span className="chip" style={{ background: 'var(--accent)', color: 'var(--panel)' }}>In the running</span> : o.ok ? (
                    <button className="btn-primary !py-0.5 !text-[11px]" disabled={busy || (view?.player.ap ?? 0) < 2} onClick={() => run(() => sim.seekAppointment(o.officeId))}>Seek it (2 AP)</button>
                  ) : <span className="muted">{o.why}</span>}
                  {o.odds != null && <div className="muted mt-0.5 num">odds {pct(o.odds)}</div>}
                </div>
              )}
              {o.kind === 'special' && <span className="muted shrink-0">{o.filed ? 'You filed' : 'File below'}</span>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
