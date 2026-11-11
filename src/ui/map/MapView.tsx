import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { feature } from 'topojson-client';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import { data, leanLabel, num, sim, useGame, type ColorMode, type Layer } from '../../store/game';
import { STATE_LIST, type Town } from '../../data/types';
import { shortTownName } from '../../sim/offices';
import { css } from '../kit';
import { MapControls, Legend } from './MapControls';

export let mapRef: maplibregl.Map | null = null;
const LAYERS: Layer[] = ['states', 'counties', 'cd', 'sldu', 'sldl'];
const PARTISAN = new Set<ColorMode>(['lean', 'pres2024', 'pres2020', 'pres2016', 'pres2012', 'pres2008', 'holder']);
const DEMO_INDEX: Partial<Record<ColorMode, number>> = { age: 1, income: 2, white: 3, black: 4, hispanic: 6, college: 7, density: 8 };

const geoCache = new Map<string, FeatureCollection>();
const layerData: Partial<Record<Layer, FeatureCollection>> = {};
async function loadTopo(rel: string): Promise<FeatureCollection> {
  const hit = geoCache.get(rel);
  if (hit) return hit;
  const topo = await data.json<any>(`geo/${rel}`);
  const key = Object.keys(topo.objects)[0];
  const fc = feature(topo, topo.objects[key]) as unknown as FeatureCollection;
  geoCache.set(rel, fc);
  return fc;
}
async function loadLegislative(kind: 'sldu' | 'sldl'): Promise<FeatureCollection> {
  const states = STATE_LIST.filter((s) => s !== 'DC' && !(kind === 'sldl' && s === 'NE'));
  const parts = await Promise.all(states.map((s) => loadTopo(`${kind}/${s}.json`).catch(() => ({ type: 'FeatureCollection', features: [] }) as FeatureCollection)));
  return { type: 'FeatureCollection', features: parts.flatMap((p) => p.features) };
}

/** Feature name for tooltips and selection. */
function featureName(layer: Layer, id: string, props: Record<string, any>): string {
  if (layer === 'states') return props.NAME;
  if (layer === 'counties') return `${data.counties[id]?.n ?? props.NAME}, ${props.STUSPS ?? ''}`;
  const d = data.districts[`${layer}:${id}`];
  return d ? `${d.n}${layer === 'cd' ? '' : ` (${d.st})`}` : props.NAMELSAD ?? id;
}

function rawRecord(layer: Layer, id: string) {
  if (layer === 'states') {
    const st = data.stateByFips[id];
    return st ? { lean: data.states[st].lean, d: data.states[st].d, pres: data.states[st].pres as Record<string, number[]> | null, key: st } : null;
  }
  if (layer === 'counties') {
    const c = data.counties[id];
    return c ? { lean: c.lean, d: c.d, pres: c.pres as Record<string, number[]> | null, key: id } : null;
  }
  const d = data.districts[`${layer}:${id}`];
  return d ? { lean: d.lean, d: d.d, pres: null, key: `${layer}:${id}` } : null;
}

/** Numeric value used for colouring (partisan modes: D share; others: raw). */
function valueFor(layer: Layer, id: string, mode: ColorMode, holders: Record<string, string>, rec: Record<string, number>): number | null {
  const r = rawRecord(layer, id);
  if (!r) return null;
  if (mode === 'lean') return r.lean;
  if (mode.startsWith('pres')) {
    const y = mode.slice(4);
    const v = r.pres?.[y];
    return v && v[0] + v[1] > 0 ? v[0] / (v[0] + v[1]) : null;
  }
  if (mode === 'holder') {
    const p = holders[id];
    return p === 'D' ? 0.82 : p === 'R' ? 0.18 : p === 'I' ? 0.5 : null;
  }
  if (mode === 'rec') return rec[r.key] ?? 0.02;
  const i = DEMO_INDEX[mode];
  return i == null ? null : (r.d[i] as number | null);
}

function partisanRamp(dark: boolean): any {
  const mid = dark ? '#3a4152' : '#eceff3';
  return ['interpolate', ['linear'], ['coalesce', ['feature-state', 'v'], 0.5], 0.15, '#991b1b', 0.35, '#ef4444', 0.46, '#fca5a5', 0.5, mid, 0.54, '#93c5fd', 0.65, '#3b82f6', 0.85, '#1e3a8a'];
}
function seqRamp(dark: boolean): any {
  return ['interpolate', ['linear'], ['coalesce', ['feature-state', 'v'], 0], 0, dark ? '#13222f' : '#f0fdfa', 0.25, '#99f6e4', 0.5, '#2dd4bf', 0.75, '#0d9488', 1, '#134e4a'];
}

