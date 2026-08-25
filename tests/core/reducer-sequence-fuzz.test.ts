import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RASTER_BRUSH_PRESETS,
  CanvasOperationSchema,
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  applyTransaction,
  createIllustrationDocument,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  decodePixelChunk,
  decodeTilemapChunk,
  rebaseTransactionExpectedRevisions,
  validateDocument,
  type AIDrawDocument,
  type CanvasOperation,
  type CanvasTransaction,
  type IllustrationDocument,
  type IllustrationLayer,
  type IllustrationObject,
  type PixelDocument,
  type PixelSprite,
  type PixelTilemap,
  type ShapeObject,
} from '@aidraw/core';

const FIXED_TIME = '2026-08-12T00:00:00.000Z';

function generator(seed: number): () => number {
  let state = seed >>> 0 || 0x9e37_79b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['revision', 'updatedAt', 'dirty', 'activity'].includes(key))
    .map(([key, entry]) => [key, semanticValue(entry)]));
}

function transaction(document: AIDrawDocument, operation: CanvasOperation, step: number): CanvasTransaction {
  return {
    id: `fuzz-tx-${step}`,
    clientOperationId: `fuzz-op-${step}`,
    documentId: document.id,
    actor: HUMAN_ACTOR,
    label: `Deterministic reducer fuzz ${step}`,
    createdAt: FIXED_TIME,
    operations: [operation],
  };
}

function entityBase(id: string, name = id) {
  return { id, revision: 0, name, createdAt: FIXED_TIME, updatedAt: FIXED_TIME, createdBy: HUMAN_ACTOR.id };
}

function shape(id: string, layerId: string, x: number): ShapeObject {
  return {
    ...entityBase(id),
    layerId,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...IDENTITY_TRANSFORM, x },
    type: 'shape',
    shape: 'rectangle',
    width: 12,
    height: 8,
    cornerRadius: 0,
    fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
}

function illustrationFixture(): IllustrationDocument {
  const document = createIllustrationDocument('Illustration sequence fuzz');
  const source = Object.values(document.layers).find((layer) => layer.type === 'vector');
  if (!source || source.type !== 'vector') throw new Error('Expected vector layer');
  const target: Extract<IllustrationLayer, { type: 'vector' }> = {
    ...entityBase('fuzz-vector-two', 'Vector 2'),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    type: 'vector',
    objectIds: [],
  };
  const layerGroup: Extract<IllustrationLayer, { type: 'group' }> = {
    ...entityBase('fuzz-layer-group', 'Layer group'),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    type: 'group',
    childIds: [target.id],
  };
  target.parentId = layerGroup.id;
  document.layers[target.id] = target;
  document.layers[layerGroup.id] = layerGroup;
  document.layerIds.push(layerGroup.id);

  const objects = [shape('fuzz-shape-a', source.id, 0), shape('fuzz-shape-b', source.id, 20), shape('fuzz-shape-c', source.id, 40)];
  const objectGroup = {
    ...entityBase('fuzz-object-group', 'Object group'),
    layerId: source.id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal' as const,
    transform: structuredClone(IDENTITY_TRANSFORM),
    type: 'group' as const,
    childIds: [objects[0].id, objects[1].id],
  };
  for (const object of [...objects, objectGroup]) document.objects[object.id] = object;
  source.objectIds.push(...objects.map((object) => object.id), objectGroup.id);
  return document;
}

function pixelFixture(): PixelDocument {
  const document = createPixelDocument('project', 'Pixel sequence fuzz');
  const second = createPixelSprite('Sprite 2', 64, 64);
  const map = createPixelTilemap('Map 1');
  document.pixelAssets[second.id] = second;
  document.pixelAssets[map.id] = map;
  document.assetIds.push(second.id, map.id);
  document.assets['fuzz-link-cache'] = { id: 'fuzz-link-cache', name: 'Link cache', mimeType: 'image/png', byteLength: 0, sha256: 'a'.repeat(64), source: 'embedded' };
  return document;
}

