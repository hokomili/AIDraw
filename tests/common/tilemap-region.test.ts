import { describe, expect, it } from 'vitest';

import { orthogonalTileArtworkEnvelope } from '../../src/common/orthogonal-tile-artwork';
import { coveringRasterViewportRegion, createGridRasterRegionFilter, tilemapChunksIntersectingRegion, tilemapGridLineRange } from '../../src/common/tilemap-region';

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

  it('retains a chunk whose native artwork overhang reaches the region', () => {
    const overhanging = chunk('overhanging', 0, 1, 1, 1);
    const far = chunk('far', 0, 10, 1, 1);
    const region = { x: 0, y: 0, width: 1, height: 1 };
    const base = { orientation: 'orthogonal' as const, rows: 64, tileWidth: 4, tileHeight: 4 };
    expect(tilemapChunksIntersectingRegion([overhanging, far], base, region)).toEqual([]);
    expect(tilemapChunksIntersectingRegion([overhanging, far], {
      ...base,
      orthogonalArtworkEnvelope: orthogonalTileArtworkEnvelope(4, 4, [{ width: 4, height: 12 }]),
    }, region)).toEqual([overhanging]);
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
    expect(() => tilemapChunksIntersectingRegion(valid, { orientation: 'orthogonal', rows: 1, tileWidth: 16, tileHeight: 16, orthogonalArtworkEnvelope: { left: 0, top: 0, right: Number.NaN, bottom: 16 } }, { x: 0, y: 0, width: 1, height: 1 })).toThrow(/finite bounds/);
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

  it('clips orthogonal overlay cells and compact runs without expanding their payload', () => {
    const filter = createGridRasterRegionFilter(
      { orientation: 'orthogonal', rows: 100, tileWidth: 16, tileHeight: 8 },
      { x: 0, y: 0, width: 16, height: 8 },
    );
    expect(filter.cellIntersects(0, 0)).toBe(true);
    expect(filter.cellIntersects(-1, 0)).toBe(false);
    expect(filter.cellIntersects(0, 1)).toBe(false);
    expect(filter.runOffsets(-10, 0, 30)).toEqual({ start: 9, end: 12 });
    expect(filter.runOffsets(-10, 20, 30)).toEqual({ start: 0, end: 0 });

    const padded = createGridRasterRegionFilter(
      { orientation: 'orthogonal', rows: 1, tileWidth: 16, tileHeight: 16 },
      { x: 16, y: 0, width: 1, height: 1 },
      1,
    );
    expect(padded.cellIntersects(0, 0)).toBe(true);
  });

  it('conservatively bounds isometric horizontal runs to projected candidates', () => {
    const filter = createGridRasterRegionFilter(
      { orientation: 'isometric', rows: 64, tileWidth: 16, tileHeight: 8 },
      { x: 496, y: -4, width: 24, height: 16 },
    );
    const run = { x: -100, y: 0, length: 200 };
    const range = filter.runOffsets(run.x, run.y, run.length);
    const intersecting = Array.from({ length: run.length }, (_, offset) => offset)
      .filter((offset) => filter.cellIntersects(run.x + offset, run.y));
    expect(intersecting.length).toBeGreaterThan(0);
    expect(range.end - range.start).toBeLessThan(run.length / 4);
    expect(intersecting.every((offset) => offset >= range.start && offset < range.end)).toBe(true);

    for (const geometry of [
      { orientation: 'isometric' as const, rows: 1, tileWidth: 4, tileHeight: 2 },
      { orientation: 'isometric' as const, rows: 3, tileWidth: 7, tileHeight: 5 },
      { orientation: 'isometric' as const, rows: 64, tileWidth: 16, tileHeight: 8 },
    ]) for (const region of [
      { x: -9, y: -7, width: 3, height: 5 },
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 31, y: 17, width: 19, height: 11 },
    ]) for (let y = -8; y <= 8; y += 1) {
      const candidateFilter = createGridRasterRegionFilter(geometry, region);
      const candidateRun = { x: -20, y, length: 40 };
      const candidateRange = candidateFilter.runOffsets(candidateRun.x, candidateRun.y, candidateRun.length);
      for (let offset = 0; offset < candidateRun.length; offset += 1) {
        if (candidateFilter.cellIntersects(candidateRun.x + offset, y)) {
          expect(offset).toBeGreaterThanOrEqual(candidateRange.start);
          expect(offset).toBeLessThan(candidateRange.end);
        }
      }
    }
  });

  it('fails closed for invalid overlay filters or records', () => {
    const geometry = { orientation: 'orthogonal' as const, rows: 1, tileWidth: 1, tileHeight: 1 };
    expect(() => createGridRasterRegionFilter(geometry, { x: 0.5, y: 0, width: 1, height: 1 })).toThrow(/safe-integer/);
    expect(() => createGridRasterRegionFilter(geometry, { x: Number.MIN_SAFE_INTEGER, y: 0, width: 1, height: 1 }, 1)).toThrow(/safe coordinates/);
    const filter = createGridRasterRegionFilter(geometry, { x: 0, y: 0, width: 1, height: 1 });
    expect(filter.cellIntersects(Number.NaN, 0)).toBe(false);
    expect(filter.runOffsets(0, 0, 0)).toEqual({ start: 0, end: 0 });
    expect(filter.runOffsets(Number.MAX_SAFE_INTEGER, 0, 2)).toEqual({ start: 0, end: 0 });
  });
});
