import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, orderedDitherIndex, orderedDitherUsesMix, stepPaletteByLuminance } from '@aidraw/core';

describe('ordered pixel dithering', () => {
  it('supports deterministic 2×2, 4×4, and 8×8 matrices with negative coordinates and exact coverage edges', () => {
    for (const size of [2, 4, 8] as const) {
      const cells = Array.from({ length: size * size }, (_, index) => orderedDitherUsesMix(index % size, Math.floor(index / size), 0.5, size));
      expect(cells.filter(Boolean)).toHaveLength(size * size / 2);
      expect(orderedDitherUsesMix(-1, -1, 0.5, size)).toBe(orderedDitherUsesMix(size - 1, size - 1, 0.5, size));
      expect(orderedDitherUsesMix(0, 0, 0, size)).toBe(false);
      expect(orderedDitherUsesMix(0, 0, 1, size)).toBe(true);
    }
    expect(orderedDitherIndex(0, 0, 2, 9, 1, 4)).toBe(9);
    expect(orderedDitherIndex(0, 0, 2, 9, 0, 4)).toBe(2);
  });

  it('steps by visual luminance rather than palette slot order', () => {
    expect(stepPaletteByLuminance(DEFAULT_PALETTE, 15, 'lighter')).toBe(5);
    expect(stepPaletteByLuminance(DEFAULT_PALETTE, 15, 'darker')).toBe(10);
    expect(stepPaletteByLuminance(DEFAULT_PALETTE, 0, 'lighter')).toBe(0);
  });
});
