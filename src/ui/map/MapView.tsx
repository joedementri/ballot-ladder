import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { feature } from 'topojson-client';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import { data, leanLabel, num, sim, useGame, type ColorMode, type Layer } from '../../store/game';
import { STATE_LIST, type Town } from '../../data/types';
import { EV, shortTownName } from '../../sim/offices';
import { css } from '../kit';
import { MapControls, Legend, NightLegend } from './MapControls';
import { useNight } from '../election/nightStore';
import { groupFrame, shortName, type GroupFrame, type UnitFrame } from '../../sim/night';
import type { ResultSummary } from '../../sim/model';

export let mapRef: maplibregl.Map | null = null;
const LAYERS: Layer[] = ['states', 'counties', 'cd', 'sldu', 'sldl'];
const PARTISAN = new Set<ColorMode>(['lean', 'pres2024', 'pres2020', 'pres2016', 'pres2012', 'pres2008', 'holder']);
const DEMO_INDEX: Partial<Record<ColorMode, number>> = { age: 1, income: 2, white: 3, black: 4, hispanic: 6, college: 7, density: 8 };
const BASE_FILL_OPACITY: any = ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0.82];
const TOWN_LAYERS = ['towns-big', 'towns-mid', 'towns-small'];
const SHAPE_LAYERS = ['town-shapes-fill', 'town-shapes-line'];
/** Dot layers' zoom ranges: in shapes mode only big towns keep a dot, until boundaries appear. */
const DOT_ZOOM: Record<string, [number, number]> = { 'towns-big': [5, 24], 'towns-mid': [6.5, 24], 'towns-small': [8, 24] };
const SHAPES_FROM = 6.5;
let pmtilesProtocol: Protocol | null = null;
/** Town boundaries come from one PMTiles archive read with HTTP range requests (pipeline/towns-geo.ts). */
function ensurePmtiles() {
  if (pmtilesProtocol) return;
  pmtilesProtocol = new Protocol();
  maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
}
const NIGHT_FILLS = { counties: 'night-counties', states: 'night-states' } as const;
type NightSrc = keyof typeof NIGHT_FILLS;

/** Election-night colouring: leader's colour; pale while leading, solid once called (stronger with margin); grey before reporting. */
function nightFillColor(colors: string[], dark: boolean): any {
  const gray = dark ? '#2b3445' : '#c9d1db';
  return colors.length ? ['match', ['coalesce', ['feature-state', 'nc'], -1], ...colors.flatMap((c, i) => [i, c]), gray] : gray;
}
const NIGHT_FILL_OPACITY: any = [
  'case',
  ['!', ['boolean', ['feature-state', 'nin'], false]], 0,
  ['<', ['coalesce', ['feature-state', 'nc'], -1], 0], 0.85,
  ['boolean', ['feature-state', 'ncall'], false], ['interpolate', ['linear'], ['coalesce', ['feature-state', 'nm'], 0], 0, 0.62, 0.35, 0.97],
  0.3,
];

