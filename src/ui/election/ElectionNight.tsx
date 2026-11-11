import { useEffect, useMemo, useRef, useState } from 'react';
import { data, num, pct, useGame } from '../../store/game';
import type { ResultSummary } from '../../sim/model';
import { EV } from '../../sim/offices';
import { clockAt, frameAt, keyItems, planNight, shortName, type KeyItem, type NightFrame, type NightPlan, type UnitFrame } from '../../sim/night';
import { PartyTag, Seg, css } from '../kit';
import { focusOn, mapRef } from '../map/MapView';
import { useNight } from './nightStore';

const SHADES: Record<string, string[]> = { D: ['#3b82f6', '#60a5fa', '#1d4ed8', '#93c5fd'], R: ['#ef4444', '#f87171', '#b91c1c', '#fca5a5'], I: ['#a78bfa', '#7c3aed', '#c4b5fd'] };
const unitWord = (k: ResultSummary['unitKind'], plural = false) => (k === 'county' ? (plural ? 'counties' : 'county') : k === 'state' ? (plural ? 'states' : 'state') : plural ? 'precincts' : 'precinct');

/** Candidate colours as hex (the map can't read CSS variables). The player gets the accent colour. */
export function candidateColors(cands: ResultSummary['cands']): string[] {
  const used: Record<string, number> = {};
  const accent = css('--accent') || '#0f766e';
  return cands.map((c) => {
    if (c.isPlayer) return accent;
    const i = used[c.party] ?? 0;
    used[c.party] = i + 1;
    return (SHADES[c.party] ?? SHADES.I)[i % 4];
  });
}

interface FeedItem {
  key: string;
  clock: string;
  text: string;
  color: string;
  race?: boolean;
}

/**
 * Election night. Results report unit by unit in batches, the decision desk calls units, states and the race,
 * and the main map colours in as votes come in (see MapView's night layers). The panel docks beside the map.
 */
