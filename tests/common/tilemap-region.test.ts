import { describe, expect, it } from 'vitest';

import { coveringRasterViewportRegion, tilemapChunksIntersectingRegion, tilemapGridLineRange } from '../../src/common/tilemap-region';

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

  it('outward-rounds a fractional translated viewport in canonical map pixels', () => {
    expect(coveringRasterViewportRegion({
      viewportWidth: 800.25,
      viewportHeight: 600.5,
      viewOffsetX: -100.4,
      viewOffsetY: 50.2,
      layerOffsetX: 3.25,
      layerOffsetY: -2.75,
      projectionScale: 2.5,
    })).toEqual({ x: 38, y: -19, width: 321, height: 241 });
  });

  it('fails closed on invalid viewport transforms', () => {
    const valid = { viewportWidth: 800, viewportHeight: 600, viewOffsetX: 0, viewOffsetY: 0, layerOffsetX: 0, layerOffsetY: 0, projectionScale: 2 };
    expect(() => coveringRasterViewportRegion({ ...valid, projectionScale: 0 })).toThrow(/positive finite/);
    expect(() => coveringRasterViewportRegion({ ...valid, layerOffsetX: Number.NaN })).toThrow(/finite offsets/);
    expect(() => coveringRasterViewportRegion({ ...valid, viewOffsetX: Number.MAX_VALUE })).toThrow(/safe canonical/);
  });

  it('bounds orthogonal grid lines to the viewport with one conservative neighbor', () => {
    expect(tilemapGridLineRange({ x: 31, y: -1, width: 34, height: 18 }, { columns: 100, rows: 50, tileWidth: 16, tileHeight: 8 }))
      .toEqual({ columnStart: 0, columnEnd: 6, rowStart: 0, rowEnd: 4 });
    expect(tilemapGridLineRange({ x: 2_000, y: 2_000, width: 1, height: 1 }, { columns: 10, rows: 10, tileWidth: 16, tileHeight: 16 }))
      .toEqual({ columnStart: 124, columnEnd: 10, rowStart: 124, rowEnd: 10 });
  });
});
