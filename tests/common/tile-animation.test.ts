import { describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTileset } from '@aidraw/core';

import { moveTileAnimationFrame, resolveTilesetTileSource, tileAnimationFrameAt, tilesetTileSourceRect } from '../../src/common/tile-animation';

describe('tile animation authoring', () => {
  it('samples exact frame boundaries and loops without unsafe duration summation', () => {
    const animation = [
      { tileId: 3, durationMs: 80 },
      { tileId: 7, durationMs: 120 },
    ];
    expect(tileAnimationFrameAt(animation, 0)).toEqual({ tileId: 3, frameIndex: 0, remainingMs: 80 });
    expect(tileAnimationFrameAt(animation, 79)).toEqual({ tileId: 3, frameIndex: 0, remainingMs: 1 });
    expect(tileAnimationFrameAt(animation, 80)).toEqual({ tileId: 7, frameIndex: 1, remainingMs: 120 });
    expect(tileAnimationFrameAt(animation, 199)).toEqual({ tileId: 7, frameIndex: 1, remainingMs: 1 });
    expect(tileAnimationFrameAt(animation, 200)).toEqual({ tileId: 3, frameIndex: 0, remainingMs: 80 });
    expect(tileAnimationFrameAt([], 0)).toBeUndefined();

    const maximum = Number.MAX_SAFE_INTEGER;
    expect(tileAnimationFrameAt([{ tileId: 1, durationMs: maximum }, { tileId: 2, durationMs: maximum }], maximum)).toEqual({ tileId: 2, frameIndex: 1, remainingMs: maximum });
  });

  it('rejects time or frame metadata that cannot produce a deterministic sample', () => {
    expect(() => tileAnimationFrameAt([{ tileId: 0, durationMs: 1 }], -1)).toThrow(/time/);
    expect(() => tileAnimationFrameAt([{ tileId: 0, durationMs: 1 }], 0.5)).toThrow(/time/);
    expect(() => tileAnimationFrameAt([{ tileId: -1, durationMs: 1 }], 0)).toThrow(/tile IDs/);
    expect(() => tileAnimationFrameAt([{ tileId: 0, durationMs: 0 }], 0)).toThrow(/durations/);
  });

  it('moves one frame without mutating the source or changing exact tile/duration pairs', () => {
    const source = [
      { tileId: 3, durationMs: 80 },
      { tileId: 1, durationMs: 120 },
      { tileId: 2, durationMs: 240 },
    ];
    expect(moveTileAnimationFrame(source, 0, 2)).toEqual([
      { tileId: 1, durationMs: 120 },
      { tileId: 2, durationMs: 240 },
      { tileId: 3, durationMs: 80 },
    ]);
    expect(moveTileAnimationFrame(source, 2, 0)).toEqual([
      { tileId: 2, durationMs: 240 },
      { tileId: 3, durationMs: 80 },
      { tileId: 1, durationMs: 120 },
    ]);
    expect(moveTileAnimationFrame(source, 1, 1)).toEqual(source);
    expect(moveTileAnimationFrame(source, 1, 1)).not.toBe(source);
    expect(source).toEqual([
      { tileId: 3, durationMs: 80 },
      { tileId: 1, durationMs: 120 },
      { tileId: 2, durationMs: 240 },
    ]);
  });

  it('rejects invalid move indices before changing metadata', () => {
    const source = [{ tileId: 0, durationMs: 100 }];
    expect(() => moveTileAnimationFrame(source, -1, 0)).toThrow(/source index/);
    expect(() => moveTileAnimationFrame(source, 0, 1)).toThrow(/destination index/);
    expect(source).toEqual([{ tileId: 0, durationMs: 100 }]);
  });

  it('resolves authored and implicit tile source rectangles with margin and spacing', () => {
    const tileset = createPixelTileset('Preview', 'sprite', 16, 8, 3, 2);
    tileset.margin = 2;
    tileset.spacing = 1;
    tileset.tiles[1] = { id: 1, sourceX: 99, sourceY: 77, probability: 1, animation: [], collisions: [], properties: {} };
    expect(tilesetTileSourceRect(tileset, 1)).toEqual({ x: 99, y: 77, width: 16, height: 8 });
    expect(tilesetTileSourceRect(tileset, 4)).toEqual({ x: 19, y: 11, width: 16, height: 8 });
    expect(() => tilesetTileSourceRect(tileset, 6)).toThrow(/outside the tileset slice/);
  });

  it('resolves each sparse image-collection tile to its own full-size sprite', () => {
    const document = createPixelDocument('project', 'Collection previews');
    const narrow = createPixelSprite('Narrow', 7, 13);
    const wide = createPixelSprite('Wide', 19, 5);
    const tileset = createPixelTileset('Collection', narrow.id, 7, 13, 1, 1);
    tileset.spriteAssetId = undefined; tileset.columns = 2; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: narrow.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: wide.id, probability: 1, animation: [], collisions: [], properties: {} },
    };
    document.assetIds = [narrow.id, wide.id, tileset.id]; document.pixelAssets = { [narrow.id]: narrow, [wide.id]: wide, [tileset.id]: tileset };
    expect(resolveTilesetTileSource(document, tileset, 0)).toEqual({ sprite: narrow, rect: { x: 0, y: 0, width: 7, height: 13 } });
    expect(resolveTilesetTileSource(document, tileset, 3)).toEqual({ sprite: wide, rect: { x: 0, y: 0, width: 19, height: 5 } });
    expect(() => resolveTilesetTileSource(document, tileset, 2)).toThrow(/missing its sprite source/);
  });
});
