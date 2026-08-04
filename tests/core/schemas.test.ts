import { describe, expect, it } from 'vitest';
import {
  CanvasOperationSchema,
  CanvasTransactionSchema,
  ActorSchema,
  HUMAN_ACTOR,
  NewDocumentOptionsSchema,
  createId,
  createPixelSprite,
  nowIso,
} from '@aidraw/core';

describe('canvas operation schemas', () => {
  it('validates optional agent model, reasoning, and task metadata', () => {
    expect(ActorSchema.safeParse({ id: 'agent', kind: 'agent', name: 'Luna', color: '#8268dd', client: { model: 'luna', reasoningEffort: 'high', taskId: 'task-29' } }).success).toBe(true);
    expect(ActorSchema.safeParse({ id: 'agent', kind: 'agent', name: 'Luna', color: '#8268dd', client: { reasoningEffort: 'undefined' } }).success).toBe(false);
  });

  it('strictly validates the shared new-document contract', () => {
    expect(NewDocumentOptionsSchema.safeParse({
      kind: 'tilemap',
      name: 'Isometric world',
      width: 128,
      height: 96,
      orientation: 'isometric',
      infinite: true,
      tileWidth: 32,
      tileHeight: 16,
    }).success).toBe(true);
    for (const options of [
      { kind: 'illustration', width: 0 },
      { kind: 'sprite', height: 64.5 },
      { kind: 'illustration', background: 'transparent' },
      { kind: 'tilemap', tileWidth: 2048 },
      { kind: 'illustration', width: 64, surprise: true },
    ]) expect(NewDocumentOptionsSchema.safeParse(options).success).toBe(false);
  });

  it('accepts complete pixel changes and sprite assets', () => {
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.cel.set',
      spriteId: 'sprite-1',
      celId: 'cel-1',
      changes: [{ x: 0, y: 31, index: 7 }],
      expectedRevision: 0,
    }).success).toBe(true);

    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.asset.add',
      asset: createPixelSprite('Validated sprite', 32, 32),
    }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.cel.region', spriteId: 'sprite-1', celId: 'cel-1',
      runs: [{ x: 30, y: 2, length: 64, index: 7 }], expectedRevision: 0,
    }).success).toBe(true);
  });

  it('rejects overlapping, oversized, and malformed compact region runs', () => {
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.cel.region', spriteId: 's', celId: 'c', runs: [{ x: 0, y: 0, length: 4, index: 1 }, { x: 3, y: 0, length: 2, index: 2 }] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.tilemap.region', mapId: 'm', layerId: 'l', runs: [{ x: 0, y: 0, length: 65_537, gid: 1 }] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.cel.region', spriteId: 's', celId: 'c', runs: Array.from({ length: 16 }, (_, index) => ({ x: index * 65_536, y: index, length: 65_536, index: 1 })) }).success).toBe(false);
  });

  it('rejects the malformed pixel playback payload that blanked the renderer', () => {
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.cel.set',
      spriteId: 'sprite-1',
      celId: 'cel-1',
    }).success).toBe(false);

    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.cel.set',
      spriteId: 'sprite-1',
      celId: 'cel-1',
      changes: [{ x: Number.NaN, y: 1, index: 2 }],
    }).success).toBe(false);
  });

  it('rejects unknown operation kinds and structurally incomplete asset replacement', () => {
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.magic', changes: [] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.asset.replace',
      asset: { id: 'sprite-1', name: 'Incomplete', type: 'sprite', tags: [] },
    }).success).toBe(false);
  });

  it('validates revision-checked illustration object moves', () => {
    expect(CanvasOperationSchema.safeParse({
      kind: 'illustration.object.move',
      objectId: 'object-a',
      layerId: 'layer-b',
      index: 2,
      expectedRevision: 4,
    }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({
      kind: 'illustration.object.move',
      objectId: '',
      layerId: 'layer-b',
      index: -1,
    }).success).toBe(false);
  });

  it('strictly validates revision-checked artboard updates', () => {
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.artboard.replace', artboard: { width: 800, height: 600, background: null, colorSpace: 'srgb', dpi: 144 }, expectedRevision: 2 }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.artboard.translate', artboard: { width: 1024, height: 768, background: null, colorSpace: 'srgb', dpi: 144 }, offsetX: 112, offsetY: 84, expectedRevision: 2 }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.artboard.translate', artboard: { width: 1024, height: 768, background: null, colorSpace: 'srgb', dpi: 144 }, offsetX: 1.5, offsetY: 0 }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.artboard.replace', artboard: { width: 0, height: 600, background: 'white', colorSpace: 'display-p3', dpi: 0 } }).success).toBe(false);
  });

  it('rejects an asset replacement containing an incomplete nested cel', () => {
    const sprite = createPixelSprite('Malformed nested cel', 32, 32);
    const layerId = sprite.layerIds[0];
    const frameId = sprite.frameIds[0];
    (sprite.cels as Record<string, unknown>)['cel-without-chunks'] = {
      id: 'cel-without-chunks',
      frameId,
      layerId,
    };
    const parsed = CanvasOperationSchema.safeParse({ kind: 'pixel.asset.replace', asset: sprite, expectedRevision: 0 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.includes('chunks'))).toBe(true);
  });

  it('rejects a malformed operation inside an otherwise valid transaction', () => {
    const transaction = {
      id: createId('tx'),
      clientOperationId: createId('client-op'),
      documentId: createId('doc'),
      actor: HUMAN_ACTOR,
      label: 'Malformed trace',
      createdAt: nowIso(),
      operations: [{ kind: 'pixel.cel.set', spriteId: 'sprite-1', celId: 'cel-1' }],
      playback: { mode: 'animated', speed: 1 },
    };
    expect(CanvasTransactionSchema.safeParse(transaction).success).toBe(false);
  });

  it('strictly validates indexed-image conversion settings', () => {
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.conversion.replace',
      conversionDefaults: { resample: 'area', paletteMetric: 'oklab', dithering: 'bayer-4x4', alphaThreshold: 0.5 },
    }).success).toBe(true);
    for (const conversionDefaults of [
      { resample: 'nearest', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: 0.5 },
      { resample: 'area', paletteMetric: 'rgb', dithering: 'none', alphaThreshold: 0.5 },
      { resample: 'area', paletteMetric: 'oklab', dithering: 'random', alphaThreshold: 0.5 },
      { resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: -0.01 },
      { resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: Number.NaN },
      { resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: 0.5, surprise: true },
    ]) expect(CanvasOperationSchema.safeParse({ kind: 'pixel.conversion.replace', conversionDefaults }).success).toBe(false);
  });

  it('validates portable, hash-pinned pixel project links', () => {
    const sha256 = 'a'.repeat(64);
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.links.replace',
      linkedAssets: [{ id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: '../art/tiles.png', sha256, cachedPreviewAssetId: 'cache-a' }],
    }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.links.replace',
      linkedAssets: [{ id: 'link-b', name: 'packed tiles', mode: 'embedded', sha256, cachedPreviewAssetId: 'cache-b' }],
    }).success).toBe(true);

    for (const link of [
      { id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: 'C:/art/tiles.png', sha256, cachedPreviewAssetId: 'cache-a' },
      { id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: 'art\\tiles.png', sha256, cachedPreviewAssetId: 'cache-a' },
      { id: 'link-a', name: 'tiles.png', mode: 'linked', sha256, cachedPreviewAssetId: 'cache-a' },
      { id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: 'art/tiles.png', cachedPreviewAssetId: 'cache-a' },
      { id: 'link-a', name: 'tiles.png', mode: 'embedded', relativePath: 'art/tiles.png', sha256, cachedPreviewAssetId: 'cache-a' },
    ]) expect(CanvasOperationSchema.safeParse({ kind: 'pixel.links.replace', linkedAssets: [link] }).success).toBe(false);

    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.links.replace', linkedAssets: [
        { id: 'duplicate', name: 'one.png', mode: 'embedded', sha256, cachedPreviewAssetId: 'cache-a' },
        { id: 'duplicate', name: 'two.png', mode: 'embedded', sha256, cachedPreviewAssetId: 'cache-b' },
      ],
    }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.links.replace', linkedAssets: [], expectedRevision: -1 }).success).toBe(false);
  });
});
