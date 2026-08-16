import {
  HUMAN_ACTOR,
  TILED_GID_MASK,
  applyTransaction,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  decodeTiledGid,
  encodeTiledGid,
  nowIso,
  readPixel,
  readTileAt,
  resolveTilesetForGid,
  tilesetLocalIdSpan,
  writePixels,
  writeTiles,
  type CanvasTransaction,
  type PixelDocument,
  type PixelSprite,
  type PixelTilemap,
  type PixelTileset,
} from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import {
  parseStampLibraryJson,
  prepareStampLibraryImport,
  serializePortableTileStampKit,
  type PortableTileStampKitBundle,
} from '../../src/common/stamp-library-interchange';

function deterministicIds() {
  let sequence = 0;
  return (prefix: string) => `${prefix}-portable-${++sequence}`;
}

function commit(document: PixelDocument, operations: CanvasTransaction['operations']) {
  return applyTransaction(document, {
    id: 'portable-kit-tx',
    clientOperationId: 'portable-kit-op',
    documentId: document.id,
    expectedDocumentRevision: document.revision,
    actor: HUMAN_ACTOR,
    label: 'Import portable tile kit',
    createdAt: nowIso(),
    operations,
  });
}

function firstCel(sprite: PixelSprite) {
  const cel = Object.values(sprite.cels)[0];
  if (!cel) throw new Error('Expected sprite cel');
  return cel;
}

function emptyProject(name: string) {
  const document = createPixelDocument('project', name);
  document.assetIds = [];
  document.pixelAssets = {};
  const map = createPixelTilemap(`${name} map`);
  document.pixelAssets[map.id] = map;
  document.assetIds = [map.id];
  document.activeAssetId = map.id;
  return { document, map };
}

function atlasKitProject() {
  const { document, map } = emptyProject('Atlas source');
  const sprite = createPixelSprite('Terrain artwork', 32, 16);
  writePixels(firstCel(sprite), [{ x: 0, y: 0, index: 2 }, { x: 16, y: 0, index: 3 }]);
  const tileset = createPixelTileset('Terrain atlas', sprite.id, 16, 16, 2, 1);
  tileset.firstGid = 17;
  tileset.tileOffset = { x: -3, y: 4 };
  tileset.objectAlignment = 'bottomright';
  tileset.transformations = { hFlip: true, vFlip: false, rotate: true };
  tileset.tiles[1] = {
    id: 1,
    sourceX: 16,
    sourceY: 0,
    probability: 0.25,
    animation: [{ tileId: 0, durationMs: 120 }, { tileId: 1, durationMs: 80 }],
    collisions: [{ id: 'ledge', type: 'rectangle', x: 1, y: 2, width: 12, height: 5, properties: { solid: true } }],
    properties: { biome: 'cliff', damage: 2 },
  };
  tileset.wangSets = [{
    id: 'wang-terrain',
    name: 'Terrain',
    type: 'edge',
    colors: [{ id: 1, name: 'Grass', color: '#00aa00', tileId: 0, probability: 1 }],
    tiles: [{ tileId: 1, wangId: [0, 1, 0, 1, 0, 1, 0, 1] }],
  }];
  map.tilesetIds = [tileset.id];
  document.palette[2] = { ...document.palette[2]!, name: 'Portable moss', color: '#123456' };
  document.pixelAssets[sprite.id] = sprite;
  document.pixelAssets[tileset.id] = tileset;
  document.assetIds = [sprite.id, tileset.id, map.id];
  document.tileStamps = [{
    id: 'terrain-stamp',
    name: 'Terrain pair',
    width: 3,
    height: 1,
    anchorX: 1,
    anchorY: 0,
    cells: [
      { x: 0, y: 0, gid: encodeTiledGid(17, { hFlip: true }) },
      { x: 1, y: 0, gid: 0 },
      { x: 2, y: 0, gid: encodeTiledGid(18, { vFlip: true, diagonal: true }) },
    ],
  }];
  return { document, map, sprite, tileset };
}

