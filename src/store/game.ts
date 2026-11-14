import { create } from 'zustand';
import * as Comlink from 'comlink';
import type { SimApi } from '../workers/sim.worker';
import type { GameView } from '../sim/game';
import type { GameState, NewCharacter } from '../sim/model';
import { DataStore } from '../data/store';
import { setApportionment } from '../sim/offices';
import { addHall, decodeSave, deleteSlot, encodeSave, listHall, listSlots, metaFromState, newSlotId, readSlot, writeSlot, type HallEntry, type SlotMeta } from './saves';

export type { HallEntry, SlotMeta } from './saves';
/** Most months one Skip ahead click runs. */
export const SKIP_MONTHS = 12;

export const BASE = new URL(import.meta.env.BASE_URL, location.href).href;
/** Main-thread copy of static data (for map + inspector); the worker has its own. */
export const data = new DataStore(BASE);

const worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), { type: 'module' });
export const sim = Comlink.wrap<SimApi>(worker);

export type Layer = 'states' | 'counties' | 'cd' | 'sldu' | 'sldl';
export type ColorMode = 'lean' | 'pres2024' | 'pres2020' | 'pres2016' | 'pres2012' | 'pres2008' | 'holder' | 'rec' | 'college' | 'income' | 'white' | 'black' | 'hispanic' | 'age' | 'density';
export type TownStyle = 'dots' | 'shapes';
export type Tab = 'campaign' | 'office' | 'run' | 'stats' | 'news' | 'career';
export interface Selection {
  kind: 'state' | 'county' | 'cd' | 'sldu' | 'sldl' | 'town';
  id: string;
  name: string;
}

interface Toast {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

interface Store {
  phase: 'loading' | 'title' | 'create' | 'play';
  loadError: string | null;
  view: GameView | null;
  busy: boolean;
  tab: Tab;
  layer: Layer;
  colorMode: ColorMode;
  showTowns: boolean;
  /** Towns as dots or as their boundaries (vector tiles). */
  townStyle: TownStyle;
  /** Bumped when district lines change (redistricting), so the map reloads district shapes. */
  geoVersion: number;
  selection: Selection | null;
  toasts: Toast[];
  /** Save slots, newest first (M13). */
  slots: SlotMeta[];
  /** The slot autosave writes to. */
  activeSlot: string | null;
  /** Bumped whenever officeholders or recognition change so the map can refresh. */
  mapVersion: number;
  /** Town picked on the map during character creation. */
  pickedTown: string | null;
  dark: boolean;
  /** Month summary modal (opens after End Month unless turned off). */
  summaryOpen: boolean;
  summaryAuto: boolean;
  /** Finished careers, best first (M17). */
  hall: HallEntry[];
  /** The career-end recap is showing (it can be closed to look around the final map). */
  recapOpen: boolean;