interface Tip { x: number; y: number; title: string; lines: string[] }

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [legend, setLegend] = useState<{ min: string; max: string } | null>(null);
  const [loadingLayer, setLoadingLayer] = useState(false);
  const { layer, colorMode, showTowns, selection, mapVersion, dark, phase, view } = useGame();
  const select = useGame((s) => s.select);
  const loaded = useRef(new Set<string>());
  const townStates = useRef(new Set<string>());
  const valueCache = useRef<{ holders: Record<string, string>; rec: Record<string, number> }>({ holders: {}, rec: {} });
  const stateBoxes = useRef<Record<string, [number, number, number, number]>>({});

  // ---- init map
  useEffect(() => {
    const map = new maplibregl.Map({
      container: el.current!,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': css('--map-bg') } }] },
      bounds: [[-124.8, 24.3], [-66.9, 49.4]],
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true, customAttribution: 'US Census Bureau · MIT Election Lab · tonmcg · Open States' },
      dragRotate: false,
      pitchWithRotate: false,
      maxZoom: 13,
      minZoom: 2,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef = map;
    map.on('load', async () => {
      const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
      for (const l of LAYERS) {
        map.addSource(l, { type: 'geojson', data: empty, promoteId: 'GEOID' });
        map.addLayer({ id: `${l}-fill`, type: 'fill', source: l, layout: { visibility: 'none' }, paint: { 'fill-color': partisanRamp(dark), 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0.82] } });
        map.addLayer({ id: `${l}-line`, type: 'line', source: l, layout: { visibility: 'none' }, paint: { 'line-color': dark ? '#0b1120' : '#ffffff', 'line-width': l === 'states' ? 1.2 : 0.5, 'line-opacity': 0.7 } });
      }
      map.addLayer({ id: 'states-outline', type: 'line', source: 'states', paint: { 'line-color': dark ? '#cbd5e1' : '#1e293b', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 1.6], 'line-opacity': 0.55 } });
      map.addLayer({ id: 'selected-line', type: 'line', source: 'counties', filter: ['==', ['get', 'GEOID'], '__none'], paint: { 'line-color': css('--accent'), 'line-width': 2.5 } });
      map.addSource('towns', { type: 'geojson', data: empty });
      const townPaint = (min: number): maplibregl.CircleLayerSpecification['paint'] => ({
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, min, 10, ['+', 1.5, ['*', 0.7, ['ln', ['max', ['get', 'pop'], 1]]]]],
        'circle-color': ['interpolate', ['linear'], ['get', 'v'], 0.15, '#991b1b', 0.35, '#ef4444', 0.5, dark ? '#94a3b8' : '#cbd5e1', 0.65, '#3b82f6', 0.85, '#1e3a8a'],
        'circle-stroke-width': 0.8,
        'circle-stroke-color': dark ? '#0b1120' : '#ffffff',
        'circle-opacity': 0.92,
      });
      map.addLayer({ id: 'towns-big', type: 'circle', source: 'towns', minzoom: 5, filter: ['>=', ['get', 'pop'], 50000], paint: townPaint(2.5) });
      map.addLayer({ id: 'towns-mid', type: 'circle', source: 'towns', minzoom: 6.5, filter: ['all', ['>=', ['get', 'pop'], 5000], ['<', ['get', 'pop'], 50000]], paint: townPaint(1.6) });
      map.addLayer({ id: 'towns-small', type: 'circle', source: 'towns', minzoom: 8, filter: ['<', ['get', 'pop'], 5000], paint: townPaint(1.2) });
      map.addSource('home', { type: 'geojson', data: empty });
      map.addLayer({ id: 'home', type: 'circle', source: 'home', paint: { 'circle-radius': 7, 'circle-color': css('--accent'), 'circle-stroke-width': 2.5, 'circle-stroke-color': dark ? '#0b1120' : '#fff' } });

      const [states, counties, cd] = await Promise.all([loadTopo('states.json'), loadTopo('counties.json'), loadTopo('cd.json')]);
      for (const f of states.features) {
        const st = data.stateByFips[f.properties!.GEOID];
        if (st) stateBoxes.current[st] = bbox(f);
      }
      Object.assign(layerData, { states, counties, cd });
      (map.getSource('states') as GeoJSONSource).setData(states);
      (map.getSource('counties') as GeoJSONSource).setData(counties);
      (map.getSource('cd') as GeoJSONSource).setData(cd);
      loaded.current = new Set(['states', 'counties', 'cd']);
      setReady(true);
    });
    return () => {
      map.remove();
      mapRef = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- theme
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    map.setPaintProperty('bg', 'background-color', css('--map-bg'));
    for (const l of LAYERS) map.setPaintProperty(`${l}-line`, 'line-color', dark ? '#0b1120' : '#ffffff');
    map.setPaintProperty('states-outline', 'line-color', dark ? '#cbd5e1' : '#1e293b');
    map.setPaintProperty('selected-line', 'line-color', css('--accent'));
    map.setPaintProperty('home', 'circle-color', css('--accent'));
  }, [dark, ready]);

  // ---- active layer + colours
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    let cancelled = false;
    (async () => {
      if (!loaded.current.has(layer) && (layer === 'sldu' || layer === 'sldl')) {
        setLoadingLayer(true);
        const fc = await loadLegislative(layer);
        if (cancelled) return;
        layerData[layer] = fc;
        (map.getSource(layer) as GeoJSONSource).setData(fc);
        loaded.current.add(layer);
        setLoadingLayer(false);
      }
      for (const l of LAYERS) {
        const vis = l === layer ? 'visible' : 'none';
        map.setLayoutProperty(`${l}-fill`, 'visibility', vis);
        map.setLayoutProperty(`${l}-line`, 'visibility', vis);
      }
      if (colorMode === 'holder' && phase === 'play') valueCache.current.holders = await sim.holderMap(layer);
      if (colorMode === 'rec' && phase === 'play') valueCache.current.rec = await sim.recMap();
      if (cancelled) return;
      const fc = layerData[layer] ?? { type: 'FeatureCollection', features: [] };
      map.removeFeatureState({ source: layer });
      const vals: number[] = [];
      const raw = new Map<string, number>();
      for (const f of fc.features ?? []) {
        const id = f.properties!.GEOID as string;
        const v = valueFor(layer, id, colorMode, valueCache.current.holders, valueCache.current.rec);
        if (v == null || !Number.isFinite(v)) continue;
        raw.set(id, v);
        vals.push(v);
      }
      let norm = (v: number) => v;
      if (!PARTISAN.has(colorMode)) {
        const sorted = [...vals].sort((a, b) => a - b);
        const lo = colorMode === 'rec' ? 0 : sorted[Math.floor(sorted.length * 0.02)] ?? 0;
        const hi = colorMode === 'rec' ? Math.max(0.3, sorted[sorted.length - 1] ?? 1) : sorted[Math.floor(sorted.length * 0.98)] ?? 1;
        const log = colorMode === 'density';
        const f = (x: number) => (log ? Math.log1p(x) : x);
        norm = (v) => Math.max(0, Math.min(1, (f(v) - f(lo)) / (f(hi) - f(lo) || 1)));
        setLegend({ min: fmtMode(colorMode, lo), max: fmtMode(colorMode, hi) });
      } else setLegend(null);
      for (const [id, v] of raw) map.setFeatureState({ source: layer, id }, { v: norm(v) });
      map.setPaintProperty(`${layer}-fill`, 'fill-color', PARTISAN.has(colorMode) ? partisanRamp(dark) : seqRamp(dark));
      refreshTowns();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, colorMode, ready, mapVersion, dark, phase]);

  // ---- towns
  function townValue(t: Town): number {
    if (colorMode === 'rec') return 0.5 + (valueCache.current.rec[t.id] ?? 0) * 0.4;
    const i = DEMO_INDEX[colorMode];
    if (i != null) return 0.5;
    return t.lean;
  }
  function refreshTowns() {
    const map = mapRef;
    if (!map) return;
    const feats: Feature<Geometry>[] = [];
    if (showTowns)
      for (const st of townStates.current)
        for (const t of data.loadedTowns(st) ?? [])
          feats.push({ type: 'Feature', id: t.id, properties: { id: t.id, name: shortTownName(t.name), st: t.st, pop: t.pop, v: townValue(t) }, geometry: { type: 'Point', coordinates: [t.lon, t.lat] } });
    (map.getSource('towns') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats });
  }
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    const onMove = async () => {
      if (!showTowns || map.getZoom() < 4.8) return;
      const b = map.getBounds();
      const need = Object.entries(stateBoxes.current)
        .filter(([, [x0, y0, x1, y1]]) => x1 >= b.getWest() && x0 <= b.getEast() && y1 >= b.getSouth() && y0 <= b.getNorth())
        .map(([st]) => st)
        .filter((st) => !townStates.current.has(st));
      if (!need.length) return;
      await Promise.all(need.map((st) => data.townsOf(st)));
      need.forEach((st) => townStates.current.add(st));
      refreshTowns();
    };
    map.on('moveend', onMove);
    onMove();
    refreshTowns();
    return () => {
      map.off('moveend', onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, showTowns]);

  // ---- home marker
  const homeId = view?.me.homeId;
  const pickedTown = useGame((s) => s.pickedTown);
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    const id = phase === 'create' ? pickedTown : homeId;
    (async () => {
      const t = id ? await data.town(id) : undefined;
      if (t) townStates.current.add(t.st);
      (map.getSource('home') as GeoJSONSource).setData({ type: 'FeatureCollection', features: t ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [t.lon, t.lat] } }] : [] });
      refreshTowns();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeId, pickedTown, ready, phase]);

  // ---- selection outline
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    const src = selection ? { state: 'states', county: 'counties', cd: 'cd', sldu: 'sldu', sldl: 'sldl', town: null }[selection.kind] : null;
    if (!src) {
      map.setFilter('selected-line', ['==', ['get', 'GEOID'], '__none']);
      return;
    }
    const geoId = selection!.kind === 'state' ? data.states[selection!.id]?.fips : selection!.id;
    map.removeLayer('selected-line');
    map.addLayer({ id: 'selected-line', type: 'line', source: src, filter: ['==', ['get', 'GEOID'], geoId], paint: { 'line-color': css('--accent'), 'line-width': 2.5 } }, 'towns-big');
  }, [selection, ready, dark]);

  // ---- interaction
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    let hoverId: { source: string; id: string } | null = null;
    let raf = 0;
    const townLayers = ['towns-big', 'towns-mid', 'towns-small'];
    const clearHover = () => {
      if (hoverId) map.setFeatureState(hoverId, { hover: false });
      hoverId = null;
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const L = useGame.getState().layer;
        const mode = useGame.getState().colorMode;
        const feats = map.queryRenderedFeatures(e.point, { layers: [...townLayers.filter((l) => map.getLayer(l)), `${L}-fill`] });
        const town = feats.find((f) => townLayers.includes(f.layer.id));
        const area = feats.find((f) => f.layer.id === `${L}-fill`);
        clearHover();
        map.getCanvas().style.cursor = town || area ? 'pointer' : '';
        if (town) {
          const t = data.townSync(town.properties!.id);
          setTip(t ? { x: e.point.x, y: e.point.y, title: `${shortTownName(t.name)}, ${t.st}`, lines: [`Pop. ${num(t.pop)}`, `Lean ${leanLabel(t.lean)}`, `College ${(t.demo.college * 100).toFixed(0)}% · Median income $${num(Math.round(t.demo.income))}`] } : null);
          return;
        }
        if (area) {
          const id = area.properties!.GEOID as string;
          hoverId = { source: L, id };
          map.setFeatureState(hoverId, { hover: true });
          setTip({ x: e.point.x, y: e.point.y, title: featureName(L, id, area.properties!), lines: tipLines(L, id, mode, valueCache.current) });
        } else setTip(null);
      });
    };
    const onLeave = () => {
      clearHover();
      setTip(null);
    };
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const L = useGame.getState().layer;
      const feats = map.queryRenderedFeatures(e.point, { layers: [...townLayers.filter((l) => map.getLayer(l)), `${L}-fill`] });
      const town = feats.find((f) => townLayers.includes(f.layer.id)) as MapGeoJSONFeature | undefined;
      if (town) {
        const id = town.properties!.id;
        if (useGame.getState().phase === 'create') useGame.getState().pickTown(id);
        select({ kind: 'town', id, name: `${town.properties!.name}, ${town.properties!.st}` });
        return;
      }
      const area = feats.find((f) => f.layer.id === `${L}-fill`);
      if (!area) return select(null);
      const gid = area.properties!.GEOID as string;
      const kind = ({ states: 'state', counties: 'county', cd: 'cd', sldu: 'sldu', sldl: 'sldl' } as const)[L];
      select({ kind, id: kind === 'state' ? data.stateByFips[gid] : gid, name: featureName(L, gid, area.properties!) });
    };
    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    map.on('click', onClick);
    return () => {
      map.off('mousemove', onMove);
      map.off('mouseout', onLeave);
      map.off('click', onClick);
    };
  }, [ready, select]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={el} className="absolute inset-0" />
      <MapControls loading={!ready || loadingLayer} />
      <Legend mode={colorMode} range={legend} />
      {tip && (
        <div className="panel pointer-events-none absolute z-20 max-w-[260px] px-3 py-2 text-xs shadow-xl" style={{ left: Math.min(tip.x + 14, (el.current?.clientWidth ?? 400) - 270), top: tip.y + 14 }}>
          <div className="mb-0.5 font-semibold">{tip.title}</div>
          {tip.lines.map((l, i) => (
            <div key={i} className="muted num">{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function tipLines(layer: Layer, id: string, mode: ColorMode, cache: { holders: Record<string, string>; rec: Record<string, number> }): string[] {
  const r = rawRecord(layer, id);
  if (!r) return [];
  const pop = r.d[0] as number;
  const out = [`Pop. ${num(Math.round(pop || 0))} · Lean ${leanLabel(r.lean)}`];
  if (mode.startsWith('pres')) {
    const y = mode.slice(4);
    const v = r.pres?.[y];
    out.push(v ? `${y} President: D ${((v[0] / v[2]) * 100).toFixed(1)}% · R ${((v[1] / v[2]) * 100).toFixed(1)}%` : `${y} President: no ${layer === 'cd' || layer.startsWith('sld') ? 'district-level' : ''} data`);
  } else if (mode === 'holder') out.push(`Held by: ${cache.holders[id] ?? 'not yet simulated'}`);
  else if (mode === 'rec') out.push(`Your name recognition: ${((cache.rec[r.key] ?? 0.02) * 100).toFixed(0)}%`);
  else if (DEMO_INDEX[mode] != null) out.push(`${modeLabel(mode)}: ${fmtMode(mode, r.d[DEMO_INDEX[mode]!] as number)}`);
  return out;
}

export function modeLabel(m: ColorMode) {
  return ({ lean: 'Partisan lean', pres2024: '2024 President', pres2020: '2020 President', pres2016: '2016 President', pres2012: '2012 President', pres2008: '2008 President', holder: 'Current officeholder', rec: 'Your name recognition', college: "Bachelor's degree+", income: 'Median household income', white: 'White (non-Hispanic)', black: 'Black', hispanic: 'Hispanic', age: 'Median age', density: 'Population density' } as Record<ColorMode, string>)[m];
}
function fmtMode(m: ColorMode, v: number) {
  if (v == null || !Number.isFinite(v)) return '–';
  if (m === 'income') return `$${Math.round(v / 1000)}K`;
  if (m === 'age') return `${v.toFixed(1)}`;
  if (m === 'density') return `${num(Math.round(v))}/mi²`;
  return `${(v * 100).toFixed(0)}%`;
}

function bbox(f: Feature): [number, number, number, number] {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = (c: any) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0];
      if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1];
      if (c[1] > y1) y1 = c[1];
    } else c.forEach(walk);
  };
  walk((f.geometry as any).coordinates);
  return [x0, y0, x1, y1];
}

/** Fly the map to a feature on a given layer. */
export async function focusOn(kind: 'state' | 'county' | 'cd' | 'sldu' | 'sldl' | 'town', id: string) {
  const map = mapRef;
  if (!map) return;
  if (kind === 'town') {
    const t = await data.town(id);
    if (t) map.flyTo({ center: [t.lon, t.lat], zoom: Math.max(map.getZoom(), 9), duration: 900 });
    return;
  }
  const rel = kind === 'state' ? 'states.json' : kind === 'county' ? 'counties.json' : kind === 'cd' ? 'cd.json' : `${kind}/${data.districts[`${kind}:${id}`]?.st}.json`;
  const fc = await loadTopo(rel);
  const gid = kind === 'state' ? data.states[id]?.fips : id;
  const f = fc.features.find((x) => x.properties!.GEOID === gid);
  if (!f) return;
  const [x0, y0, x1, y1] = bbox(f);
  map.fitBounds([[x0, y0], [x1, y1]], { padding: 60, duration: 900, maxZoom: 11 });
}
