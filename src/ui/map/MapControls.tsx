import { useGame, type ColorMode, type Layer } from '../../store/game';
import { Seg } from '../kit';
import { modeLabel } from './MapView';
import { useNight } from '../election/nightStore';

const LAYER_OPTS: { value: Layer; label: string }[] = [
  { value: 'states', label: 'State' },
  { value: 'counties', label: 'County' },
  { value: 'cd', label: 'Congress' },
  { value: 'sldu', label: 'St. Senate' },
  { value: 'sldl', label: 'St. House' },
];

const MODE_GROUPS: { label: string; modes: ColorMode[] }[] = [
  { label: 'Politics', modes: ['lean', 'holder', 'rec'] },
  { label: 'Real results', modes: ['pres2024', 'pres2020', 'pres2016', 'pres2012', 'pres2008'] },
  { label: 'Demographics', modes: ['college', 'income', 'age', 'white', 'black', 'hispanic', 'density'] },
];

export function MapControls({ loading }: { loading: boolean }) {
  const { layer, setLayer, colorMode, setColorMode, showTowns, setShowTowns, phase } = useGame();
  return (
    <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100%-24px)] flex-col gap-2">
      <div className="panel flex flex-wrap items-center gap-2 p-1.5 shadow-lg">
        <Seg value={layer} options={LAYER_OPTS} onChange={setLayer} size="xs" />
        <select className="input !w-auto !py-1 !text-xs" value={colorMode} onChange={(e) => setColorMode(e.target.value as ColorMode)} aria-label="Map colouring">
          {MODE_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.modes
                .filter((m) => phase === 'play' || (m !== 'holder' && m !== 'rec'))
                .map((m) => (
                  <option key={m} value={m}>
                    {modeLabel(m)}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 px-1 text-xs">
          <input type="checkbox" checked={showTowns} onChange={(e) => setShowTowns(e.target.checked)} />
          Towns
        </label>
        {loading && <span className="muted animate-pulse px-1 text-xs">Loading…</span>}
      </div>
    </div>
  );
}

export function Legend({ mode, range }: { mode: ColorMode; range: { min: string; max: string } | null }) {
  const partisan = !range;
  const note = mode.startsWith('pres') ? 'County & state only (district data not public)' : mode === 'lean' ? 'Blend of 2024/2020/2016 presidential results; sub-county areas modeled from demographics' : mode === 'holder' ? 'Simulated officeholders (real party at game start)' : null;
  return (
    <div className="panel pointer-events-none absolute bottom-3 left-3 z-10 w-56 p-2 text-[11px] shadow-lg max-md:bottom-2 max-md:left-2 max-md:w-40 max-md:p-1.5 max-md:text-[10px]">
      <div className="mb-1 font-semibold">{modeLabel(mode)}</div>
      <div className="h-2 w-full rounded-full" style={{ background: partisan ? 'linear-gradient(90deg,#991b1b,#ef4444,#fca5a5,var(--line),#93c5fd,#3b82f6,#1e3a8a)' : 'linear-gradient(90deg,#f0fdfa,#99f6e4,#2dd4bf,#0d9488,#134e4a)' }} />
      <div className="muted mt-0.5 flex justify-between num">
        <span>{partisan ? 'R+35' : range!.min}</span>
        {partisan && <span>Even</span>}
        <span>{partisan ? 'D+35' : range!.max}</span>
      </div>
      {note && <div className="muted mt-1 leading-tight max-md:hidden">{note}</div>}
    </div>
  );
}

/** Map key during election night: candidate colours and what solid/pale/grey mean. */
export function NightLegend() {
  const night = useNight((s) => s.night);
  const colors = useNight((s) => s.colors);
  const mapMode = useNight((s) => s.mapMode);
  if (!night) return null;
  const what = night.unitKind === 'precinct' ? 'Towns (dot size = expected vote)' : night.unitKind === 'state' || (night.electoral && mapMode === 'states') ? 'States' : 'Counties';
  return (
    <div className="panel pointer-events-none absolute bottom-3 left-3 z-10 w-56 p-2 text-[11px] shadow-lg max-md:hidden">
      <div className="mb-1 font-semibold">Election night · {what}</div>
      {night.cands.slice(0, 5).map((c, i) => (
        <div key={c.id} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colors[i] }} />
          <span className="truncate">{c.name}{c.isPlayer ? ' (you)' : ''}</span>
        </div>
      ))}
      <div className="muted mt-1 leading-tight">Solid = called · pale = leading · grey = not reporting</div>
    </div>
  );
}
