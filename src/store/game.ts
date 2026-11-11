import { create } from 'zustand';
import * as Comlink from 'comlink';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import type { SimApi } from '../workers/sim.worker';
import type { GameView } from '../sim/game';
import type { NewCharacter } from '../sim/model';
import { DataStore } from '../data/store';

export const BASE = new URL(import.meta.env.BASE_URL, location.href).href;
/** Main-thread copy of static data (for map + inspector); the worker has its own. */
export const data = new DataStore(BASE);

const worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), { type: 'module' });
export const sim = Comlink.wrap<SimApi>(worker);

export type Layer = 'states' | 'counties' | 'cd' | 'sldu' | 'sldl';
export type ColorMode = 'lean' | 'pres2024' | 'pres2020' | 'pres2016' | 'pres2012' | 'pres2008' | 'holder' | 'rec' | 'college' | 'income' | 'white' | 'black' | 'hispanic' | 'age' | 'density';
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
  selection: Selection | null;
  toasts: Toast[];
  hasSave: boolean;
  /** Bumped whenever officeholders or recognition change so the map can refresh. */
  mapVersion: number;
  /** Town picked on the map during character creation. */
  pickedTown: string | null;
  dark: boolean;
  /** Month summary modal (opens after End Month unless turned off). */
  summaryOpen: boolean;
  summaryAuto: boolean;

  boot(): Promise<void>;
  setTab(t: Tab): void;
  setLayer(l: Layer): void;
  setColorMode(m: ColorMode): void;
  setShowTowns(v: boolean): void;
  select(s: Selection | null): void;
  toast(text: string, tone?: Toast['tone']): void;
  setPhase(p: Store['phase']): void;
  newGame(ch: NewCharacter): Promise<void>;
  continueGame(): Promise<void>;
  importSave(json: string): Promise<void>;
  exportSave(): Promise<string>;
  run<T extends { view: GameView; result?: { ok: boolean; msg: string } }>(fn: () => Promise<T>): Promise<T | undefined>;
  endTurn(): Promise<void>;
  ackNight(): Promise<void>;
  deleteSave(): Promise<void>;
  toggleDark(): void;
  pickTown(id: string | null): void;
  openSummary(open: boolean): void;
  setSummaryAuto(v: boolean): void;
}

const SAVE_KEY = 'ballot-ladder-autosave';
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
  selection: null,
  toasts: [],
  hasSave: false,
  mapVersion: 0,
  pickedTown: null,
  dark: prefersDark(),
  summaryOpen: false,
  summaryAuto: readPref('summaryAuto', true),

  async boot() {
    document.documentElement.classList.toggle('dark', get().dark);
    try {
      await Promise.all([sim.init(BASE), data.loadCore()]);
      let hasSave = false;
      try { hasSave = !!(await idbGet(SAVE_KEY)); } catch { /* IndexedDB unavailable */ }
      set({ phase: 'title', hasSave });
    } catch (e) {
      set({ loadError: String(e) });
    }
  },
  setTab: (tab) => set({ tab }),
  setLayer: (layer) => set({ layer }),
  setColorMode: (colorMode) => set({ colorMode }),
  setShowTowns: (showTowns) => set({ showTowns }),
  select: (selection) => set({ selection }),
  toast(text, tone = 'neutral') {
    const t = { id: toastId++, text, tone };
    set({ toasts: [...get().toasts.slice(-3), t] });
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), 4200);
  },
  setPhase: (phase) => set({ phase }),
  async newGame(ch) {
    set({ busy: true });
    const view = await sim.newGame(ch);
    set({ view, phase: 'play', busy: false, tab: 'run', mapVersion: get().mapVersion + 1, colorMode: 'lean' });
    await autosave();
  },
  async continueGame() {
    const st = await idbGet(SAVE_KEY);
    if (!st) return;
    set({ busy: true });
    const view = await sim.load(st);
    set({ view, phase: 'play', busy: false, tab: view.campaign ? 'campaign' : view.me.office ? 'office' : 'run', mapVersion: get().mapVersion + 1, summaryOpen: false });
  },
  async importSave(json) {
    const st = JSON.parse(json);
    if (!st?.version || !st?.politicians) throw new Error('Not a Ballot Ladder save file');
    const view = await sim.load(st);
    set({ view, phase: 'play', mapVersion: get().mapVersion + 1, summaryOpen: false });
    await autosave();
  },
  async exportSave() {
    return JSON.stringify(await sim.exportState());
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
  async deleteSave() {
    try { await idbDel(SAVE_KEY); } catch { /* ignore */ }
    set({ hasSave: false });
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
}));

function readPref(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

async function autosave() {
  try {
    const st = await sim.exportState();
    await idbSet(SAVE_KEY, st);
    useGame.setState({ hasSave: true });
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
