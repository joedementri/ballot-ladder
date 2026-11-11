import { useEffect, useMemo, useState } from 'react';
import { data, num, pct, useGame } from '../../store/game';
import type { ResultSummary } from '../../sim/model';
import { EV } from '../../sim/offices';
import { PartyTag } from '../kit';

const SHADES: Record<string, string[]> = { D: ['#3b82f6', '#60a5fa', '#1d4ed8', '#93c5fd'], R: ['#ef4444', '#f87171', '#b91c1c', '#fca5a5'], I: ['#a78bfa', '#7c3aed', '#c4b5fd'] };

/** Animated election-night results: units report over time, the race is called when the lead is safe. */
export function ElectionNight({ night }: { night: ResultSummary & { replay?: boolean } }) {
  const ackNight = useGame((s) => s.ackNight);
  const [shown, setShown] = useState(0);
  const [speed, setSpeed] = useState(1);
  const total = night.units.length;

  const colors = useMemo(() => {
    const used: Record<string, number> = {};
    return night.cands.map((c) => {
      if (c.isPlayer) return 'var(--accent)';
      const i = used[c.party] ?? 0;
      used[c.party] = i + 1;
      return (SHADES[c.party] ?? SHADES.I)[i % 4];
    });
  }, [night]);

  useEffect(() => {
    setShown(0);
  }, [night]);
  useEffect(() => {
    if (shown >= total) return;
    const step = Math.max(1, Math.ceil(total / 60));
    const t = setTimeout(() => setShown((s) => Math.min(total, s + step * speed)), 110);
    return () => clearTimeout(t);
  }, [shown, total, speed]);

  const tally = useMemo(() => {
    const v = new Array(night.cands.length).fill(0);
    for (let i = 0; i < shown; i++) night.units[i].votes.forEach((x, j) => (v[j] += x));
    return v;
  }, [shown, night]);
  const finalTot = night.cands.reduce((a, c) => a + c.votes, 0) || 1;
  const counted = tally.reduce((a, b) => a + b, 0);
  const remaining = finalTot - counted;
  const order = tally.map((v, i) => i).sort((a, b) => tally[b] - tally[a]);
  const lead = tally[order[0]] - (tally[order[1]] ?? 0);
  const called = shown >= total || (counted > finalTot * 0.35 && lead > remaining * 0.6);
  const winnerIdx = night.cands.findIndex((c) => c.id === night.winnerId);
  const playerIdx = night.cands.findIndex((c) => c.isPlayer);
  const playerWon = playerIdx >= 0 && winnerIdx === playerIdx;
  const isTopTwo = night.stage === 'primary' && night.title && night.cands.some((c) => c.party !== night.cands[0].party);

  // Electoral votes as states report (presidential)
  const ev = useMemo(() => {
    if (!night.electoral) return null;
    const byState: Record<string, number[]> = {};
    for (const u of night.units.slice(0, shown)) {
      const st = night.unitKind === 'state' ? u.id : data.counties[u.id]?.st;
      if (!st) continue;
      const v = (byState[st] ??= new Array(u.votes.length).fill(0));
      u.votes.forEach((x, j) => (v[j] += x));
    }
    return byState;
  }, [shown, night]);

  const close = () => (night.replay ? useGame.setState((s) => ({ view: s.view ? { ...s.view, pendingNight: null } : s.view })) : ackNight());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm">
      <div className="panel rise flex max-h-full w-full max-w-3xl flex-col overflow-hidden shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b p-4 hairline">
          <div className="min-w-0">
            <div className="label">{night.replay ? 'Replay · ' : ''}Election night · {night.year} {night.stage}</div>
            <h2 className="truncate text-lg font-bold">{night.title}</h2>
          </div>
          <div className="text-right">
            <div className="num text-2xl font-bold">{pct(shown / Math.max(1, total))}</div>
            <div className="muted text-[11px]">{night.unitKind === 'county' ? 'counties' : night.unitKind === 'state' ? 'states' : 'precincts'} reporting</div>
          </div>
        </header>

        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4">
          <div className="space-y-2">
            {order.map((i) => {
              const c = night.cands[i];
              const share = counted ? tally[i] / counted : 0;
              return (
                <div key={c.id}>
                  <div className="mb-0.5 flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <PartyTag party={c.party} />
                      <span className="truncate font-semibold">{c.name}{c.isPlayer && ' (you)'}</span>
                      {called && i === winnerIdx && <span className="chip" style={{ background: colors[i], color: '#fff' }}>✓ {isTopTwo ? 'Advances' : 'Winner'}</span>}
                    </span>
                    <span className="num shrink-0">{pct(share, 1)} <span className="muted text-xs">{num(tally[i])}</span></span>
                  </div>
                  <div className="h-3 w-full overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
                    <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${share * 100}%`, background: colors[i] }} />
                  </div>
                </div>
              );
            })}
          </div>

          {ev && <ElectoralBar cands={night.cands} byState={ev} colors={colors} />}

          <div>
            <div className="label mb-1">Results by {night.unitKind === 'county' ? 'county' : night.unitKind === 'state' ? 'state' : 'precinct'}</div>
            <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${total > 400 ? 9 : total > 100 ? 16 : 30}px, 1fr))` }}>
              {night.units.map((u, k) => {
                const reported = k < shown;
                const w = u.votes.indexOf(Math.max(...u.votes));
                const tot = u.votes.reduce((a, b) => a + b, 0) || 1;
                const margin = (u.votes[w] - Math.max(...u.votes.filter((_, j) => j !== w), 0)) / tot;
                return (
                  <div key={u.id} title={reported ? `${u.label}: ${night.cands.map((c, j) => `${c.name} ${pct(u.votes[j] / tot)}`).join(', ')}` : u.label} className="aspect-square rounded-[3px] transition-colors duration-300" style={{ background: reported ? colors[w] : 'var(--line)', opacity: reported ? 0.45 + Math.min(0.55, margin * 2) : 1 }} />
                );
              })}
            </div>
          </div>

          {called && night.blocs.length > 0 && (
            <div className="rise">
              <div className="label mb-1">Exit poll by group</div>
              <table className="w-full text-xs num">
                <thead>
                  <tr className="muted text-left">
                    <th className="py-1 font-medium">Group</th>
                    {night.cands.map((c, i) => <th key={c.id} className="py-1 text-right font-medium" style={{ color: colors[i] }}>{c.name.split(' ').slice(-1)[0]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {night.blocs.map((b) => (
                    <tr key={b.label} className="border-t hairline">
                      <td className="py-1">{b.label}</td>
                      {b.shares.map((s, i) => <td key={i} className="py-1 text-right">{pct(s)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t p-3 hairline">
          <div className="text-sm font-semibold" style={{ color: called ? (playerIdx < 0 ? 'var(--text)' : playerWon ? 'var(--accent)' : 'var(--rep)') : 'var(--muted)' }}>
            {!called ? 'Too early to call…' : playerIdx < 0 ? `${night.cands[winnerIdx].name} wins` : playerWon ? (night.stage === 'primary' ? 'You won the primary!' : 'Victory! You won.') : night.stage === 'primary' && isTopTwo && order.slice(0, 2).includes(playerIdx) ? 'You advance to November!' : 'Defeat.'}
          </div>
          <div className="flex gap-2">
            {shown < total && <button className="btn-ghost" onClick={() => setSpeed(speed === 1 ? 4 : 1)}>{speed === 1 ? 'Faster' : 'Normal'}</button>}
            {shown < total && <button className="btn-ghost" onClick={() => setShown(total)}>Skip</button>}
            <button className="btn-primary" disabled={shown < total && !called} onClick={close}>Continue</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ElectoralBar({ cands, byState, colors }: { cands: ResultSummary['cands']; byState: Record<string, number[]>; colors: string[] }) {
  const ev = new Array(cands.length).fill(0);
  for (const [st, v] of Object.entries(byState)) ev[v.indexOf(Math.max(...v))] += EV[st] ?? 0;
  return (
    <div>
      <div className="label mb-1">Electoral votes · 270 to win</div>
      <div className="relative flex h-5 overflow-hidden rounded-md" style={{ background: 'var(--line)' }}>
        {ev.map((e, i) => <div key={i} style={{ width: `${(e / 538) * 100}%`, background: colors[i] }} className="transition-[width] duration-200" />)}
        <div className="absolute inset-y-0 left-1/2 w-0.5 bg-white/80" />
      </div>
      <div className="mt-0.5 flex justify-between text-xs num">{ev.map((e, i) => <span key={i} style={{ color: colors[i] }}>{cands[i].name.split(' ').slice(-1)[0]} {e}</span>)}</div>
    </div>
  );
}