function assertIllustrationStructure(document: IllustrationDocument): void {
  expect(() => validateDocument(structuredClone(document))).not.toThrow();
  const layerParents = new Map<string, string>();
  for (const layer of Object.values(document.layers)) if (layer.type === 'group') for (const childId of layer.childIds) {
    expect(document.layers[childId]).toBeTruthy();
    expect(layerParents.has(childId)).toBe(false);
    layerParents.set(childId, layer.id);
  }
  expect(new Set(document.layerIds).size).toBe(document.layerIds.length);
  for (const layer of Object.values(document.layers)) {
    expect(layerParents.get(layer.id)).toBe(layer.parentId);
    expect(document.layerIds.includes(layer.id)).toBe(layer.parentId === undefined);
  }

  const objectParents = new Map<string, string>();
  for (const object of Object.values(document.objects)) if (object.type === 'group') for (const childId of object.childIds) {
    expect(document.objects[childId]?.layerId).toBe(object.layerId);
    expect(objectParents.has(childId)).toBe(false);
    objectParents.set(childId, object.id);
  }
  const membership = new Map<string, number>();
  for (const layer of Object.values(document.layers)) if (layer.type === 'vector') for (const objectId of layer.objectIds) {
    expect(document.objects[objectId]?.layerId).toBe(layer.id);
    membership.set(objectId, (membership.get(objectId) ?? 0) + 1);
  }
  for (const objectId of Object.keys(document.objects)) expect(membership.get(objectId)).toBe(1);

  for (const layer of Object.values(document.layers)) if (layer.type === 'paint') for (const chunkId of Object.values(layer.tileAssetIds)) expect(document.assets[chunkId]).toBeTruthy();
}

function assertPixelStructure(document: PixelDocument): void {
  expect(() => validateDocument(structuredClone(document))).not.toThrow();
  expect(new Set(document.assetIds).size).toBe(document.assetIds.length);
  expect(new Set(document.assetIds)).toEqual(new Set(Object.keys(document.pixelAssets)));
  expect(document.pixelAssets[document.activeAssetId]).toBeTruthy();
  for (const asset of Object.values(document.pixelAssets)) {
    if (asset.type === 'sprite') for (const cel of Object.values(asset.cels)) for (const chunk of Object.values(cel.chunks)) {
      expect(decodePixelChunk(chunk).some((value) => value !== 0)).toBe(true);
    }
    if (asset.type === 'tilemap') for (const layer of Object.values(asset.layers)) if (layer.type === 'tile') for (const chunk of Object.values(layer.chunks ?? {})) {
      expect(decodeTilemapChunk(chunk).some((value) => value !== 0)).toBe(true);
    }
  }
}

function pixelOperation(document: PixelDocument, next: () => number, step: number): CanvasOperation {
  const sprites = Object.values(document.pixelAssets).filter((asset): asset is PixelSprite => asset.type === 'sprite');
  const maps = Object.values(document.pixelAssets).filter((asset): asset is PixelTilemap => asset.type === 'tilemap');
  const sprite = sprites[next() % sprites.length];
  const map = maps[next() % maps.length];
  const cel = Object.values(sprite.cels)[next() % Object.keys(sprite.cels).length];
  const frame = sprite.frames[sprite.frameIds[next() % sprite.frameIds.length]];
  const tileLayer = map.layers[map.layerIds.find((id) => map.layers[id]?.type === 'tile')!];
  const choice = next() % 12;
  if (choice === 0) return { kind: 'document.rename', name: `Pixel fuzz ${step}` };
  if (choice === 1) return { kind: 'pixel.active-asset.set', assetId: document.assetIds[next() % document.assetIds.length] };
  if (choice === 2) {
    const asset = document.pixelAssets[document.assetIds[next() % document.assetIds.length]];
    return { kind: 'pixel.asset.replace', asset: { ...structuredClone(asset), name: `Asset ${step}` }, expectedRevision: asset.revision };
  }
  if (choice === 3) return { kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: next() % sprite.width, y: next() % sprite.height, index: next() % document.palette.length }], expectedRevision: cel.revision };
  if (choice === 4) {
    const length = 1 + next() % 8; const x = next() % (sprite.width - length + 1);
    return { kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs: [{ x, y: next() % sprite.height, length, index: next() % document.palette.length }], expectedRevision: cel.revision };
  }
  if (choice === 5) return { kind: 'pixel.frame.replace', spriteId: sprite.id, frame: { ...frame, name: `Frame ${step}`, durationMs: 16 + next() % 2_000 }, expectedRevision: frame.revision };
  if (choice === 6) return { kind: 'pixel.tilemap.set', mapId: map.id, layerId: tileLayer.id, changes: [{ x: next() % map.width, y: next() % map.height, gid: next() % 32 }], expectedRevision: tileLayer.revision };
  if (choice === 7) {
    const length = 1 + next() % 8; const x = next() % (map.width - length + 1);
    return { kind: 'pixel.tilemap.region', mapId: map.id, layerId: tileLayer.id, runs: [{ x, y: next() % map.height, length, gid: next() % 32 }], expectedRevision: tileLayer.revision };
  }
  if (choice === 8) return { kind: 'pixel.conversion.replace', conversionDefaults: { ...document.conversionDefaults, dithering: next() % 2 ? 'none' : 'bayer-4x4', alphaThreshold: (next() % 101) / 100 } };
  if (choice === 9) return { kind: 'pixel.palette-cycles.replace', cycles: [{ id: 'fuzz-cycle', name: `Cycle ${step}`, fromIndex: 1, toIndex: 3, direction: next() % 2 ? 'forward' : 'reverse', stepMs: 16 + next() % 1_000 }] };
  if (choice === 10) {
    const entryIds = document.palette.map((entry) => entry.id); const left = 1 + next() % (entryIds.length - 1); const right = 1 + next() % (entryIds.length - 1);
    [entryIds[left], entryIds[right]] = [entryIds[right], entryIds[left]];
    return { kind: 'pixel.palette.reorder', entryIds, expectedRevision: document.revision };
  }
  const linkedAssets = next() % 2 ? [{ id: 'fuzz-link', name: 'source.png', mode: 'embedded' as const, sha256: 'a'.repeat(64), cachedPreviewAssetId: 'fuzz-link-cache' }] : [];
  return { kind: 'pixel.links.replace', linkedAssets, expectedRevision: document.revision };
}

