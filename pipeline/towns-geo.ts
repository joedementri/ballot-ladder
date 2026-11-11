/**
 * Town polygons as vector tiles:  npm run data:towns
 *
 * Every playable town (incorporated places and active county subdivisions in places/<ST>.json) gets its Census
 * cartographic boundary (cb_2024 place and cousub, 1:500k). Shapes are cut into Mapbox Vector Tiles (zoom 6–10 (the map overzooms past 10),
 * layer "towns", properties id/pop/lean) and packed into one PMTiles v3 archive, public/data/geo/towns.pmtiles,
 * which the map reads with HTTP range requests (GitHub Pages serves them), so only the tiles in view are fetched.
 *
 * The PMTiles writer is small and follows the v3 spec: a 127-byte header, a gzip'd root directory (with leaf
 * directories when it would exceed 16 KB), gzip'd JSON metadata, then tile data in tile-id order with identical
 * tiles stored once.
 */
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { zxyToTileId } from 'pmtiles';
import { download, STATES } from './sources.ts';
import { OUT, readShapefile } from './lib.ts';

const MIN_Z = 6;
const MAX_Z = +(process.env.TOWNS_MAX_Z ?? 10);
const LAYER = 'towns';

async function main() {
  await download(false, ['place.zip', 'cousub.zip']);
  // the game's towns: id -> [pop, lean]
  const towns = new Map<string, [number, number]>();
  for (const st of STATES) {
    const rows: any[] = JSON.parse(readFileSync(join(OUT, 'places', `${st}.json`), 'utf8'));
    for (const r of rows) towns.set(r[0], [r[4], r[9]]);
  }
  console.log(`${towns.size} towns`);
  const feats: Feature<Geometry>[] = [];
  for (const [zip, prefix] of [['place.zip', 'P'], ['cousub.zip', 'M']] as const) {
    const fc = await readShapefile(zip);
    for (const f of fc.features) {
      const id = `${prefix}${f.properties!.GEOID}`;
      const t = towns.get(id);
      if (!t || !f.geometry) continue;
      feats.push({ type: 'Feature', geometry: f.geometry, properties: { id, pop: t[0], lean: t[1] } });
    }
  }
  const have = new Set(feats.map((f) => f.properties!.id));
  console.log(`${feats.length} town shapes (${towns.size - have.size} towns without a shape)`);

  const fc: FeatureCollection = { type: 'FeatureCollection', features: feats };
  const index = geojsonvt(fc as any, { maxZoom: MAX_Z, indexMaxZoom: MIN_Z, indexMaxPoints: 0, tolerance: 2, extent: 4096, buffer: 64 });

  // tiles that can contain a town, per zoom
  const keys = new Set<string>();
  let bbox = [180, 90, -180, -90];
  for (const f of feats) {
    const [x0, y0, x1, y1] = boundsOf(f.geometry);
    bbox = [Math.min(bbox[0], x0), Math.min(bbox[1], y0), Math.max(bbox[2], x1), Math.max(bbox[3], y1)];
    for (let z = MIN_Z; z <= MAX_Z; z++) {
      const [tx0, ty0] = tileOf(x0, y1, z), [tx1, ty1] = tileOf(x1, y0, z);
      for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) keys.add(`${z}/${x}/${y}`);
    }
  }
  console.log(`cutting ${keys.size} candidate tiles ...`);
  const tiles: { id: number; data: Buffer }[] = [];
  const byZoom: Record<number, number> = {};
  for (const k of keys) {
    const [z, x, y] = k.split('/').map(Number);
    const t = index.getTile(z, x, y);
    if (!t || !t.features.length) continue;
    const pbf = vtpbf.fromGeojsonVt({ [LAYER]: t }, { version: 2 });
    const data = gzipSync(Buffer.from(pbf));
    byZoom[z] = (byZoom[z] ?? 0) + data.length;
    tiles.push({ id: zxyToTileId(z, x, y), data });
  }
  tiles.sort((a, b) => a.id - b.id);
  console.log('  MB by zoom: ' + Object.entries(byZoom).map(([z, b]) => `z${z} ${(b / 1e6).toFixed(1)}`).join(', '));
  const archive = writePmtiles(tiles, {
    minZoom: MIN_Z, maxZoom: MAX_Z, bounds: bbox as [number, number, number, number],
    metadata: {
      name: 'Ballot Ladder towns', format: 'pbf', attribution: 'US Census Bureau (cb_2024 place, cousub)',
      vector_layers: [{ id: LAYER, minzoom: MIN_Z, maxzoom: MAX_Z, fields: { id: 'String', pop: 'Number', lean: 'Number' } }],
    },
  });
  writeFileSync(join(OUT, 'geo', 'towns.pmtiles'), archive);
  console.log(`wrote geo/towns.pmtiles: ${tiles.length} tiles, ${(archive.length / 1e6).toFixed(1)} MB`);
}

