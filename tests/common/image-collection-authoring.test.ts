import { describe, expect, it } from 'vitest';
import { TILED_GID_MASK, createId, createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, encodeTiledGid, nowIso, writeTiles } from '@aidraw/core';

import {
  appendImageCollectionSource,
  createImageCollectionTileset,
  imageCollectionAuthoringGuardError,
  imageCollectionSourceEligibility,
  imageCollectionSourceObservationGuardError,
  imageCollectionSourceDependencyGuards,
  imageCollectionSourceRemovalProof,
  imageCollectionSourceReplacementImpact,
  imageCollectionTileIds,
  removeUnusedImageCollectionSource,
  replaceImageCollectionSource,
  replaceImageCollectionTileMetadata,
} from '../../src/common/image-collection-authoring';

function collectionFixture() {
  const document = createPixelDocument('project', 'Collection authoring');
  const source0 = createPixelSprite('Tile zero', 9, 7);
  const source3 = createPixelSprite('Tile three', 13, 5);
  const tileset = createPixelTileset('Collection', source0.id, 9, 7, 1, 1);
  tileset.spriteAssetId = undefined;
  tileset.columns = 2;
  tileset.rows = 0;
  tileset.margin = 0;
  tileset.spacing = 0;
  tileset.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.5, animation: [{ tileId: 0, durationMs: 80 }], collisions: [], properties: { biome: 'cave' } },
  };
  tileset.wangSets = [];
  document.assetIds = [source0.id, source3.id, tileset.id];
  document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset };
  document.activeAssetId = tileset.id;
  return { document, source0, source3, tileset };
}

