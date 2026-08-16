import {
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  encodeTiledGid,
  writeTiles,
} from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import {
  planTiledExportReferences,
  planTiledMapExport,
} from '../../src/common/tiled-export-integrity';

function tileProject() {
  const document = createPixelDocument('project', 'Tiled integrity');
  document.assetIds = [];
  document.pixelAssets = {};
  const sprite = createPixelSprite('Terrain pixels', 2, 1);
  const tileset = createPixelTileset('Terrain', sprite.id, 1, 1, 2, 1);
  tileset.firstGid = 17;
  const map = createPixelTilemap('Map');
  map.tilesetIds = [tileset.id];
  document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map };
  document.assetIds = [sprite.id, tileset.id, map.id];
  document.activeAssetId = map.id;
  return { document, sprite, tileset, map };
}

function tileLayer(map: ReturnType<typeof createPixelTilemap>) {
  const layer = map.layers[map.layerIds[0]];
  if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
  return layer;
}

describe('Tiled export reference integrity', () => {
  it('requires every declared tileset and source sprite before artifact planning', () => {
    const { document, sprite, tileset, map } = tileProject();
    const plan = planTiledExportReferences(document, map);
    expect(plan.tilesets).toEqual([expect.objectContaining({ tileset, sprite, firstGid: 17, lastGid: 18 })]);

    map.tilesetIds = ['missing-tileset'];
    expect(() => planTiledExportReferences(document, map)).toThrow('references missing tileset missing-tileset');
    map.tilesetIds = [tileset.id, tileset.id];
    expect(() => planTiledExportReferences(document, map)).toThrow(`references tileset ${tileset.id} more than once`);
    map.tilesetIds = [tileset.id];
    delete document.pixelAssets[sprite.id];
    expect(() => planTiledExportReferences(document, map)).toThrow('tileset “Terrain” is missing its source sprite');
    expect(() => planTiledExportReferences(document, tileset)).toThrow('tileset “Terrain” is missing its source sprite');
  });

  it('rejects overlapping and out-of-range map GID ranges without renumbering', () => {
    const { document, sprite, tileset, map } = tileProject();
    const second = createPixelTileset('Overlay', sprite.id, 1, 1, 2, 1);
    second.firstGid = 18;
    document.pixelAssets[second.id] = second;
    map.tilesetIds.push(second.id);
    expect(() => planTiledExportReferences(document, map)).toThrow('“Terrain” and “Overlay” have overlapping GID ranges');

    second.firstGid = 0x0fff_fffe;
    expect(() => planTiledExportReferences(document, map)).not.toThrow();
    second.firstGid = 0x0fff_ffff;
    expect(() => planTiledExportReferences(document, map)).toThrow('“Overlay” exceeds the supported 28-bit GID range');
    expect(tileset.firstGid).toBe(17);
    expect(second.firstGid).toBe(0x0fff_ffff);
  });

  it('admits transformed resolved GIDs and reports the exact unresolved signed cell', () => {
    const { document, tileset, map } = tileProject();
    map.infinite = true;
    const layer = tileLayer(map);
    writeTiles(layer.chunks!, [
      { x: -33, y: -1, gid: encodeTiledGid(tileset.firstGid, { hFlip: true }) },
      { x: 32, y: 7, gid: tileset.firstGid + 1 },
    ]);
    expect(() => planTiledMapExport(document, map)).not.toThrow();
    writeTiles(layer.chunks!, [{ x: -31, y: -1, gid: 99 }]);
    expect(() => planTiledMapExport(document, map)).toThrow('layer “Ground” uses unresolved tile GID 99 at (-31, -1)');
  });

  it('validates the final finite plane and ignores stored cells the writer clips away', () => {
    const { document, tileset, map } = tileProject();
    map.width = 1;
    map.height = 1;
    const layer = tileLayer(map);
    writeTiles(layer.chunks!, [{ x: 0, y: 0, gid: tileset.firstGid }, { x: 4, y: 4, gid: 99 }]);
    expect(() => planTiledMapExport(document, map)).not.toThrow();
    writeTiles(layer.chunks!, [{ x: 0, y: 0, gid: 99 }]);
    expect(() => planTiledMapExport(document, map)).toThrow('layer “Ground” uses unresolved tile GID 99 at (0, 0)');
  });

  it('admits exact collection tile objects while refusing a sparse-gap object before export', () => {
    const { document, sprite, tileset, map } = tileProject();
    tileset.spriteAssetId = undefined; tileset.columns = 0; tileset.rows = 0; tileset.wangSets = [];
    tileset.tiles = { 3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: sprite.id, probability: 1, animation: [], collisions: [], properties: {} } };
    const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [{ id: 'exact', type: 'tile', gid: encodeTiledGid(20, { diagonal: true }), x: 2, y: 3, width: 2, height: 1, rotation: 0, name: '', className: '', properties: {} }];
    expect(() => planTiledMapExport(document, map)).not.toThrow();
    const exactObject = layer.objects[0]; if (exactObject.type !== 'tile') throw new Error('Expected tile object');
    layer.objects[0] = { ...exactObject, gid: 18 };
    expect(() => planTiledMapExport(document, map)).toThrow('missing sparse image-collection GID 18');
  });
});
