import { MAX_STATIC_RASTER_PIXELS } from './static-raster';

export const MAX_PSD_LAYER_RECORDS = 2_048;
export const MAX_PSD_LAYER_NESTING_DEPTH = 64;
export const MAX_PSD_EXPANDED_LAYER_PIXELS = MAX_STATIC_RASTER_PIXELS;

export function assertPsdLayerStructureBudget(layerRecordCount: number, maximumDepth: number): void {
  if (!Number.isSafeInteger(layerRecordCount) || layerRecordCount < 0) throw new RangeError('PSD layer record count must be a nonnegative safe integer.');
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 0) throw new RangeError('PSD layer depth must be a nonnegative safe integer.');
  if (layerRecordCount > MAX_PSD_LAYER_RECORDS) throw new RangeError(`PSD exceeds the ${MAX_PSD_LAYER_RECORDS.toLocaleString('en-US')}-layer safety limit.`);
  if (maximumDepth > MAX_PSD_LAYER_NESTING_DEPTH) throw new RangeError(`PSD layer nesting exceeds the ${MAX_PSD_LAYER_NESTING_DEPTH}-level safety limit.`);
}