function boundsOf(g: Geometry): [number, number, number, number] {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = (c: any) => {
    if (typeof c[0] === 'number') { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); }
    else for (const k of c) walk(k);
  };
  walk((g as any).coordinates);
  return [x0, y0, x1, y1];
}
function tileOf(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

// ------------------------------------------------------------------ PMTiles v3 writer

interface Entry { tileId: number; offset: number; length: number; runLength: number }

function varint(out: number[], v: number) {
  while (v >= 0x80) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
  out.push(v);
}
function serializeDir(entries: Entry[]): Buffer {
  const out: number[] = [];
  varint(out, entries.length);
  let last = 0;
  for (const e of entries) { varint(out, e.tileId - last); last = e.tileId; }
  for (const e of entries) varint(out, e.runLength);
  for (const e of entries) varint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    varint(out, i > 0 && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  });
  return gzipSync(Buffer.from(out));
}

export function writePmtiles(tiles: { id: number; data: Buffer }[], o: { minZoom: number; maxZoom: number; bounds: [number, number, number, number]; metadata: object }): Buffer {
  // tile data, identical tiles stored once
  const chunks: Buffer[] = [];
  const byHash = new Map<string, { offset: number; length: number }>();
  const entries: Entry[] = [];
  let size = 0;
  for (const t of tiles) {
    const h = createHash('sha1').update(t.data).digest('hex');
    let loc = byHash.get(h);
    if (!loc) {
      loc = { offset: size, length: t.data.length };
      byHash.set(h, loc);
      chunks.push(t.data);
      size += t.data.length;
    }
    const prev = entries[entries.length - 1];
    if (prev && prev.tileId + prev.runLength === t.id && prev.offset === loc.offset) prev.runLength++;
    else entries.push({ tileId: t.id, offset: loc.offset, length: loc.length, runLength: 1 });
  }
  const tileData = Buffer.concat(chunks);
  // directories: one root, or a root of leaf directories
  let root = serializeDir(entries);
  let leaves = Buffer.alloc(0);
  if (root.length > 16384 - 127) {
    for (let per = 4096; ; per *= 2) {
      const leafBufs: Buffer[] = [];
      const rootEntries: Entry[] = [];
      let off = 0;
      for (let i = 0; i < entries.length; i += per) {
        const leaf = serializeDir(entries.slice(i, i + per));
        rootEntries.push({ tileId: entries[i].tileId, offset: off, length: leaf.length, runLength: 0 });
        leafBufs.push(leaf);
        off += leaf.length;
      }
      root = serializeDir(rootEntries);
      leaves = Buffer.concat(leafBufs);
      if (root.length <= 16384 - 127) break;
    }
  }
  const meta = gzipSync(Buffer.from(JSON.stringify(o.metadata)));
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'ascii');
  h.writeUInt8(3, 7);
  const rootOff = 127, metaOff = rootOff + root.length, leafOff = metaOff + meta.length, dataOff = leafOff + leaves.length;
  const u64 = (pos: number, v: number) => h.writeBigUInt64LE(BigInt(v), pos);
  u64(8, rootOff); u64(16, root.length);
  u64(24, metaOff); u64(32, meta.length);
  u64(40, leafOff); u64(48, leaves.length);
  u64(56, dataOff); u64(64, tileData.length);
  u64(72, tiles.length); u64(80, entries.length); u64(88, byHash.size);
  h.writeUInt8(1, 96); // clustered
  h.writeUInt8(2, 97); // internal compression: gzip
  h.writeUInt8(2, 98); // tile compression: gzip
  h.writeUInt8(1, 99); // tile type: MVT
  h.writeUInt8(o.minZoom, 100);
  h.writeUInt8(o.maxZoom, 101);
  const e7 = (v: number) => Math.round(v * 1e7);
  h.writeInt32LE(e7(o.bounds[0]), 102);
  h.writeInt32LE(e7(o.bounds[1]), 106);
  h.writeInt32LE(e7(o.bounds[2]), 110);
  h.writeInt32LE(e7(o.bounds[3]), 114);
  h.writeUInt8(o.minZoom, 118);
  h.writeInt32LE(e7((o.bounds[0] + o.bounds[2]) / 2), 119);
  h.writeInt32LE(e7((o.bounds[1] + o.bounds[3]) / 2), 123);
  return Buffer.concat([h, root, meta, leaves, tileData]);
}

if (process.argv[1]?.endsWith('towns-geo.ts')) main().catch((e) => { console.error(e); process.exit(1); });
