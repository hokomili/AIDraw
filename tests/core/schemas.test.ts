import { describe, expect, it } from 'vitest';
import {
  CanvasOperationSchema,
  CanvasTransactionSchema,
  HUMAN_ACTOR,
  createId,
  createPixelSprite,
  nowIso,
} from '@aidraw/core';

describe('canvas operation schemas', () => {
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
});