export function ElectionNight({ night }: { night: ResultSummary & { replay?: boolean } }) {
  const ackNight = useGame((s) => s.ackNight);
  const dark = useGame((s) => s.dark);
  const me = useGame((s) => s.view?.me);
  const mapMode = useNight((s) => s.mapMode);
  const setMapMode = useNight((s) => s.setMapMode);
  const [t, setT] = useState(0);
  const [speed, setSpeed] = useState(1);
  const national = night.officeId === 'pres';
  const n = night.units.length;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const colors = useMemo(() => candidateColors(night.cands), [night, dark]);
  const plan = useMemo(() => {
    const groupOf = national ? (id: string) => (night.unitKind === 'state' ? id : data.counties[id]?.st ?? null) : undefined;
    return planNight(night, { groupOf, waves: national, ev: EV });
  }, [night, national]);
  const frame = useMemo(() => frameAt(night, plan, t), [night, plan, t]);

  useEffect(() => {
    setT(0);
  }, [night]);
  useEffect(() => {
    if (t >= 1) return;
    const dt = (n > 500 ? 0.008 : 0.013) * speed;
    const h = setTimeout(() => setT((x) => Math.min(1, x + dt)), 120);
    return () => clearTimeout(h);
  }, [t, n, speed]);

  // share playback with the map
  useEffect(() => {
    useNight.setState({ night, plan, frame, colors });
  }, [night, plan, frame, colors]);
  useEffect(() => () => useNight.setState({ night: null, plan: null, frame: null, colors: [], mapMode: 'units' }), []);
  // frame the race on the map
  useEffect(() => {
    useGame.getState().select(null);
    if (national) return void focusUS();
    const st = night.officeId.split(':')[1];
    if (night.unitKind === 'county' && st) focusOn('state', st);
    else if (night.unitKind === 'precinct') focusJurisdiction(night);
  }, [night, national]);

  const home = useMemo(() => {
    if (!me) return undefined;
    if (night.unitKind === 'county') return { unit: night.units.findIndex((u) => u.id === me.homeCounty), group: plan.ev ? me.homeSt : undefined };
    if (night.unitKind === 'state') return { unit: night.units.findIndex((u) => u.id === me.homeSt), group: plan.ev ? me.homeSt : undefined };
    if (night.units.every((u) => u.geo === night.units[0]?.geo)) return undefined; // ward race: the whole race is home
    return { unit: night.units.findIndex((u) => u.geo === me.homeId) };
  }, [night, plan, me]);
  const keys = useMemo(() => keyItems(night, plan, { home, unitWord: unitWord(night.unitKind) }), [night, plan, home]);

  const feed = useCallFeed(night, plan, frame, colors, keys, national);

  const order = frame.tally.map((_, i) => i).sort((a, b) => frame.tally[b] - frame.tally[a]);
  const called = frame.called;
  const winnerIdx = plan.winnerIdx;
  const playerIdx = night.cands.findIndex((c) => c.isPlayer);
  const playerWon = playerIdx >= 0 && winnerIdx === playerIdx;
  const isTopTwo = night.stage === 'primary' && night.cands.some((c) => c.party !== night.cands[0].party);
  const done = t >= 1;

  const close = () => (night.replay ? useGame.setState((s) => ({ view: s.view ? { ...s.view, pendingNight: null } : s.view })) : ackNight());

  return (
    <section aria-label="Election night results" className="panel rise fixed bottom-2 right-2 top-2 z-50 flex w-[460px] flex-col overflow-hidden shadow-2xl max-lg:w-[400px] max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:h-[50vh] max-md:w-auto max-md:rounded-b-none">
      <header className="flex items-start justify-between gap-3 border-b p-3 hairline">
        <div className="min-w-0">
          <div className="label">{night.replay ? 'Replay · ' : ''}Election night · {night.year} {night.stage}</div>
          <h2 className="truncate text-base font-bold">{night.title}</h2>
          <div className="muted num text-[11px]">{clockAt(t, national)} · {num(frame.unitsIn)} of {num(n)} {unitWord(night.unitKind, true)} fully in</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="num text-2xl font-bold leading-tight">{pct(Math.min(1, frame.pctIn))}</div>
          <div className="muted text-[11px]">of expected vote</div>
        </div>
      </header>

      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-3">
        <div className="space-y-2">
          {order.map((i) => {
            const c = night.cands[i];
            const share = frame.counted ? frame.tally[i] / frame.counted : 0;
            return (
              <div key={c.id}>
                <div className="mb-0.5 flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <PartyTag party={c.party} />
                    <span className="truncate font-semibold">{c.name}{c.isPlayer && ' (you)'}</span>
                    {called && i === winnerIdx && <span className="chip" style={{ background: colors[i], color: '#fff' }}>✓ {isTopTwo ? 'Advances' : 'Winner'}</span>}
                  </span>
                  <span className="num shrink-0">{pct(share, 1)} <span className="muted text-xs">{num(frame.tally[i])}</span></span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
                  <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${share * 100}%`, background: colors[i] }} />
                </div>
              </div>
            );
          })}
        </div>

        {frame.evCalled && <ElectoralBar cands={night.cands} called={frame.evCalled} leading={frame.evLeading!} colors={colors} />}

        {plan.ev && night.unitKind === 'county' && (
          <div className="flex items-center justify-between gap-2">
            <span className="label">Map</span>
            <Seg value={mapMode} options={[{ value: 'units', label: 'Counties' }, { value: 'states', label: 'Electoral map' }]} onChange={setMapMode} size="xs" />
          </div>
        )}

        {keys.length > 0 && (
          <div>
            <div className="label mb-1">Key {plan.ev ? 'states & counties' : unitWord(night.unitKind, true)}</div>
            <div className="grid grid-cols-2 gap-1.5 max-sm:grid-cols-1">
              {keys.map((k) => <KeyCard key={`${k.tag}-${k.unit ?? k.group}`} item={k} night={night} frame={frame} colors={colors} />)}
            </div>
          </div>
        )}

        {feed.length > 0 && (
          <div>
            <div className="label mb-1">Decision desk</div>
            <ul className="space-y-0.5 text-xs" aria-live="polite">
              {[...feed.filter((f) => f.race), ...feed.filter((f) => !f.race)].slice(0, 8).map((f) => (
                <li key={f.key} className={`rise flex items-baseline gap-2 ${f.race ? 'font-semibold' : ''}`}>
                  <span className="muted num w-[4.75rem] shrink-0 whitespace-nowrap">{f.clock}</span>
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: f.color }} />
                  <span className="min-w-0">{f.text}</span>
                </li>
              ))}
              {feed.length > 8 && <li className="muted pl-[5.75rem]">+{feed.length - 8} earlier calls</li>}
            </ul>
          </div>
        )}

        {n <= 400 && (
          <div>
            <div className="label mb-1">All {unitWord(night.unitKind, true)}</div>
            <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${n > 100 ? 16 : 26}px, 1fr))` }}>
              {night.units.map((u, k) => {
                const uf = frame.units[k];
                return <div key={u.id} title={unitTitle(u.label, uf, night)} className="aspect-square rounded-[3px] transition-colors duration-300" style={{ background: uf.f > 0 ? colors[uf.leader] : 'var(--line)', opacity: uf.f <= 0 ? 1 : uf.called ? 0.6 + Math.min(0.4, uf.margin * 1.5) : 0.3 }} />;
              })}
            </div>
            <div className="muted mt-1 text-[10px]">Solid = called · pale = leading, not yet called · grey = not reporting</div>
          </div>
        )}

        {called && night.blocs.length > 0 && (
          <div className="rise">
            <div className="label mb-1">Exit poll by group</div>
            <table className="w-full text-xs num">
              <thead>
                <tr className="muted text-left">
                  <th className="py-1 font-medium">Group</th>
                  {night.cands.map((c, i) => <th key={c.id} className="py-1 text-right font-medium" style={{ color: colors[i] }}>{shortName(night, i)}</th>)}
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
          {!called ? 'Too early to call…' : playerIdx < 0 ? `${night.cands[winnerIdx].name} wins` : playerWon ? (night.stage === 'primary' ? 'You won the primary!' : 'Victory! You won.') : night.stage === 'primary' && isTopTwo && [...frame.tally.keys()].sort((a, b) => plan.finalTotals[b] - plan.finalTotals[a]).slice(0, 2).includes(playerIdx) ? 'You advance to November!' : 'Defeat.'}
        </div>
        <div className="flex gap-2">
          {!done && <button className="btn-ghost" onClick={() => setSpeed(speed === 1 ? 4 : 1)}>{speed === 1 ? 'Faster' : 'Normal'}</button>}
          {!done && <button className="btn-ghost" onClick={() => setT(1)}>Skip</button>}
          <button className="btn-primary" disabled={!done && !called} onClick={close}>Continue</button>
        </div>
      </footer>
    </section>
  );
}

function unitTitle(label: string, uf: UnitFrame, night: ResultSummary) {
  if (uf.f <= 0) return `${label}: not reporting`;
  const shares = night.cands.map((_, j) => `${shortName(night, j)} ${pct(uf.votes[j] / (uf.counted || 1), 1)}`).join(', ');
  return `${label} (${pct(uf.f)} in${uf.called ? ', called' : ''}): ${shares}`;
}

/** Calls as they happen: states (electoral races), notable units, and the race itself. */
function useCallFeed(night: ResultSummary, plan: NightPlan, frame: NightFrame, colors: string[], keys: KeyItem[], national: boolean): FeedItem[] {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const prev = useRef<{ units: boolean[]; groups: Record<string, boolean>; race: boolean }>({ units: [], groups: {}, race: false });
  const notable = useMemo(() => {
    if (plan.ev) return new Set<number>();
    if (plan.n <= 40) return new Set(plan.tot.map((_, i) => i));
    const top = plan.tot.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 25).map(([, i]) => i);
    return new Set([...top, ...keys.flatMap((k) => (k.unit != null ? [k.unit] : []))]);
  }, [plan, keys]);
  useEffect(() => {
    setFeed([]);
    prev.current = { units: [], groups: {}, race: false };
  }, [night]);
  useEffect(() => {
    const p = prev.current;
    const clock = clockAt(frame.t, national);
    const add: FeedItem[] = [];
    const who = (i: number) => shortName(night, i);
    for (const i of notable) {
      const u = frame.units[i];
      if (u.called && !p.units[i]) add.push({ key: `u${i}`, clock, color: colors[u.leader], text: `${who(u.leader)} wins ${night.units[i].label}${u.f < 1 ? ` (${pct(u.f)} in)` : ''}` });
      p.units[i] = u.called;
    }
    if (frame.groups && plan.ev)
      for (const g of Object.values(frame.groups)) {
        if (g.called && !p.groups[g.id]) add.push({ key: `g${g.id}`, clock, color: colors[g.leader], text: `${who(g.leader)} wins ${data.states[g.id]?.n ?? g.id} (${g.ev} EV)` });
        p.groups[g.id] = g.called;
      }
    if (frame.called && !p.race) {
      const isTopTwo = night.stage === 'primary' && night.cands.some((c) => c.party !== night.cands[0].party);
      add.push({ key: 'race', clock, color: colors[plan.winnerIdx], race: true, text: `Race call: ${night.cands[plan.winnerIdx].name} ${isTopTwo ? 'advances' : night.stage === 'primary' ? 'wins the primary' : 'wins'}` });
      p.race = true;
    }
    if (add.length) setFeed((f) => [...add.reverse(), ...f]);
  }, [frame, night, plan, colors, notable, national]);
  return feed;
}

function KeyCard({ item, night, frame, colors }: { item: KeyItem; night: ResultSummary; frame: NightFrame; colors: string[] }) {
  const g = item.group != null ? frame.groups?.[item.group] : undefined;
  const u = item.unit != null ? frame.units[item.unit] : g;
  if (!u) return null;
  const unit = item.unit != null ? night.units[item.unit] : undefined;
  const label = item.group != null ? `${data.states[item.group]?.n ?? item.group}${g?.ev ? ` · ${g.ev} EV` : ''}` : unit!.label;
  const swing = baselineSwing(night, item, u);
  const onClick = () => {
    if (item.group != null) return focusOn('state', item.group);
    if (night.unitKind === 'county') return focusOn('county', unit!.id);
    if (night.unitKind === 'state') return focusOn('state', unit!.id);
    if (unit!.geo) return focusOn('town', unit!.geo);
  };
  return (
    <button className="panel-2 p-2 text-left transition-colors hover:border-[var(--accent)]" onClick={onClick} title={item.why}>
      <div className="flex items-center justify-between gap-1">
        <span className="label truncate !text-[10px]">{item.tag}</span>
        {u.called && <span className="chip !px-1.5 !py-0 !text-[9px]" style={{ background: colors[u.leader], color: '#fff' }}>Called</span>}
      </div>
      <div className="truncate text-sm font-semibold">{label}</div>
      <div className="num text-xs">
        {u.f <= 0 ? (
          <span className="muted">Not yet reporting</span>
        ) : (
          <>
            <span style={{ color: colors[u.leader] }} className="font-semibold">{shortName(night, u.leader)} +{(u.margin * 100).toFixed(1)}</span>
            <span className="muted"> · {pct(u.f)} in</span>
          </>
        )}
      </div>
      {swing && <div className="muted num text-[10px]">{swing}</div>}
    </button>
  );
}

/** For D-vs-R generals in counties/states: how the count compares with the area's baseline partisan lean. */
function baselineSwing(night: ResultSummary, item: KeyItem, u: UnitFrame): string | null {
  if (night.stage !== 'general' || u.counted <= 0) return null;
  const d = night.cands.findIndex((c) => c.party === 'D'), r = night.cands.findIndex((c) => c.party === 'R');
  if (d < 0 || r < 0) return null;
  const id = item.group ?? night.units[item.unit!].id;
  const lean = item.group != null || night.unitKind === 'state' ? data.states[id]?.lean : night.unitKind === 'county' ? data.counties[id]?.lean : undefined;
  if (lean == null) return null;
  const share = u.votes[d] / (u.votes[d] + u.votes[r] || 1);
  const m = Math.round((share - lean) * 200);
  return m === 0 ? 'Even with baseline lean' : `${m > 0 ? 'D' : 'R'} +${Math.abs(m)} vs. baseline lean`;
}

/** Called electoral votes (solid) and leads not yet called (pale); the first candidate fills from the left, the rest from the right. */
function ElectoralBar({ cands, called, leading, colors }: { cands: ResultSummary['cands']; called: number[]; leading: number[]; colors: string[] }) {
  const seg = (i: number, part: 'called' | 'leading') => <div key={`${i}${part}`} className="transition-[width] duration-200" style={{ width: `${((part === 'called' ? called[i] : leading[i]) / 538) * 100}%`, background: colors[i], opacity: part === 'called' ? 1 : 0.4 }} />;
  const rest = cands.map((_, i) => i).slice(1);
  return (
    <div>
      <div className="label mb-1">Electoral votes · 270 to win</div>
      <div className="relative flex h-5 overflow-hidden rounded-md" style={{ background: 'var(--line)' }}>
        {seg(0, 'called')}
        {seg(0, 'leading')}
        <div className="flex-1" />
        {rest.flatMap((i) => [seg(i, 'leading'), seg(i, 'called')])}
        <div className="absolute inset-y-0 left-1/2 w-0.5 bg-white/80" />
      </div>
      <div className="mt-0.5 flex justify-between gap-2 text-xs num">
        {cands.map((c, i) => (
          <span key={i} style={{ color: colors[i] }}>
            {shortName({ cands }, i)} <b>{called[i]}</b>{leading[i] > 0 && <span className="muted"> (+{leading[i]} leading)</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function focusUS() {
  mapRef?.fitBounds([[-124.8, 24.3], [-66.9, 49.4]], { padding: 24, duration: 900 });
}

/** Frame the race's district, county or town. */
function focusJurisdiction(night: ResultSummary) {
  const [type, a] = night.officeId.split(':');
  const geo = night.units[0]?.geo;
  if (type === 'council' || type === 'mayor') return geo && focusOn('town', geo);
  if (type === 'county') return focusOn('county', a);
  if (type === 'house') return focusOn('cd', a);
  if (type === 'sldu' || type === 'sldl') return focusOn(type, a);
}
