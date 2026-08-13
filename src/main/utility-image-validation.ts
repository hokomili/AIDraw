import { createCanvas, loadImage } from '@napi-rs/canvas';
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

/** Decode and reduce one already-admitted source only inside the supervised utility process. */
export async function renderUtilityImagePreview(
  bytes: Buffer,
  expected: ExpectedDecodedImage,
  preview: { width: number; height: number },
): Promise<Buffer> {
  const decoded = await loadImage(bytes);
  if (decoded.width !== expected.width || decoded.height !== expected.height) {
    throw new Error(`Decoded image dimensions ${decoded.width}×${decoded.height} disagree with the validated ${expected.width}×${expected.height} envelope.`);
  }
  const canvas = createCanvas(preview.width, preview.height);
  try {
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded, 0, 0, preview.width, preview.height);
    return canvas.toBuffer('image/png');
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
