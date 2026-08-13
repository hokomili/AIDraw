import { describe, expect, it } from 'vitest';
import {
  TILE_TRANSFORM_CHOICES,
  constrainTileTransformFlags,
  tileTransformChoiceAllowed,
  tileTransformChoiceId,
  tileTransformFlagsAllowed,
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
});
