import { describe, expect, it } from 'vitest';

import { MAX_STATIC_RASTER_PIXELS, MAX_STATIC_RASTER_SIDE, assertStaticRasterDimensions, staticRasterDimensionsWithinLimits } from '../../src/common/static-raster';

describe('static raster allocation limits', () => {
  it('accepts the exact side and pixel boundaries and rejects the first unsafe dimensions', () => {
    expect(() => assertStaticRasterDimensions(MAX_STATIC_RASTER_SIDE, 1, 'Test raster')).not.toThrow();
    expect(() => assertStaticRasterDimensions(8_192, 8_192, 'Test raster')).not.toThrow();
    expect(8_192 * 8_192).toBe(MAX_STATIC_RASTER_PIXELS);
    expect(() => assertStaticRasterDimensions(MAX_STATIC_RASTER_SIDE + 1, 1, 'Test raster')).toThrow(/65,535-pixel side limit/);
    expect(staticRasterDimensionsWithinLimits(MAX_STATIC_RASTER_SIDE, 1)).toBe(true);
    expect(staticRasterDimensionsWithinLimits(MAX_STATIC_RASTER_SIDE + 1, 1)).toBe(false);
    expect(() => assertStaticRasterDimensions(8_193, 8_192, 'Test raster')).toThrow(/64-megapixel safety limit/);
  });

  it('rejects non-positive, fractional, or unsafe geometry', () => {
    for (const [width, height] of [[0, 1], [1, -1], [1.5, 1], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
      expect(() => assertStaticRasterDimensions(width, height)).toThrow(/positive safe integers/);
    }
    expect(staticRasterDimensionsWithinLimits(0, 1)).toBe(false);
  });
});
