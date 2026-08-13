import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, freemem, hostname, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  createIllustrationDocument,
  createPixelCelReader,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  floodPixelRegion,
  nowIso,
  writePixelRuns,
  writeTileRuns,
  type CanvasOperation,
  type CanvasTransaction,
  type IllustrationLayer,
  type RasterStroke,
  type ShapeObject,
} from '@aidraw/core';
import { exportDocument } from '@main/export-document';
import { transactionSamples, visibleOperations } from '@main/playback-scheduler';
import { materializePaintTiles, writeNativeDocument } from '@main/persistence';
import { renderIllustration, renderTilemap, renderTilemapRegion } from '@main/render-document';

const budgets = {
  vector5000RenderMs: 3_000,
  four4kPaintRenderMs: 8_000,
  coldCachedFour4kPaintRenderMs: 8_000,
  warmCachedFour4kPaintRenderMs: 3_000,
  tilemap65536RenderMs: 5_000,
  tilemap4096ChunkRegionRenderMs: 100,
  nativeSaveMs: 5_000,
  pngExportMs: 5_000,
  millionSampleAccountingMs: 500,
  millionCellFloodFillMs: 2_000,
  rssGrowthMiB: 1_200,
};

const temporaryPaths: string[] = [];
afterAll(async () => { await Promise.all(temporaryPaths.map((path) => rm(path, { recursive: true, force: true }))); });

async function measured<T>(work: () => T | Promise<T>): Promise<{ value: T; durationMs: number }> {
  const started = performance.now();
  const value = await work();
  return { value, durationMs: Number((performance.now() - started).toFixed(2)) };
}

function memorySnapshot(stage: string, baselineRss: number) {
  const usage = process.memoryUsage();
  return {
    stage,
    rssMiB: Number((usage.rss / 1024 / 1024).toFixed(2)),
    rssGrowthMiB: Number(((usage.rss - baselineRss) / 1024 / 1024).toFixed(2)),
    heapUsedMiB: Number((usage.heapUsed / 1024 / 1024).toFixed(2)),
    externalMiB: Number((usage.external / 1024 / 1024).toFixed(2)),
    arrayBuffersMiB: Number((usage.arrayBuffers / 1024 / 1024).toFixed(2)),
    maxRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
  };
}

function releaseMeasuredCanvas(canvas: { width: number; height: number }): void {
  // Each scenario measures its completed output before this reset. Do not keep
  // unrelated full-resolution native canvases alive across the rest of the
  // gate merely because the timing helper returned them.
  canvas.width = 1;
  canvas.height = 1;
}

