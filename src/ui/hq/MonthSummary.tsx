import type { ReactNode } from 'react';
import { money, useGame } from '../../store/game';
import { HelpLabel } from '../kit';
import type { MonthSummary as Summary } from '../../sim/model';

/** "What changed and why" after each End Month. */
export function MonthSummary() {
  const { view, summaryOpen, openSummary, summaryAuto, setSummaryAuto, setTab } = useGame();
  const s = view?.summary as Summary | null | undefined;
  if (!view || !s || !summaryOpen || view.pendingNight) return null;
  const close = () => openSummary(false);
  const pts = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={close}>
      <div role="dialog" aria-modal="true" aria-label={`${s.monthName} ${s.year} summary`} className="panel rise flex max-h-[92vh] w-full max-w-xl flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="border-b p-4 hairline">
          <div className="label">Month in review{s.context ? ` · ${s.context}` : ''}</div>
          <h2 className="text-lg font-bold">{s.monthName} {s.year}</h2>
        </header>
        <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Delta label="Cash" from={s.cash[0]} to={s.cash[1]} fmt={money} />
            <Delta label="Known by" from={s.rec[0]} to={s.rec[1]} fmt={pts} />
            {s.approval ? <Delta label="Approval" from={s.approval[0]} to={s.approval[1]} fmt={pts} /> : <Delta label="Favorable" from={s.fav[0]} to={s.fav[1]} fmt={pts} />}
            <Delta label="Party standing" from={s.partyStanding[0]} to={s.partyStanding[1]} fmt={(x) => `${Math.round(x)}`} />
            {s.poll && (
              <>
                <Delta label="Poll" from={s.poll.me[0]} to={s.poll.me[1]} fmt={pts} sub="you" />
                <Delta label={s.poll.rivalName} from={s.poll.rival[0]} to={s.poll.rival[1]} fmt={pts} sub="top rival" invert />
              </>
            )}
          </div>

          {s.why.length > 0 && (
            <Section title="Why">
              <ul className="space-y-1.5 text-sm">
                {s.why.map((w, i) => <li key={i} className="flex gap-2"><span style={{ color: 'var(--accent)' }}>•</span><span>{w}</span></li>)}
              </ul>
            </Section>
          )}

          {s.money.length > 0 && (
            <Section title="Money">
              <table className="w-full text-sm">
                <tbody>
                  {s.money.map((m) => (
                    <tr key={m.label} className="border-b hairline last:border-0">
                      <td className="py-1">{m.label}</td>
                      <td className="num py-1 text-right font-medium" style={{ color: m.amount >= 0 ? 'var(--accent)' : 'var(--rep)' }}>{m.amount >= 0 ? '+' : '−'}{money(Math.abs(m.amount))}</td>
                    </tr>
                  ))}
                  <tr><td className="pt-1.5 font-semibold">Campaign cash</td><td className="num pt-1.5 text-right font-semibold">{money(s.cash[0])} → {money(s.cash[1])}</td></tr>
                </tbody>
              </table>
            </Section>
          )}

          <Section title={`Your actions (${s.actions.length})`}>
            {s.actions.length ? (
              <ul className="space-y-1 text-sm">
                {s.actions.map((a, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="min-w-0"><span className="font-medium">{a.label}</span> <span className="muted">{a.msg}</span></span>
                    {a.cash !== 0 && <span className="num shrink-0 text-xs" style={{ color: a.cash > 0 ? 'var(--accent)' : 'var(--muted)' }}>{a.cash > 0 ? '+' : '−'}{money(Math.abs(a.cash))}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted text-sm">None. Action points don't carry over, so use them every month.</p>
            )}
          </Section>

          {s.events.length > 0 && (
            <Section title="What happened">
              <ul className="space-y-1 text-sm">
                {s.events.map((e, i) => (
                  <li key={i} className="flex gap-2"><span style={{ color: e.tone === 'good' ? 'var(--accent)' : e.tone === 'bad' ? 'var(--rep)' : 'var(--muted)' }}>●</span><span>{e.title}</span></li>
                ))}
              </ul>
            </Section>
          )}

          {s.next.length > 0 && (
            <Section title="Coming up">
              <ul className="space-y-1 text-sm">{s.next.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </Section>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t p-3 hairline">
          <label className="muted flex items-center gap-2 text-xs">
            <input type="checkbox" checked={summaryAuto} onChange={(e) => setSummaryAuto(e.target.checked)} />
            Show after every month
          </label>
          <div className="flex gap-2">
            {view.decisions.length > 0 && <button className="btn-ghost" onClick={() => { setTab('office'); close(); }}>Decisions ({view.decisions.length})</button>}
            <button className="btn-primary" autoFocus onClick={close}>Continue</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="label mb-1.5">{title}</h3>
      {children}
    </section>
  );
}

function Delta({ label, from, to, fmt, sub, invert }: { label: string; from: number | null; to: number; fmt: (x: number) => string; sub?: string; invert?: boolean }) {
  const d = from == null ? 0 : to - from;
  const good = invert ? d < 0 : d > 0;
  const flat = Math.abs(d) < 1e-3 || fmt(from ?? to) === fmt(to);
  return (
    <div className="panel-2 min-w-0 p-2">
      <div className="label truncate"><HelpLabel label={label} /></div>
      <div className="num text-base font-semibold leading-tight">{fmt(to)}</div>
      <div className="num text-[11px]" style={{ color: flat ? 'var(--muted)' : good ? 'var(--accent)' : 'var(--rep)' }}>
        {from == null ? (sub ?? 'first poll') : flat ? `no change${sub ? ` · ${sub}` : ''}` : `${d > 0 ? '▲' : '▼'} from ${fmt(from)}${sub ? ` · ${sub}` : ''}`}
      </div>
    </div>
  );
}
