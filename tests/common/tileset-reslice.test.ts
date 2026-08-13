import { CanvasOperationSchema, createPixelTileset, type PixelTileset, type TileDefinition } from '@aidraw/core';
import { describe, expect, it } from 'vitest';

import { MAX_TILESET_SLICE_TILES, planTilesetReslice } from '../../src/common/tileset-reslice';

function populatedTileset(): PixelTileset {
  const tileset = createPixelTileset('Reslice fixture', 'sprite-source', 2, 2, 3, 2);
  for (let id = 0; id < 6; id += 1) {
    tileset.tiles[id] = {
      id,
      sourceX: id % 3 * 2,
      sourceY: Math.floor(id / 3) * 2,
      probability: 1,
      animation: [],
      collisions: [],
      properties: {},
    };
  }
  return tileset;
}

function metadata(tile: TileDefinition, marker: string): void {
  tile.probability = 0.5;
  tile.collisions = [{ id: `collision-${marker}`, type: 'rectangle', x: 0, y: 0, width: 1, height: 1, properties: {} }];
  tile.properties = { marker };
}

describe('tileset re-slicing', () => {
  it('keeps surviving tile IDs while dropping every invalid animation and Wang reference explicitly', () => {
    const source = populatedTileset();
    metadata(source.tiles[2], 'kept');
    source.tiles[2].animation = [{ tileId: 5, durationMs: 90 }];
    source.tiles[5].properties = { marker: 'dropped' };
    source.wangSets = [{
      id: 'terrain', name: 'Terrain', type: 'mixed',
      colors: [{ id: 1, name: 'Grass', color: '#44aa55', tileId: 5, probability: 1 }],
      tiles: [
        { tileId: 2, wangId: [1, 1, 1, 1, 1, 1, 1, 1] },
        { tileId: 5, wangId: [1, 1, 1, 1, 1, 1, 1, 1] },
      ],
    }];
    const before = structuredClone(source);

    const plan = planTilesetReslice(source, { width: 6, height: 4 }, { tileWidth: 3, tileHeight: 2, margin: 0, spacing: 0 }, 'tile-id');

    expect(plan.tileset).toMatchObject({ tileWidth: 3, tileHeight: 2, columns: 2, rows: 2 });
    expect(plan.tileset.tiles[2]).toMatchObject({ id: 2, sourceX: 0, sourceY: 2, probability: 0.5, animation: [], properties: { marker: 'kept' } });
    expect(plan.tileset.wangSets[0]).toMatchObject({ colors: [], tiles: [] });
    expect(plan.impact).toEqual({
      metadataTiles: 2,
      preservedMetadataTiles: 1,
      reframedMetadataTiles: 1,
      remappedMetadataTileIds: 0,
      droppedMetadataTiles: 1,
      droppedAnimationFrames: 1,
      droppedCollisionShapes: 0,
      droppedCustomProperties: 1,
      droppedWangColors: 1,
      droppedWangTiles: 2,
    });
    expect(() => CanvasOperationSchema.parse({ kind: 'pixel.asset.replace', asset: plan.tileset, expectedRevision: source.revision })).not.toThrow();
    expect(source).toEqual(before);
  });

  it('follows matching source origins and remaps internal metadata references to the new tile IDs', () => {
    const source = populatedTileset();
    metadata(source.tiles[3], 'follow-source');
    source.tiles[3].animation = [{ tileId: 3, durationMs: 120 }];
    source.wangSets = [{
      id: 'terrain', name: 'Terrain', type: 'edge',
      colors: [{ id: 1, name: 'Grass', color: '#44aa55', tileId: 3, probability: 1 }],
      tiles: [{ tileId: 3, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }],
    }];

    const plan = planTilesetReslice(source, { width: 6, height: 4 }, { tileWidth: 3, tileHeight: 2, margin: 0, spacing: 0 }, 'source-position');

    expect(plan.mapTileId(3)).toBe(2);
    expect(plan.tileset.tiles[2]).toMatchObject({ sourceX: 0, sourceY: 2, properties: { marker: 'follow-source' }, animation: [{ tileId: 2, durationMs: 120 }] });
    expect(plan.tileset.wangSets[0]).toMatchObject({ colors: [{ tileId: 2 }], tiles: [{ tileId: 2, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }] });
    expect(plan.impact).toEqual({
      metadataTiles: 1,
      preservedMetadataTiles: 1,
      reframedMetadataTiles: 1,
      remappedMetadataTileIds: 1,
      droppedMetadataTiles: 0,
      droppedAnimationFrames: 0,
      droppedCollisionShapes: 0,
      droppedCustomProperties: 0,
      droppedWangColors: 0,
      droppedWangTiles: 0,
    });
  });

  it('rejects invalid, oversized, or ambiguous plans before allocating a replacement tileset', () => {
    const source = populatedTileset();
    expect(() => planTilesetReslice(source, { width: 6, height: 4 }, { tileWidth: 7, tileHeight: 2, margin: 0, spacing: 0 }, 'tile-id')).toThrow(/do not fit/);
    expect(() => planTilesetReslice(source, { width: 6, height: 4 }, { tileWidth: 2.5, tileHeight: 2, margin: 0, spacing: 0 }, 'tile-id')).toThrow(/integer/);
    expect(() => planTilesetReslice(source, { width: 8_192, height: 8_192 }, { tileWidth: 1, tileHeight: 1, margin: 0, spacing: 0 }, 'tile-id')).toThrow(new RegExp(MAX_TILESET_SLICE_TILES.toLocaleString('en-US')));
    source.tiles[0].properties = { marker: 'first' };
    source.tiles[1].properties = { marker: 'second' };
    source.tiles[1].sourceX = 0;
    expect(() => planTilesetReslice(source, { width: 6, height: 4 }, { tileWidth: 2, tileHeight: 2, margin: 0, spacing: 0 }, 'source-position')).toThrow(/ambiguous/);
    expect(() => planTilesetReslice(source, { width: 6, height: 4 }, { tileWidth: 2, tileHeight: 2, margin: 0, spacing: 0 }, 'tile-id')).not.toThrow();
  });

  it('keeps a maximum-size blank slice sparse instead of materializing a million default definitions', () => {
    const source = createPixelTileset('Maximum sparse slice', 'sprite-source', 8, 8, 1_024, 1_024);
    const plan = planTilesetReslice(source, { width: 8_192, height: 8_192 }, { tileWidth: 8, tileHeight: 8, margin: 0, spacing: 0 }, 'source-position');
    expect(plan.tileset.columns * plan.tileset.rows).toBe(MAX_TILESET_SLICE_TILES);
    expect(plan.tileset.tiles).toEqual({});
    expect(plan.impact.metadataTiles).toBe(0);
  });
});
