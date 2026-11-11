import { useRef, useState } from 'react';
import { money, pct, useGame } from '../store/game';
import { HelpLabel, PartyTag } from './kit';
import type { GameView } from '../sim/game';

export function TopBar() {
  const { view, endTurn, busy, toggleDark, dark, exportSave, importSave, setPhase, toast, openSummary } = useGame();
  const [menu, setMenu] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  if (!view) return null;
  const c = view.campaign && view.campaign.stage !== 'done' ? view.campaign : null;
  const P = view.player;
  const nextEvent = c ? (c.stage === 'primary' ? `Primary in ${c.monthsToPrimary} mo` : `Election in ${c.monthsToGeneral} mo`) : view.me.office ? `Next race ${view.me.office.nextElection}` : 'Not running';
  const pending = view.decisions.length;

  const doExport = async () => {
    const json = await exportSave();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `ballot-ladder-${view.me.last.toLowerCase()}-${view.year}-${view.month}.json` });
    a.click();
    URL.revokeObjectURL(url);
    setMenu(false);
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
        <button className="btn-primary" disabled={busy || !!view.pendingNight || !!view.gameOver} onClick={endTurn} title={pending ? `${pending} decisions pending — unanswered ones expire` : 'Advance one month'}>
          {busy ? 'Simulating…' : 'End month'}
          {pending > 0 && <span className="rounded-full bg-black/25 px-1.5 text-[10px]">{pending}</span>}
        </button>
        <div className="relative">
          <button className="btn-ghost !px-2" onClick={() => setMenu(!menu)} aria-label="Menu">☰</button>
          {menu && (
            <div className="panel absolute right-0 top-10 w-48 p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
              {view.summary && <MenuItem onClick={() => { openSummary(true); setMenu(false); }}>Last month's summary</MenuItem>}
              <MenuItem onClick={doExport}>Export save file</MenuItem>
              <MenuItem onClick={() => file.current?.click()}>Import save file</MenuItem>
              <MenuItem onClick={() => { toggleDark(); setMenu(false); }}>{dark ? 'Light' : 'Dark'} theme</MenuItem>
              <MenuItem onClick={() => { if (confirm('Leave this game? It is autosaved.')) { setPhase('title'); setMenu(false); } }}>Title screen</MenuItem>
            </div>
          )}
          <input ref={file} type="file" accept="application/json" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try { await importSave(await f.text()); toast('Save loaded', 'good'); } catch (err) { toast(String(err), 'bad'); }
            setMenu(false);
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
  return <button className="w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-[var(--panel-2)]" onClick={onClick}>{children}</button>;
}
