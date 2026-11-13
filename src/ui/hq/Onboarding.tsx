import { useState } from 'react';
import { useGame, type Tab } from '../../store/game';

const key = (seed: number) => `onboarding-done-${seed}`;
const readDone = (seed: number) => {
  try { return localStorage.getItem(key(seed)) === '1'; } catch { return false; }
};

/** First-month checklist. Shown at the top of the side panel until done or dismissed. */
export function Onboarding() {
  const { view, setTab } = useGame();
  const [dismissed, setDismissed] = useState(() => (view ? readDone(view.seed) : true));
  if (!view || dismissed) return null;
  const log = view.player.log;
  const months = view.history.length;
  // Only for new careers: the first few months
  if (months > 4 || view.me.office) return null;
  const steps: { done: boolean; text: string; hint: string; tab?: Tab; go?: string }[] = [
    { done: !!view.campaign, text: 'File to run for a seat', hint: 'The Run tab lists every office that represents your home. A council seat is the usual first rung.', tab: 'run', go: 'Run tab' },
    { done: log.some((x) => x.id.startsWith('fund_') || x.id === 'self_fund'), text: 'Raise some money', hint: 'Small-dollar fundraising is cheap on action points. Ads and canvassing cost cash.', tab: 'campaign', go: 'Actions' },
    { done: log.some((x) => ['town_hall', 'canvass', 'rally', 'community'].includes(x.id)), text: 'Hold an event in a town', hint: 'Events build name recognition where you hold them. Repeating the same place in one month has diminishing returns.', tab: 'campaign', go: 'Actions' },
    { done: months > 1, text: 'End the month', hint: 'Unused action points are lost. After each month you get a summary of what changed and why.' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const dismiss = () => {
    try { localStorage.setItem(key(view.seed), '1'); } catch { /* ignore */ }
    setDismissed(true);
  };
  if (doneCount === steps.length && months > 2) return null;
  return (
    <section className="panel rise mb-3 p-3" style={{ borderLeft: '3px solid var(--accent)' }} aria-label="Getting started">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="label">Getting started · {doneCount}/{steps.length}</h3>
        <button className="muted text-xs hover:underline" onClick={dismiss}>Dismiss</button>
      </header>
      <ol className="space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span className="num mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold" style={{ background: s.done ? 'var(--accent)' : 'var(--panel-2)', color: s.done ? 'var(--panel)' : 'var(--muted)', border: '1px solid var(--line)' }}>
              {s.done ? '✓' : i + 1}
            </span>
            <div className="min-w-0">
              <div className={s.done ? 'muted line-through' : 'font-medium'}>
                {s.text}
                {!s.done && s.tab && <button className="ml-2 text-xs font-normal underline" style={{ color: 'var(--accent)' }} onClick={() => setTab(s.tab!)}>{s.go}</button>}
              </div>
              {!s.done && <div className="muted text-[11px] leading-snug">{s.hint}</div>}
            </div>
          </li>
        ))}
      </ol>
      <p className="muted mt-2 text-[11px]">Tip: hover or tap any underlined label for an explanation.</p>
    </section>
  );
}
