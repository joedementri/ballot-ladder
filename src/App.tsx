import { Component, useEffect, useRef, type ReactNode } from 'react';
import { useGame, type Tab } from './store/game';
import { MapView } from './ui/map/MapView';
import { Inspector } from './ui/panels/Inspector';
import { TopBar } from './ui/TopBar';
import { Creation } from './ui/creation/Creation';
import { CampaignPanel } from './ui/hq/CampaignPanel';
import { RunPanel } from './ui/hq/RunPanel';
import { OfficePanel } from './ui/hq/OfficePanel';
import { StatsPanel } from './ui/hq/StatsPanel';
import { CareerPanel, NewsPanel } from './ui/hq/NewsCareer';
import { ElectionNight } from './ui/election/ElectionNight';

const TABS: { id: Tab; label: string }[] = [
  { id: 'campaign', label: 'Campaign' },
  { id: 'office', label: 'Office' },
  { id: 'run', label: 'Run' },
  { id: 'stats', label: 'Stats' },
  { id: 'news', label: 'News' },
  { id: 'career', label: 'Career' },
];

export default function App() {
  const { phase, boot, loadError, view, tab, setTab, toasts } = useGame();
  useEffect(() => {
    boot();
  }, [boot]);

  if (loadError)
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel max-w-md p-6 text-sm">
          <h1 className="mb-2 text-lg font-semibold">Couldn't load game data</h1>
          <p className="muted">{loadError}</p>
        </div>
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      {phase === 'play' && <TopBar />}
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <main className="relative min-h-0 flex-1 max-md:h-[45vh] max-md:flex-none">
          <MapView />
          <Inspector />
        </main>
        {phase === 'play' && view && (
          <aside className="flex min-h-0 w-[460px] shrink-0 flex-col border-l hairline max-lg:w-[400px] max-md:w-full max-md:flex-1 max-md:border-l-0 max-md:border-t" style={{ background: 'var(--bg)' }}>
            <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 hairline" style={{ background: 'var(--panel)' }}>
              {TABS.map((t) => {
                const badge = t.id === 'office' ? view.decisions.length : t.id === 'campaign' && view.campaign && view.campaign.stage !== 'done' ? '●' : 0;
                return (
                  <button key={t.id} onClick={() => setTab(t.id)} className="relative shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors" style={tab === t.id ? { background: 'var(--panel-2)', color: 'var(--text)', boxShadow: 'inset 0 -2px 0 var(--accent)' } : { color: 'var(--muted)' }}>
                    {t.label}
                    {!!badge && <span className="ml-1 text-[10px]" style={{ color: 'var(--accent)' }}>{badge}</span>}
                  </button>
                );
              })}
            </nav>
            <PanelScroll>
              {tab === 'campaign' && <CampaignPanel />}
              {tab === 'office' && <OfficePanel />}
              {tab === 'run' && <RunPanel />}
              {tab === 'stats' && <StatsPanel />}
              {tab === 'news' && <NewsPanel />}
              {tab === 'career' && <CareerPanel />}
            </PanelScroll>
          </aside>
        )}
        {(phase === 'title' || phase === 'create' || phase === 'loading') && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-stretch justify-end p-3 max-md:items-end">
            <div className="pointer-events-auto flex max-h-full w-full max-w-[480px] max-md:max-h-[60vh]">
              {phase === 'create' ? <Creation /> : <Title />}
            </div>
          </div>
        )}
      </div>
      {view?.pendingNight && phase === 'play' && <ElectionNight night={view.pendingNight as any} />}
      {view?.gameOver && phase === 'play' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="panel max-w-md p-6 text-center">
            <h2 className="mb-2 text-xl font-bold">Career over</h2>
            <p className="muted mb-4 text-sm">{view.gameOver}</p>
            <button className="btn-primary" onClick={() => useGame.getState().setPhase('title')}>Title screen</button>
          </div>
        </div>
      )}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="panel rise px-4 py-2 text-sm shadow-xl" style={{ borderLeft: `3px solid ${t.tone === 'good' ? 'var(--accent)' : t.tone === 'bad' ? 'var(--rep)' : 'var(--line)'}` }}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function PanelScroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const tab = useGame((s) => s.tab);
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [tab]);
  return (
    <div ref={ref} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
      <PanelBoundary key={tab}>{children}</PanelBoundary>
    </div>
  );
}

function Title() {
  const { phase, setPhase, hasSave, continueGame, importSave, toast, busy } = useGame();
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="panel rise flex w-full flex-col justify-between gap-6 overflow-y-auto p-6 shadow-2xl">
      <div>
        <div className="mb-4 flex items-center gap-3">
          <svg width="44" height="44" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M8 22h16M10 22V12m6 10V8m6 14v-7" stroke="var(--panel)" strokeWidth="3" strokeLinecap="round" /></svg>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Ballot Ladder</h1>
            <div className="muted text-sm">An American political career simulator</div>
          </div>
        </div>
        <p className="text-sm leading-relaxed">
          Start on a town council. Climb to the statehouse, Congress, the governor's mansion — and maybe the White House.
        </p>
        <ul className="muted mt-3 space-y-1.5 text-sm">
          <li>• Every county, congressional and legislative district, plus 35,000+ towns and townships</li>
          <li>• Real election history (2008–2024) and Census demographics drive every race</li>
          <li>• ~7,500 simulated officeholders; real party control at start, fictional names</li>
          <li>• Campaign month by month, survive primaries, govern, and build a record</li>
        </ul>
      </div>
      <div className="space-y-2">
        <button className="btn-primary w-full !py-2.5 !text-base" disabled={phase === 'loading'} onClick={() => setPhase('create')}>
          {phase === 'loading' ? 'Loading map data…' : 'New career'}
        </button>
        {hasSave && <button className="btn-ghost w-full !py-2" disabled={busy} onClick={continueGame}>Continue saved game</button>}
        <button className="btn-ghost w-full !py-2" disabled={phase === 'loading'} onClick={() => file.current?.click()}>Import save file</button>
        <input ref={file} type="file" accept="application/json" className="hidden" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try { await importSave(await f.text()); } catch (err) { toast(String(err), 'bad'); }
        }} />
        <p className="muted pt-2 text-[11px] leading-snug">Explore the map while you decide — switch layers and colour modes at top-left. All people in the game are fictional. Data: US Census Bureau, MIT Election Data + Science Lab, Open States.</p>
      </div>
    </div>
  );
}

/** Keeps a crash in one panel from taking down the whole game. */
class PanelBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: String(e) };
  }
  render() {
    if (this.state.error)
      return (
        <div className="panel p-4 text-sm">
          <div className="font-semibold">This panel hit an error</div>
          <div className="muted mt-1 text-xs">{this.state.error}</div>
          <button className="btn-ghost mt-3" onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    return this.props.children;
  }
}