describe('image-collection authoring boundary', () => {
  it('creates exact source-ordered tiles and appends above the sparse authored span without rebasing', () => {
    const document = createPixelDocument('project', 'Collection lifecycle');
    const first = createPixelSprite('First', 7, 11);
    const second = createPixelSprite('Second', 19, 5);
    const appended = createPixelSprite('Appended', 23, 13);
    document.assetIds = [second.id, first.id, appended.id];
    document.pixelAssets = { [first.id]: first, [second.id]: second, [appended.id]: appended };
    document.activeAssetId = second.id;
    const collection = createImageCollectionTileset(document, '  Environment  ', [second.id, first.id], { id: 'collection', createdAt: '2026-08-16T00:00:00.000Z', createdBy: 'tester' });
    expect(collection).toMatchObject({ id: 'collection', name: 'Environment', firstGid: 1, tileWidth: 19, tileHeight: 11, columns: 0, rows: 0, createdBy: 'tester' });
    expect(collection.spriteAssetId).toBeUndefined();
    expect(collection.tiles).toEqual({
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: second.id, probability: 1, animation: [], collisions: [], properties: {} },
      1: { id: 1, sourceX: 0, sourceY: 0, imageAssetId: first.id, probability: 1, animation: [], collisions: [], properties: {} },
    });
    document.assetIds.push(collection.id);
    document.pixelAssets[collection.id] = collection;
    delete collection.tiles[1];
    collection.tiles[3] = { id: 3, sourceX: 0, sourceY: 0, imageAssetId: first.id, probability: 0.4, animation: [], collisions: [], properties: { preserved: true } };
    const plan = appendImageCollectionSource(document, collection.id, appended.id);
    expect(plan.tileId).toBe(4);
    expect(plan.tileset.firstGid).toBe(1);
    expect(plan.tileset.tiles[3]).toEqual(collection.tiles[3]);
    expect(plan.tileset.tiles[4]).toMatchObject({ id: 4, imageAssetId: appended.id, probability: 1 });
    expect(plan.tileset).toMatchObject({ tileWidth: 23, tileHeight: 13 });
    expect(plan.expectedSpriteDependencies.map(({ spriteId }) => spriteId)).toEqual([second.id, first.id, appended.id]);
    const later = createImageCollectionTileset(document, 'Later collection', [appended.id], { id: 'later-collection' });
    expect(later.firstGid).toBe(5);
  });

  it('replaces one exact sparse source, preserves its complete tile record, and counts signed sparse-infinite impact', () => {
    const { document, tileset, source0, source3 } = collectionFixture();
    const replacement = createPixelSprite('Replacement', 4, 3);
    const map = createPixelTilemap('Collection map');
    map.width = 1; map.height = 1; map.infinite = true; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [
      { x: -33, y: 4, gid: tileset.firstGid + 3 },
      { x: 34, y: -35, gid: encodeTiledGid(tileset.firstGid + 3, { hFlip: true, diagonal: true }) },
      { x: 0, y: 0, gid: tileset.firstGid },
    ]);
    tileset.tiles[0].animation = [{ tileId: 3, durationMs: 90 }];
    tileset.tiles[3].animation.push({ tileId: 3, durationMs: 110 });
    document.assetIds.push(replacement.id, map.id);
    document.pixelAssets[replacement.id] = replacement; document.pixelAssets[map.id] = map;

    expect(imageCollectionSourceReplacementImpact(document, tileset.id, 3)).toEqual({
      baseGid: tileset.firstGid + 3,
      attachedMapCount: 1,
      directMapCellCount: 2,
      animationReferenceCount: 2,
      scannedCellCount: 3_072,
    });
    const beforeTile = structuredClone(tileset.tiles[3]);
    const sourceBytes = JSON.stringify([source0, source3, replacement]);
    const mapBytes = JSON.stringify(map);
    const plan = replaceImageCollectionSource(document, tileset.id, 3, replacement.id);
    expect(plan).toMatchObject({ tileId: 3, previousSourceId: source3.id, sourceId: replacement.id });
    expect(plan.tileset).toMatchObject({ id: tileset.id, firstGid: tileset.firstGid, tileWidth: source0.width, tileHeight: source0.height });
    expect(plan.tileset.tiles[3]).toEqual({ ...beforeTile, imageAssetId: replacement.id });
    expect(plan.tileset.tiles[0]).toEqual(tileset.tiles[0]);
    expect(plan.expectedSpriteDependencies.map(({ spriteId }) => spriteId)).toEqual([source0.id, source3.id, replacement.id]);
    expect(JSON.stringify([source0, source3, replacement])).toBe(sourceBytes);
    expect(JSON.stringify(map)).toBe(mapBytes);
  });

  it('removes only one proven-unused sparse tile and deterministically shrinks the retained-source envelope', () => {
    const { document, tileset, source0, source3 } = collectionFixture();
    const source7 = createPixelSprite('Tile seven', 4, 11);
    tileset.tiles[7] = { id: 7, sourceX: 0, sourceY: 0, imageAssetId: source7.id, probability: 0.25, animation: [], collisions: [], properties: { retained: true } };
    tileset.tileWidth = source3.width; tileset.tileHeight = source7.height;
    tileset.tiles[0].animation = [{ tileId: 7, durationMs: 90 }];
    const map = createPixelTilemap('Unused source map'); map.tilesetIds = [tileset.id]; map.width = 2; map.height = 1;
    document.assetIds.push(source7.id, map.id); document.pixelAssets[source7.id] = source7; document.pixelAssets[map.id] = map;
    const beforeSources = JSON.stringify([source0, source3, source7]);
    const beforeMap = JSON.stringify(map);

    expect(imageCollectionSourceRemovalProof(document, tileset.id, 3)).toEqual({
      baseGid: tileset.firstGid + 3,
      sourceId: source3.id,
      sourceName: source3.name,
      retainedTileCount: 2,
      attachedMapCount: 1,
      scannedCellCount: 0,
      scannedObjectCount: 0,
      scannedAnimationFrameCount: 1,
      scannedTileStampCellCount: 0,
      scannedReferenceCount: 1,
    });
    const plan = removeUnusedImageCollectionSource(document, tileset.id, 3);
    expect(plan).toMatchObject({ tileId: 3, sourceId: source3.id, tileset: { firstGid: tileset.firstGid, tileWidth: source0.width, tileHeight: source7.height } });
    expect(Object.keys(plan.tileset.tiles)).toEqual(['0', '7']);
    expect(plan.tileset.tiles[0]).toEqual(tileset.tiles[0]);
    expect(plan.tileset.tiles[7]).toEqual(tileset.tiles[7]);
    expect(plan.expectedSpriteDependencies.map(({ spriteId }) => spriteId)).toEqual([source0.id, source3.id, source7.id]);
    expect(JSON.stringify([source0, source3, source7])).toBe(beforeSources);
    expect(JSON.stringify(map)).toBe(beforeMap);
  });

  it('refuses final, transformed-map, animation, tile-object, stamp, Wang, and resolver-shadow removal references', () => {
    const { document, tileset, source0 } = collectionFixture();
    const only = createImageCollectionTileset(document, 'Only source', [source0.id], { id: 'only-source' });
    document.assetIds.push(only.id); document.pixelAssets[only.id] = only;
    expect(() => removeUnusedImageCollectionSource(document, only.id, 0)).toThrow(/final image-collection source/);

    const animationReference = structuredClone(document);
    const animatedTileset = animationReference.pixelAssets[tileset.id]; if (animatedTileset.type !== 'tileset') throw new Error('Expected tileset');
    animatedTileset.tiles[0].animation = [{ tileId: 3, durationMs: 100 }];
    expect(() => removeUnusedImageCollectionSource(animationReference, tileset.id, 3)).toThrow(/tile 0 animation still references tile 3/);

    const mapReference = structuredClone(document);
    const map = createPixelTilemap('Reference map'); map.tilesetIds = [tileset.id]; map.width = 1; map.height = 1; map.infinite = true;
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: -33, y: 35, gid: encodeTiledGid(tileset.firstGid + 3, { hFlip: true, vFlip: true, diagonal: true }) }]);
    mapReference.assetIds.push(map.id); mapReference.pixelAssets[map.id] = map;
    expect(() => removeUnusedImageCollectionSource(mapReference, tileset.id, 3)).toThrow(/tile layer .* still references.*tile 3/);

    const objectReference = structuredClone(document);
    const objectMap = createPixelTilemap('Object reference map'); objectMap.tilesetIds = [tileset.id];
    const createdAt = nowIso(); const objectLayerId = createId('map-layer');
    objectMap.layerIds.push(objectLayerId); objectMap.layers[objectLayerId] = {
      id: objectLayerId, revision: 0, name: 'Objects', type: 'object', visible: true, locked: false, opacity: 1, createdBy: 'human',
      offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1, createdAt, updatedAt: createdAt,
      objects: [{ id: 'tile-object', type: 'tile', gid: encodeTiledGid(tileset.firstGid + 3, { diagonal: true }), x: 0, y: 0, width: 13, height: 5, rotation: 0, name: 'Target', className: '', properties: {} }],
    };
    objectReference.assetIds.push(objectMap.id); objectReference.pixelAssets[objectMap.id] = objectMap;
    expect(() => removeUnusedImageCollectionSource(objectReference, tileset.id, 3)).toThrow(/tile object.*still references.*tile 3/);

    const stampReference = structuredClone(document);
    stampReference.tileStamps = [{ id: 'stamp', name: 'Target stamp', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: encodeTiledGid(tileset.firstGid + 3, { hFlip: true }) }] }];
    expect(() => removeUnusedImageCollectionSource(stampReference, tileset.id, 3)).toThrow(/tile stamp.*still stores.*tile 3/);

    const wangReference = structuredClone(document); const wangTileset = wangReference.pixelAssets[tileset.id]; if (wangTileset.type !== 'tileset') throw new Error('Expected tileset');
    wangTileset.wangSets = [{ id: 'wang', name: 'Unsupported', type: 'mixed', colors: [], tiles: [{ tileId: 3, wangId: [0, 0, 0, 0, 0, 0, 0, 0] }] }];
    expect(() => removeUnusedImageCollectionSource(wangReference, tileset.id, 3)).toThrow(/unsupported Wang metadata/);

    const shadowReference = structuredClone(document); const shadowMap = createPixelTilemap('Shadow map'); shadowMap.tilesetIds = [tileset.id];
    const shadow = createPixelTileset('Short shadow', source0.id, 8, 8, 1, 1); shadow.firstGid = tileset.firstGid + 2;
    shadowReference.assetIds.push(shadow.id, shadowMap.id); shadowReference.pixelAssets[shadow.id] = shadow; shadowReference.pixelAssets[shadowMap.id] = shadowMap; shadowMap.tilesetIds.push(shadow.id);
    expect(() => removeUnusedImageCollectionSource(shadowReference, tileset.id, 3)).toThrow(/attached tileset precedence shadows the target/);
  });

  it('refuses animated, duplicate, oversized, overlapping, and exhausted lifecycle inputs', () => {
    const document = createPixelDocument('project', 'Collection refusals');
    const source = createPixelSprite('Source', 8, 8);
    const animated = createPixelSprite('Animated', 8, 8);
    animated.frameIds.push('frame-2'); animated.frames['frame-2'] = { ...animated.frames[animated.frameIds[0]], id: 'frame-2' };
    document.assetIds = [source.id, animated.id]; document.pixelAssets = { [source.id]: source, [animated.id]: animated }; document.activeAssetId = source.id;
    expect(imageCollectionSourceEligibility(document, source.id)).toBeUndefined();
    expect(imageCollectionSourceEligibility(document, animated.id)).toMatch(/one-frame sprites/);
    expect(() => createImageCollectionTileset(document, 'Collection', [source.id, source.id])).toThrow(/unique/);
    expect(() => createImageCollectionTileset(document, 'Collection', [animated.id])).toThrow(/one-frame/);
    expect(() => createImageCollectionTileset(document, 'Collection', Array.from({ length: 1_024 }, (_, index) => `source-${index}`))).toThrow(/at most 1,023/);
    const maximum = createPixelSprite('Maximum', 8_192, 8_192);
    const overflow = createPixelSprite('Overflow', 1, 1);
    document.assetIds.push(maximum.id, overflow.id);
    Object.assign(document.pixelAssets, { [maximum.id]: maximum, [overflow.id]: overflow });
    expect(() => createImageCollectionTileset(document, 'Too many pixels', [maximum.id, overflow.id])).toThrow(/64-megapixel/);
    const collection = createImageCollectionTileset(document, 'Collection', [source.id], { id: 'collection' });
    collection.firstGid = 4;
    const other = createPixelTileset('Atlas', source.id, 8, 8, 1, 1); other.firstGid = 5;
    const appendSource = createPixelSprite('Append', 8, 8);
    document.assetIds.push(collection.id, other.id, appendSource.id);
    Object.assign(document.pixelAssets, { [collection.id]: collection, [other.id]: other, [appendSource.id]: appendSource });
    expect(() => appendImageCollectionSource(document, collection.id, source.id)).toThrow(/already belongs/);
    expect(() => appendImageCollectionSource(document, collection.id, appendSource.id)).toThrow(/overlapping tileset/);
    other.firstGid = 20;
    collection.firstGid = TILED_GID_MASK;
    expect(() => appendImageCollectionSource(document, collection.id, appendSource.id)).toThrow(/28-bit/);
  });

  it('refuses unavailable, reused, animated, ambiguous, and unsupported replacement inputs without a partial plan', () => {
    const { document, tileset, source0, source3 } = collectionFixture();
    const replacement = createPixelSprite('Replacement', 6, 6);
    const animated = createPixelSprite('Animated replacement', 6, 6);
    const oversized = createPixelSprite('Oversized replacement', 8_192, 8_192);
    animated.frameIds.push('frame-2'); animated.frames['frame-2'] = { ...animated.frames[animated.frameIds[0]], id: 'frame-2' };
    document.assetIds.push(replacement.id, animated.id, oversized.id); Object.assign(document.pixelAssets, { [replacement.id]: replacement, [animated.id]: animated, [oversized.id]: oversized });
    expect(() => replaceImageCollectionSource(document, tileset.id, 2, replacement.id)).toThrow(/unavailable/);
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, 'missing-source')).toThrow(/does not exist/);
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, source3.id)).toThrow(/already the source/);
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, source0.id)).toThrow(/already belongs/);
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, animated.id)).toThrow(/one-frame/);
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, oversized.id)).toThrow(/64-megapixel/);

    const map = createPixelTilemap('Ambiguous map'); map.tilesetIds = [tileset.id];
    document.assetIds.push(map.id); document.pixelAssets[map.id] = map;
    const overlap = createPixelTileset('Overlapping atlas', source0.id, 8, 8, 8, 1);
    overlap.firstGid = tileset.firstGid;
    document.assetIds.push(overlap.id); document.pixelAssets[overlap.id] = overlap; map.tilesetIds.push(overlap.id);
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, replacement.id)).toThrow(/one exact attached GID range/);
    const shortShadow = createPixelTileset('Short precedence shadow', source0.id, 8, 8, 1, 1);
    shortShadow.firstGid = tileset.firstGid + 2;
    document.assetIds.push(shortShadow.id); document.pixelAssets[shortShadow.id] = shortShadow; map.tilesetIds = [tileset.id, shortShadow.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: encodeTiledGid(tileset.firstGid + 3, { hFlip: true, vFlip: true, diagonal: true }) }]);
    expect(() => imageCollectionSourceReplacementImpact(document, tileset.id, 3)).toThrow(/attached tileset precedence shadows the target/);
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, replacement.id)).toThrow(/attached tileset precedence shadows the target/);
    const sparseShadow = createImageCollectionTileset(document, 'Sparse shadow', [replacement.id], { id: 'sparse-shadow' });
    sparseShadow.firstGid = tileset.firstGid + 2;
    sparseShadow.tiles[5] = { ...sparseShadow.tiles[0], id: 5 };
    delete sparseShadow.tiles[0];
    document.assetIds.push(sparseShadow.id); document.pixelAssets[sparseShadow.id] = sparseShadow; map.tilesetIds = [tileset.id, sparseShadow.id];
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, replacement.id)).toThrow(/one exact attached GID range/);
    map.tilesetIds = [tileset.id]; map.orientation = 'isometric';
    expect(() => replaceImageCollectionSource(document, tileset.id, 3, replacement.id)).toThrow(/must remain orthogonal/);
  });

  it('selects only exact sparse IDs and replaces metadata without changing source topology', () => {
    const { document, tileset, source0, source3 } = collectionFixture();
    expect(imageCollectionTileIds(tileset)).toEqual([0, 3]);
    expect(imageCollectionSourceDependencyGuards(document, tileset)).toEqual([
      { spriteId: source0.id, expectedRevision: source0.revision, width: source0.width, height: source0.height },
      { spriteId: source3.id, expectedRevision: source3.revision, width: source3.width, height: source3.height },
    ]);
    const next = replaceImageCollectionTileMetadata(tileset, 3, {
      probability: 0.75,
      animation: [{ tileId: 3, durationMs: 125 }, { tileId: 0, durationMs: 75 }],
      collisions: [{ id: 'collision-3', type: 'rectangle', x: 1, y: 2, width: 7, height: 3, properties: { damage: 4 } }],
      properties: { biome: 'forest', solid: true, cost: 2 },
    });
    expect(next.tiles[3]).toMatchObject({ id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.75 });
    expect(next.tiles[3].collisions).toEqual([{ id: 'collision-3', type: 'rectangle', x: 1, y: 2, width: 7, height: 3, properties: { damage: 4 } }]);
    expect(next.tiles[0].imageAssetId).toBe(source0.id);
    expect(Object.keys(next.tiles)).toEqual(['0', '3']);
    expect(tileset.tiles[3]).toMatchObject({ probability: 0.5, properties: { biome: 'cave' } });
    expect(() => replaceImageCollectionTileMetadata(tileset, 2, { probability: 1 })).toThrow(/unavailable/);
    expect(() => replaceImageCollectionTileMetadata(tileset, 3, { animation: [{ tileId: 2, durationMs: 100 }] })).toThrow(/existing sparse tile IDs/);
  });

  it('refuses stale collection, topology, and sprite-source observations before submission', () => {
    const { document, source3, tileset } = collectionFixture();
    expect(imageCollectionAuthoringGuardError(document, structuredClone(document), tileset.id)).toBeUndefined();
    const staleTileset = structuredClone(document);
    if (staleTileset.pixelAssets[tileset.id].type !== 'tileset') throw new Error('Expected tileset');
    staleTileset.pixelAssets[tileset.id].revision += 1;
    expect(imageCollectionAuthoringGuardError(document, staleTileset, tileset.id)).toMatch(/collection changed/);
    const changedSource = structuredClone(document);
    if (changedSource.pixelAssets[source3.id].type !== 'sprite') throw new Error('Expected sprite');
    changedSource.pixelAssets[source3.id].revision += 1;
    expect(imageCollectionAuthoringGuardError(document, changedSource, tileset.id)).toMatch(/tile 3 source changed/);
    const missingSource = structuredClone(document);
    delete missingSource.pixelAssets[source3.id];
    expect(imageCollectionAuthoringGuardError(document, missingSource, tileset.id)).toMatch(/tile 3 is missing/);
    expect(() => imageCollectionSourceDependencyGuards(missingSource, tileset)).toThrow(/tile 3 is missing/);
    const changedTopology = structuredClone(document);
    const changedTileset = changedTopology.pixelAssets[tileset.id];
    if (changedTileset.type !== 'tileset') throw new Error('Expected tileset');
    delete changedTileset.tiles[3];
    expect(imageCollectionAuthoringGuardError(document, changedTopology, tileset.id)).toMatch(/tile IDs changed/);
  });

  it('refuses a chooser source that changed after it was displayed', () => {
    const document = createPixelDocument('project', 'Collection source observation');
    const source = document.pixelAssets[document.activeAssetId]; if (source.type !== 'sprite') throw new Error('Expected sprite');
    expect(imageCollectionSourceObservationGuardError(document, structuredClone(document), [source.id])).toBeUndefined();
    const revised = structuredClone(document);
    const revisedSource = revised.pixelAssets[source.id]; if (revisedSource.type !== 'sprite') throw new Error('Expected sprite');
    revisedSource.revision += 1;
    expect(imageCollectionSourceObservationGuardError(document, revised, [source.id])).toMatch(/changed/);
    const missing = structuredClone(document); delete missing.pixelAssets[source.id];
    expect(imageCollectionSourceObservationGuardError(document, missing, [source.id])).toMatch(/missing or changed kind/);
  });
});
