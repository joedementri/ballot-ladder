import { useRef, useState } from 'react';
import { SKIP_MONTHS, money, pct, useGame } from '../store/game';
import { HelpLabel, PartyTag, useHotkeys } from './kit';
import type { GameView } from '../sim/game';

/** Shortcuts shown in the menu (App.tsx registers them). */
export const SHORTCUTS: [string, string][] = [
  ['E', 'End month'],
  ['S', 'Skip ahead'],
  ['1–6', 'Switch tabs'],
  ['M', "Last month's summary"],
  ['Esc', 'Close dialogs and menus'],
];

/** Skip is offered when the player isn't in a live race and nothing blocks the turn. */
export const canSkip = (view: GameView | null, busy: boolean) =>
  !!view && !busy && !view.pendingNight && !view.gameOver && !(view.campaign && view.campaign.stage !== 'done');

/** Skip ahead, after confirming if pending decisions would expire unanswered. */
export function requestSkip() {
  const { view, busy, skipAhead } = useGame.getState();
  if (!canSkip(view, busy)) return;
  const n = view!.decisions.length;
  if (n && !confirm(`${n} decision${n > 1 ? 's' : ''} pending will expire unanswered if you skip. Skip anyway?`)) return;
  void skipAhead();
}

export function TopBar() {
  const { view, endTurn, busy, toggleDark, dark, exportSave, importSave, setPhase, toast, openSummary, saveAsSlot } = useGame();
  const [menu, setMenu] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useHotkeys({ Escape: () => setMenu(false) }, menu);
  if (!view) return null;
  const c = view.campaign && view.campaign.stage !== 'done' ? view.campaign : null;
  const nextEvent = c ? (c.stage === 'primary' ? `Primary in ${c.monthsToPrimary} mo` : `Election in ${c.monthsToGeneral} mo`) : view.me.office ? (view.me.office.nextElection ? `Next race ${view.me.office.nextElection}` : 'Serving with the President') : 'Not running';
  const pending = view.decisions.length;

  const doExport = async () => {
    setMenu(false);
    const blob = await exportSave();
    const ext = blob.type === 'application/gzip' ? 'json.gz' : 'json';
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `ballot-ladder-${view.me.last.toLowerCase()}-${view.year}-${view.month}.${ext}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const doSaveAs = () => {
    setMenu(false);
    const name = prompt('Name for the new save slot:', `${view.me.name}, ${view.monthName} ${view.year}`);
    if (name != null) void saveAsSlot(name);
  };

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b px-3 hairline max-sm:h-auto max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-1 max-sm:py-1.5" style={{ background: 'var(--panel)' }}>
      <div className="flex min-w-0 items-center gap-2">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M8 22h16M10 22V12m6 10V8m6 14v-7" stroke="var(--panel)" strokeWidth="3" strokeLinecap="round" /></svg>
        <div className="hidden min-w-0 leading-tight sm:block">
          <div className="truncate text-sm font-semibold">{view.me.name} <PartyTag party={view.me.party} /></div>
          <div className="muted truncate text-[11px]">{view.me.office?.title ?? view.me.homeTown}</div>
        </div>
      </div>
      <div className="mx-auto flex min-w-0 items-center gap-4 text-xs max-sm:mx-0 max-sm:flex-1">
        <Pill label="Date" value={`${view.monthName} ${view.year}`} />
        <Pill label="Status" value={nextEvent} />
        <div className="flex items-center gap-4 max-sm:hidden">{resources(view)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!c && (
          <button className="btn-ghost max-sm:!px-2" disabled={!canSkip(view, busy)} onClick={requestSkip} aria-label="Skip ahead" title={`Skip to the next thing that needs you: a decision, a filing deadline or an election (up to ${SKIP_MONTHS} months). Shortcut: S`}>
            <span className="max-sm:hidden">Skip ahead </span><span aria-hidden>⏭</span>
          </button>
        )}
        <button className="btn-primary" disabled={busy || !!view.pendingNight || !!view.gameOver} onClick={endTurn} title={pending ? `${pending} decisions pending — unanswered ones expire` : 'Advance one month (shortcut: E)'}>
          {busy ? 'Simulating…' : 'End month'}
          {pending > 0 && <span className="rounded-full bg-black/25 px-1.5 text-[10px]">{pending}</span>}
        </button>
        <div className="relative">
          <button className="btn-ghost !px-2" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>☰</button>
          {menu && (
            <div className="panel absolute right-0 top-10 w-56 p-1 shadow-xl" role="menu" onMouseLeave={() => setMenu(false)}>
              {view.summary && <MenuItem onClick={() => { openSummary(true); setMenu(false); }}>Last month's summary</MenuItem>}
              <MenuItem onClick={doSaveAs}>Save as new slot…</MenuItem>
              <MenuItem onClick={doExport}>Export save file</MenuItem>
              <MenuItem onClick={() => file.current?.click()}>Import save file</MenuItem>
              <MenuItem onClick={() => { toggleDark(); setMenu(false); }}>{dark ? 'Light' : 'Dark'} theme</MenuItem>
              <MenuItem onClick={() => { if (confirm('Leave this game? It is autosaved.')) { setPhase('title'); setMenu(false); } }}>Title screen</MenuItem>
              <div className="mt-1 border-t px-3 pb-1 pt-2 hairline max-sm:hidden">
                <div className="label mb-1 !text-[10px]">Keyboard shortcuts</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {SHORTCUTS.map(([k, label]) => (
                    <div key={k} className="contents">
                      <dt><kbd className="num rounded px-1 text-[10px]" style={{ background: 'var(--panel-2)', border: '1px solid var(--line)' }}>{k}</kbd></dt>
                      <dd className="muted">{label}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}
          <input ref={file} type="file" accept=".json,.gz,application/json,application/gzip" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            setMenu(false);
            if (!f) return;
            try { await importSave(f); toast('Save loaded into a new slot', 'good'); } catch (err) { toast(String(err), 'bad'); }
          }} />
        </div>
      </div>
      <div className="hidden w-full justify-between text-xs max-sm:flex">{resources(view)}</div>
    </header>
  );
}

function resources(view: GameView) {
  const P = view.player;
  return (
    <>
      <Pill label="Cash" value={money(P.cash)} />
      <Pill label="Actions" value={`${P.ap}/${P.apMax}`} warn={P.ap === 0} />
      <Pill label="Energy" value={`${Math.round(P.energy)}`} warn={P.energy < 25} />
      <Pill label={view.me.office ? 'Approval' : 'Favorable'} value={pct(view.me.approval)} />
    </>
  );
}

function Pill({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="shrink-0 leading-tight">
      <div className="label !text-[10px]"><HelpLabel label={label} /></div>
      <div className="num font-semibold" style={{ color: warn ? 'var(--rep)' : undefined }}>{value}</div>
    </div>
  );
}
function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button role="menuitem" className="w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-[var(--panel-2)]" onClick={onClick}>{children}</button>;
}