function destinationWithAtlas(firstGid = 1) {
  const { document, map } = emptyProject('Destination');
  const sprite = createPixelSprite('Existing artwork', 16, 16);
  const tileset = createPixelTileset('Existing tiles', sprite.id, 16, 16, 1, 1);
  tileset.firstGid = firstGid;
  map.tilesetIds = [tileset.id];
  document.pixelAssets[sprite.id] = sprite;
  document.pixelAssets[tileset.id] = tileset;
  document.assetIds = [sprite.id, tileset.id, map.id];
  return { document, map, sprite, tileset };
}

function collectionKitProject() {
  const { document, map } = emptyProject('Collection source');
  const small = createPixelSprite('Small tile', 7, 5);
  const large = createPixelSprite('Large tile', 11, 9);
  writePixels(firstCel(small), [{ x: 1, y: 1, index: 2 }]);
  writePixels(firstCel(large), [{ x: 10, y: 8, index: 3 }]);
  const tileset = createPixelTileset('Sparse collection', small.id, 11, 9, 1, 1);
  delete tileset.spriteAssetId;
  tileset.firstGid = 41;
  tileset.columns = 3;
  tileset.rows = 0;
  tileset.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: small.id, probability: 0.75, animation: [{ tileId: 3, durationMs: 90 }], collisions: [], properties: { kind: 'small' } },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: large.id, probability: 0.5, animation: [], collisions: [{ id: 'large-hit', type: 'ellipse', x: 1, y: 2, width: 8, height: 6, properties: {} }], properties: { kind: 'large' } },
  };
  tileset.wangSets = [];
  map.tilesetIds = [tileset.id];
  document.pixelAssets[small.id] = small;
  document.pixelAssets[large.id] = large;
  document.pixelAssets[tileset.id] = tileset;
  document.assetIds = [small.id, large.id, tileset.id, map.id];
  document.tileStamps = [{ id: 'sparse', name: 'Sparse choice', width: 2, height: 1, anchorX: 0, anchorY: 0, cells: [
    { x: 0, y: 0, gid: 41 },
    { x: 1, y: 0, gid: encodeTiledGid(44, { diagonal: true }) },
  ] }];
  return { document, map, tileset, small, large };
}

function addTileObject(map: PixelTilemap, rawGid: number) {
  const sourceLayer = map.layers[map.layerIds[0]!];
  const layer = structuredClone(sourceLayer);
  layer.id = 'portable-object-layer';
  layer.name = 'Portable objects';
  layer.type = 'object';
  delete layer.chunks;
  layer.objects = [{
    id: 'portable-tile-object', type: 'tile', gid: rawGid,
    x: 8, y: 8, width: 8, height: 8, rotation: 0,
    name: 'Existing tile object', className: '', properties: {},
  }];
  map.layers[layer.id] = layer;
  map.layerIds.push(layer.id);
  return layer;
}

function exactUnattachedCollectionDestination() {
  const source = collectionKitProject();
  source.tileset.firstGid = 5;
  source.document.tileStamps = [{
    id: 'portable-incoming', name: 'Portable incoming', width: 1, height: 1, anchorX: 0, anchorY: 0,
    cells: [{ x: 0, y: 0, gid: encodeTiledGid(5, { diagonal: true }) }],
  }];
  const bundle = parseStampLibraryJson(serializePortableTileStampKit(source.document, source.map));
  const document = structuredClone(source.document);
  document.id = 'destination-with-exact-unattached-collection';
  document.tileStamps = [];
  const existingSprite = createPixelSprite('Existing sparse source', 8, 8);
  const existingTileset = createPixelTileset('Existing sparse A', existingSprite.id, 8, 8, 1, 1);
  delete existingTileset.spriteAssetId;
  existingTileset.firstGid = 1;
  existingTileset.columns = 8;
  existingTileset.rows = 0;
  existingTileset.tiles = {
    7: { id: 7, sourceX: 0, sourceY: 0, imageAssetId: existingSprite.id, probability: 1, animation: [], collisions: [], properties: {} },
  };
  const map = createPixelTilemap('Destination semantic map');
  map.tilesetIds = [existingTileset.id];
  document.pixelAssets[existingSprite.id] = existingSprite;
  document.pixelAssets[existingTileset.id] = existingTileset;
  document.pixelAssets[map.id] = map;
  document.assetIds.push(existingSprite.id, existingTileset.id, map.id);
  document.activeAssetId = map.id;
  return { bundle, document, map, existingTileset, sourceTileset: source.tileset };
}