function illustrationOperation(document: IllustrationDocument, next: () => number, step: number): CanvasOperation {
  const shapes = Object.values(document.objects).filter((object): object is ShapeObject => object.type === 'shape');
  const object = shapes[next() % shapes.length];
  const vectorLayers = Object.values(document.layers).filter((layer): layer is Extract<IllustrationLayer, { type: 'vector' }> => layer.type === 'vector');
  const targetLayer = vectorLayers[next() % vectorLayers.length];
  const group = Object.values(document.objects).find(
    (entry): entry is Extract<IllustrationObject, { type: 'group' }> => entry.type === 'group' && entry.layerId === targetLayer.id,
  );
  const movableLayer = vectorLayers[next() % vectorLayers.length];
  const layerGroup = Object.values(document.layers).find((layer) => layer.type === 'group');
  const paint = Object.values(document.layers).find((layer) => layer.type === 'paint');
  if (!paint || paint.type !== 'paint' || !layerGroup || layerGroup.type !== 'group') throw new Error('Expected fuzz layers');
  const choice = next() % 10;
  if (choice === 0) return { kind: 'document.rename', name: `Illustration fuzz ${step}` };
  if (choice === 1) return { kind: 'illustration.object.replace', object: { ...object, name: `Shape ${step}`, transform: { ...object.transform, x: (next() % 400) - 200, y: (next() % 400) - 200 } }, expectedRevision: object.revision };
  if (choice === 2) {
    const index = next() % (targetLayer.objectIds.length + 1);
    const parentGroupId = group && next() % 2 ? group.id : undefined;
    const candidateGroupIndex = group ? next() % (group.childIds.length + 1) : undefined;
    return {
      kind: 'illustration.object.move', objectId: object.id, layerId: targetLayer.id, index,
      parentGroupId, groupIndex: parentGroupId ? candidateGroupIndex : undefined, expectedRevision: object.revision,
    };
  }
  if (choice === 3) return { kind: 'illustration.layer.move', layerId: movableLayer.id, parentId: next() % 2 ? layerGroup.id : undefined, index: next() % (document.layerIds.length + layerGroup.childIds.length + 1), expectedRevision: movableLayer.revision };
  if (choice === 4) return { kind: 'illustration.guides.replace', guides: [{ id: 'fuzz-guide', orientation: next() % 2 ? 'vertical' : 'horizontal', position: (next() % 2_000) - 1_000, color: '#ff0000', locked: Boolean(next() % 2) }], expectedRevision: document.revision };
  if (choice === 5) return { kind: 'illustration.snap-settings.replace', settings: { ...document.snapSettings, grid: Boolean(next() % 2), pixel: Boolean(next() % 2), gridSize: 1 + next() % 128, tolerance: next() % 32 }, expectedRevision: document.revision };
  if (choice === 6) return { kind: 'illustration.artboard.replace', artboard: { ...document.artboard, width: 128 + next() % 2_048, height: 128 + next() % 2_048 }, expectedRevision: document.revision };
  if (choice === 7) return { kind: 'illustration.artboard.translate', artboard: structuredClone(document.artboard), offsetX: (next() % 17) - 8, offsetY: (next() % 17) - 8, expectedRevision: document.revision };
  if (choice === 8) return { kind: 'illustration.paint.stroke', layerId: paint.id, stroke: { id: `fuzz-stroke-${step}`, actorId: HUMAN_ACTOR.id, points: [{ x: next() % document.artboard.width, y: next() % document.artboard.height, pressure: (next() % 101) / 100 }], color: '#112233', size: 1 + next() % 100, opacity: 1, hardness: 1, flow: 1, mode: next() % 2 ? 'paint' : 'erase', preset: 'hard-round' }, expectedRevision: paint.revision };
  return { kind: 'illustration.brush-presets.replace', presets: [{ ...structuredClone(BUILT_IN_RASTER_BRUSH_PRESETS.watercolor), id: 'fuzz-brush', name: `Brush ${step}`, size: 1 + next() % 200 }] };
}

