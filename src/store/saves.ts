/**
 * Save slots (IndexedDB) and save files (M13).
 * - `ballot-ladder-slots` holds the index: one SlotMeta per slot, newest first.
 * - `ballot-ladder-slot:<id>` holds that slot's GameState.
 * - The pre-M13 single autosave (`ballot-ladder-autosave`) becomes a slot named "Autosave" on first boot.
 * Export files are gzipped JSON; import accepts gzip or plain JSON.
 */
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

export interface SlotMeta {
  id: string;
  name: string;
  /** Player name, party and what they are doing, for the title screen. */
  player: string;
  party: string;
  office: string;
  year: number;
  month: number;
  /** Last write, ms since epoch. */
  updated: number;
}

const INDEX_KEY = 'ballot-ladder-slots';
const LEGACY_KEY = 'ballot-ladder-autosave';
const slotKey = (id: string) => `ballot-ladder-slot:${id}`;

export const newSlotId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const sortSlots = (list: SlotMeta[]) => [...list].sort((a, b) => b.updated - a.updated);

/** Meta for a save that has not been through the worker yet (legacy autosave, imports). */
export function metaFromState(st: any, id: string, name: string): SlotMeta {
  const me = st?.politicians?.[st?.player?.id];
  return {
    id, name, player: me ? `${me.first} ${me.last}` : 'Unknown', party: me?.party ?? '',
    office: me?.officeId ? 'In office' : 'Private citizen', year: st?.year ?? 0, month: st?.month ?? 1, updated: Date.now(),
  };
}

/** The slot index, creating it from the pre-M13 autosave if there is one. */
export async function listSlots(): Promise<SlotMeta[]> {
  const list = (await idbGet<SlotMeta[]>(INDEX_KEY)) ?? null;
  if (list) return sortSlots(list);
  const legacy = await idbGet(LEGACY_KEY);
  if (!legacy) return [];
  const id = newSlotId();
  const meta = metaFromState(legacy, id, 'Autosave');
  await idbSet(slotKey(id), legacy);
  await idbSet(INDEX_KEY, [meta]);
  await idbDel(LEGACY_KEY);
  return [meta];
}

export async function readSlot(id: string): Promise<unknown> {
  return idbGet(slotKey(id));
}

/** Write a slot's state and update (or add) its index entry. Returns the new index. */
export async function writeSlot(meta: SlotMeta, state: unknown): Promise<SlotMeta[]> {
  await idbSet(slotKey(meta.id), state);
  const list = (await idbGet<SlotMeta[]>(INDEX_KEY)) ?? [];
  const next = [...list.filter((s) => s.id !== meta.id), meta];
  await idbSet(INDEX_KEY, next);
  return sortSlots(next);
}

export async function deleteSlot(id: string): Promise<SlotMeta[]> {
  await idbDel(slotKey(id));
  const next = ((await idbGet<SlotMeta[]>(INDEX_KEY)) ?? []).filter((s) => s.id !== id);
  await idbSet(INDEX_KEY, next);
  return sortSlots(next);
}

// ----- save files

const GZIP_MAGIC = [0x1f, 0x8b];

export const isGzip = (bytes: Uint8Array) => bytes.length > 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];

/** Gzipped JSON when the browser supports CompressionStream, plain JSON otherwise. */
export async function encodeSave(state: unknown): Promise<Blob> {
  const json = JSON.stringify(state);
  if (typeof CompressionStream === 'undefined') return new Blob([json], { type: 'application/json' });
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' });
}

/** Parse a save file: gzip (by its magic bytes) or plain JSON. */
export async function decodeSave(file: Blob): Promise<unknown> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  if (isGzip(bytes)) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed saves');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else text = new TextDecoder().decode(bytes);
  let st: unknown;
  try {
    st = JSON.parse(text);
  } catch {
    throw new Error('Not a Ballot Ladder save file');
  }
  const s = st as { version?: unknown; politicians?: unknown } | null;
  if (!s?.version || !s?.politicians) throw new Error('Not a Ballot Ladder save file');
  return st;
}