/** What a night-map feature stands for: a reporting unit, or a group of units (a state, or a town's precincts). */
interface NightHit { unit?: number; units?: number[]; group?: string; label: string }
interface NightRef {
  night: ResultSummary;
  src: NightSrc | null;
  /** GEOID (or town id) -> unit index or group of unit indices. */
  lookup: Map<string, NightHit>;
  towns: { id: string; lon: number; lat: number; idxs: number[]; expected: number }[];
  applied: Map<string, string>;
}

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
const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };
type DistrictKind = 'cd' | 'sldu' | 'sldl';
/** One state's districts: the plan enacted after the census, or today's lines. */
async function stateDistricts(kind: DistrictKind, st: string): Promise<FeatureCollection> {
  const plan = data.activePlans[`${kind}:${st}`];
  if (plan) return loadTopo(`plans/${kind}/${st}-${plan}.json`).catch(() => loadTopo(`plans/${kind}/${st}-fair.json`)).catch(() => EMPTY_FC);
  if (kind === 'cd') {
    const fips = data.states[st]?.fips;
    const all = await loadTopo('cd.json');
    return { type: 'FeatureCollection', features: all.features.filter((f) => String(f.properties!.GEOID).slice(0, 2) === fips) };
  }
  return loadTopo(`${kind}/${st}.json`).catch(() => EMPTY_FC);
}
/** A whole district layer, with redrawn states swapped in. */
async function districtLayer(kind: DistrictKind): Promise<FeatureCollection> {
  if (kind === 'cd') {
    const base = await loadTopo('cd.json');
    const redrawn = Object.keys(data.activePlans).filter((k) => k.startsWith('cd:')).map((k) => k.slice(3));
    if (!redrawn.length) return base;
    const fips = new Set(redrawn.map((st) => data.states[st]?.fips));
    const parts = await Promise.all(redrawn.map((st) => stateDistricts('cd', st)));
    return { type: 'FeatureCollection', features: [...base.features.filter((f) => !fips.has(String(f.properties!.GEOID).slice(0, 2))), ...parts.flatMap((p) => p.features)] };
  }
  const states = STATE_LIST.filter((s) => s !== 'DC' && !(kind === 'sldl' && s === 'NE'));
  const parts = await Promise.all(states.map((s) => stateDistricts(kind, s)));
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
/** Town boundary colours: lean (from the tile) in partisan modes, your recognition, or neutral for demographics. */
function townShapeColor(mode: ColorMode, dark: boolean): any {
  if (mode === 'rec') return ['interpolate', ['linear'], ['coalesce', ['feature-state', 'rec'], 0], 0, dark ? '#13222f' : '#f0fdfa', 0.15, '#99f6e4', 0.3, '#2dd4bf', 0.5, '#0d9488', 0.7, '#134e4a'];
  if (DEMO_INDEX[mode] != null) return dark ? '#475569' : '#cbd5e1';
  return ['interpolate', ['linear'], ['get', 'lean'], 0.15, '#991b1b', 0.35, '#ef4444', 0.46, '#fca5a5', 0.5, dark ? '#3a4152' : '#eceff3', 0.54, '#93c5fd', 0.65, '#3b82f6', 0.85, '#1e3a8a'];
}

interface Tip { x: number; y: number; title: string; lines: string[] }

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [legend, setLegend] = useState<{ min: string; max: string } | null>(null);
  const [loadingLayer, setLoadingLayer] = useState(false);
  const { layer, colorMode, showTowns, townStyle, geoVersion, selection, mapVersion, dark, phase, view } = useGame();
  const geoApplied = useRef(0);
  const select = useGame((s) => s.select);
  const loaded = useRef(new Set<string>());
  const townStates = useRef(new Set<string>());
  const valueCache = useRef<{ holders: Record<string, string>; rec: Record<string, number> }>({ holders: {}, rec: {} });
  const stateBoxes = useRef<Record<string, [number, number, number, number]>>({});
  const night = useNight((s) => s.night);
  const nightColors = useNight((s) => s.colors);
  const nightMode = useNight((s) => s.mapMode);
  const nightFrame = useNight((s) => s.frame);
  const nightRef = useRef<NightRef | null>(null);
  const [nightSetup, setNightSetup] = useState(0);

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
      for (const [src, id] of Object.entries(NIGHT_FILLS)) map.addLayer({ id, type: 'fill', source: src, layout: { visibility: 'none' }, paint: { 'fill-color': '#888', 'fill-opacity': NIGHT_FILL_OPACITY } });
      ensurePmtiles();
      map.addSource('town-shapes', { type: 'vector', url: `pmtiles://${data.url('geo/towns.pmtiles')}`, promoteId: { towns: 'id' } });
      map.addLayer({ id: 'town-shapes-fill', type: 'fill', source: 'town-shapes', 'source-layer': 'towns', minzoom: SHAPES_FROM, layout: { visibility: 'none' }, paint: { 'fill-color': townShapeColor(useGame.getState().colorMode, dark), 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0.72] } });
      map.addLayer({ id: 'town-shapes-line', type: 'line', source: 'town-shapes', 'source-layer': 'towns', minzoom: SHAPES_FROM, layout: { visibility: 'none' }, paint: { 'line-color': dark ? '#0b1120' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.2, 10, 0.9], 'line-opacity': 0.85 } });
      map.addSource('night-area', { type: 'geojson', data: empty });
      map.addLayer({ id: 'night-area-fill', type: 'fill', source: 'night-area', layout: { visibility: 'none' }, paint: { 'fill-color': css('--accent'), 'fill-opacity': 0.08 } });
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
      map.addLayer({ id: 'night-area-line', type: 'line', source: 'night-area', layout: { visibility: 'none' }, paint: { 'line-color': css('--accent'), 'line-width': 2.5 } });
      map.addSource('night-towns', { type: 'geojson', data: empty });
      map.addLayer({
        id: 'night-towns', type: 'circle', source: 'night-towns', layout: { visibility: 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['*', ['get', 'r'], 0.55], 9, ['get', 'r'], 12, ['*', ['get', 'r'], 1.6]],
          'circle-color': ['get', 'c'],
          'circle-opacity': ['get', 'o'],
          'circle-stroke-width': 1,
          'circle-stroke-color': dark ? '#0b1120' : '#ffffff',
        },
      });
      map.addSource('home', { type: 'geojson', data: empty });
      map.addLayer({ id: 'home', type: 'circle', source: 'home', paint: { 'circle-radius': 7, 'circle-color': css('--accent'), 'circle-stroke-width': 2.5, 'circle-stroke-color': dark ? '#0b1120' : '#fff' } });

      const [states, counties, cd] = await Promise.all([loadTopo('states.json'), loadTopo('counties.json'), districtLayer('cd')]);
      for (const f of states.features) {
        const st = data.stateByFips[f.properties!.GEOID];
        if (st) stateBoxes.current[st] = bbox(f);
      }
      Object.assign(layerData, { states, counties, cd });
      (map.getSource('states') as GeoJSONSource).setData(states);
      (map.getSource('counties') as GeoJSONSource).setData(counties);
      (map.getSource('cd') as GeoJSONSource).setData(cd);
      loaded.current = new Set(['states', 'counties', 'cd']);
      geoApplied.current = useGame.getState().geoVersion;
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
    map.setPaintProperty('night-area-line', 'line-color', css('--accent'));
    map.setPaintProperty('night-area-fill', 'fill-color', css('--accent'));
    map.setPaintProperty('night-towns', 'circle-stroke-color', dark ? '#0b1120' : '#ffffff');
    map.setPaintProperty('town-shapes-line', 'line-color', dark ? '#0b1120' : '#ffffff');
  }, [dark, ready]);

  // ---- active layer + colours
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    let cancelled = false;
    (async () => {
      // district lines were redrawn (redistricting): reload the district layers already on the map
      if (geoApplied.current !== geoVersion) {
        geoApplied.current = geoVersion;
        for (const l of ['cd', 'sldu', 'sldl'] as const) {
          if (!loaded.current.has(l)) continue;
          const fc = await districtLayer(l);
          if (cancelled) return;
          layerData[l] = fc;
          (map.getSource(l) as GeoJSONSource).setData(fc);
        }
      }
      if (!loaded.current.has(layer) && (layer === 'sldu' || layer === 'sldl')) {
        setLoadingLayer(true);
        const fc = await districtLayer(layer);
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
      nightRef.current?.applied.clear();
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
      // town boundaries: recognition is per town (feature state); other modes read the tile
      map.setPaintProperty('town-shapes-fill', 'fill-color', townShapeColor(colorMode, dark));
      map.removeFeatureState({ source: 'town-shapes', sourceLayer: 'towns' });
      if (colorMode === 'rec') for (const [k, v] of Object.entries(valueCache.current.rec)) if (/^[PM]\d{6,}$/.test(k)) map.setFeatureState({ source: 'town-shapes', sourceLayer: 'towns', id: k }, { rec: v });
      refreshTowns();
      applyNight();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, colorMode, ready, mapVersion, dark, phase, geoVersion]);

  // ---- towns as dots or boundaries
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    const shapes = showTowns && townStyle === 'shapes' && !night;
    for (const l of SHAPE_LAYERS) map.setLayoutProperty(l, 'visibility', shapes ? 'visible' : 'none');
    for (const [l, [lo, hi]] of Object.entries(DOT_ZOOM)) map.setLayerZoomRange(l, lo, shapes ? Math.max(lo, SHAPES_FROM) : hi);
  }, [showTowns, townStyle, ready, night]);

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

  // ---- election night: set up layers for the race
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    let cancelled = false;
    clearNight(map, nightRef.current);
    nightRef.current = null;
    if (!night) {
      for (const l of LAYERS) map.setPaintProperty(`${l}-fill`, 'fill-opacity', BASE_FILL_OPACITY);
      for (const l of TOWN_LAYERS) map.setLayoutProperty(l, 'visibility', 'visible');
      for (const l of ['night-area-fill', 'night-area-line', 'night-towns']) map.setLayoutProperty(l, 'visibility', 'none');
      (map.getSource('night-towns') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    for (const l of LAYERS) map.setPaintProperty(`${l}-fill`, 'fill-opacity', 0.14);
    for (const l of TOWN_LAYERS) map.setLayoutProperty(l, 'visibility', 'none');
    (async () => {
      const ref: NightRef = { night, src: null, lookup: new Map(), towns: [], applied: new Map() };
      let area: Feature | null = null;
      if (night.unitKind === 'state') {
        ref.src = 'states';
        night.units.forEach((u, i) => data.states[u.id] && ref.lookup.set(data.states[u.id].fips, { unit: i, label: data.states[u.id].n }));
      } else if (night.unitKind === 'county' && night.electoral && nightMode === 'states') {
        ref.src = 'states';
        const by: Record<string, number[]> = {};
        night.units.forEach((u, i) => {
          const st = data.counties[u.id]?.st;
          if (st) (by[st] ??= []).push(i);
        });
        for (const [st, idxs] of Object.entries(by)) if (data.states[st]) ref.lookup.set(data.states[st].fips, { units: idxs, group: st, label: data.states[st].n });
      } else if (night.unitKind === 'county') {
        ref.src = 'counties';
        night.units.forEach((u, i) => ref.lookup.set(u.id, { unit: i, label: u.label.includes(',') ? u.label : `${u.label}, ${data.counties[u.id]?.st ?? ''}` }));
      } else {
        // precincts -> town dots, plus the district outline
        const by = new Map<string, number[]>();
        night.units.forEach((u, i) => {
          if (!u.geo) return;
          if (!by.has(u.geo)) by.set(u.geo, []);
          by.get(u.geo)!.push(i);
        });
        for (const [geo, idxs] of by) {
          const t = await data.town(geo);
          if (!t) continue;
          const expected = idxs.reduce((a, i) => a + night.units[i].votes.reduce((x, y) => x + y, 0), 0);
          const label = `${shortTownName(t.name)}, ${t.st}`;
          ref.towns.push({ id: geo, lon: t.lon, lat: t.lat, idxs, expected });
          ref.lookup.set(geo, { units: idxs, label: idxs.length > 1 ? `${label} (${idxs.length} precincts)` : label });
        }
        area = await nightArea(night.officeId).catch(() => null);
      }
      if (cancelled) return;
      for (const [src, id] of Object.entries(NIGHT_FILLS)) {
        const on = src === ref.src;
        map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        if (on) map.setPaintProperty(id, 'fill-color', nightFillColor(nightColors, dark));
      }
      (map.getSource('night-area') as GeoJSONSource).setData({ type: 'FeatureCollection', features: area ? [area] : [] });
      map.setLayoutProperty('night-area-fill', 'visibility', area ? 'visible' : 'none');
      map.setLayoutProperty('night-area-line', 'visibility', area ? 'visible' : 'none');
      map.setLayoutProperty('night-towns', 'visibility', ref.towns.length ? 'visible' : 'none');
      nightRef.current = ref;
      setNightSetup((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [night, nightMode, ready, dark, nightColors]);

  // ---- election night: apply the current frame (only features whose look changed are touched)
  function applyNight() {
    const map = mapRef;
    const ref = nightRef.current;
    const { frame, plan, colors, night: cur } = useNight.getState();
    if (!map || !ref || !frame || !plan || ref.night !== cur) return;
    if (ref.src) {
      for (const [gid, e] of ref.lookup) {
        const u = hitFrame(ref.night, e);
        if (!u) continue;
        const st = { nin: true, nc: u.counted > 0 ? u.leader : -1, ncall: u.called, nm: Math.round(u.margin * 50) / 50 };
        const key = `${st.nc}|${st.ncall}|${st.nm}`;
        if (ref.applied.get(gid) === key) continue;
        ref.applied.set(gid, key);
        map.setFeatureState({ source: ref.src, id: gid }, st);
      }
    }
    if (ref.towns.length) {
      const maxExp = Math.max(1, ...ref.towns.map((t) => t.expected));
      const gray = dark ? '#475569' : '#94a3b8';
      const feats: Feature<Geometry>[] = ref.towns.map((t) => {
        const g: GroupFrame = groupFrame(ref.night, plan, frame, t.idxs);
        const reporting = g.counted > 0;
        return {
          type: 'Feature', id: t.id,
          properties: { id: t.id, c: reporting ? colors[g.leader] : gray, o: !reporting ? 0.7 : g.called ? 0.95 : 0.5, r: 5 + 11 * Math.sqrt(t.expected / maxExp) },
          geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
        };
      });
      (map.getSource('night-towns') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
    }
  }
  useEffect(() => {
    if (ready) applyNight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nightFrame, nightSetup, ready]);

  // ---- interaction
  useEffect(() => {
    const map = mapRef;
    if (!map || !ready) return;
    let hoverId: { source: string; sourceLayer?: string; id: string } | null = null;
    let raf = 0;
    const townLayers = [...TOWN_LAYERS, 'town-shapes-fill'];
    const visible = (l: string) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none';
    const clearHover = () => {
      if (hoverId) map.setFeatureState(hoverId, { hover: false });
      hoverId = null;
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const L = useGame.getState().layer;
        const mode = useGame.getState().colorMode;
        const nref = nightRef.current;
        if (nref) {
          const nl = ['night-towns', ...(nref.src ? [NIGHT_FILLS[nref.src]] : [])];
          const hit = map.queryRenderedFeatures(e.point, { layers: nl }).map((f) => nref.lookup.get(String(f.properties!.GEOID ?? f.properties!.id))).find(Boolean);
          if (hit) {
            clearHover();
            map.getCanvas().style.cursor = 'pointer';
            setTip({ x: e.point.x, y: e.point.y, ...nightTip(nref.night, hit) });
            return;
          }
        }
        const feats = map.queryRenderedFeatures(e.point, { layers: [...townLayers.filter(visible), `${L}-fill`] });
        const town = feats.find((f) => townLayers.includes(f.layer.id));
        const area = feats.find((f) => f.layer.id === `${L}-fill`);
        clearHover();
        map.getCanvas().style.cursor = town || area ? 'pointer' : '';
        if (town) {
          const id = town.properties!.id as string;
          if (town.layer.id === 'town-shapes-fill') {
            hoverId = { source: 'town-shapes', sourceLayer: 'towns', id };
            map.setFeatureState(hoverId!, { hover: true });
          }
          const t = data.townSync(id);
          setTip(t
            ? { x: e.point.x, y: e.point.y, title: `${shortTownName(t.name)}, ${t.st}`, lines: [`Pop. ${num(t.pop)}`, `Lean ${leanLabel(t.lean)}`, `College ${(t.demo.college * 100).toFixed(0)}% · Median income $${num(Math.round(t.demo.income))}`] }
            : { x: e.point.x, y: e.point.y, title: 'Town', lines: [`Pop. ${num(town.properties!.pop ?? 0)}`, `Lean ${leanLabel(town.properties!.lean ?? 0.5)}`] });
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
      const feats = map.queryRenderedFeatures(e.point, { layers: [...townLayers.filter(visible), `${L}-fill`] });
      const town = feats.find((f) => townLayers.includes(f.layer.id)) as MapGeoJSONFeature | undefined;
      if (town) {
        const id = town.properties!.id as string;
        if (useGame.getState().phase === 'create') useGame.getState().pickTown(id);
        const pick = (t?: Town) => select({ kind: 'town', id, name: t ? `${shortTownName(t.name)}, ${t.st}` : `${town.properties!.name}, ${town.properties!.st}` });
        const t = data.townSync(id);
        if (t || town.properties!.name) pick(t);
        else data.town(id).then(pick);
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
      {night ? <NightLegend /> : <Legend mode={colorMode} range={legend} />}
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
  const fc = kind === 'state' ? await loadTopo('states.json') : kind === 'county' ? await loadTopo('counties.json') : await stateDistricts(kind, data.districts[`${kind}:${id}`]?.st ?? '');
  const gid = kind === 'state' ? data.states[id]?.fips : id;
  const f = fc.features.find((x) => x.properties!.GEOID === gid);
  if (!f) return;
  const [x0, y0, x1, y1] = bbox(f);
  map.fitBounds([[x0, y0], [x1, y1]], { padding: 60, duration: 900, maxZoom: 11 });
}

/** Reset election-night feature state on the shared county/state sources. */
function clearNight(map: maplibregl.Map, ref: NightRef | null) {
  for (const id of Object.values(NIGHT_FILLS)) map.setLayoutProperty(id, 'visibility', 'none');
  if (!ref?.src) return;
  for (const gid of ref.lookup.keys()) map.setFeatureState({ source: ref.src, id: gid }, { nin: false, nc: -1, ncall: false, nm: 0 });
}

/** The race's district or county shape (precinct-level races), for the outline drawn on election night. */
async function nightArea(officeId: string): Promise<Feature | null> {
  const [type, a] = officeId.split(':');
  if (type === 'county') return (await loadTopo('counties.json')).features.find((f) => f.properties!.GEOID === a) ?? null;
  const kind = type === 'house' ? 'cd' : type === 'sldu' || type === 'sldl' ? type : null;
  if (!kind) return null;
  const fc = await stateDistricts(kind, data.districts[`${kind}:${a}`]?.st ?? '');
  return fc.features.find((f) => f.properties!.GEOID === a) ?? null;
}

/** Current count for a night-map feature: one unit, a state (latched calls), or a town's precincts. */
function hitFrame(night: ResultSummary, hit: NightHit): UnitFrame | null {
  const { frame, plan } = useNight.getState();
  if (!frame || !plan) return null;
  if (hit.group && frame.groups?.[hit.group]) return frame.groups[hit.group];
  return hit.unit != null ? frame.units[hit.unit] : groupFrame(night, plan, frame, hit.units!);
}

function nightTip(night: ResultSummary, hit: NightHit): { title: string; lines: string[] } {
  const { frame, plan } = useNight.getState();
  if (!frame || !plan) return { title: hit.label, lines: [] };
  const u = hitFrame(night, hit)!;
  if (u.counted <= 0) return { title: hit.label, lines: ['Not yet reporting'] };
  const order = u.votes.map((_, i) => i).sort((a, b) => u.votes[b] - u.votes[a]);
  const lines = order.slice(0, 4).map((i) => `${night.cands[i].name}${night.cands[i].isPlayer ? ' (you)' : ''}: ${((u.votes[i] / u.counted) * 100).toFixed(1)}% · ${num(u.votes[i])}`);
  const ev = hit.group && night.electoral ? EV[hit.group] ?? 0 : 0;
  lines.push(`${Math.round(u.f * 100)}% in · ${u.called ? `Called for ${shortName(night, u.leader)}` : 'Too early to call'}${ev ? ` · ${ev} EV` : ''}`);
  return { title: hit.label, lines };
}