  boot(): Promise<void>;
  setTab(t: Tab): void;
  setLayer(l: Layer): void;
  setColorMode(m: ColorMode): void;
  setShowTowns(v: boolean): void;
  setTownStyle(v: TownStyle): void;
  select(s: Selection | null): void;
  toast(text: string, tone?: Toast['tone']): void;
  setPhase(p: Store['phase']): void;
  newGame(ch: NewCharacter): Promise<void>;
  continueGame(slotId: string): Promise<void>;
  importSave(file: Blob): Promise<void>;
  exportSave(): Promise<Blob>;
  saveAsSlot(name: string): Promise<void>;
  deleteSlot(slotId: string): Promise<void>;
  /** End months until something needs the player (at most `maxMonths`). */
  skipAhead(maxMonths?: number): Promise<void>;
  run<T extends { view: GameView; result?: { ok: boolean; msg: string } }>(fn: () => Promise<T>): Promise<T | undefined>;
  endTurn(): Promise<void>;
  ackNight(): Promise<void>;
  toggleDark(): void;
  pickTown(id: string | null): void;
  openSummary(open: boolean): void;
  setSummaryAuto(v: boolean): void;
  /** Retire from politics: ends the career (M17). */
  retire(): Promise<void>;
  openRecap(open: boolean): void;
}

let toastId = 1;

const prefersDark = () => {
  try {
    const t = localStorage.getItem('theme');
    if (t) return t === 'dark';
  } catch { /* storage unavailable */ }
  return matchMedia('(prefers-color-scheme: dark)').matches;
};

export const useGame = create<Store>((set, get) => ({
  phase: 'loading',
  loadError: null,
  view: null,
  busy: false,
  tab: 'run',
  layer: 'counties',
  colorMode: 'lean',
  showTowns: true,
  townStyle: readPref('townShapes', false) ? 'shapes' : 'dots',
  geoVersion: 0,
  selection: null,
  toasts: [],
  slots: [],
  activeSlot: null,
  mapVersion: 0,
  pickedTown: null,
  dark: prefersDark(),
  summaryOpen: false,
  summaryAuto: readPref('summaryAuto', true),
  hall: [],
  recapOpen: true,

  async boot() {
    document.documentElement.classList.toggle('dark', get().dark);
    try {
      await Promise.all([sim.init(BASE), data.loadCore()]);
      let slots: SlotMeta[] = [];
      let hall: HallEntry[] = [];
      try { slots = await listSlots(); hall = await listHall(); } catch { /* IndexedDB unavailable */ }
      set({ phase: 'title', slots, hall });
    } catch (e) {
      set({ loadError: String(e) });
    }
  },
  setTab: (tab) => set({ tab }),
  setLayer: (layer) => set({ layer }),
  setColorMode: (colorMode) => set({ colorMode }),
  setShowTowns: (showTowns) => set({ showTowns }),
  setTownStyle(townStyle) {
    try { localStorage.setItem('townShapes', townStyle === 'shapes' ? '1' : '0'); } catch { /* ignore */ }
    set({ townStyle });
  },
  select: (selection) => set({ selection }),
  toast(text, tone = 'neutral') {
    const t = { id: toastId++, text, tone };
    set({ toasts: [...get().toasts.slice(-3), t] });
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), 4200);
  },
  setPhase: (phase) => set(phase === 'play' ? { phase, recapOpen: true } : { phase }),
  async newGame(ch) {
    set({ busy: true });
    const view = await sim.newGame(ch);
    set({ view, phase: 'play', busy: false, tab: 'run', mapVersion: get().mapVersion + 1, colorMode: 'lean', activeSlot: newSlotId(), recapOpen: true });
    await autosave(`${ch.first} ${ch.last}`);
  },
  async continueGame(slotId) {
    if (get().busy) return;
    set({ busy: true });
    try {
      const st = await readSlot(slotId);
      if (!st) throw new Error('That save slot is empty');
      const view = await sim.load(st as GameState);
      set({ view, phase: 'play', busy: false, activeSlot: slotId, recapOpen: true, tab: view.campaign ? 'campaign' : view.me.office ? 'office' : 'run', mapVersion: get().mapVersion + 1, summaryOpen: false });
    } catch (e) {
      set({ busy: false });
      get().toast(String(e), 'bad');
    }
  },
  async importSave(file) {
    const st = (await decodeSave(file)) as GameState;
    const view = await sim.load(st);
    // an import gets its own slot, so it never overwrites the game in progress
    const id = newSlotId();
    set({ view, phase: 'play', mapVersion: get().mapVersion + 1, summaryOpen: false, activeSlot: id, recapOpen: true });
    await autosave(`${metaFromState(st, id, '').player} (imported)`);
  },
  async exportSave() {
    return encodeSave(await sim.exportState());
  },
  async saveAsSlot(name) {
    if (!get().view) return;
    set({ activeSlot: newSlotId() });
    await autosave(name.trim() || 'Untitled');
    get().toast(`Saved to slot "${name.trim() || 'Untitled'}". Autosave now writes there.`, 'good');
  },
  async deleteSlot(slotId) {
    try {
      const slots = await deleteSlot(slotId);
      set({ slots, activeSlot: get().activeSlot === slotId ? null : get().activeSlot });
    } catch (e) {
      get().toast(String(e), 'bad');
    }
  },
  async skipAhead(maxMonths = SKIP_MONTHS) {
    if (get().busy) return;
    set({ busy: true });
    try {
      const r = await sim.advance(maxMonths);
      // the merged summary explains how far the game went and why it stopped
      set({ view: r.view, busy: false, mapVersion: get().mapVersion + 1, summaryOpen: !!r.view.summary, toasts: [] });
      await autosave();
    } catch (e) {
      set({ busy: false });
      get().toast(`Skip failed: ${e}`, 'bad');
    }
  },
  async run(fn) {
    if (get().busy) return;
    set({ busy: true });
    try {
      const r = await fn();
      set({ view: r.view, busy: false });
      if (r.result) get().toast(r.result.msg, r.result.ok ? 'good' : 'bad');
      return r;
    } catch (e) {
      set({ busy: false });
      get().toast(String(e), 'bad');
    }
  },
  async endTurn() {
    if (get().busy) return;
    set({ busy: true });
    try {
      const view = await sim.endTurn();
      // last month's action toasts would only cover the month summary
      set({ view, busy: false, mapVersion: get().mapVersion + 1, summaryOpen: get().summaryAuto && !!view.summary, toasts: [] });
      await autosave();
    } catch (e) {
      set({ busy: false });
      get().toast(`Turn failed: ${e}`, 'bad');
    }
  },
  async ackNight() {
    const view = await sim.ackNight();
    set({ view });
    await autosave();
  },
  toggleDark() {
    const dark = !get().dark;
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
    set({ dark });
  },
  pickTown: (pickedTown) => set({ pickedTown }),
  openSummary: (summaryOpen) => set({ summaryOpen }),
  setSummaryAuto(summaryAuto) {
    try { localStorage.setItem('summaryAuto', summaryAuto ? '1' : '0'); } catch { /* ignore */ }
    set({ summaryAuto });
  },
  async retire() {
    if (get().busy) return;
    set({ busy: true });
    try {
      const r = await sim.retire();
      set({ view: r.view, busy: false, summaryOpen: false, recapOpen: true, mapVersion: get().mapVersion + 1 });
      if (!r.result.ok) get().toast(r.result.msg, 'bad');
      await autosave();
    } catch (e) {
      set({ busy: false });
      get().toast(String(e), 'bad');
    }
  },
  openRecap: (recapOpen) => set({ recapOpen }),
}));

