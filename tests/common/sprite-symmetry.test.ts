import { describe, expect, it } from 'vitest';
import { wrapPixelPoints } from '@aidraw/core';
import {
  DEFAULT_SPRITE_SYMMETRY_PREFERENCES,
  effectiveSpriteSymmetry,
  expandSpriteSymmetry,
  parseSpriteSymmetryPreferences,
  withSpriteSymmetryAxes,
  withSpriteSymmetryMode,
} from '../../src/common/sprite-symmetry';

describe('human-local sprite symmetry', () => {
  it('preserves the predecessor centered reflection exactly for odd and even sprites', () => {
    const preferences = withSpriteSymmetryMode({ mode: DEFAULT_SPRITE_SYMMETRY_PREFERENCES.mode, bindings: [] }, 'both');
    for (const [width, height] of [[5, 3], [6, 4]]) {
      const effective = effectiveSpriteSymmetry(preferences, { documentId: 'doc', spriteId: 'sprite', width, height });
      expect(effective).toMatchObject({ horizontalAxis: (width - 1) / 2, verticalAxis: (height - 1) / 2, source: 'centered-default' });
      expect(expandSpriteSymmetry([{ x: 1, y: 1 }], effective)).toEqual([
        { x: 1, y: 1 },
        { x: width - 2, y: 1 },
        { x: 1, y: height - 2 },
        { x: width - 2, y: height - 2 },
      ].filter((point, index, all) => all.findIndex((candidate) => candidate.x === point.x && candidate.y === point.y) === index));
    }
  });

  it('reflects around explicit half-pixel axes and deterministically keeps the last payload at a duplicate cell', () => {
    const symmetry = { mode: 'horizontal' as const, horizontalAxis: 2.5, verticalAxis: 1 };
    expect(expandSpriteSymmetry([{ x: 1, y: 0, index: 3 }, { x: 4, y: 0, index: 7 }], symmetry)).toEqual([
      { x: 4, y: 0, index: 7 },
      { x: 1, y: 0, index: 7 },
    ]);
    expect(expandSpriteSymmetry([{ x: 2, y: 1 }], { ...symmetry, mode: 'both', verticalAxis: 1.5 })).toEqual([
      { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 2 },
    ]);
  });

  it('retains raw reflected coordinates until the existing finite or Wrap-edit boundary', () => {
    const expanded = expandSpriteSymmetry([{ x: 4, y: 1, index: 5 }], { mode: 'horizontal', horizontalAxis: 0.5, verticalAxis: 1 });
    expect(expanded).toEqual([{ x: 4, y: 1, index: 5 }, { x: -3, y: 1, index: 5 }]);
    expect(expanded.filter((point) => point.x >= 0 && point.x < 4)).toEqual([]);
    expect(wrapPixelPoints(expanded, 4, 3)).toEqual([{ x: 0, y: 1, index: 5 }, { x: 1, y: 1, index: 5 }]);
  });

  it('binds saved axes to exact document, sprite, and dimensions and centers every mismatch', () => {
    const preferences = withSpriteSymmetryAxes({ mode: 'both', bindings: [] }, {
      documentId: 'doc-a', spriteId: 'sprite-a', width: 8, height: 6, horizontalAxis: 1.5, verticalAxis: 4,
    });
    expect(effectiveSpriteSymmetry(preferences, { documentId: 'doc-a', spriteId: 'sprite-a', width: 8, height: 6 })).toMatchObject({ horizontalAxis: 1.5, verticalAxis: 4, source: 'saved' });
    expect(effectiveSpriteSymmetry(preferences, { documentId: 'doc-a', spriteId: 'sprite-a', width: 10, height: 6 })).toMatchObject({ horizontalAxis: 4.5, verticalAxis: 2.5, source: 'centered-default' });
    expect(effectiveSpriteSymmetry(preferences, { documentId: 'doc-a', spriteId: 'sprite-b', width: 8, height: 6 })).toMatchObject({ horizontalAxis: 3.5, verticalAxis: 2.5, source: 'centered-default' });
    expect(effectiveSpriteSymmetry(preferences, { documentId: 'x'.repeat(300), spriteId: 'sprite-a', width: 8, height: 6 })).toMatchObject({ horizontalAxis: 3.5, verticalAxis: 2.5, source: 'centered-default' });
  });

  it('rejects partial, extra, duplicate, off-grid, and out-of-range complete values', () => {
    const valid = { mode: 'horizontal', bindings: [{ documentId: 'doc', spriteId: 'sprite', width: 8, height: 6, horizontalAxis: 2.5, verticalAxis: 3 }] };
    expect(parseSpriteSymmetryPreferences(valid)).toEqual(valid);
    expect(() => parseSpriteSymmetryPreferences({ mode: 'none' })).toThrow('Invalid sprite symmetry preferences.');
    expect(() => parseSpriteSymmetryPreferences({ ...valid, extra: true })).toThrow('Invalid sprite symmetry preferences.');
    expect(() => parseSpriteSymmetryPreferences({ ...valid, bindings: [...valid.bindings, ...valid.bindings] })).toThrow('Invalid sprite symmetry preferences.');
    expect(() => parseSpriteSymmetryPreferences({ ...valid, bindings: [{ ...valid.bindings[0], horizontalAxis: 2.25 }] })).toThrow('Invalid sprite symmetry preferences.');
    expect(() => parseSpriteSymmetryPreferences({ ...valid, bindings: [{ ...valid.bindings[0], verticalAxis: 6 }] })).toThrow('Invalid sprite symmetry preferences.');
  });

  it('compares binding identities as exact tuples even when canonical IDs contain delimiters', () => {
    const delimiterBearing = {
      mode: 'both',
      bindings: [
        { documentId: 'doc\0sprite', spriteId: 'asset', width: 8, height: 6, horizontalAxis: 2.5, verticalAxis: 3 },
        { documentId: 'doc', spriteId: 'sprite\0asset', width: 8, height: 6, horizontalAxis: 4, verticalAxis: 1.5 },
      ],
    };
    expect(parseSpriteSymmetryPreferences(delimiterBearing)).toEqual(delimiterBearing);
    expect(() => parseSpriteSymmetryPreferences({
      ...delimiterBearing,
      bindings: [...delimiterBearing.bindings, { ...delimiterBearing.bindings[0] }],
    })).toThrow('Invalid sprite symmetry preferences.');
  });
});
