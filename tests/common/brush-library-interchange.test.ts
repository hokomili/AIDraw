import {
  BUILT_IN_RASTER_BRUSH_PRESETS,
  HUMAN_ACTOR,
  applyTransaction,
  createIllustrationDocument,
  nowIso,
  rasterBrushDynamics,
  type CanvasTransaction,
  type IllustrationDocument,
  type RasterBrushPreset,
} from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_BRUSH_LIBRARY_BYTES,
  parseBrushLibraryJson,
  prepareBrushLibraryImport,
  serializeBrushLibrary,
} from '../../src/common/brush-library-interchange';

function preset(id: string, name: string, size = 72): RasterBrushPreset {
  return { ...structuredClone(BUILT_IN_RASTER_BRUSH_PRESETS.watercolor), id, name, size };
}

function commit(document: IllustrationDocument, operations: CanvasTransaction['operations']): IllustrationDocument {
  const result = applyTransaction(document, { id: 'brush-library-tx', clientOperationId: 'brush-library-op', documentId: document.id, actor: HUMAN_ACTOR, label: 'Import brush library', createdAt: nowIso(), operations }).document;
  if (result.kind !== 'illustration') throw new Error('Expected illustration document');
  return result;
}

function deterministicIds() {
  let sequence = 0;
  return (prefix: string) => `${prefix}-import-${++sequence}`;
}

describe('custom brush library interchange', () => {
  it('serializes and parses exact ordered custom dab recipes without mutating the document', () => {
    const source = createIllustrationDocument('Brush source');
    source.brushPresets = [preset('storm-wash', 'Storm wash', 81), { ...preset('dry-marker', 'Dry marker', 19), dynamics: { ...preset('dry-marker', 'Dry marker').dynamics, tip: 'chalk', angle: 27, granulation: 0.91 } }];
    const before = structuredClone(source);
    const serialized = serializeBrushLibrary(source);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(parseBrushLibraryJson(serialized)).toEqual({ format: 'aidraw-brush-library', version: 1, presets: source.brushPresets });
    expect(source).toEqual(before);
  });

  it('adds fresh non-destructive copies with deterministic IDs and case-insensitive unique names', () => {
    const source = createIllustrationDocument('Brush source'); source.brushPresets = [preset('source-wash', 'Storm wash')];
    const bundle = parseBrushLibraryJson(serializeBrushLibrary(source));
    const target = createIllustrationDocument('Brush target'); target.brushPresets = [preset('existing-wash', 'storm WASH', 24)];
    const paintLayer = Object.values(target.layers).find((layer) => layer.type === 'paint'); if (!paintLayer || paintLayer.type !== 'paint') throw new Error('Expected paint layer');
    paintLayer.strokes.push({ id: 'embedded-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 1, y: 2, pressure: 0.5 }], color: '#123456', size: 24, opacity: 0.5, hardness: 0.4, flow: 0.3, mode: 'paint', preset: 'custom', brushPresetId: 'existing-wash', dynamics: rasterBrushDynamics(target.brushPresets[0], 91) });
    const embeddedBefore = structuredClone(paintLayer.strokes);

    const plan = prepareBrushLibraryImport(target, bundle, 'append', { makeId: deterministicIds() });
    expect(plan).toMatchObject({ mode: 'append', incomingCount: 1, totalCount: 2, importedIds: ['brush-preset-import-1'] });
    const imported = commit(target, plan.operations);
    expect(imported.brushPresets).toEqual([target.brushPresets[0], { ...source.brushPresets[0], id: 'brush-preset-import-1', name: 'Storm wash (import 2)' }]);
    const importedPaint = imported.layers[paintLayer.id]; if (importedPaint.type !== 'paint') throw new Error('Expected paint layer');
    expect(importedPaint.strokes).toEqual(embeddedBefore);
  });

  it('replaces only the custom library while preserving imported IDs and the parsed bundle', () => {
    const source = createIllustrationDocument('Brush source'); source.brushPresets = [preset('ink-one', 'Ink one'), preset('ink-two', 'Ink two')];
    const bundle = parseBrushLibraryJson(serializeBrushLibrary(source)); const before = structuredClone(bundle);
    const target = createIllustrationDocument('Brush target'); target.brushPresets = [preset('old', 'Old')];
    const plan = prepareBrushLibraryImport(target, bundle, 'replace');
    expect(plan).toMatchObject({ mode: 'replace', incomingCount: 2, totalCount: 2, importedIds: ['ink-one', 'ink-two'] });
    expect(commit(target, plan.operations).brushPresets).toEqual(source.brushPresets);
    expect(bundle).toEqual(before);
  });

  it('rejects malformed, oversized, empty, reserved, invalid, and over-capacity input', () => {
    const source = createIllustrationDocument('Brush source'); source.brushPresets = [preset('valid', 'Valid')];
    const bundle = parseBrushLibraryJson(serializeBrushLibrary(source));
    expect(() => parseBrushLibraryJson('{')).toThrow(/malformed/);
    expect(() => parseBrushLibraryJson(JSON.stringify({ ...bundle, unexpected: true }))).toThrow(/Unrecognized key/);
    expect(() => parseBrushLibraryJson(JSON.stringify({ ...bundle, presets: [] }))).toThrow(/at least one/);
    expect(() => parseBrushLibraryJson(JSON.stringify({ ...bundle, presets: Array.from({ length: 257 }, (_, index) => preset(`many-${index}`, `Many ${index}`)) }))).toThrow(/256/);
    expect(() => parseBrushLibraryJson(JSON.stringify({ ...bundle, presets: [preset('hard-round', 'Override built-in')] }))).toThrow(/reserved/);
    expect(() => parseBrushLibraryJson(JSON.stringify({ ...bundle, presets: [{ ...preset('invalid', 'Invalid'), dynamics: { ...preset('invalid', 'Invalid').dynamics, spacing: 0 } }] }))).toThrow();
    expect(() => parseBrushLibraryJson('x'.repeat(MAX_BRUSH_LIBRARY_BYTES + 1))).toThrow(/1 MiB/);
    expect(() => serializeBrushLibrary(createIllustrationDocument('Empty'))).toThrow(/at least one/);

    const full = createIllustrationDocument('Full'); full.brushPresets = Array.from({ length: 256 }, (_, index) => preset(`full-${index}`, `Full ${index}`));
    expect(() => prepareBrushLibraryImport(full, bundle, 'append', { makeId: deterministicIds() })).toThrow(/256/);
  });
});
