import { describe, expect, it } from 'vitest';
import { encodeTiledGid, type TileMapObject } from '@aidraw/core';
import { effectiveTileObjectAlignment, tileObjectArtworkContainsPoint, tileObjectArtworkIntersects, tileObjectArtworkPlacement, tileObjectFallbackColor } from '../../src/common/tile-object-artwork';

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function object(overrides: Partial<TileMapObject> = {}): TileMapObject {
  return { id: 'tile-object', type: 'tile', gid: 1, x: 100, y: 80, width: 20, height: 10, rotation: 0, name: 'Chest', className: 'loot', properties: {}, ...overrides };
}

describe('shared Tiled tile-object artwork geometry', () => {
  it('uses the documented orientation-specific unspecified anchors and screen-axis drawing offset', () => {
    expect(effectiveTileObjectAlignment('unspecified', 'orthogonal')).toBe('bottomleft');
    expect(effectiveTileObjectAlignment(undefined, 'isometric')).toBe('bottom');
    const tileset = { objectAlignment: 'unspecified' as const, tileOffset: { x: 3, y: -2 }, tileWidth: 20, tileHeight: 10 };
    expect(tileObjectArtworkPlacement(object(), 'orthogonal', identity, 1, tileset)).toMatchObject({
      anchor: { x: 100, y: 80 }, center: { x: 113, y: 73 }, bounds: { x: 103, y: 68, width: 20, height: 10 }, alignment: 'bottomleft',
    });
    expect(tileObjectArtworkPlacement(object(), 'isometric', identity, 1, tileset)).toMatchObject({
      anchor: { x: 100, y: 80 }, center: { x: 103, y: 73 }, bounds: { x: 93, y: 68, width: 20, height: 10 }, alignment: 'bottom',
    });
  });

  it.each([
    ['topleft', 110, 85], ['top', 100, 85], ['topright', 90, 85],
    ['left', 110, 80], ['center', 100, 80], ['right', 90, 80],
    ['bottomleft', 110, 75], ['bottom', 100, 75], ['bottomright', 90, 75],
  ] as const)('anchors explicit %s alignment without changing the object anchor', (objectAlignment, centerX, centerY) => {
    const placement = tileObjectArtworkPlacement(object(), 'orthogonal', identity, 1, { objectAlignment, tileOffset: { x: 0, y: 0 }, tileWidth: 20, tileHeight: 10 });
    expect(placement.anchor).toEqual({ x: 100, y: 80 });
    expect(placement.center).toEqual({ x: centerX, y: centerY });
  });

  it('applies diagonal-first compensation and rotates the complete placement clockwise around the object anchor', () => {
    const placement = tileObjectArtworkPlacement(object({ gid: encodeTiledGid(1, { diagonal: true }), rotation: 90 }), 'orthogonal', identity, 1, { objectAlignment: 'bottomleft', tileOffset: { x: 2, y: 1 }, tileWidth: 20, tileHeight: 10 });
    expect(placement.anchor).toEqual({ x: 100, y: 80 });
    expect(placement.center).toMatchObject({ x: 109, y: 87 });
    expect(placement.bounds.x).toBeCloseTo(99);
    expect(placement.bounds.y).toBeCloseTo(82);
    expect(placement.bounds.width).toBeCloseTo(20);
    expect(placement.bounds.height).toBeCloseTo(10);
    expect(tileObjectArtworkContainsPoint(placement, placement.center)).toBe(true);
    expect(tileObjectArtworkContainsPoint(placement, { x: placement.bounds.x - 1, y: placement.bounds.y - 1 })).toBe(false);
  });

  it('uses explicit alignment, projection, scaling, culling, and exact transformed resize handles', () => {
    const placement = tileObjectArtworkPlacement(object(), 'isometric', { a: 0.5, b: 0.25, c: -0.5, d: 0.25, e: 32, f: 0 }, 2, { objectAlignment: 'topright', tileOffset: { x: -2, y: 4 }, tileWidth: 20, tileHeight: 10 });
    expect(placement).toMatchObject({ anchor: { x: 42, y: 45 }, center: { x: 18, y: 63 }, width: 40, height: 20, alignment: 'topright' });
    expect(placement.resizeHandle).toEqual(placement.corners[2]);
    expect(tileObjectArtworkIntersects(placement, placement.bounds)).toBe(true);
    expect(tileObjectArtworkIntersects(placement, { x: 1_000, y: 1_000, width: 10, height: 10 })).toBe(false);
  });

  it('fails closed on invalid canonical or raster geometry', () => {
    expect(() => tileObjectArtworkPlacement(object({ width: 0 }), 'orthogonal', identity, 1)).toThrow(/width must be positive/);
    expect(() => tileObjectArtworkPlacement(object(), 'orthogonal', { ...identity, a: Number.NaN }, 1)).toThrow(/projection must be finite/);
    const placement = tileObjectArtworkPlacement(object(), 'orthogonal', identity, 1);
    expect(() => tileObjectArtworkIntersects(placement, { x: 0, y: 0, width: 0, height: 1 })).toThrow(/dimensions must be positive/);
    expect(tileObjectFallbackColor(77)).toBe('hsl(19 55% 60%)');
    expect(() => tileObjectFallbackColor(0x1000_0000)).toThrow(/unsigned 28-bit/);
  });
});
