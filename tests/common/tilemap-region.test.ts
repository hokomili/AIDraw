import { describe, expect, it } from 'vitest';

import { tilemapChunksIntersectingRegion } from '../../src/common/tilemap-region';

function chunk(id: string, x: number, y: number, width = 32, height = 32) {
  return { id, x, y, width, height };
}

describe('tilemap region chunk filtering', () => {
  it('keeps only orthogonal chunks whose transformed-cell envelope can intersect', () => {
    const chunks = [chunk('left-edge-only', -32, 0), chunk('target', 0, 0), chunk('far-right', 32, 0)];
    expect(tilemapChunksIntersectingRegion(chunks, { orientation: 'orthogonal', rows: 64, tileWidth: 16, tileHeight: 8 }, { x: 0, y: 0, width: 16, height: 8 }))
      .toEqual([chunks[1]]);

    const rotatedRectangular = chunk('diagonal-padding', 0, 0, 1, 1);
    expect(tilemapChunksIntersectingRegion([rotatedRectangular], { orientation: 'orthogonal', rows: 1, tileWidth: 4, tileHeight: 16 }, { x: 8, y: 0, width: 1, height: 1 }))
      .toEqual([rotatedRectangular]);
  });

  it('filters isometric chunks conservatively without changing retained order', () => {
    const chunks = [chunk('far-right', 64, 0), chunk('target-second', 0, 0), chunk('target-first', -32, -32), chunk('far-bottom', 64, 64)];
    const region = { x: 496, y: -4, width: 24, height: 16 };
    expect(tilemapChunksIntersectingRegion(chunks, { orientation: 'isometric', rows: 64, tileWidth: 16, tileHeight: 8 }, region).map(({ id }) => id))
      .toEqual(['target-second', 'target-first']);
  });

  it('fails closed on unsafe region, projection, or chunk geometry', () => {
    const valid = [chunk('valid', 0, 0)];
    expect(() => tilemapChunksIntersectingRegion(valid, { orientation: 'orthogonal', rows: 0, tileWidth: 16, tileHeight: 16 }, { x: 0, y: 0, width: 1, height: 1 })).toThrow(/row count/);
    expect(() => tilemapChunksIntersectingRegion(valid, { orientation: 'orthogonal', rows: 1, tileWidth: 16, tileHeight: 16 }, { x: 0.5, y: 0, width: 1, height: 1 })).toThrow(/safe-integer/);
    expect(() => tilemapChunksIntersectingRegion([chunk('invalid', 0, 0, 0, 32)], { orientation: 'orthogonal', rows: 1, tileWidth: 16, tileHeight: 16 }, { x: 0, y: 0, width: 1, height: 1 })).toThrow(/chunk geometry/);
  });
});