function vectorFixture() {
  const document = createIllustrationDocument('5,000 vector performance fixture');
  document.artboard = { ...document.artboard, width: 1_280, height: 720, background: '#fffdf7' };
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
  if (!layer || layer.type !== 'vector') throw new Error('Vector fixture layer is missing.');
  const timestamp = nowIso();
  for (let index = 0; index < 5_000; index += 1) {
    const object: ShapeObject = {
      id: `perf-shape-${index}`, revision: 0, name: `Shape ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: index % 100 * 13, y: Math.floor(index / 100) * 14 },
      type: 'shape', shape: index % 3 === 0 ? 'ellipse' : 'rectangle', width: 11, height: 11, fill: { kind: 'solid', color: index % 2 ? '#8268dd' : '#ff6b7a' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[object.id] = object; layer.objectIds.push(object.id);
  }
  return document;
}

function paintFixture() {
  const document = createIllustrationDocument('Four 4K paint layers performance fixture');
  document.artboard = { ...document.artboard, width: 4_096, height: 4_096, background: '#fffdf7' };
  document.layers = {}; document.layerIds = [];
  const timestamp = nowIso();
  for (let layerIndex = 0; layerIndex < 4; layerIndex += 1) {
    const layer: IllustrationLayer = { id: `perf-paint-${layerIndex}`, revision: 0, name: `Paint ${layerIndex + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 0.92, blendMode: 'normal', type: 'paint', tileSize: 256, tileAssetIds: {}, strokes: [] };
    if (layer.type !== 'paint') continue;
    for (let strokeIndex = 0; strokeIndex < 16; strokeIndex += 1) {
      const y = 96 + layerIndex * 20 + strokeIndex * 248;
      const stroke: RasterStroke = { id: `perf-stroke-${layerIndex}-${strokeIndex}`, actorId: HUMAN_ACTOR.id, points: [{ x: 32, y, pressure: 0.6 }, { x: 2_048, y: y + 40, pressure: 0.8 }, { x: 4_064, y, pressure: 0.6 }], color: ['#8268dd', '#ff6b7a', '#31a6a0', '#e5b84b'][layerIndex], size: 18, opacity: 0.7, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' };
      layer.strokes.push(stroke);
    }
    document.layers[layer.id] = layer; document.layerIds.push(layer.id);
  }
  return document;
}

function mapFixture() {
  const document = createPixelDocument('project', '65,536 addressed tile performance fixture'); document.assetIds = []; document.pixelAssets = {};
  const sprite = createPixelSprite('Maximum sparse performance sheet', 8_192, 8_192); const cel = Object.values(sprite.cels)[0];
  writePixelRuns(cel, Array.from({ length: 16 }, (_, y) => ({ x: 0, y, length: 16, index: y % 2 ? 4 : 8 })));
  const tileset = createPixelTileset('Addressed performance tile', sprite.id, 16, 16, 1, 1); tileset.firstGid = 1;
  const map = createPixelTilemap('Addressed performance map'); map.tilesetIds = [tileset.id];
  map.width = 256; map.height = 256; map.tileWidth = 8; map.tileHeight = 8;
  const layer = map.layers[map.layerIds[0]];
  if (layer.type !== 'tile' || !layer.chunks) throw new Error('Tile layer is missing.');
  writeTileRuns(layer.chunks, Array.from({ length: map.height }, (_, y) => ({ x: 0, y, length: map.width, gid: 1 })));
  document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
  return { document, map };
}

function sparseMapRegionFixture() {
  const document = createPixelDocument('tilemap', '4,096-chunk regional performance fixture');
  const map = document.pixelAssets[document.activeAssetId];
  if (map.type !== 'tilemap') throw new Error('Sparse regional map fixture is missing.');
  map.width = 2_048; map.height = 2_048; map.tileWidth = 1; map.tileHeight = 1;
  const layer = map.layers[map.layerIds[0]];
  if (layer.type !== 'tile' || !layer.chunks) throw new Error('Sparse regional tile layer is missing.');
  writeTileRuns(layer.chunks, Array.from({ length: 4_096 }, (_, index) => ({ x: index % 64 * 32, y: Math.floor(index / 64) * 32, length: 1, gid: 1 })));
  return { document, map, region: { x: 2_016, y: 2_016, width: 1, height: 1 } };
}

function floodFillFixture() {
  const document = createPixelDocument('sprite', 'One million cell flood-fill fixture');
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite.type !== 'sprite') throw new Error('Sprite fixture is missing.');
  sprite.width = 1_000; sprite.height = 1_000;
  const cel = Object.values(sprite.cels)[0];
  writePixelRuns(cel, Array.from({ length: 1_000 }, (_, y) => ({ x: 0, y, length: 1_000, index: 4 })));
  return { sprite, read: createPixelCelReader(cel) };
}

describe('Windows v1 non-GUI performance gate', () => {
  it('meets the canonical render, persistence, and queue budgets', async () => {
    await renderIllustration(Object.assign(createIllustrationDocument('warmup'), { artboard: { ...createIllustrationDocument().artboard, width: 8, height: 8 } }));
    const startingRss = process.memoryUsage().rss;
    const memoryProfile = [memorySnapshot('baseline-after-warmup', startingRss)];
    const vector = vectorFixture();
    const vectorRender = await measured(() => renderIllustration(vector));
    const afterVectorRss = process.memoryUsage().rss;
    memoryProfile.push(memorySnapshot('after-vector-render', startingRss));
    releaseMeasuredCanvas(vectorRender.value);
    const paint = paintFixture();
    const paintRender = await measured(() => renderIllustration(paint));
    memoryProfile.push(memorySnapshot('after-editable-paint-render', startingRss));
    releaseMeasuredCanvas(paintRender.value);
    materializePaintTiles(paint);
    memoryProfile.push(memorySnapshot('after-paint-tile-materialization', startingRss));
    const coldCachedPaintRender = await measured(() => renderIllustration(paint));
    memoryProfile.push(memorySnapshot('after-cold-cached-paint-render', startingRss));
    releaseMeasuredCanvas(coldCachedPaintRender.value);
    const warmCachedPaintRender = await measured(() => renderIllustration(paint));
    const afterPaintRss = process.memoryUsage().rss;
    memoryProfile.push(memorySnapshot('after-warm-cached-paint-render', startingRss));
    releaseMeasuredCanvas(warmCachedPaintRender.value);
    const mapFixtureValue = mapFixture();
    const tilemapRender = await measured(() => renderTilemap(mapFixtureValue.document, mapFixtureValue.map));
    const afterMapRss = process.memoryUsage().rss;
    memoryProfile.push(memorySnapshot('after-tilemap-render', startingRss));
    releaseMeasuredCanvas(tilemapRender.value);
    const sparseMapRegionFixtureValue = sparseMapRegionFixture();
    const sparseMapRegionRender = await measured(() => renderTilemapRegion(sparseMapRegionFixtureValue.document, sparseMapRegionFixtureValue.map, sparseMapRegionFixtureValue.region));
    const afterSparseMapRegionRss = process.memoryUsage().rss;
    memoryProfile.push(memorySnapshot('after-4096-chunk-region-render', startingRss));
    releaseMeasuredCanvas(sparseMapRegionRender.value);
    const root = await mkdtemp(join(tmpdir(), 'aidraw-performance-')); temporaryPaths.push(root);
    const nativeSave = await measured(() => writeNativeDocument(join(root, 'vectors.aidraw'), vector, 'performance-gate'));
    memoryProfile.push(memorySnapshot('after-native-save', startingRss));
    const pngExport = await measured(() => exportDocument(vector, 'png'));
    memoryProfile.push(memorySnapshot('after-png-export', startingRss));
    const runs = Array.from({ length: 10_000 }, (_, index) => ({ x: 0, y: index, length: 100, index: 4 }));
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: vector.id, actor: HUMAN_ACTOR, label: 'One million samples', createdAt: nowIso(), playback: { mode: 'animated', speed: 1 }, operations: [{ kind: 'pixel.cel.region', spriteId: 'sprite', celId: 'cel', runs } as CanvasOperation] };
    const queueAccounting = await measured(() => ({ samples: transactionSamples(transaction), midpoint: visibleOperations(transaction.operations, 0.5) }));
    memoryProfile.push(memorySnapshot('after-queue-accounting', startingRss));
    const floodFixture = floodFillFixture();
    memoryProfile.push(memorySnapshot('after-million-cell-flood-fixture', startingRss));
    const floodFill = await measured(() => floodPixelRegion({ width: floodFixture.sprite.width, height: floodFixture.sprite.height, start: { x: 0, y: 0 }, read: floodFixture.read }));
    memoryProfile.push(memorySnapshot('after-million-cell-flood-fill', startingRss));
    const peakRss = Math.max(afterVectorRss, afterPaintRss, afterMapRss, afterSparseMapRegionRss, process.memoryUsage().rss);
    const metrics = {
      vector5000RenderMs: vectorRender.durationMs,
      four4kPaintRenderMs: paintRender.durationMs,
      coldCachedFour4kPaintRenderMs: coldCachedPaintRender.durationMs,
      warmCachedFour4kPaintRenderMs: warmCachedPaintRender.durationMs,
      tilemap65536RenderMs: tilemapRender.durationMs,
      tilemap4096ChunkRegionRenderMs: sparseMapRegionRender.durationMs,
      nativeSaveMs: nativeSave.durationMs,
      pngExportMs: pngExport.durationMs,
      millionSampleAccountingMs: queueAccounting.durationMs,
      millionCellFloodFillMs: floodFill.durationMs,
      rssGrowthMiB: Number(((peakRss - startingRss) / 1024 / 1024).toFixed(2)),
    };
    const report = { version: 1, createdAt: new Date().toISOString(), build: process.env.GITHUB_SHA ?? 'local', machine: { hostname: hostname(), platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryMiB: Math.round(totalmem() / 1024 / 1024), freeMemoryMiB: Math.round(freemem() / 1024 / 1024), node: process.version }, coverage: { automated: ['5,000 vector render', 'four 4096×4096 editable paint layers', 'cold and warm four-layer 4096×4096 materialized sparse paint render', '65,536 addressed tiles from an 8192×8192 sparse source sheet', 'one-pixel regional render across 4,096 stored map chunks', 'native save', 'PNG export', 'one-million-sample compact accounting', 'one-million-cell bounded flood fill', 'RSS growth'], deferredToPackagedComputerUse: ['pointer-to-preview latency', 'requestAnimationFrame pacing', 'human input during four visible agent lanes', '200% display scaling and tablet latency'] }, budgets, metrics, diagnostics: { memoryProfile } };
    const reportPath = process.env.AIDRAW_PERFORMANCE_REPORT ?? join(process.cwd(), 'test-results', 'performance-gate.json');
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    expect(queueAccounting.value.samples).toBe(1_000_000); expect((queueAccounting.value.midpoint[0] as Extract<CanvasOperation, { kind: 'pixel.cel.region' }>).runs.reduce((sum, run) => sum + run.length, 0)).toBe(500_000);
    expect(floodFill.value).toMatchObject({ ok: true, cellCount: 1_000_000 });
    if (!floodFill.value.ok) throw new Error('Expected bounded flood fill to succeed.');
    expect(floodFill.value.runs).toHaveLength(1_000);
    for (const [name, budget] of Object.entries(budgets)) expect(metrics[name as keyof typeof metrics], `${name} exceeded its documented budget; inspect ${reportPath}`).toBeLessThanOrEqual(budget);
  }, 60_000);
});