function exerciseSequence<T extends AIDrawDocument>(
  initial: T,
  seed: number,
  operationFor: (document: T, next: () => number, step: number) => CanvasOperation,
  assertStructure: (document: T) => void,
): void {
  const next = generator(seed);
  let current = structuredClone(initial);
  const undo: CanvasTransaction[] = [];
  for (let step = 0; step < 48; step += 1) {
    const operation = operationFor(current, next, step);
    expect(CanvasOperationSchema.safeParse(operation).success).toBe(true);
    const result = applyTransaction(current, transaction(current, operation, step));
    current = result.document as T;
    undo.push(result.inverse);
    assertStructure(current);
  }
  const forward = semanticValue(current);
  const redo: CanvasTransaction[] = [];
  while (undo.length) {
    const result = applyTransaction(current, rebaseTransactionExpectedRevisions(current, undo.pop()!));
    current = result.document as T;
    redo.push(result.inverse);
    assertStructure(current);
  }
  expect(semanticValue(current)).toEqual(semanticValue(initial));
  while (redo.length) {
    const result = applyTransaction(current, rebaseTransactionExpectedRevisions(current, redo.pop()!));
    current = result.document as T;
    assertStructure(current);
  }
  expect(semanticValue(current)).toEqual(forward);
}

describe('deterministic reducer sequence fuzzing', () => {
  for (const seed of [1, 7, 19, 41, 97, 257, 65_537, 0xdead_beef]) {
    it(`restores illustration sequences for seed ${seed}`, () => exerciseSequence(illustrationFixture(), seed, illustrationOperation, assertIllustrationStructure));
    it(`restores pixel sequences for seed ${seed}`, () => exerciseSequence(pixelFixture(), seed, pixelOperation, assertPixelStructure));
  }

  it('keeps seeded multi-operation failures atomic', () => {
    for (const seed of Array.from({ length: 32 }, (_, index) => index + 1)) {
      const next = generator(seed);
      if (next() % 2) {
        const document = illustrationFixture(); const object = document.objects['fuzz-shape-a']; const target = document.layers['fuzz-vector-two'];
        const operations: CanvasOperation[] = [
          { kind: 'document.rename', name: `Must roll back ${seed}` },
          { kind: 'illustration.object.replace', object: { ...object, layerId: target.id }, expectedRevision: object.revision },
        ];
        const before = semanticValue(document);
        expect(() => applyTransaction(document, { ...transaction(document, operations[0], seed), operations })).toThrow(/object\.move/);
        expect(semanticValue(document)).toEqual(before);
      } else {
        const document = pixelFixture(); const sprite = Object.values(document.pixelAssets).find((asset): asset is PixelSprite => asset.type === 'sprite')!; const cel = Object.values(sprite.cels)[0];
        const operations: CanvasOperation[] = [
          { kind: 'document.rename', name: `Must roll back ${seed}` },
          { kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: sprite.width, y: 0, index: 2 }], expectedRevision: cel.revision },
        ];
        const before = semanticValue(document);
        expect(() => applyTransaction(document, { ...transaction(document, operations[0], seed), operations })).toThrow(/outside sprite/);
        expect(semanticValue(document)).toEqual(before);
      }
    }
  });
});
