import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Serve public/data from disk for tests (DataStore uses fetch). */
export const BASE = 'http://local.test/';
const root = join(import.meta.dirname, '..', 'public');
globalThis.fetch = (async (url: string) => {
  const path = decodeURIComponent(new URL(url).pathname);
  const body = readFileSync(join(root, path), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(body) } as Response;
}) as typeof fetch;
