import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RASTER_BRUSH_PRESETS,
  CanvasOperationSchema,
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  applyTransaction,
  createDefaultBitmapFont,
  createIllustrationDocument,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  duplicatePixelFrame,
  type AIDrawDocument,
  type CanvasOperation,
  type CanvasTransaction,
  type DocumentAsset,
  type IllustrationDocument,
  type IllustrationKeyframe,
  type IllustrationLayer,
  type PixelDocument,
  type PixelSprite,
  type Provenance,
  type ShapeObject,
} from '@aidraw/core';

const FIXED_TIME = '2026-08-12T00:00:00.000Z';

interface OperationScenario {
  document: AIDrawDocument;
  operation: CanvasOperation;
}

type OperationKind = CanvasOperation['kind'];
type ScenarioFactory = () => OperationScenario;

function transaction(document: AIDrawDocument, operations: CanvasOperation[]): CanvasTransaction {
  return {
    id: `tx-${operations.map((operation) => operation.kind).join('-')}`,
    clientOperationId: `op-${operations.map((operation) => operation.kind).join('-')}`,
    documentId: document.id,
    actor: HUMAN_ACTOR,
    label: 'Reducer operation corpus',
    createdAt: FIXED_TIME,
    operations,
  };
}

function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['revision', 'updatedAt', 'dirty', 'activity'].includes(key))
    .map(([key, entry]) => [key, semanticValue(entry)]));
}

function vectorLayer(document: IllustrationDocument) {
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
  if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
  return layer;
}

function paintLayer(document: IllustrationDocument) {
  const layer = Object.values(document.layers).find((entry) => entry.type === 'paint');
  if (!layer || layer.type !== 'paint') throw new Error('Expected paint layer');
  return layer;
}

function shape(id: string, layerId: string): ShapeObject {
  return {
    id,
    revision: 0,
    name: id,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    createdBy: HUMAN_ACTOR.id,
    layerId,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: structuredClone(IDENTITY_TRANSFORM),
    type: 'shape',
    shape: 'rectangle',
    width: 12,
    height: 8,
    cornerRadius: 0,
    fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
}

function illustrationWithShape(): { document: IllustrationDocument; object: ShapeObject } {
  const document = createIllustrationDocument('Operation corpus');
  const layer = vectorLayer(document);
  const object = shape('shape-one', layer.id);
  document.objects[object.id] = object;
  layer.objectIds.push(object.id);
  return { document, object };
}

function emptyVectorLayer(id: string, name = id): Extract<IllustrationLayer, { type: 'vector' }> {
  return {
    id,
    revision: 0,
    name,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    createdBy: HUMAN_ACTOR.id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    type: 'vector',
    objectIds: [],
  };
}

function groupLayer(id: string, childIds: string[] = []): Extract<IllustrationLayer, { type: 'group' }> {
  return {
    id,
    revision: 0,
    name: id,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    createdBy: HUMAN_ACTOR.id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    type: 'group',
    childIds,
  };
}

function documentAsset(id: string): DocumentAsset {
  return { id, name: id, mimeType: 'image/png', byteLength: 0, sha256: '0'.repeat(64), source: 'embedded' };
}

function provenance(id: string, assetId: string): Provenance {
  return { id, assetId, provider: 'external', modelOrWorkflow: 'operation-corpus', sourceAssetIds: [], createdAt: FIXED_TIME };
}

function pixelWithSecondAsset(): { document: PixelDocument; first: PixelSprite; second: PixelSprite } {
  const document = createPixelDocument('project', 'Operation corpus');
  const first = document.pixelAssets[document.activeAssetId];
  if (first.type !== 'sprite') throw new Error('Expected sprite');
  const second = createPixelSprite('Sprite 2', 8, 8);
  second.id = 'sprite-two';
  document.pixelAssets[second.id] = second;
  document.assetIds.push(second.id);
  return { document, first, second };
}

function spriteDocument(): { document: PixelDocument; sprite: PixelSprite } {
  const document = createPixelDocument('sprite', 'Operation corpus');
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite.type !== 'sprite') throw new Error('Expected sprite');
  return { document, sprite };
}

function installSecondFrame(sprite: PixelSprite) {
  const duplicate = duplicatePixelFrame(sprite, sprite.frameIds[0], {
    actorId: HUMAN_ACTOR.id,
    timestamp: FIXED_TIME,
    createId: (prefix) => `${prefix}-two`,
  });
  sprite.frames[duplicate.frame.id] = duplicate.frame;
  sprite.frameIds.push(duplicate.frame.id);
  for (const cel of duplicate.cels) sprite.cels[cel.id] = cel;
  return duplicate;
}

