import { describe, expect, it } from 'vitest';
import {
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  decodeTiledGid,
  type PixelDocument,
  type TileMapObject,
} from '@aidraw/core';
import {
  deleteTileObjectProperty,
  editTileObject,
  planTileObjectCreation,
  requireTileObjectPlacementTileset,
  requireWritableTileObject,
  requireWritableTileObjectLayer,
  setTileObjectProperty,
  TILE_OBJECT_ALIGNMENT_OPTIONS,
} from '../../src/common/tile-object-authoring';

function fixture(): { document: PixelDocument; mapId: string; layerId: string; tilesetId: string } {
  const document = createPixelDocument('project', 'Tile-object authoring');
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite.type !== 'sprite') throw new Error('Expected sprite');
  const tileset = createPixelTileset('Actors', sprite.id, 24, 32, 3, 2); tileset.firstGid = 17;
  const map = createPixelTilemap('Scene'); map.tilesetIds = [tileset.id];
  const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [];
  document.pixelAssets[tileset.id] = tileset; document.pixelAssets[map.id] = map; document.assetIds.push(tileset.id, map.id); document.activeAssetId = map.id;
  return { document, mapId: map.id, layerId: layer.id, tilesetId: tileset.id };
}

function tileObject(): TileMapObject {
  return { id: 'tile-object', type: 'tile', gid: 0xa000_0012, x: 4, y: 8, width: 24, height: 32, rotation: 0, name: '', className: '', properties: {} };
}

