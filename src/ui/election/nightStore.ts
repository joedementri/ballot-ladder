import { create } from 'zustand';
import type { ResultSummary } from '../../sim/model';
import type { NightFrame, NightPlan } from '../../sim/night';

/** Live election-night playback shared by the results panel (which drives it) and the map (which draws it). */
export interface NightUI {
  night: ResultSummary | null;
  plan: NightPlan | null;
  frame: NightFrame | null;
  /** Resolved candidate colours (hex), indexed like night.cands. */
  colors: string[];
  /** Presidential generals: draw counties or the state electoral map. */
  mapMode: 'units' | 'states';
  setMapMode(m: NightUI['mapMode']): void;
}

export const useNight = create<NightUI>((set) => ({
  night: null,
  plan: null,
  frame: null,
  colors: [],
  mapMode: 'units',
  setMapMode: (mapMode) => set({ mapMode }),
}));
