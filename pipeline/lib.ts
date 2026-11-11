import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { RAW } from './sources.ts';

export const OUT = join(import.meta.dirname, '..', 'public', 'data');

export function writeJson(rel: string, data: unknown) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data));
}

/** RFC-4180-ish CSV parser (handles quotes, embedded commas/newlines). */
export function parseCsv(text: string, delim = ','): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift()!.map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export const readRaw = (name: string) => readFileSync(join(RAW, name), 'utf8');

export function readZipText(zipName: string): string {
  const zip = new AdmZip(join(RAW, zipName));
  const entry = zip.getEntries().find((e) => e.entryName.endsWith('.txt'))!;
  return entry.getData().toString('utf8');
}

/** Read an ACS table-based summary file into geoid -> {col: number}. Only keeps wanted geo prefixes. */
export function readAcs(table: string, prefixes: string[], cols: string[]): Map<string, number[]> {
  const text = readRaw(`acs_${table}.dat`);
  const lines = text.split('\n');
  const header = lines[0].trim().split('|');
  const idx = cols.map((c) => header.indexOf(c));
  if (idx.some((i) => i < 0)) throw new Error(`ACS ${table}: missing column in ${cols}`);
  const out = new Map<string, number[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!prefixes.some((p) => line.startsWith(p))) continue;
    const parts = line.trim().split('|');
    out.set(parts[0], idx.map((j) => Number(parts[j])));
  }
  return out;
}

/** Unzip a shapefile and read it as GeoJSON. */
export async function readShapefile(zipName: string): Promise<FeatureCollection> {
  const dir = join(RAW, zipName.replace('.zip', ''));
  if (!existsSync(dir)) new AdmZip(join(RAW, zipName)).extractAllTo(dir, true);
  const zip = new AdmZip(join(RAW, zipName));
  const shp = zip.getEntries().find((e) => e.entryName.endsWith('.shp'))!.entryName;
  return shapefile.read(join(dir, shp), join(dir, shp.replace('.shp', '.dbf')), { encoding: 'utf-8' }) as Promise<FeatureCollection>;
}

export function shpPath(zipName: string): string {
  const dir = join(RAW, zipName.replace('.zip', ''));
  if (!existsSync(dir)) new AdmZip(join(RAW, zipName)).extractAllTo(dir, true);
  const zip = new AdmZip(join(RAW, zipName));
  return join(dir, zip.getEntries().find((e) => e.entryName.endsWith('.shp'))!.entryName);
}

// ---------- Point-in-polygon index ----------

type Rings = Position[][];
interface Indexed { id: string; bbox: [number, number, number, number]; rings: Rings }

function ringsOf(g: Geometry): Rings {
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
}

/** Even-odd ray casting over all rings (handles holes and multipolygons). */
function inRings(x: number, y: number, rings: Rings): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export class PipIndex {
  private grid = new Map<string, Indexed[]>();
  private items: Indexed[] = [];
  constructor(fc: FeatureCollection, idOf: (f: Feature) => string) {
    for (const f of fc.features) {
      if (!f.geometry) continue;
      const rings = ringsOf(f.geometry);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of rings) for (const [x, y] of r) {
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
      const item: Indexed = { id: idOf(f), bbox: [x0, y0, x1, y1], rings };
      this.items.push(item);
      for (let gx = Math.floor(x0); gx <= Math.floor(x1); gx++)
        for (let gy = Math.floor(y0); gy <= Math.floor(y1); gy++) {
          const k = `${gx},${gy}`;
          (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(item);
        }
    }
  }
  find(lon: number, lat: number): string | null {
    const cell = this.grid.get(`${Math.floor(lon)},${Math.floor(lat)}`);
    if (!cell) return null;
    for (const it of cell) {
      const [x0, y0, x1, y1] = it.bbox;
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      if (inRings(lon, lat, it.rings)) return it.id;
    }
    return null;
  }
  /** Fallback: nearest bbox center among candidates in neighbouring cells (for coastal centroids). */
  nearest(lon: number, lat: number): string | null {
    let best: string | null = null, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const it of this.grid.get(`${Math.floor(lon) + dx},${Math.floor(lat) + dy}`) ?? []) {
        const cx = (it.bbox[0] + it.bbox[2]) / 2, cy = (it.bbox[1] + it.bbox[3]) / 2;
        const d = (cx - lon) ** 2 + (cy - lat) ** 2;
        if (d < bd) { bd = d; best = it.id; }
      }
    }
    return best;
  }
  locate(lon: number, lat: number) { return this.find(lon, lat) ?? this.nearest(lon, lat); }
}

// ---------- Small linear algebra for weighted least squares ----------

export function wls(X: number[][], y: number[], w: number[], ridge = 1e-6): number[] {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let n = 0; n < X.length; n++) {
    const xn = X[n], wn = w[n];
    for (let i = 0; i < k; i++) {
      b[i] += wn * xn[i] * y[n];
      for (let j = i; j < k; j++) A[i][j] += wn * xn[i] * xn[j];
    }
  }
  for (let i = 0; i < k; i++) { A[i][i] += ridge; for (let j = 0; j < i; j++) A[i][j] = A[j][i]; }
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < k; r++) {
      const f = A[r][c] / A[c][c];
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < k; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

export const logit = (p: number) => Math.log(p / (1 - p));
export const expit = (z: number) => 1 / (1 + Math.exp(-z));
export const r3 = (x: number) => Math.round(x * 1000) / 1000;
