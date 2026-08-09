import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { resourceUsage } from 'node:process';
import { readTileAt } from '@aidraw/core';
import { test, expect } from 'vitest';
import { importDocument } from '@main/import-document';

const CONTRACT = 'qa08-tiled-cell-budget-v2';
const LAYER_WIDTH = 2_048;
const LAYER_HEIGHT = 2_048;
const LAYER_CELLS = 4_194_304;
const TOTAL_CELLS = 16_777_216;

interface TiledFixtureLayer {
  type: 'tilelayer';
  name: string;
  width: number;
  height: number;
  encoding?: 'base64';
  compression?: 'zlib';
  data: string | number[];
}

function memorySnapshot() {
  const memory = process.memoryUsage(); const resources = resourceUsage();
  return { rss: memory.rss, heapTotal: memory.heapTotal, heapUsed: memory.heapUsed, external: memory.external, arrayBuffers: memory.arrayBuffers, maxRss: resources.maxRSS };
}

function exactLayerData(): string {
  return deflateSync(Buffer.alloc(LAYER_CELLS * 4)).toString('base64');
}

function tiledMap(encoded: string, includeOverflow: boolean) {
  const layers: TiledFixtureLayer[] = Array.from({ length: 4 }, (_, index) => ({ type: 'tilelayer', name: `Exact layer ${index + 1}`, width: LAYER_WIDTH, height: LAYER_HEIGHT, encoding: 'base64', compression: 'zlib', data: encoded }));
  if (includeOverflow) layers.push({ type: 'tilelayer', name: 'Over-budget layer', width: 1, height: 1, data: [1] });
  return { type: 'map', orientation: 'orthogonal', infinite: false, width: LAYER_WIDTH, height: LAYER_HEIGHT, tilewidth: 16, tileheight: 16, tilesets: [], layers };
}

function smokeMap() {
  return { type: 'map', orientation: 'orthogonal', infinite: false, width: 1, height: 1, tilewidth: 16, tileheight: 16, tilesets: [], layers: [{ type: 'tilelayer', name: 'Vitest 4 CLI smoke', width: 1, height: 1, data: [7] }] };
}