describe('portable tile stamp kits', () => {
  it('copies an exact atlas dependency graph, adds exact palette slots, allocates a safe range, and preserves transformed stamp meaning', () => {
    const source = atlasKitProject();
    const sourceBefore = structuredClone(source.document);
    const bundle = parseStampLibraryJson(serializePortableTileStampKit(source.document, source.map));
    expect(bundle).toMatchObject({ version: 2, kind: 'tile', tilesetIds: [source.tileset.id], assets: [{ id: source.sprite.id }, { id: source.tileset.id }] });

    const target = destinationWithAtlas();
    target.document.tileStamps = [{ id: 'existing-stamp', name: 'Terrain pair', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: 1 }] }];
    const before = structuredClone(target.document);
    const plan = prepareStampLibraryImport(target.document, bundle, 'append', { map: target.map, makeId: deterministicIds() });
    expect(plan).toMatchObject({
      kind: 'tile',
      formatVersion: 2,
      expectedDocumentId: target.document.id,
      expectedDocumentRevision: target.document.revision,
      incomingCount: 1,
      totalCount: 2,
      portable: {
        copiedSpriteCount: 1,
        copiedTilesetCount: 1,
        reusedSpriteCount: 0,
        reusedTilesetCount: 0,
        rebasedCellCount: 2,
        sources: [expect.objectContaining({ sourceAssetId: source.sprite.id, disposition: 'copied' })],
      },
    });
    expect(plan.operations.map((operation) => operation.kind)).toEqual([
      'pixel.palette.replace',
      'pixel.asset.add',
      'pixel.asset.add',
      'pixel.asset.replace',
      'pixel.tile-stamps.replace',
    ]);
    expect(plan.portable?.paletteAdditions).toEqual([expect.objectContaining({ name: 'Portable moss', color: '#123456' })]);
    expect(plan.portable?.dependencies).toEqual([expect.objectContaining({
      sourceFirstGid: 17,
      sourceLastGid: 18,
      targetFirstGid: 2,
      targetLastGid: 3,
      disposition: 'copied',
    })]);

    const applied = commit(target.document, plan.operations);
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const importedMap = applied.document.pixelAssets[target.map.id] as PixelTilemap;
    const copiedTileset = Object.values(applied.document.pixelAssets).find((asset): asset is PixelTileset => asset.type === 'tileset' && asset.name === source.tileset.name);
    if (!copiedTileset) throw new Error('Expected copied tileset');
    expect(importedMap.tilesetIds).toEqual([target.tileset.id, copiedTileset.id]);
    expect(copiedTileset).toMatchObject({
      firstGid: 2,
      tileOffset: source.tileset.tileOffset,
      objectAlignment: source.tileset.objectAlignment,
      transformations: source.tileset.transformations,
      tiles: source.tileset.tiles,
      wangSets: source.tileset.wangSets,
    });
    expect(copiedTileset.id).not.toBe(source.tileset.id);
    expect(copiedTileset.spriteAssetId).not.toBe(source.sprite.id);
    const copiedSprite = applied.document.pixelAssets[copiedTileset.spriteAssetId!];
    if (copiedSprite.type !== 'sprite') throw new Error('Expected copied sprite');
    const importedMossIndex = applied.document.palette.findIndex((entry) => entry.name === 'Portable moss' && entry.color === '#123456');
    expect(importedMossIndex).toBeGreaterThanOrEqual(before.palette.length);
    expect(readPixel(firstCel(copiedSprite), 0, 0)).toBe(importedMossIndex);
    const beforeMap = before.pixelAssets[target.map.id];
    if (beforeMap.type !== 'tilemap') throw new Error('Expected predecessor map');
    expect((applied.document.pixelAssets[target.map.id] as PixelTilemap).layers).toEqual(beforeMap.layers);
    const importedStamp = applied.document.tileStamps[1]!;
    expect(importedStamp).toMatchObject({ name: 'Terrain pair', width: 3, height: 1, anchorX: 1, anchorY: 0 });
    expect(applied.document.tileStamps.map((stamp) => stamp.name)).toEqual(['Terrain pair', 'Terrain pair']);
    expect(importedStamp.cells[1]).toEqual({ x: 1, y: 0, gid: 0 });
    expect(decodeTiledGid(importedStamp.cells[0]!.gid)).toEqual({ gid: 2, hFlip: true, vFlip: false, diagonal: false });
    expect(decodeTiledGid(importedStamp.cells[2]!.gid)).toEqual({ gid: 3, hFlip: false, vFlip: true, diagonal: true });
    expect(source.document).toEqual(sourceBefore);

    const undone = applyTransaction(applied.document, applied.inverse).document;
    if (undone.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(undone.palette).toEqual(before.palette);
    expect(undone.assetIds).toEqual(before.assetIds);
    expect(Object.keys(undone.pixelAssets)).toEqual(Object.keys(before.pixelAssets));
    expect((undone.pixelAssets[target.map.id] as PixelTilemap).tilesetIds).toEqual(target.map.tilesetIds);
    expect(undone.pixelAssets[target.sprite.id]).toEqual(before.pixelAssets[target.sprite.id]);
    expect(undone.pixelAssets[target.tileset.id]).toEqual(before.pixelAssets[target.tileset.id]);
    expect(undone.tileStamps).toEqual(before.tileStamps);
  });

  it('reuses only exact canonical dependencies already attached to the destination map', () => {
    const source = atlasKitProject();
    const bundle = parseStampLibraryJson(serializePortableTileStampKit(source.document, source.map));
    const target = structuredClone(source.document);
    target.id = 'exact-reuse-target';
    target.tileStamps = [];
    const targetMap = target.pixelAssets[source.map.id] as PixelTilemap;
    const plan = prepareStampLibraryImport(target, bundle, 'replace', { map: targetMap, makeId: deterministicIds() });
    expect(plan.portable).toMatchObject({ copiedSpriteCount: 0, reusedSpriteCount: 1, copiedTilesetCount: 0, reusedTilesetCount: 1, mapAttachments: [] });
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['pixel.tile-stamps.replace']);
    const imported = commit(target, plan.operations).document;
    if (imported.kind !== 'pixel') throw new Error('Expected pixel document');
    expect((imported.pixelAssets[targetMap.id] as PixelTilemap).tilesetIds).toEqual([source.tileset.id]);
    expect(imported.pixelAssets[source.sprite.id]).toEqual(source.sprite);
  });

  it('does not treat name-only sprite or tileset similarity as reusable identity', () => {
    const source = atlasKitProject();
    const bundle = parseStampLibraryJson(serializePortableTileStampKit(source.document, source.map));
    const nameOnly = destinationWithAtlas();
    nameOnly.sprite.name = source.sprite.name;
    nameOnly.tileset.name = source.tileset.name;
    const nameOnlyPlan = prepareStampLibraryImport(nameOnly.document, bundle, 'append', { map: nameOnly.map, makeId: deterministicIds() });
    expect(nameOnlyPlan.portable).toMatchObject({ copiedSpriteCount: 1, reusedSpriteCount: 0, copiedTilesetCount: 1, reusedTilesetCount: 0 });
  });

  it('copies an exact unattached tileset above existing ranges so resolved cells, objects, and retained stamps keep their meaning', () => {
    const target = exactUnattachedCollectionDestination();
    const existingRaw = encodeTiledGid(8, { hFlip: true, vFlip: true, diagonal: true });
    const tileLayer = target.map.layers[target.map.layerIds[0]!];
    if (tileLayer.type !== 'tile' || !tileLayer.chunks) throw new Error('Expected tile layer');
    writeTiles(tileLayer.chunks, [{ x: 0, y: 0, gid: existingRaw }]);
    const objectLayer = addTileObject(target.map, existingRaw);
    target.document.tileStamps = [{
      id: 'retained', name: 'Retained destination stamp', width: 1, height: 1, anchorX: 0, anchorY: 0,
      cells: [{ x: 0, y: 0, gid: existingRaw }],
    }];
    expect(resolveTilesetForGid(target.document, target.map, 8)).toMatchObject({ tileset: { id: target.existingTileset.id }, localId: 7 });

    const plan = prepareStampLibraryImport(target.document, target.bundle, 'append', { map: target.map, makeId: deterministicIds() });
    expect(plan.portable).toMatchObject({
      copiedSpriteCount: 0,
      reusedSpriteCount: 2,
      copiedTilesetCount: 1,
      reusedTilesetCount: 0,
      dependencies: [expect.objectContaining({
        sourceTilesetId: target.sourceTileset.id,
        sourceFirstGid: 5,
        targetFirstGid: 9,
        targetLastGid: 12,
        disposition: 'copied',
      })],
    });
    const applied = commit(target.document, plan.operations).document;
    if (applied.kind !== 'pixel') throw new Error('Expected pixel document');
    const appliedMap = applied.pixelAssets[target.map.id];
    if (appliedMap.type !== 'tilemap') throw new Error('Expected imported map');
    expect(resolveTilesetForGid(applied, appliedMap, 8)).toMatchObject({ tileset: { id: target.existingTileset.id }, localId: 7 });
    const appliedTileLayer = appliedMap.layers[tileLayer.id];
    if (appliedTileLayer.type !== 'tile' || !appliedTileLayer.chunks) throw new Error('Expected imported tile layer');
    expect(readTileAt(appliedTileLayer.chunks, 0, 0)).toBe(existingRaw);
    const appliedObjectLayer = appliedMap.layers[objectLayer.id];
    if (appliedObjectLayer.type !== 'object') throw new Error('Expected imported object layer');
    expect(appliedObjectLayer.objects?.[0]).toMatchObject({ type: 'tile', gid: existingRaw });
    expect(applied.tileStamps[0]?.cells[0]?.gid).toBe(existingRaw);
    expect(decodeTiledGid(applied.tileStamps[1]!.cells[0]!.gid)).toEqual({ gid: 9, hFlip: false, vFlip: false, diagonal: true });
  });

  it('refuses unresolved destination cells, tile objects, or retained stamps that a new attachment would resolve', () => {
    for (const family of ['cell', 'object', 'stamp'] as const) {
      const target = exactUnattachedCollectionDestination();
      const unresolvedRaw = encodeTiledGid(9, { hFlip: true, diagonal: true });
      expect(resolveTilesetForGid(target.document, target.map, 9)).toBeUndefined();
      if (family === 'cell') {
        const layer = target.map.layers[target.map.layerIds[0]!];
        if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
        writeTiles(layer.chunks, [{ x: 0, y: 0, gid: unresolvedRaw }]);
      } else if (family === 'object') {
        addTileObject(target.map, unresolvedRaw);
      } else {
        target.document.tileStamps = [{
          id: 'unresolved-retained', name: 'Unresolved retained stamp', width: 1, height: 1, anchorX: 0, anchorY: 0,
          cells: [{ x: 0, y: 0, gid: unresolvedRaw }],
        }];
      }
      const before = structuredClone(target.document);
      expect(() => prepareStampLibraryImport(target.document, target.bundle, 'append', { map: target.map, makeId: deterministicIds() }))
        .toThrow(new RegExp(`${family === 'cell' ? 'cell' : family === 'object' ? 'tile object' : 'retained tile stamp'}.*base GID 9 from unresolved to tileset`));
      expect(target.document).toEqual(before);
    }
  });

  it('rejects a complete bundled sprite and tileset pair that no nonzero stamp cell reaches', () => {
    const source = atlasKitProject();
    const bundle = JSON.parse(serializePortableTileStampKit(source.document, source.map)) as PortableTileStampKitBundle;
    const atlas = bundle.assets.find((asset): asset is PixelSprite => asset.type === 'sprite')!;
    const tileset = bundle.assets.find((asset): asset is PixelTileset => asset.type === 'tileset')!;
    const extraSprite = { ...structuredClone(atlas), id: 'unreachable-sprite', name: 'Unreachable sprite' };
    const extraTileset = { ...structuredClone(tileset), id: 'unreachable-tileset', name: 'Unreachable tileset', spriteAssetId: extraSprite.id, firstGid: 100 };
    bundle.assets.push(extraSprite, extraTileset);
    bundle.tilesetIds.push(extraTileset.id);
    expect(() => parseStampLibraryJson(`${JSON.stringify(bundle)}\n`)).toThrow(/Unreachable tileset.*not reached by any nonzero stamp cell/);
  });

  it('copies sparse image collections into a sparse-infinite orthogonal map without densifying IDs or collapsing their per-tile sprites', () => {
    const source = collectionKitProject();
    source.map.infinite = true;
    const parsed = parseStampLibraryJson(serializePortableTileStampKit(source.document, source.map));
    expect(parsed).toMatchObject({ version: 2, assets: [{ id: source.small.id }, { id: source.large.id }, { id: source.tileset.id }] });
    const target = destinationWithAtlas(9);
    target.map.infinite = true;
    const plan = prepareStampLibraryImport(target.document, parsed, 'replace', { map: target.map, makeId: deterministicIds() });
    expect(plan.portable).toMatchObject({ copiedSpriteCount: 2, copiedTilesetCount: 1, rebasedCellCount: 2 });
    const result = commit(target.document, plan.operations).document;
    if (result.kind !== 'pixel') throw new Error('Expected pixel document');
    const copied = Object.values(result.pixelAssets).find((asset): asset is PixelTileset => asset.type === 'tileset' && asset.name === source.tileset.name);
    if (!copied) throw new Error('Expected copied collection');
    expect(Object.keys(copied.tiles)).toEqual(['0', '3']);
    expect(copied.columns).toBe(3);
    expect(copied.rows).toBe(0);
    expect(tilesetLocalIdSpan(copied)).toBe(4);
    expect(copied.tiles[0]?.imageAssetId).not.toBe(source.small.id);
    expect(copied.tiles[3]?.imageAssetId).not.toBe(source.large.id);
    expect((result.pixelAssets[copied.tiles[0]!.imageAssetId!] as PixelSprite).width).toBe(7);
    expect((result.pixelAssets[copied.tiles[3]!.imageAssetId!] as PixelSprite).width).toBe(11);
    const stamp = result.tileStamps[0]!;
    expect(decodeTiledGid(stamp.cells[0]!.gid).gid).toBe(copied.firstGid);
    expect(decodeTiledGid(stamp.cells[1]!.gid)).toMatchObject({ gid: copied.firstGid + 3, diagonal: true });
  });

  it('fails closed for palette exhaustion, unsupported collection maps, shadowed gaps, malformed graphs, and exhausted ranges', () => {
    const atlas = atlasKitProject();
    const atlasBundle = parseStampLibraryJson(serializePortableTileStampKit(atlas.document, atlas.map));
    const full = destinationWithAtlas();
    while (full.document.palette.length < 256) {
      const index = full.document.palette.length;
      full.document.palette.push({ id: `full-${index}`, name: `Full ${index}`, color: `#${index.toString(16).padStart(6, '0')}` });
    }
    expect(() => prepareStampLibraryImport(full.document, atlasBundle, 'append', { map: full.map, makeId: deterministicIds() })).toThrow(/palette is full/);

    const collection = collectionKitProject();
    const collectionBundle = parseStampLibraryJson(serializePortableTileStampKit(collection.document, collection.map));
    const isometric = destinationWithAtlas();
    isometric.map.orientation = 'isometric';
    expect(() => prepareStampLibraryImport(isometric.document, collectionBundle, 'append', { map: isometric.map, makeId: deterministicIds() })).toThrow(/orthogonal destination/);

    const shadowed = structuredClone(collectionBundle) as PortableTileStampKitBundle;
    const collectionTileset = shadowed.assets.find((asset): asset is PixelTileset => asset.type === 'tileset')!;
    const shadow = structuredClone(collectionTileset);
    shadow.id = 'shadow-short';
    shadow.name = 'Shadow short';
    shadow.firstGid = 43;
    shadow.tiles = { 0: { ...structuredClone(shadow.tiles[0]!), id: 0, animation: [] } };
    shadowed.assets.push(shadow);
    shadowed.tilesetIds.push(shadow.id);
    const shadowTarget = destinationWithAtlas();
    expect(() => prepareStampLibraryImport(shadowTarget.document, shadowed, 'append', { map: shadowTarget.map })).toThrow(/missing or shadowed/);

    const missingSource = structuredClone(collectionBundle) as PortableTileStampKitBundle;
    missingSource.assets = missingSource.assets.filter((asset) => asset.id !== collection.small.id);
    const missingTarget = destinationWithAtlas();
    expect(() => prepareStampLibraryImport(missingTarget.document, missingSource, 'append', { map: missingTarget.map })).toThrow(/missing bundled sprite/);

    const exhausted = destinationWithAtlas();
    exhausted.tileset.firstGid = TILED_GID_MASK;
    expect(() => prepareStampLibraryImport(exhausted.document, atlasBundle, 'append', { map: exhausted.map, makeId: deterministicIds() })).toThrow(/leaves no room/);

    const partialRoom = destinationWithAtlas();
    partialRoom.tileset.firstGid = TILED_GID_MASK - 1;
    const localZeroOnly = structuredClone(atlasBundle) as PortableTileStampKitBundle;
    localZeroOnly.stamps = [{
      id: 'local-zero-only', name: 'Only local zero', width: 1, height: 1, anchorX: 0, anchorY: 0,
      cells: [{ x: 0, y: 0, gid: 17 }],
    }];
    const partialBefore = structuredClone(partialRoom.document);
    expect(() => prepareStampLibraryImport(partialRoom.document, localZeroOnly, 'append', { map: partialRoom.map, makeId: deterministicIds() }))
      .toThrow(/complete local-ID span inside the supported 28-bit GID range/);
    expect(partialRoom.document).toEqual(partialBefore);

    const oversized = emptyProject('Oversized source');
    const huge = createPixelSprite('Too many logical pixels', 2_049, 2_049);
    const hugeTileset = createPixelTileset('Huge atlas', huge.id, 16, 16, 1, 1);
    hugeTileset.firstGid = 1;
    oversized.map.tilesetIds = [hugeTileset.id];
    oversized.document.pixelAssets[huge.id] = huge;
    oversized.document.pixelAssets[hugeTileset.id] = hugeTileset;
    oversized.document.assetIds = [huge.id, hugeTileset.id, oversized.map.id];
    oversized.document.tileStamps = [{ id: 'huge', name: 'Huge', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: 1 }] }];
    expect(() => serializePortableTileStampKit(oversized.document, oversized.map)).toThrow(/4,194,304 logical and stored source pixels/);
  });
});
