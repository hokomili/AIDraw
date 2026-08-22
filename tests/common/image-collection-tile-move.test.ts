import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  TransactionConflictError,
  applyTransaction,
  createId,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  decodeTiledGid,
  encodeTiledGid,
  nowIso,
  readTileAt,
  resolveTilesetForGid,
  writeTiles,
  type CanvasTransaction,
  type PixelDocument,
  type PixelTilemap,
} from '@aidraw/core';

import {
  firstUnusedImageCollectionTileId,
  planImageCollectionTileIdMove,
} from '../../src/common/image-collection-tile-move';
import { MAX_TILED_TOTAL_CELLS } from '../../src/common/tiled-resource-policy';

function fixture(): {
  document: PixelDocument;
  collectionId: string;
  sourceIds: string[];
  finiteMapId: string;
  sparseMapId: string;
  finiteTileLayerId: string;
  finiteObjectLayerId: string;
  sparseLayerId: string;
} {
  const document = createPixelDocument('project', 'Move exact sparse tile');
  const source0 = createPixelSprite('Pebble zero', 8, 12);
  const source3 = createPixelSprite('Tall grass three', 17, 6);
  const source7 = createPixelSprite('Arch seven', 5, 14);
  const atlasSource = createPixelSprite('Unrelated atlas pixels', 8, 8);
  const collection = createPixelTileset('Sparse environment', source0.id, 17, 14, 1, 1);
  collection.spriteAssetId = undefined;
  collection.firstGid = 20;
  collection.columns = 3;
  collection.rows = 0;
  collection.margin = 0;
  collection.spacing = 0;
  collection.tileWidth = 17;
  collection.tileHeight = 14;
  collection.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [{ tileId: 3, durationMs: 70 }], collisions: [], properties: { role: 'entry' } },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.35, animation: [{ tileId: 3, durationMs: 90 }, { tileId: 7, durationMs: 110 }], collisions: [{ id: 'grass-hit', type: 'rectangle', x: -2, y: 1, width: 15, height: 5, properties: { damage: 2 } }], properties: { biome: 'meadow', exact: true } },
    7: { id: 7, sourceX: 0, sourceY: 0, imageAssetId: source7.id, probability: 0.8, animation: [{ tileId: 0, durationMs: 130 }], collisions: [], properties: { role: 'exit' } },
  };
  collection.wangSets = [{
    id: 'wang-ground', name: 'Ground edges', type: 'mixed',
    colors: [{ id: 1, name: 'Grass', color: '#55aa66', tileId: 3, probability: 1 }],
    tiles: [
      { tileId: 3, wangId: [1, 0, 1, 0, 1, 0, 1, 0] },
      { tileId: 0, wangId: [0, 1, 0, 1, 0, 1, 0, 1] },
    ],
  }];
  collection.tileOffset = { x: -4, y: 9 };
  collection.transformations = { hFlip: true, vFlip: true, rotate: true };

  const atlas = createPixelTileset('Unrelated atlas', atlasSource.id, 8, 8, 1, 1);
  atlas.firstGid = 100;
  const unrelatedCollection = createPixelTileset('Unrelated collection', source0.id, 8, 12, 1, 1);
  unrelatedCollection.spriteAssetId = undefined;
  unrelatedCollection.firstGid = 120;
  unrelatedCollection.columns = 0;
  unrelatedCollection.rows = 0;
  unrelatedCollection.tiles = {
    0: {
      id: 0,
      sourceX: 0,
      sourceY: 0,
      imageAssetId: source0.id,
      probability: 1,
      animation: [],
      collisions: [],
      properties: {},
    },
  };
  unrelatedCollection.wangSets = [];
  const finite = createPixelTilemap('Finite orthogonal references');
  finite.orientation = 'orthogonal';
  finite.width = 4;
  finite.height = 3;
  finite.tilesetIds = [collection.id, atlas.id, unrelatedCollection.id];
  const finiteTileLayer = finite.layers[finite.layerIds[0]];
  if (finiteTileLayer.type !== 'tile' || !finiteTileLayer.chunks) throw new Error('Expected finite tile layer.');
  writeTiles(finiteTileLayer.chunks, [
    { x: 1, y: 1, gid: encodeTiledGid(23, { hFlip: true, diagonal: true }) },
    { x: 2, y: 1, gid: 20 },
    { x: 3, y: 2, gid: 100 },
    { x: 0, y: 2, gid: 120 },
  ]);
  const createdAt = nowIso();
  const finiteObjectLayerId = 'finite-objects';
  finite.layerIds.push(finiteObjectLayerId);
  finite.layers[finiteObjectLayerId] = {
    id: finiteObjectLayerId, revision: 0, name: 'Placed objects', type: 'object', visible: true, locked: false,
    opacity: 1, offsetX: 2, offsetY: -3, parallaxX: 1, parallaxY: 1, createdAt, updatedAt: createdAt, createdBy: HUMAN_ACTOR.id,
    objects: [{ id: 'grass-object', type: 'tile', gid: encodeTiledGid(23, { vFlip: true }), x: -14, y: 33, width: 34, height: 12, rotation: 15, name: 'Exact grass', className: 'prop', properties: { retained: true } }],
  };

  const sparse = createPixelTilemap('Sparse isometric references');
  sparse.orientation = 'isometric';
  sparse.infinite = true;
  sparse.width = 1;
  sparse.height = 1;
  sparse.tilesetIds = [collection.id];
  const sparseLayer = sparse.layers[sparse.layerIds[0]];
  if (sparseLayer.type !== 'tile' || !sparseLayer.chunks) throw new Error('Expected sparse tile layer.');
  writeTiles(sparseLayer.chunks, [
    { x: 35, y: -67, gid: encodeTiledGid(23, { hFlip: true, vFlip: true }) },
    { x: -65, y: 34, gid: encodeTiledGid(23, { diagonal: true }) },
    { x: -64, y: 34, gid: 27 },
  ]);

  document.assetIds = [source0.id, source3.id, source7.id, collection.id, atlasSource.id, atlas.id, unrelatedCollection.id, finite.id, sparse.id];
  document.pixelAssets = {
    [source0.id]: source0,
    [source3.id]: source3,
    [source7.id]: source7,
    [collection.id]: collection,
    [atlasSource.id]: atlasSource,
    [atlas.id]: atlas,
    [unrelatedCollection.id]: unrelatedCollection,
    [finite.id]: finite,
    [sparse.id]: sparse,
  };
  document.activeAssetId = collection.id;
  document.tileStamps = [{
    id: 'grass-stamp', name: 'Grass diagonal', width: 2, height: 1, anchorX: 1, anchorY: 0,
    cells: [{ x: 0, y: 0, gid: 0 }, { x: 1, y: 0, gid: encodeTiledGid(23, { hFlip: true, vFlip: true, diagonal: true }) }],
  }];
  return {
    document,
    collectionId: collection.id,
    sourceIds: [source0.id, source3.id, source7.id, atlasSource.id],
    finiteMapId: finite.id,
    sparseMapId: sparse.id,
    finiteTileLayerId: finiteTileLayer.id,
    finiteObjectLayerId,
    sparseLayerId: sparseLayer.id,
  };
}

