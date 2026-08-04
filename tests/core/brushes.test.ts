import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RASTER_BRUSH_PRESETS,
  CanvasOperationSchema,
  HUMAN_ACTOR,
  applyTransaction,
  createId,
  createIllustrationDocument,
  nowIso,
  rasterBrushDabs,
  rasterBrushDynamics,
  resolveRasterBrushPreset,
  stabilizeRasterPoints,
  validateDocument,
  type RasterBrushPreset,
  type RasterStroke,
} from '@aidraw/core';

function watercolorStroke(seed = 42): RasterStroke {
  const preset = BUILT_IN_RASTER_BRUSH_PRESETS.watercolor;
  return {
    id: 'wash', actorId: HUMAN_ACTOR.id, points: [{ x: 8, y: 10, pressure: 0.3 }, { x: 48, y: 16, pressure: 0.8 }],
    color: '#315fa4', size: preset.size, opacity: preset.opacity, hardness: preset.hardness, flow: preset.flow,
    mode: 'paint', preset: 'watercolor', brushPresetId: preset.id, dynamics: rasterBrushDynamics(preset, seed),
  };
}

describe('natural-media and custom raster brushes', () => {
  it('samples deterministic pressure-aware dabs and changes only when the stored seed changes', () => {
    const first = rasterBrushDabs(watercolorStroke(10));
    expect(first.length).toBeGreaterThan(10);
    expect(rasterBrushDabs(watercolorStroke(10))).toEqual(first);
    expect(rasterBrushDabs(watercolorStroke(11))).not.toEqual(first);
    expect(first.at(-1)!.radiusX).toBeGreaterThan(first[0].radiusX);
  });

  it('stabilizes a noisy pointer path without changing its sample count', () => {
    const points = [0, 12, -9, 11, -8, 0].map((y, x) => ({ x: x * 5, y, pressure: 0.5 }));
    const smoothed = stabilizeRasterPoints(points, 0.8);
    const variation = (values: typeof points) => values.slice(1).reduce((sum, point, index) => sum + Math.abs(point.y - values[index].y), 0);
    expect(smoothed).toHaveLength(points.length);
    expect(variation(smoothed)).toBeLessThan(variation(points));
  });

  it('resolves custom presets by value and leaves the stored preset immutable', () => {
    const custom: RasterBrushPreset = { ...structuredClone(BUILT_IN_RASTER_BRUSH_PRESETS.watercolor), id: 'custom-wash', name: 'Storm wash', size: 72 };
    const resolved = resolveRasterBrushPreset(custom.id, [custom]);
    resolved.size = 12;
    expect(custom.size).toBe(72);
    expect(resolveRasterBrushPreset('missing').id).toBe('hard-round');
  });

  it('strictly validates, persists, and exactly undoes a named preset library', () => {
    const preset: RasterBrushPreset = { ...structuredClone(BUILT_IN_RASTER_BRUSH_PRESETS.watercolor), id: 'custom-wash', name: 'Storm wash' };
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.brush-presets.replace', presets: [preset] }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.brush-presets.replace', presets: [{ ...preset, dynamics: { ...preset.dynamics, spacing: 0 } }] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.brush-presets.replace', presets: [preset, preset] }).success).toBe(false);
    const document = createIllustrationDocument();
    const applied = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Save brush', createdAt: nowIso(), operations: [{ kind: 'illustration.brush-presets.replace', presets: [preset] }] });
    if (applied.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(applied.document.brushPresets).toEqual([preset]);
    const restored = applyTransaction(applied.document, applied.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    expect(restored.brushPresets).toEqual([]);
  });

  it('hydrates a schema-1 illustration created before brush libraries existed', () => {
    const legacy = createIllustrationDocument();
    delete (legacy as Partial<typeof legacy>).brushPresets;
    const hydrated = validateDocument(legacy);
    if (hydrated.kind !== 'illustration') throw new Error('Expected illustration');
    expect(hydrated.brushPresets).toEqual([]);
  });
});
