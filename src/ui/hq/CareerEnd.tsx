/**
 * Career-end recap (M17): shown when the game is over (retirement, health, or anything else that sets gameOver).
 * Timeline, legacy score and rank, biggest wins and losses, rivals, achievements, and a shareable career card.
 */
import { pct, useGame } from '../../store/game';
import type { GameView } from '../../sim/game';
import { PartyTag, Stat, useHotkeys } from '../kit';
import { AchievementsCard, CAREER_LABEL, LegacyCard } from './NewsCareer';

export function CareerEnd() {
  const { view, setPhase, openRecap } = useGame();
  useHotkeys({ Escape: () => openRecap(false) });
  if (!view?.gameOver) return null;
  const me = view.me;
  const L = view.legacy;
  const rivals = view.rivals.filter((r) => r.wins + r.losses > 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Career over">
      <div className="panel rise flex max-h-full w-full max-w-2xl flex-col shadow-2xl">
        <header className="border-b p-5 hairline">
          <div className="label">Career over · {view.monthName} {view.year}</div>
          <h2 className="text-2xl font-bold">{me.name} <PartyTag party={me.party} /></h2>
          <p className="muted mt-1 text-sm">{view.gameOver}</p>
          <div className="mt-3 grid grid-cols-4 gap-2 max-sm:grid-cols-2">
            <Stat label="Legacy" value={L.score} sub={L.rank} />
            <Stat label="Peak office" value={<span className="text-sm">{L.peak?.title ?? 'None'}</span>} />
            <Stat label="Years in office" value={L.yearsInOffice.toFixed(1)} />
            <Stat label="Elections" value={`${L.wins}–${L.losses}`} sub="won–lost" />
          </div>
        </header>
        <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <LegacyCard breakdownOnly />
          {(L.bigWins.length > 0 || L.bigLosses.length > 0) && (
            <section className="panel p-3">
              <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                <Highlights title="Biggest wins" rows={L.bigWins} good />
                <Highlights title="Toughest losses" rows={L.bigLosses} />
              </div>
            </section>
          )}
          {rivals.length > 0 && (
            <section className="panel p-3">
              <h3 className="label mb-1.5">Rivals</h3>
              <ul className="space-y-1 text-xs">
                {rivals.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate"><PartyTag party={r.party} /> {r.name} <span className="muted">· {r.retired ? `retired ${r.retired}` : r.office ?? 'out of office'}</span></span>
                    <span className="chip num shrink-0" title="Your record against them">{r.wins}–{r.losses}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <AchievementsCard earnedOnly />
          <section className="panel p-3">
            <h3 className="label mb-1.5">Timeline</h3>
            <ol className="space-y-0.5 text-xs">
              {me.career.map((c, i) => (
                <li key={i} className="flex gap-2"><span className="num muted w-10 shrink-0">{c.year}</span><span>{CAREER_LABEL[c.result] ?? c.result}{c.officeId ? ` · ${c.title}` : ''}{c.share != null && c.share < 1 ? ` (${pct(c.share, 1)})` : ''}</span></li>
              ))}
              {me.career.length === 0 && <li className="muted">No races run.</li>}
            </ol>
          </section>
        </div>
        <footer className="flex flex-wrap justify-end gap-2 border-t p-3 hairline">
          <button className="btn-ghost" onClick={() => void downloadCard(view)}>Export career card</button>
          <button className="btn-ghost" onClick={() => openRecap(false)}>Look around the map</button>
          <button className="btn-primary" onClick={() => setPhase('title')}>Title screen</button>
        </footer>
      </div>
    </div>
  );
}

function Highlights({ title, rows, good }: { title: string; rows: GameView['legacy']['bigWins']; good?: boolean }) {
  return (
    <div>
      <h3 className="label mb-1">{title}</h3>
      {rows.length === 0 ? <div className="muted text-xs">None.</div> : (
        <ul className="space-y-1 text-xs">
          {rows.map((r, i) => (
            <li key={i}>
              <span className="font-medium">{r.year} · {r.title}</span>
              <span className="muted"> · {r.result === 'lost-primary' ? 'primary' : 'general'}{r.share != null && r.share < 1 ? ` · ${pct(r.share, 1)}` : ''}</span>
              {good && r.flip && <span className="chip ml-1">flip</span>}
              {good && r.vsIncumbent && <span className="chip ml-1">beat incumbent</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Draw a 1200×630 career card and download it as a PNG. */
export async function downloadCard(view: GameView) {
  const cv = document.createElement('canvas');
  cv.width = 1200;
  cv.height = 630;
  const g = cv.getContext('2d');
  if (!g) return;
  const L = view.legacy;
  // the card is always dark, whatever the app theme
  const accent = '#34d399';
  const party = view.me.party === 'D' ? '#3b82f6' : view.me.party === 'R' ? '#ef4444' : '#a855f7';
  g.fillStyle = '#0f172a';
  g.fillRect(0, 0, 1200, 630);
  g.fillStyle = party;
  g.fillRect(0, 0, 18, 630);
  const font = (w: number, px: number) => `${w} ${px}px Inter, system-ui, sans-serif`;
  g.fillStyle = '#94a3b8';
  g.font = font(600, 26);
  g.fillText('BALLOT LADDER · CAREER CARD', 70, 80);
  g.fillStyle = '#f8fafc';
  g.font = font(800, 68);
  g.fillText(view.me.name, 70, 170, 1060);
  g.fillStyle = '#cbd5e1';
  g.font = font(500, 30);
  const partyName = view.me.party === 'D' ? 'Democrat' : view.me.party === 'R' ? 'Republican' : 'Independent';
  g.fillText(`${partyName} · ${view.me.homeTown} · ${L.peak ? `Peak office: ${L.peak.title}` : 'Never held office'}`, 70, 220, 1060);
  const stats: [string, string][] = [
    ['Legacy', String(L.score)],
    ['Rank', L.rank],
    ['Years in office', L.yearsInOffice.toFixed(1)],
    ['Elections', `${L.wins}–${L.losses}`],
  ];
  stats.forEach(([k, v], i) => {
    const x = 70 + i * 275;
    g.fillStyle = '#94a3b8';
    g.font = font(600, 22);
    g.fillText(k.toUpperCase(), x, 310);
    g.fillStyle = i === 0 ? accent : '#f8fafc';
    g.font = font(800, i === 1 ? 34 : 54);
    g.fillText(v, x, 370, 255);
  });
  const earned = L.achievements.filter((a) => a.earned);
  g.fillStyle = '#94a3b8';
  g.font = font(600, 22);
  g.fillText(`ACHIEVEMENTS (${earned.length}/${L.achievements.length})`, 70, 450);
  g.fillStyle = '#e2e8f0';
  g.font = font(500, 28);
  const line = earned.map((a) => a.label).join('  ·  ') || 'None';
  wrap(g, line, 70, 495, 1060, 38, 2);
  g.fillStyle = '#64748b';
  g.font = font(500, 22);
  g.fillText(`${view.monthName} ${view.year} · seed ${view.seed}`, 70, 595);
  const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `ballot-ladder-career-${view.me.last.toLowerCase()}.png` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, lh: number, maxLines: number) {
  const words = text.split(' ');
  let line = '';
  let n = 0;
  for (const word of words) {
    const t = line ? `${line} ${word}` : word;
    if (g.measureText(t).width > w && line) {
      if (++n >= maxLines) { g.fillText(`${line} …`, x, y); return; }
      g.fillText(line, x, y);
      y += lh;
      line = word;
    } else line = t;
  }
  if (line) g.fillText(line, x, y);
}
