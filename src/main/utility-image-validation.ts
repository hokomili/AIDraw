import { loadImage } from '@napi-rs/canvas';
import type { ExpectedDecodedImage } from './transaction-policy';

export type UtilityImageLoader = (bytes: Buffer) => Promise<{ width: number; height: number }>;

/**
 * This function is invoked only inside the supervised utility process in
 * production. Tests may replace the loader to exercise deterministic failures
 * without passing hostile bytes to the native decoder in the test process.
 */
export async function validateUtilityImage(
  bytes: Buffer,
  expected: ExpectedDecodedImage,
  loader: UtilityImageLoader = loadImage,
): Promise<{ width: number; height: number }> {
  const decoded = await loader(bytes);
  if (decoded.width !== expected.width || decoded.height !== expected.height) {
    throw new Error(`Decoded image dimensions ${decoded.width}×${decoded.height} disagree with the validated ${expected.width}×${expected.height} envelope.`);
  }
  return { width: decoded.width, height: decoded.height };
}