/**
 * Achievements (M17): a toast for each one earned since the last view of the same career, and finished careers go
 * into the hall of fame the first time their end is seen.
 */
let seen: { game: string; ids: Set<string> } | null = null;
const hallDone = new Set<string>();
useGame.subscribe((st) => {
  const v = st.view;
  if (!v || st.phase !== 'play') return;
  const game = `${v.seed}:${v.me.id}`;
  const ids = new Set(v.legacy.achievements.filter((a) => a.earned).map((a) => a.id));
  if (seen?.game === game) {
    for (const id of ids) if (!seen.ids.has(id)) {
      const a = v.legacy.achievements.find((x) => x.id === id);
      if (a) setTimeout(() => useGame.getState().toast(`🏆 Achievement: ${a.label}`, 'good'), 0);
    }
  }
  seen = { game, ids };
  if (v.gameOver && !hallDone.has(game)) {
    hallDone.add(game);
    const L = v.legacy;
    const entry: HallEntry = {
      id: game, name: v.me.name, party: v.me.party, peak: L.peak?.title ?? 'Private citizen', score: L.score, rank: L.rank,
      years: Math.round(L.yearsInOffice * 10) / 10, ended: v.year, achievements: ids.size, seed: v.seed, at: Date.now(),
    };
    addHall(entry).then((hall) => useGame.setState({ hall })).catch(() => { /* storage unavailable */ });
  }
});

/**
 * Keep the main thread's copy of the geography in step with the save: redrawn district lines after the 2030 census
 * and the new electoral votes (the worker applies the same plans to its own DataStore).
 */
let geoKey = '';
useGame.subscribe((st) => {
  const R = st.view?.redistricting ?? null;
  const key = R ? `${R.apportioned}|${JSON.stringify(R.plans)}` : '';
  if (key === geoKey) return;
  geoKey = key;
  (async () => {
    setApportionment(R?.apportioned ? (await data.apportionment()).ev : null);
    await data.applyPlans(R?.plans ?? {});
    if (geoKey === key) useGame.setState((s) => ({ geoVersion: s.geoVersion + 1, mapVersion: s.mapVersion + 1 }));
  })().catch(() => { /* data missing: keep today's lines */ });
});

function readPref(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

/** Write the game to the active slot (optionally renaming it). */
async function autosave(name?: string) {
  const { activeSlot, slots } = useGame.getState();
  if (!activeSlot) return;
  try {
    const st = await sim.exportState();
    const view = useGame.getState().view;
    const c = view?.campaign && view.campaign.stage !== 'done' ? view.campaign : null;
    const meta: SlotMeta = {
      id: activeSlot,
      name: name ?? slots.find((s) => s.id === activeSlot)?.name ?? 'Autosave',
      player: view?.me.name ?? '', party: view?.me.party ?? '',
      office: view?.me.office?.title ?? (c ? `Running for ${c.title}` : 'Private citizen'),
      year: view?.year ?? st.year, month: view?.month ?? st.month, updated: Date.now(),
    };
    useGame.setState({ slots: await writeSlot(meta, st) });
  } catch {
    /* storage may be unavailable (private mode) — the game still works */
  }
}

// ----- formatting helpers
export const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K` : `${Math.round(a)}`;
  return `${n < 0 ? '-' : ''}$${s}`;
};
export const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
export const num = (n: number) => n.toLocaleString('en-US');
/** "D+7" / "R+12" style label from a D two-party share. */
export const leanLabel = (dShare: number) => {
  const m = Math.round((dShare - 0.5) * 200);
  return m === 0 ? 'EVEN' : m > 0 ? `D+${m}` : `R+${-m}`;
};
export const partyColor = (p?: string | null) => (p === 'D' ? 'var(--dem)' : p === 'R' ? 'var(--rep)' : p === 'I' ? 'var(--ind)' : 'var(--muted)');
