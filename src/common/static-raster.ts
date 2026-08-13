export const MAX_STATIC_RASTER_SIDE = 65_535;
export const MAX_STATIC_RASTER_PIXELS = 64 * 1024 * 1024;

export function staticRasterDimensionsWithinLimits(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && width > 0
    && Number.isSafeInteger(height) && height > 0
    && width <= MAX_STATIC_RASTER_SIDE && height <= MAX_STATIC_RASTER_SIDE
    && Number.isSafeInteger(width * height) && width * height <= MAX_STATIC_RASTER_PIXELS;
}

/** Protects headless/native whole-raster allocation before a canvas is made. */
export function assertStaticRasterDimensions(width: number, height: number, label = 'Static raster'): void {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError(`${label} dimensions must be positive safe integers.`);
  }
  if (width > MAX_STATIC_RASTER_SIDE || height > MAX_STATIC_RASTER_SIDE) {
    throw new RangeError(`${label} dimensions exceed the 65,535-pixel side limit.`);
  }
  if (!Number.isSafeInteger(width * height) || width * height > MAX_STATIC_RASTER_PIXELS) {
    throw new RangeError(`${label} exceeds the 64-megapixel safety limit.`);
  }
}