describe('tile-object human authoring', () => {
  it('creates one exact transformed tile object with native size on the admitted object layer', () => {
    const source = fixture();
    const plan = planTileObjectCreation(source.document, {
      mapId: source.mapId, layerId: source.layerId, tilesetId: source.tilesetId, tileId: 2,
      transforms: { hFlip: true, vFlip: false, diagonal: true }, point: { x: 37.5, y: -12.25 }, objectId: 'new-tile-object',
    });
    expect(decodeTiledGid(plan.object.gid)).toEqual({ gid: 19, hFlip: true, vFlip: false, diagonal: true });
    expect(plan.object).toMatchObject({ id: 'new-tile-object', type: 'tile', x: 37.5, y: -12.25, width: 24, height: 32, rotation: 0, name: '', className: '', properties: {} });
    expect(plan.expectedRevision).toBe(0);
    expect(plan.expectedDocumentRevision).toBeUndefined();
    expect(plan.expectedSpriteDependencies).toBeUndefined();
    expect(plan.asset.layers[source.layerId].objects).toEqual([plan.object]);
    expect((source.document.pixelAssets[source.mapId] as typeof plan.asset).layers[source.layerId].objects).toEqual([]);
  });

  it('creates one exact sparse image-collection tile object with per-source dimensions and dependency guards', () => {
    const source = fixture();
    const map = source.document.pixelAssets[source.mapId]; const atlas = source.document.pixelAssets[source.tilesetId];
    if (map.type !== 'tilemap' || atlas.type !== 'tileset') throw new Error('Expected map and tileset');
    const narrow = createPixelSprite('Narrow exact tile', 7, 13); const wide = createPixelSprite('Wide exact tile', 19, 5);
    const collection = createPixelTileset('Sparse collection', narrow.id, 19, 13, 1, 1);
    collection.spriteAssetId = undefined; collection.firstGid = 41; collection.columns = 2; collection.rows = 0; collection.wangSets = [];
    collection.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: narrow.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: wide.id, probability: 1, animation: [{ tileId: 0, durationMs: 90 }], collisions: [], properties: {} },
    };
    source.document.pixelAssets[narrow.id] = narrow; source.document.pixelAssets[wide.id] = wide; source.document.pixelAssets[collection.id] = collection;
    source.document.assetIds.push(narrow.id, wide.id, collection.id); map.tilesetIds = [collection.id];
    const plan = planTileObjectCreation(source.document, {
      mapId: map.id, layerId: source.layerId, tilesetId: collection.id, tileId: 3,
      transforms: { hFlip: true, vFlip: false, diagonal: true }, point: { x: 12, y: 18 }, objectId: 'collection-object',
    });
    expect(decodeTiledGid(plan.object.gid)).toEqual({ gid: 44, hFlip: true, vFlip: false, diagonal: true });
    expect(plan.object).toMatchObject({ width: 19, height: 5 });
    expect(plan.expectedDocumentRevision).toBe(source.document.revision);
    expect(plan.expectedSpriteDependencies).toEqual([
      { spriteId: narrow.id, expectedRevision: narrow.revision, width: 7, height: 13 },
      { spriteId: wide.id, expectedRevision: wide.revision, width: 19, height: 5 },
    ]);
    const request = { mapId: map.id, layerId: source.layerId, tilesetId: collection.id, transforms: { hFlip: false, vFlip: false, diagonal: false }, point: { x: 0, y: 0 } };
    const shortShadow = createPixelTileset('Short later shadow', narrow.id, 7, 13, 1, 1); shortShadow.firstGid = 43; source.document.pixelAssets[shortShadow.id] = shortShadow; map.tilesetIds.push(shortShadow.id);
    expect(() => planTileObjectCreation(source.document, { ...request, tileId: 3, objectId: 'shadowed' })).toThrow('does not resolve exactly');
    map.tilesetIds = [collection.id];
    expect(() => planTileObjectCreation(source.document, { ...request, tileId: 2, objectId: 'gap' })).toThrow('sparse gap');
    map.orientation = 'isometric';
    expect(planTileObjectCreation(source.document, { ...request, tileId: 0, objectId: 'isometric' }).object).toMatchObject({ gid: 41, width: 7, height: 13 });
    map.infinite = true;
    expect(planTileObjectCreation(source.document, { ...request, tileId: 3, point: { x: -37, y: 91 }, objectId: 'sparse-infinite' }).object).toMatchObject({
      gid: 44,
      x: -37,
      y: 91,
      width: 19,
      height: 5,
    });
    map.orientation = 'orthogonal';
    delete source.document.pixelAssets[wide.id];
    expect(() => planTileObjectCreation(source.document, { ...request, tileId: 3, objectId: 'missing' })).toThrow('missing its sprite source');
  });

  it('fails closed for the wrong layer, locked ancestry, stale attachment, tile range, permission, or ambiguous GID resolution', () => {
    const source = fixture(); const map = source.document.pixelAssets[source.mapId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    const request = { mapId: source.mapId, layerId: source.layerId, tilesetId: source.tilesetId, tileId: 1, transforms: { hFlip: false, vFlip: false, diagonal: false }, point: { x: 0, y: 0 }, objectId: 'candidate' };
    map.layers[source.layerId].type = 'tile'; map.layers[source.layerId].chunks = {};
    expect(() => planTileObjectCreation(source.document, request)).toThrow('is not an object layer');
    map.layers[source.layerId].type = 'object'; delete map.layers[source.layerId].chunks; map.layers[source.layerId].objects = []; map.layers[source.layerId].locked = true;
    expect(() => planTileObjectCreation(source.document, request)).toThrow('is locked');
    map.layers[source.layerId].locked = false; map.tilesetIds = [];
    expect(() => planTileObjectCreation(source.document, request)).toThrow('is not attached');
    map.tilesetIds = [source.tilesetId];
    expect(() => planTileObjectCreation(source.document, { ...request, tileId: 6 })).toThrow('from 0 to 5');
    const tileset = source.document.pixelAssets[source.tilesetId]; if (tileset.type !== 'tileset') throw new Error('Expected tileset'); tileset.transformations = { hFlip: false, vFlip: false, rotate: false };
    expect(() => planTileObjectCreation(source.document, { ...request, transforms: { hFlip: true, vFlip: false, diagonal: false } })).toThrow('not permitted');
    tileset.transformations = { hFlip: true, vFlip: true, rotate: true };
    if (!tileset.spriteAssetId) throw new Error('Expected atlas tileset');
    const overlap = createPixelTileset('Overlap', tileset.spriteAssetId, 24, 32, 1, 1); overlap.firstGid = 18; source.document.pixelAssets[overlap.id] = overlap; map.tilesetIds.push(overlap.id);
    expect(() => planTileObjectCreation(source.document, request)).toThrow('covered by 2 attached tileset ranges');
    expect(() => planTileObjectCreation(source.document, { ...request, tilesetId: overlap.id, tileId: 0 })).toThrow('covered by 2 attached tileset ranges');
    map.tilesetIds.reverse();
    expect(() => planTileObjectCreation(source.document, request)).toThrow('covered by 2 attached tileset ranges');
    expect(() => planTileObjectCreation(source.document, { ...request, tilesetId: overlap.id, tileId: 0 })).toThrow('covered by 2 attached tileset ranges');
    overlap.firstGid = tileset.firstGid; overlap.columns = 2;
    expect(() => planTileObjectCreation(source.document, request)).toThrow('covered by 2 attached tileset ranges');
    expect(() => planTileObjectCreation(source.document, { ...request, tilesetId: overlap.id, tileId: 1 })).toThrow('covered by 2 attached tileset ranges');
    expect(map.layers[source.layerId].objects).toEqual([]);
  });

  it('binds placement admission to the exact attached tileset kind and revision observed by the renderer', () => {
    const source = fixture(); const map = source.document.pixelAssets[source.mapId]; const tileset = source.document.pixelAssets[source.tilesetId];
    if (map.type !== 'tilemap' || tileset.type !== 'tileset') throw new Error('Expected tilemap and tileset');
    expect(requireTileObjectPlacementTileset(source.document, map, tileset.id, tileset.revision)).toBe(tileset);
    tileset.revision += 1;
    expect(() => requireTileObjectPlacementTileset(source.document, map, tileset.id, tileset.revision - 1)).toThrow('changed from revision');
    tileset.revision -= 1; map.tilesetIds = [];
    expect(() => requireTileObjectPlacementTileset(source.document, map, tileset.id, tileset.revision)).toThrow('detached');
    map.tilesetIds = [tileset.id]; delete source.document.pixelAssets[tileset.id];
    expect(() => requireTileObjectPlacementTileset(source.document, map, tileset.id, tileset.revision)).toThrow('no longer exists');
    const wrongKind = createPixelTilemap('Wrong kind'); source.document.pixelAssets[tileset.id] = { ...wrongKind, id: tileset.id };
    expect(() => requireTileObjectPlacementTileset(source.document, map, tileset.id, tileset.revision)).toThrow('is not a tileset');
  });

  it('requires visible unlocked group ancestry without silently choosing another layer', () => {
    const source = fixture(); const map = source.document.pixelAssets[source.mapId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    const layer = map.layers[source.layerId]; const parent = { ...layer, id: 'group', name: 'Locked group', type: 'group' as const, childIds: [layer.id], objects: undefined };
    map.layers[parent.id] = parent; map.layerIds = [parent.id]; layer.parentId = parent.id; parent.locked = true;
    expect(() => requireWritableTileObjectLayer(map, layer.id)).toThrow('Locked group');
    layer.objects = [tileObject()];
    expect(() => requireWritableTileObject(map, layer.id, 'tile-object')).toThrow('Locked group');
    parent.locked = false; parent.visible = false;
    expect(() => requireWritableTileObjectLayer(map, layer.id)).toThrow('hidden');
    expect(() => requireWritableTileObject(map, layer.id, 'tile-object')).toThrow('hidden');
  });

  it('edits admitted fields and typed properties while preserving tile identity exactly', () => {
    const object = tileObject();
    const edited = editTileObject(object, { ...object, x: -0, y: 9.5, width: 48, height: 64, rotation: -45, name: 'Gate', className: 'portal', properties: { target: 'north', cost: 3, open: true } });
    expect(edited).toEqual({ ...object, x: 0, y: 9.5, width: 48, height: 64, rotation: -45, name: 'Gate', className: 'portal', properties: { target: 'north', cost: 3, open: true } });
    expect(edited.gid).toBe(object.gid); expect(edited.id).toBe(object.id); expect(edited.type).toBe('tile');
    const numbered = setTileObjectProperty(edited, 'weight', 'number', '2.5');
    const boolean = setTileObjectProperty(numbered, 'solid', 'boolean', 'false');
    expect(deleteTileObjectProperty(boolean, 'target').properties).toEqual({ cost: 3, open: true, weight: 2.5, solid: false });
    expect(() => editTileObject(object, { ...object, width: 0.5 })).toThrow('from 1 through');
    expect(() => setTileObjectProperty(object, 'bad', 'number', 'NaN')).toThrow('finite number');
  });

  it('preserves untouched canonical imported property keys and strings while bounding newly entered values', () => {
    const object = tileObject();
    const longKey = 'k'.repeat(201); const longValue = 'v'.repeat(16_385);
    object.properties = JSON.parse(`{"__proto__":"sentinel","  spaced  ":"old","":"retained","${longKey}":"${longValue}"}`) as TileMapObject['properties'];
    const edited = editTileObject(object, { ...object, x: 5 });
    expect(JSON.stringify(edited.properties)).toBe(JSON.stringify(object.properties));
    expect(Object.hasOwn(edited.properties, '__proto__')).toBe(true);
    expect(edited.properties.__proto__).toBe('sentinel');
    expect(Object.getPrototypeOf(edited.properties)).toBe(Object.prototype);
    const whitespaceEdit = setTileObjectProperty(edited, '  spaced  ', 'string', 'new');
    expect(whitespaceEdit.properties['  spaced  ']).toBe('new');
    expect(Object.hasOwn(whitespaceEdit.properties, 'spaced')).toBe(false);
    expect(whitespaceEdit.properties.__proto__).toBe('sentinel');
    expect(setTileObjectProperty(edited, longKey, 'string', longValue).properties[longKey]).toBe(longValue);
    expect(() => setTileObjectProperty(object, 'n'.repeat(201), 'string', 'value')).toThrow('1–200');
    expect(() => setTileObjectProperty(object, 'new', 'string', 'v'.repeat(16_385))).toThrow('16,384');
  });

  it('publishes the complete strict Tiled alignment choice set with an honest orientation-dependent default', () => {
    expect(TILE_OBJECT_ALIGNMENT_OPTIONS.map((option) => option.value)).toEqual(['unspecified', 'topleft', 'top', 'topright', 'left', 'center', 'right', 'bottomleft', 'bottom', 'bottomright']);
    expect(TILE_OBJECT_ALIGNMENT_OPTIONS[0].label).toContain('orthogonal bottom-left · isometric bottom');
  });
});