function validateRoot(root: string, scenario: string): void {
  const retained = resolve(process.cwd(), 'test-results', 'retained');
  const pattern = scenario === 'smoke' ? /^aidraw-qa08-tiled-cell-budget-cli-smoke-v2-[0-9]{8}T[0-9]{6}$/ : /^aidraw-qa08-tiled-cell-budget-optin-v2-[0-9]{8}T[0-9]{6}$/;
  if (dirname(root) !== retained || !pattern.test(root.slice(retained.length + 1))) throw new Error('The QA-08 v2 test root is outside the exact retained boundary.');
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function prepareFreshRoot(root: string): Promise<void> {
  if (await exists(root)) {
    const existing = await readdir(root);
    if (existing.some((name) => name !== 'vite-cache')) throw new Error('The QA-08 v2 retained root contains a non-cache artifact before the scenario.');
  } else await mkdir(root);
}

async function acceptExact(filePath: string) {
  const result = await importDocument(filePath, true); expect(result.warnings).toEqual([]); expect(result.documents).toHaveLength(1);
  const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected exact-boundary pixel document');
  const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected exact-boundary tilemap');
  expect(map.layerIds).toHaveLength(4); expect(Object.keys(map.layers)).toHaveLength(4);
  for (const [index, id] of map.layerIds.entries()) {
    const layer = map.layers[id]; if (layer.type !== 'tile' || !layer.chunks) throw new Error(`Expected exact tile layer ${index + 1}`);
    expect(layer.name).toBe(`Exact layer ${index + 1}`); expect(readTileAt(layer.chunks, 0, 0)).toBe(0); expect(readTileAt(layer.chunks, LAYER_WIDTH - 1, LAYER_HEIGHT - 1)).toBe(0);
  }
  return { canonicalLayerCount: map.layerIds.length, canonicalNames: map.layerIds.map((id) => map.layers[id].name), sampleGids: [0, 0] };
}

async function runSmoke(root: string): Promise<void> {
  await prepareFreshRoot(root);
  const source = Buffer.from(JSON.stringify(smokeMap()));
  const filePath = resolve(root, 'smoke.tmj'); await writeFile(filePath, source, { flag: 'wx' });
  const before = memorySnapshot(); const started = performance.now();
  const result = await importDocument(filePath, true); expect(result.warnings).toEqual([]); expect(result.documents).toHaveLength(1);
  const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected smoke pixel document');
  const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected smoke tilemap');
  expect(map.layerIds).toHaveLength(1);
  const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected smoke tile layer');
  expect(layer.name).toBe('Vitest 4 CLI smoke'); expect(readTileAt(layer.chunks, 0, 0)).toBe(7);
  globalThis.gc?.();
  const durationMs = performance.now() - started; const after = memorySnapshot(); const file = await stat(filePath);
  await writeFile(resolve(root, 'smoke-evidence.json'), `${JSON.stringify({ contract: CONTRACT, scenario: 'smoke', totalCells: 1, source: { bytes: file.size, sha256: createHash('sha256').update(await readFile(filePath)).digest('hex').toUpperCase() }, canonicalLayerCount: 1, canonicalNames: [layer.name], sampleGids: [7], error: null, durationMs, resources: { before, after, maxRss: Math.max(before.maxRss, after.maxRss) } }, null, 2)}\n`, { flag: 'wx' });
}

test('QA-08 opt-in exact aggregate Tiled cell budget v2', async () => {
  const scenario = process.env.AIDRAW_QA08_CELL_BUDGET_SCENARIO;
  const root = resolve(String(process.env.AIDRAW_QA08_CELL_BUDGET_ROOT ?? ''));
  if (process.env.AIDRAW_QA08_CELL_BUDGET_OPT_IN !== CONTRACT || !['accept', 'reject', 'smoke'].includes(String(scenario))) throw new Error('The audited QA-08 v2 opt-in controller contract is absent.');
  validateRoot(root, String(scenario));
  if (scenario === 'smoke') { await runSmoke(root); return; }
  if (scenario === 'accept') await prepareFreshRoot(root);
  else {
    if (!await exists(resolve(root, 'accept-evidence.json'))) throw new Error('Reject scenario requires retained exact-acceptance evidence from the same controller run.');
    if (await exists(resolve(root, 'reject-evidence.json'))) throw new Error('Reject evidence already exists.');
  }

  const encoded = exactLayerData();
  const source = Buffer.from(JSON.stringify(tiledMap(encoded, scenario === 'reject')));
  const filePath = resolve(root, `${scenario}.tmj`); await writeFile(filePath, source, { flag: 'wx' });
  const before = memorySnapshot(); const started = performance.now();
  let canonicalLayerCount = 0; let canonicalNames: string[] = []; let sampleGids: number[] = []; let error: string | null = null;
  if (scenario === 'accept') ({ canonicalLayerCount, canonicalNames, sampleGids } = await acceptExact(filePath));
  else {
    try { await importDocument(filePath, true); throw new Error('The over-budget fixture unexpectedly imported.'); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); expect(error).toBe('Tiled layer data exceeds the 16,777,216-cell total import budget.'); }
  }
  globalThis.gc?.();
  const durationMs = performance.now() - started; const after = memorySnapshot(); const file = await stat(filePath);
  const evidence = {
    contract: CONTRACT,
    scenario,
    totalCells: scenario === 'accept' ? TOTAL_CELLS : TOTAL_CELLS + 1,
    individualLayerCells: scenario === 'accept' ? [LAYER_CELLS, LAYER_CELLS, LAYER_CELLS, LAYER_CELLS] : [LAYER_CELLS, LAYER_CELLS, LAYER_CELLS, LAYER_CELLS, 1],
    source: { bytes: file.size, sha256: createHash('sha256').update(await readFile(filePath)).digest('hex').toUpperCase() },
    canonicalLayerCount,
    canonicalNames,
    sampleGids,
    error,
    durationMs,
    resources: { before, after, maxRss: Math.max(before.maxRss, after.maxRss) },
  };
  await writeFile(resolve(root, `${scenario}-evidence.json`), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
});