function keyframe(objectId: string): IllustrationKeyframe {
  return {
    id: 'keyframe-one',
    revision: 0,
    name: 'Pose',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    createdBy: HUMAN_ACTOR.id,
    objectId,
    timeMs: 250,
    transform: { ...IDENTITY_TRANSFORM, x: 4 },
    opacity: 0.75,
    visible: true,
    easing: 'linear',
  };
}

const scenarios = {
  'document.rename': () => ({ document: createIllustrationDocument('Before'), operation: { kind: 'document.rename', name: 'After' } }),
  'illustration.artboard.replace': () => {
    const document = createIllustrationDocument();
    return { document, operation: { kind: 'illustration.artboard.replace', artboard: { ...document.artboard, width: 320, height: 200 }, expectedRevision: document.revision } };
  },
  'illustration.artboard.translate': () => {
    const document = createIllustrationDocument();
    return { document, operation: { kind: 'illustration.artboard.translate', artboard: { ...document.artboard, width: 2_000, height: 1_200 }, offsetX: 17, offsetY: 11, expectedRevision: document.revision } };
  },
  'illustration.layer.add': () => ({ document: createIllustrationDocument(), operation: { kind: 'illustration.layer.add', layer: emptyVectorLayer('added-layer'), index: 1 } }),
  'illustration.layer.replace': () => {
    const document = createIllustrationDocument(); const layer = vectorLayer(document);
    return { document, operation: { kind: 'illustration.layer.replace', layer: { ...layer, name: 'Renamed vector' }, expectedRevision: layer.revision } };
  },
  'illustration.layer.move': () => {
    const document = createIllustrationDocument(); const layer = vectorLayer(document); const group = groupLayer('layer-group');
    document.layers[group.id] = group; document.layerIds.push(group.id);
    return { document, operation: { kind: 'illustration.layer.move', layerId: layer.id, parentId: group.id, index: 0, expectedRevision: layer.revision } };
  },
  'illustration.layer.delete': () => {
    const document = createIllustrationDocument(); const layer = emptyVectorLayer('delete-layer');
    document.layers[layer.id] = layer; document.layerIds.splice(1, 0, layer.id);
    return { document, operation: { kind: 'illustration.layer.delete', layerId: layer.id, expectedRevision: layer.revision } };
  },
  'illustration.object.add': () => {
    const document = createIllustrationDocument(); const layer = vectorLayer(document);
    return { document, operation: { kind: 'illustration.object.add', object: shape('added-shape', layer.id), index: 0 } };
  },
  'illustration.object.replace': () => {
    const { document, object } = illustrationWithShape();
    return { document, operation: { kind: 'illustration.object.replace', object: { ...object, name: 'Renamed shape' }, expectedRevision: object.revision } };
  },
  'illustration.object.move': () => {
    const { document, object } = illustrationWithShape(); const target = emptyVectorLayer('target-layer');
    document.layers[target.id] = target; document.layerIds.push(target.id);
    return { document, operation: { kind: 'illustration.object.move', objectId: object.id, layerId: target.id, index: 0, expectedRevision: object.revision } };
  },
  'illustration.object.delete': () => {
    const { document, object } = illustrationWithShape();
    return { document, operation: { kind: 'illustration.object.delete', objectId: object.id, expectedRevision: object.revision } };
  },
  'illustration.paint.stroke': () => {
    const document = createIllustrationDocument(); const layer = paintLayer(document);
    return { document, operation: { kind: 'illustration.paint.stroke', layerId: layer.id, expectedRevision: layer.revision, stroke: { id: 'stroke-one', actorId: HUMAN_ACTOR.id, points: [{ x: 2, y: 3, pressure: 0.5 }], color: '#112233', size: 8, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' } } };
  },
  'illustration.brush-presets.replace': () => ({ document: createIllustrationDocument(), operation: { kind: 'illustration.brush-presets.replace', presets: [{ ...structuredClone(BUILT_IN_RASTER_BRUSH_PRESETS.watercolor), id: 'custom-watercolor', name: 'Custom watercolor' }] } }),
  'illustration.guides.replace': () => ({ document: createIllustrationDocument(), operation: { kind: 'illustration.guides.replace', guides: [{ id: 'guide-one', orientation: 'vertical', position: 24, color: '#ff0000', locked: false }], expectedRevision: 0 } }),
  'illustration.snap-settings.replace': () => {
    const document = createIllustrationDocument();
    return { document, operation: { kind: 'illustration.snap-settings.replace', settings: { ...document.snapSettings, grid: true, gridSize: 12 }, expectedRevision: 0 } };
  },
  'illustration.animation.settings.replace': () => ({ document: createIllustrationDocument(), operation: { kind: 'illustration.animation.settings.replace', settings: { durationMs: 4_000, framesPerSecond: 24, playback: 'ping-pong' }, expectedRevision: 0 } }),
  'illustration.animation.keyframe.upsert': () => {
    const { document, object } = illustrationWithShape();
    return { document, operation: { kind: 'illustration.animation.keyframe.upsert', keyframe: keyframe(object.id), index: 0 } };
  },
  'illustration.animation.keyframe.delete': () => {
    const { document, object } = illustrationWithShape(); const frame = keyframe(object.id);
    document.animation.keyframes[frame.id] = frame; document.animation.keyframeIds.push(frame.id);
    return { document, operation: { kind: 'illustration.animation.keyframe.delete', keyframeId: frame.id, expectedRevision: frame.revision } };
  },
  'asset.add': () => ({ document: createIllustrationDocument(), operation: { kind: 'asset.add', asset: documentAsset('asset-added') } }),
  'asset.delete': () => {
    const document = createIllustrationDocument(); const asset = documentAsset('asset-deleted'); document.assets[asset.id] = asset;
    return { document, operation: { kind: 'asset.delete', assetId: asset.id } };
  },
  'provenance.add': () => {
    const document = createIllustrationDocument(); const asset = documentAsset('provenance-source'); document.assets[asset.id] = asset;
    document.provenance.push(provenance('existing-provenance', asset.id));
    return { document, operation: { kind: 'provenance.add', provenance: provenance('inserted-provenance', asset.id), index: 0 } };
  },
  'provenance.delete': () => {
    const document = createIllustrationDocument(); const asset = documentAsset('provenance-source'); document.assets[asset.id] = asset;
    document.provenance = ['first', 'middle', 'last'].map((id) => provenance(id, asset.id));
    return { document, operation: { kind: 'provenance.delete', provenanceId: 'middle' } };
  },
  'pixel.palette.replace': () => {
    const document = createPixelDocument();
    return { document, operation: { kind: 'pixel.palette.replace', palette: [...document.palette, { id: 'extra-color', name: 'Extra', color: '#123456ff' }] } };
  },
  'pixel.palette.reorder': () => {
    const document = createPixelDocument(); const entryIds = document.palette.map((entry) => entry.id); [entryIds[1], entryIds[2]] = [entryIds[2], entryIds[1]];
    return { document, operation: { kind: 'pixel.palette.reorder', entryIds, expectedRevision: document.revision } };
  },
  'pixel.palette-cycles.replace': () => ({ document: createPixelDocument(), operation: { kind: 'pixel.palette-cycles.replace', cycles: [{ id: 'cycle-one', name: 'Cycle', fromIndex: 1, toIndex: 3, direction: 'forward', stepMs: 120 }] } }),
  'pixel.stamps.replace': () => ({ document: createPixelDocument(), operation: { kind: 'pixel.stamps.replace', stamps: [{ id: 'stamp-one', name: 'Stamp', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 2 }] }] } }),
  'pixel.tile-stamps.replace': () => ({ document: createPixelDocument('tilemap'), operation: { kind: 'pixel.tile-stamps.replace', stamps: [{ id: 'tile-stamp-one', name: 'Tile stamp', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: 7 }] }] } }),
  'pixel.bitmap-fonts.replace': () => {
    const document = createPixelDocument(); const font = createDefaultBitmapFont(); font.name = 'Operation corpus font';
    return { document, operation: { kind: 'pixel.bitmap-fonts.replace', fonts: [font] } };
  },
  'pixel.conversion.replace': () => ({ document: createPixelDocument(), operation: { kind: 'pixel.conversion.replace', conversionDefaults: { resample: 'area', paletteMetric: 'oklab', dithering: 'bayer-4x4', alphaThreshold: 0.25 } } }),
  'pixel.links.replace': () => {
    const document = createPixelDocument('project'); const cached = documentAsset('link-cache'); document.assets[cached.id] = cached;
    return { document, operation: { kind: 'pixel.links.replace', linkedAssets: [{ id: 'link-one', name: 'tiles.png', mode: 'embedded', sha256: cached.sha256, cachedPreviewAssetId: cached.id }], expectedRevision: document.revision } };
  },
  'pixel.active-asset.set': () => {
    const { document, second } = pixelWithSecondAsset();
    return { document, operation: { kind: 'pixel.active-asset.set', assetId: second.id } };
  },
  'pixel.frame.add': () => {
    const { document, sprite } = spriteDocument(); const duplicate = duplicatePixelFrame(sprite, sprite.frameIds[0], { actorId: HUMAN_ACTOR.id, timestamp: FIXED_TIME, createId: (prefix) => `${prefix}-added` });
    return { document, operation: { kind: 'pixel.frame.add', spriteId: sprite.id, ...duplicate, index: 1, expectedRevision: sprite.revision } };
  },
  'pixel.frame.replace': () => {
    const { document, sprite } = spriteDocument(); const frame = sprite.frames[sprite.frameIds[0]];
    return { document, operation: { kind: 'pixel.frame.replace', spriteId: sprite.id, frame: { ...frame, name: 'Renamed frame', durationMs: 240 }, expectedRevision: frame.revision } };
  },
  'pixel.frame.delete': () => {
    const { document, sprite } = spriteDocument(); const duplicate = installSecondFrame(sprite);
    return { document, operation: { kind: 'pixel.frame.delete', spriteId: sprite.id, frameId: duplicate.frame.id, expectedRevision: sprite.revision } };
  },
  'pixel.asset.add': () => ({ document: createPixelDocument('project'), operation: { kind: 'pixel.asset.add', asset: createPixelTilemap('Added map'), index: 0 } }),
  'pixel.asset.replace': () => {
    const { document, sprite } = spriteDocument();
    return { document, operation: { kind: 'pixel.asset.replace', asset: { ...sprite, name: 'Renamed sprite' }, expectedRevision: sprite.revision } };
  },
  'pixel.asset.delete': () => {
    const { document, first } = pixelWithSecondAsset();
    return { document, operation: { kind: 'pixel.asset.delete', assetId: first.id, expectedRevision: first.revision } };
  },
  'pixel.cel.set': () => {
    const { document, sprite } = spriteDocument(); const cel = Object.values(sprite.cels)[0];
    return { document, operation: { kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: 1, y: 2, index: 4 }], expectedRevision: cel.revision } };
  },
  'pixel.cel.region': () => {
    const { document, sprite } = spriteDocument(); const cel = Object.values(sprite.cels)[0];
    return { document, operation: { kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs: [{ x: 2, y: 3, length: 4, index: 5 }], expectedRevision: cel.revision } };
  },
  'pixel.tilemap.set': () => {
    const document = createPixelDocument('tilemap'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap'); const layer = map.layers[map.layerIds[0]];
    return { document, operation: { kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes: [{ x: 1, y: 2, gid: 9 }], expectedRevision: layer.revision } };
  },
  'pixel.tilemap.region': () => {
    const document = createPixelDocument('tilemap'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap'); const layer = map.layers[map.layerIds[0]];
    return { document, operation: { kind: 'pixel.tilemap.region', mapId: map.id, layerId: layer.id, runs: [{ x: 3, y: 4, length: 5, gid: 11 }], expectedRevision: layer.revision } };
  },
} satisfies Record<OperationKind, ScenarioFactory>;

describe('systematic reducer operation/inverse corpus', () => {
  for (const kind of Object.keys(scenarios) as OperationKind[]) {
    it(`${kind} restores semantic state through undo and redo`, () => {
      const { document, operation } = scenarios[kind]();
      expect(operation.kind).toBe(kind);
      expect(CanvasOperationSchema.safeParse(operation).success).toBe(true);

      const applied = applyTransaction(document, transaction(document, [operation]));
      expect(semanticValue(applied.document)).not.toEqual(semanticValue(document));
      for (const inverse of applied.inverse.operations) expect(CanvasOperationSchema.safeParse(inverse).success).toBe(true);

      const restored = applyTransaction(applied.document, applied.inverse);
      expect(semanticValue(restored.document)).toEqual(semanticValue(document));
      for (const redo of restored.inverse.operations) expect(CanvasOperationSchema.safeParse(redo).success).toBe(true);

      const redone = applyTransaction(restored.document, restored.inverse);
      expect(semanticValue(redone.document)).toEqual(semanticValue(applied.document));
    });
  }

  it('restores ordered provenance and the active pixel asset explicitly', () => {
    const provenanceScenario = scenarios['provenance.delete']();
    const removedProvenance = applyTransaction(provenanceScenario.document, transaction(provenanceScenario.document, [provenanceScenario.operation]));
    expect(removedProvenance.inverse.operations).toMatchObject([{ kind: 'provenance.add', index: 1 }]);
    expect(applyTransaction(removedProvenance.document, removedProvenance.inverse).document.provenance.map((entry) => entry.id)).toEqual(['first', 'middle', 'last']);

    const assetScenario = scenarios['pixel.asset.delete']();
    const originalActiveId = (assetScenario.document as PixelDocument).activeAssetId;
    const removedAsset = applyTransaction(assetScenario.document, transaction(assetScenario.document, [assetScenario.operation]));
    expect(removedAsset.inverse.operations.map((operation) => operation.kind)).toEqual(['pixel.asset.add', 'pixel.active-asset.set']);
    const restored = applyTransaction(removedAsset.document, removedAsset.inverse).document;
    expect(restored.kind).toBe('pixel');
    if (restored.kind === 'pixel') expect(restored.activeAssetId).toBe(originalActiveId);
  });

  it('requires dedicated move operations for structural membership changes', () => {
    const { document, object } = illustrationWithShape();
    const sourceLayer = vectorLayer(document);
    const targetLayer = emptyVectorLayer('structural-target');
    const objectGroup = { ...shape('object-group', sourceLayer.id), type: 'group' as const, childIds: [object.id] };
    document.objects[objectGroup.id] = objectGroup;
    sourceLayer.objectIds.push(objectGroup.id);
    const layerGroup = groupLayer('structural-layer-group');
    document.layers[layerGroup.id] = layerGroup;
    document.layerIds.push(layerGroup.id);
    document.layers[targetLayer.id] = targetLayer;
    document.layerIds.push(targetLayer.id);
    const before = semanticValue(document);

    const invalid: CanvasOperation[] = [
      { kind: 'illustration.layer.add', layer: { ...groupLayer('prepopulated-group'), childIds: [sourceLayer.id] } },
      { kind: 'illustration.layer.add', layer: { ...emptyVectorLayer('prepopulated-vector'), objectIds: [object.id] } },
      { kind: 'illustration.object.replace', object: { ...object, layerId: targetLayer.id }, expectedRevision: object.revision },
      { kind: 'illustration.object.replace', object: { ...objectGroup, childIds: [] }, expectedRevision: objectGroup.revision },
      { kind: 'illustration.layer.replace', layer: { ...sourceLayer, parentId: layerGroup.id }, expectedRevision: sourceLayer.revision },
      { kind: 'illustration.layer.replace', layer: { ...sourceLayer, objectIds: sourceLayer.objectIds.slice(1) }, expectedRevision: sourceLayer.revision },
      { kind: 'illustration.layer.replace', layer: { ...layerGroup, childIds: [sourceLayer.id] }, expectedRevision: layerGroup.revision },
    ];

    for (const operation of invalid) expect(() => applyTransaction(document, transaction(document, [operation]))).toThrow(/Use .*move|Use object add/);
    expect(semanticValue(document)).toEqual(before);
  });

  it('rejects object groups whose children are missing, cross-layer, or already grouped', () => {
    const { document, object } = illustrationWithShape(); const sourceLayer = vectorLayer(document); const targetLayer = emptyVectorLayer('group-target');
    document.layers[targetLayer.id] = targetLayer; document.layerIds.push(targetLayer.id);
    const candidate = { ...shape('candidate-group', sourceLayer.id), type: 'group' as const, childIds: ['missing-child'] };
    expect(() => applyTransaction(document, transaction(document, [{ kind: 'illustration.object.add', object: candidate }]))).toThrow(/must already exist/);
    expect(() => applyTransaction(document, transaction(document, [{ kind: 'illustration.object.add', object: { ...candidate, id: 'cross-layer-group', layerId: targetLayer.id, childIds: [object.id] } }]))).toThrow(/same vector layer/);

    const existing = { ...candidate, id: 'existing-group', childIds: [object.id] };
    const grouped = applyTransaction(document, transaction(document, [{ kind: 'illustration.object.add', object: existing }])).document;
    expect(() => applyTransaction(grouped, transaction(grouped, [{ kind: 'illustration.object.add', object: { ...candidate, id: 'second-group', childIds: [object.id] } }]))).toThrow(/already belongs to a group/);
  });
});
