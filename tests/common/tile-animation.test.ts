import { describe, expect, it } from 'vitest';
import { createPixelTileset } from '@aidraw/core';

import { moveTileAnimationFrame, tilesetTileSourceRect } from '../../src/common/tile-animation';

describe('tile animation authoring', () => {
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
});
