import { describe, expect, it } from 'vitest';
import {
  TILE_TRANSFORM_CHOICES,
  constrainTileTransformFlags,
  tileTransformChoiceAllowed,
  tileTransformChoiceId,
  tileTransformFlagsAllowed,
  tileTransformPreviewGeometry,
} from '../../src/common/tile-transform-options';

describe('tile transform choices', () => {
  it('enumerates each Tiled H/V/diagonal combination exactly once', () => {
    expect(TILE_TRANSFORM_CHOICES.map((choice) => choice.id)).toEqual(['identity', 'h', 'v', 'hv', 'd', 'dh', 'dv', 'dhv']);
    expect(new Set(TILE_TRANSFORM_CHOICES.map((choice) => JSON.stringify(choice.flags))).size).toBe(8);
    for (const choice of TILE_TRANSFORM_CHOICES) expect(tileTransformChoiceId(choice.flags)).toBe(choice.id);
  });

  it('derives permitted flag combinations from geometric flip and rotation capabilities', () => {
    const allowedIds = (permissions: { hFlip: boolean; vFlip: boolean; rotate: boolean }) => TILE_TRANSFORM_CHOICES
      .filter((choice) => tileTransformChoiceAllowed(choice, permissions))
      .map((choice) => choice.id);
    expect(allowedIds({ hFlip: false, vFlip: false, rotate: false })).toEqual(['identity']);
    expect(allowedIds({ hFlip: true, vFlip: false, rotate: false })).toEqual(['identity', 'h']);
    expect(allowedIds({ hFlip: false, vFlip: true, rotate: false })).toEqual(['identity', 'v']);
    expect(allowedIds({ hFlip: true, vFlip: true, rotate: false })).toEqual(['identity', 'h', 'v', 'hv']);
    expect(allowedIds({ hFlip: false, vFlip: false, rotate: true })).toEqual(['identity', 'hv', 'dh', 'dv']);
    expect(allowedIds({ hFlip: true, vFlip: false, rotate: true })).toEqual(TILE_TRANSFORM_CHOICES.map((choice) => choice.id));
    expect(allowedIds({ hFlip: false, vFlip: true, rotate: true })).toEqual(TILE_TRANSFORM_CHOICES.map((choice) => choice.id));
  });

  it('preserves an exact permitted state and falls back to identity instead of changing geometry', () => {
    const rotationsOnly = { hFlip: false, vFlip: false, rotate: true };
    const quarterTurn = { hFlip: true, vFlip: false, diagonal: true };
    expect(tileTransformFlagsAllowed(quarterTurn, rotationsOnly)).toBe(true);
    expect(constrainTileTransformFlags(quarterTurn, rotationsOnly)).toEqual(quarterTurn);
    expect(constrainTileTransformFlags({ hFlip: true, vFlip: false, diagonal: false }, rotationsOnly)).toEqual({ hFlip: false, vFlip: false, diagonal: false });
    expect(constrainTileTransformFlags({ hFlip: true, vFlip: true, diagonal: true }, undefined)).toEqual({ hFlip: false, vFlip: false, diagonal: false });
  });

  it('aspect-fits ordinary and diagonal rectangular previews without clipping or stretching', () => {
    const ordinary = tileTransformPreviewGeometry(16, 8, { hFlip: true, vFlip: false, diagonal: false }, 32);
    expect(ordinary).toEqual({
      surfaceSide: 32,
      sampleWidth: 32,
      sampleHeight: 16,
      drawWidth: 32,
      drawHeight: 16,
      transformedWidth: 32,
      transformedHeight: 16,
      bounds: { left: 0, top: 8, right: 32, bottom: 24 },
      transform: { a: -1, b: 0, c: 0, d: 1 },
    });
    const diagonal = tileTransformPreviewGeometry(16, 8, { hFlip: true, vFlip: false, diagonal: true }, 32);
    expect(diagonal).toEqual({
      surfaceSide: 32,
      sampleWidth: 32,
      sampleHeight: 16,
      drawWidth: 32,
      drawHeight: 16,
      transformedWidth: 16,
      transformedHeight: 32,
      bounds: { left: 8, top: 0, right: 24, bottom: 32 },
      transform: { a: 0, b: -1, c: 1, d: 0 },
    });
  });

  it('keeps every transform inside the bounded surface with the exact source aspect', () => {
    for (const choice of TILE_TRANSFORM_CHOICES) {
      const geometry = tileTransformPreviewGeometry(7, 3, choice.flags, 32);
      expect(geometry.drawWidth / geometry.drawHeight).toBeCloseTo(7 / 3, 12);
      expect(geometry.bounds.left).toBeGreaterThanOrEqual(0);
      expect(geometry.bounds.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bounds.right).toBeLessThanOrEqual(32);
      expect(geometry.bounds.bottom).toBeLessThanOrEqual(32);
      expect(Number.isInteger(geometry.sampleWidth)).toBe(true);
      expect(Number.isInteger(geometry.sampleHeight)).toBe(true);
    }
    expect(() => tileTransformPreviewGeometry(0, 8, TILE_TRANSFORM_CHOICES[0].flags, 32)).toThrow(/source width/);
    expect(() => tileTransformPreviewGeometry(16, 8, TILE_TRANSFORM_CHOICES[0].flags, 0)).toThrow(/surface side/);
  });
});