function transaction(document: PixelDocument, operations: CanvasTransaction['operations']): CanvasTransaction {
  return {
    id: createId('tx'), clientOperationId: createId('move-op'), documentId: document.id,
    expectedDocumentRevision: document.revision, actor: HUMAN_ACTOR, label: 'Move image-collection tile ID', createdAt: nowIso(), operations,
  };
}

describe('exact image-collection tile-ID movement', () => {
  it('moves one complete record and every proven direct reference without changing pixels, ranges, transforms, or structure', () => {
    const source = fixture();
    const { document } = source;
    const before = structuredClone(document);
    const beforeSources = JSON.stringify(source.sourceIds.map((id) => document.pixelAssets[id]));
    const collection = document.pixelAssets[source.collectionId]; if (collection.type !== 'tileset') throw new Error('Expected collection.');
    const movedRecord = structuredClone(collection.tiles[3]);

    expect(firstUnusedImageCollectionTileId(collection, 3)).toBe(1);
    const plan = planImageCollectionTileIdMove(document, collection.id, 3, 2);
    expect(plan.impact).toMatchObject({
      sourceTileId: 3, destinationTileId: 2, sourceId: movedRecord.imageAssetId,
      oldBaseGid: 23, newBaseGid: 22, maximumLocalId: 7, attachedMapCount: 2,
      mapCellCount: 3, tileObjectCount: 1, animationFrameCount: 2,
      wangColorCount: 1, wangTileCount: 1, tileStampCellCount: 1,
      rewrittenReferenceCount: 9, operationCount: 4,
    });
    expect(plan.impact.maps.map(({ mapId, tileCellCount, tileObjectCount }) => ({ mapId, tileCellCount, tileObjectCount }))).toEqual([
      { mapId: source.finiteMapId, tileCellCount: 1, tileObjectCount: 1 },
      { mapId: source.sparseMapId, tileCellCount: 2, tileObjectCount: 0 },
    ]);
    expect(plan.impact.animations).toEqual([{ tileId: 0, frameCount: 1 }, { tileId: 3, frameCount: 1 }]);
    expect(plan.impact.wangSets).toEqual([{ setId: 'wang-ground', setName: 'Ground edges', colorCount: 1, tileCount: 1 }]);
    expect(plan.impact.stamps).toEqual([{ stampId: 'grass-stamp', stampName: 'Grass diagonal', cellCount: 1 }]);
    expect(plan.tileset.firstGid).toBe(collection.firstGid);
    expect(Object.keys(plan.tileset.tiles)).toEqual(['0', '2', '7']);
    expect(plan.tileset.tiles[2]).toEqual({ ...movedRecord, id: 2, animation: [{ tileId: 2, durationMs: 90 }, { tileId: 7, durationMs: 110 }] });
    expect(plan.tileset.tiles[0].animation).toEqual([{ tileId: 2, durationMs: 70 }]);
    expect(plan.tileset.wangSets[0].colors[0].tileId).toBe(2);
    expect(plan.tileset.wangSets[0].tiles.map(({ tileId }) => tileId)).toEqual([2, 0]);
    expect(JSON.stringify(document)).toBe(JSON.stringify(before));

    const applied = applyTransaction(document, transaction(document, plan.operations));
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document.');
    const changed = applied.document;
    expect(changed.activity[0]).toMatchObject({ label: 'Move image-collection tile ID', actor: HUMAN_ACTOR, operationCount: 4 });
    expect(JSON.stringify(source.sourceIds.map((id) => changed.pixelAssets[id]))).toBe(beforeSources);
    const changedCollection = changed.pixelAssets[collection.id]; if (changedCollection.type !== 'tileset') throw new Error('Expected collection.');
    expect(changedCollection.firstGid).toBe(20);
    expect(Object.keys(changedCollection.tiles)).toEqual(['0', '2', '7']);
    const finite = changed.pixelAssets[source.finiteMapId] as PixelTilemap;
    const sparse = changed.pixelAssets[source.sparseMapId] as PixelTilemap;
    const changedFiniteTileLayer = finite.layers[source.finiteTileLayerId]; if (changedFiniteTileLayer.type !== 'tile' || !changedFiniteTileLayer.chunks) throw new Error('Expected changed finite tile layer.');
    const changedSparseLayer = sparse.layers[source.sparseLayerId]; if (changedSparseLayer.type !== 'tile' || !changedSparseLayer.chunks) throw new Error('Expected changed sparse tile layer.');
    expect(decodeTiledGid(readTileAt(changedFiniteTileLayer.chunks, 1, 1))).toEqual({ gid: 22, hFlip: true, vFlip: false, diagonal: true });
    expect(readTileAt(changedFiniteTileLayer.chunks, 2, 1)).toBe(20);
    expect(readTileAt(changedFiniteTileLayer.chunks, 3, 2)).toBe(100);
    expect(readTileAt(changedFiniteTileLayer.chunks, 0, 2)).toBe(120);
    const finiteObjectLayer = finite.layers[source.finiteObjectLayerId]; if (finiteObjectLayer.type !== 'object') throw new Error('Expected object layer.');
    const beforeFinite = before.pixelAssets[source.finiteMapId]; if (beforeFinite.type !== 'tilemap') throw new Error('Expected prior finite map.');
    const beforeObjectLayer = beforeFinite.layers[source.finiteObjectLayerId]; if (beforeObjectLayer.type !== 'object') throw new Error('Expected prior object layer.');
    expect(finiteObjectLayer.objects?.[0]).toEqual({ ...beforeObjectLayer.objects?.[0], gid: encodeTiledGid(22, { vFlip: true }) });
    expect(decodeTiledGid(readTileAt(changedSparseLayer.chunks, 35, -67))).toEqual({ gid: 22, hFlip: true, vFlip: true, diagonal: false });
    expect(decodeTiledGid(readTileAt(changedSparseLayer.chunks, -65, 34))).toEqual({ gid: 22, hFlip: false, vFlip: false, diagonal: true });
    expect(readTileAt(changedSparseLayer.chunks, -64, 34)).toBe(27);
    expect(changed.tileStamps[0].cells).toEqual([{ x: 0, y: 0, gid: 0 }, { x: 1, y: 0, gid: encodeTiledGid(22, { hFlip: true, vFlip: true, diagonal: true }) }]);
    expect(resolveTilesetForGid(changed, finite, 22)).toMatchObject({ tileset: { id: collection.id }, localId: 2 });
    expect(resolveTilesetForGid(changed, finite, 23)).toBeUndefined();
    expect(resolveTilesetForGid(changed, finite, 20)).toMatchObject({ tileset: { id: collection.id }, localId: 0 });
    expect(resolveTilesetForGid(changed, finite, 100)).toMatchObject({ localId: 0 });

    const restored = applyTransaction(changed, applied.inverse, { recordActivity: false }).document;
    if (restored.kind !== 'pixel') throw new Error('Expected pixel document.');
    const normalized = structuredClone(restored);
    normalized.revision = before.revision;
    normalized.updatedAt = before.updatedAt;
    normalized.activity = before.activity;
    normalized.dirty = before.dirty;
    for (const assetId of [collection.id, source.finiteMapId, source.sparseMapId]) {
      normalized.pixelAssets[assetId].revision = before.pixelAssets[assetId].revision;
      normalized.pixelAssets[assetId].updatedAt = before.pixelAssets[assetId].updatedAt;
    }
    expect(normalized).toEqual(before);
  });

  it('refuses invalid IDs, highest movement, missing gaps/sources, locked references, shadowing, ambiguity, and scan overflow without mutating input', () => {
    const base = fixture();
    const before = JSON.stringify(base.document);
    expect(() => planImageCollectionTileIdMove(base.document, base.collectionId, 7, 1)).toThrow(/highest authored local ID/);
    expect(() => planImageCollectionTileIdMove(base.document, base.collectionId, 3, 3)).toThrow(/must differ/);
    expect(() => planImageCollectionTileIdMove(base.document, base.collectionId, 3, 0)).toThrow(/already occupied/);
    expect(() => planImageCollectionTileIdMove(base.document, base.collectionId, 3, -1)).toThrow(/whole number/);
    expect(() => planImageCollectionTileIdMove(base.document, base.collectionId, 3, 8)).toThrow(/outside the unchanged authored span/);
    expect(JSON.stringify(base.document)).toBe(before);

    const noGap = fixture(); const dense = noGap.document.pixelAssets[noGap.collectionId]; if (dense.type !== 'tileset') throw new Error('Expected collection.');
    for (let id = 1; id < 7; id += 1) if (!dense.tiles[id]) dense.tiles[id] = { ...structuredClone(dense.tiles[0]), id };
    expect(() => firstUnusedImageCollectionTileId(dense, 3)).toThrow(/no unused local-ID gap/);

    const missing = fixture(); const missingCollection = missing.document.pixelAssets[missing.collectionId]; if (missingCollection.type !== 'tileset') throw new Error('Expected collection.');
    delete missing.document.pixelAssets[missingCollection.tiles[3].imageAssetId!];
    expect(() => planImageCollectionTileIdMove(missing.document, missing.collectionId, 3, 2)).toThrow(/missing its sprite source/);

    const locked = fixture(); const lockedMap = locked.document.pixelAssets[locked.finiteMapId]; if (lockedMap.type !== 'tilemap') throw new Error('Expected map.');
    lockedMap.layers[locked.finiteTileLayerId].locked = true;
    expect(() => planImageCollectionTileIdMove(locked.document, locked.collectionId, 3, 2)).toThrow(/locked and contains a moved tile reference/);

    const retainedDestination = fixture(); const destinationMap = retainedDestination.document.pixelAssets[retainedDestination.finiteMapId]; if (destinationMap.type !== 'tilemap') throw new Error('Expected map.');
    const destinationLayer = destinationMap.layers[retainedDestination.finiteTileLayerId]; if (destinationLayer.type !== 'tile' || !destinationLayer.chunks) throw new Error('Expected layer.');
    writeTiles(destinationLayer.chunks, [{ x: 0, y: 0, gid: 22 }]);
    expect(() => planImageCollectionTileIdMove(retainedDestination.document, retainedDestination.collectionId, 3, 2)).toThrow(/already stores destination GID 22/);

    const shadowed = fixture(); const shadowMap = shadowed.document.pixelAssets[shadowed.finiteMapId]; if (shadowMap.type !== 'tilemap') throw new Error('Expected map.');
    const shadowSource = shadowed.document.pixelAssets[shadowed.sourceIds[0]]; if (shadowSource.type !== 'sprite') throw new Error('Expected sprite.');
    const shortShadow = createPixelTileset('Short higher precedence', shadowSource.id, 8, 8, 1, 1); shortShadow.firstGid = 22;
    shadowed.document.assetIds.push(shortShadow.id); shadowed.document.pixelAssets[shortShadow.id] = shortShadow; shadowMap.tilesetIds.push(shortShadow.id);
    expect(() => planImageCollectionTileIdMove(shadowed.document, shadowed.collectionId, 3, 2)).toThrow(/missing or shadowed/);

    const overlap = fixture(); const overlapMap = overlap.document.pixelAssets[overlap.finiteMapId]; if (overlapMap.type !== 'tilemap') throw new Error('Expected map.');
    const overlapSource = overlap.document.pixelAssets[overlap.sourceIds[0]]; if (overlapSource.type !== 'sprite') throw new Error('Expected sprite.');
    const overlapping = createPixelTileset('Overlapping atlas', overlapSource.id, 8, 8, 8, 1); overlapping.firstGid = 18;
    overlap.document.assetIds.push(overlapping.id); overlap.document.pixelAssets[overlapping.id] = overlapping; overlapMap.tilesetIds.push(overlapping.id);
    expect(() => planImageCollectionTileIdMove(overlap.document, overlap.collectionId, 3, 2)).toThrow(/cannot prove one exact attached range/);

    const ambiguousStamp = fixture(); const ambiguousSource = ambiguousStamp.document.pixelAssets[ambiguousStamp.sourceIds[0]]; if (ambiguousSource.type !== 'sprite') throw new Error('Expected sprite.');
    const sameFirstGid = createPixelTileset('Ambiguous reusable range', ambiguousSource.id, 8, 8, 1, 1); sameFirstGid.firstGid = 20;
    ambiguousStamp.document.assetIds.push(sameFirstGid.id); ambiguousStamp.document.pixelAssets[sameFirstGid.id] = sameFirstGid;
    expect(() => planImageCollectionTileIdMove(ambiguousStamp.document, ambiguousStamp.collectionId, 3, 2)).toThrow(/Reusable tile-stamp GID 23 is ambiguous/);

    const overflow = fixture(); const overflowMap = overflow.document.pixelAssets[overflow.finiteMapId]; if (overflowMap.type !== 'tilemap') throw new Error('Expected map.');
    const overflowLayer = overflowMap.layers[overflow.finiteTileLayerId]; if (overflowLayer.type !== 'tile' || !overflowLayer.chunks) throw new Error('Expected layer.');
    overflowLayer.chunks = { overflow: { x: 0, y: 0, width: MAX_TILED_TOTAL_CELLS + 1, height: 1, encoding: 'base64', compression: 'none', data: '' } } as unknown as typeof overflowLayer.chunks;
    expect(() => planImageCollectionTileIdMove(overflow.document, overflow.collectionId, 3, 2)).toThrow(/reference-scan limit/);
  });

  it('keeps the document guard atomic when a canonical dependency changes after planning', () => {
    const { document, collectionId, sourceIds } = fixture();
    const plan = planImageCollectionTileIdMove(document, collectionId, 3, 2);
    const request = transaction(document, plan.operations);
    const drifted = structuredClone(document);
    const source = drifted.pixelAssets[sourceIds[1]]; if (source.type !== 'sprite') throw new Error('Expected source.');
    source.revision += 1;
    drifted.revision += 1;
    const before = structuredClone(drifted);
    expect(() => applyTransaction(drifted, request)).toThrow(TransactionConflictError);
    expect(drifted).toEqual(before);
  });
});
