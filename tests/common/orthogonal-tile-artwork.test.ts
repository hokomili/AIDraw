import { describe, expect, it } from 'vitest';

import {
  orthogonalTileArtworkEnvelope,
  orthogonalTileArtworkIntersects,
  orthogonalTileArtworkPlacement,
} from '../../src/common/orthogonal-tile-artwork';

describe('orthogonal native tile artwork geometry', () => {
  it('anchors native artwork to the cell left edge and bottom baseline', () => {
    expect(orthogonalTileArtworkPlacement(
      { x: 10, y: 20, width: 8, height: 6 },
      4,
      3,
      { width: 6, height: 9 },
    )).toEqual({
      centerX: 16,
      centerY: 17,
      width: 12,
      height: 18,
      transform: { a: 1, b: 0, c: 0, d: 1 },
      bounds: { left: 10, top: 8, right: 22, bottom: 26 },
    });
  });

  it('keeps equal-size placement identical and applies rectangular transforms around the native footprint', () => {
    const cell = { x: -8, y: 12, width: 8, height: 4 };
    expect(orthogonalTileArtworkPlacement(cell, 16, 8, { width: 16, height: 8 })).toEqual({
      centerX: -4,
      centerY: 14,
      width: 8,
      height: 4,
      transform: { a: 1, b: 0, c: 0, d: 1 },
      bounds: { left: -8, top: 12, right: 0, bottom: 16 },
    });
    expect(orthogonalTileArtworkPlacement(cell, 16, 8, { width: 16, height: 8 }, { diagonal: true, hFlip: true })).toEqual({
      centerX: -4,
      centerY: 14,
      width: 8,
      height: 4,
      transform: { a: 0, b: -1, c: 1, d: 0 },
      bounds: { left: -6, top: 10, right: -2, bottom: 18 },
    });
    const fractionalCell = { x: 0.25, y: -1.75, width: 7.3, height: 4.1 };
    const equalSize = orthogonalTileArtworkPlacement(fractionalCell, 16, 8, { width: 16, height: 8 });
    expect(equalSize.width).toBe(fractionalCell.width);
    expect(equalSize.height).toBe(fractionalCell.height);
  });

  it('unions ordinary and diagonal overhang for every attached artwork size', () => {
    expect(orthogonalTileArtworkEnvelope(4, 4, [
      { width: 4, height: 4 },
      { width: 6, height: 8 },
      { width: 10, height: 2 },
    ])).toEqual({ left: -1, top: -4, right: 10, bottom: 8 });
  });

  it('uses strict raster intersection and rejects unsafe geometry', () => {
    const bounds = { left: -1, top: -4, right: 7, bottom: 4 };
    expect(orthogonalTileArtworkIntersects(bounds, { x: -1, y: -1, width: 1, height: 1 })).toBe(true);
    expect(orthogonalTileArtworkIntersects(bounds, { x: 7, y: -1, width: 1, height: 1 })).toBe(false);
    expect(() => orthogonalTileArtworkPlacement({ x: 0, y: 0, width: 4, height: 4 }, 4, 4, { width: 0, height: 4 })).toThrow(/artwork width/);
    expect(() => orthogonalTileArtworkEnvelope(4, 4, [])).toThrow(/at least one footprint/);
  });
});
