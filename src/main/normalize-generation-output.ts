import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type {
  GeneratedAcceptancePreparation,
  GeneratedOutput,
  GenerationAcceptanceNormalization,
} from '../common/generation';
import { GENERATION_ACCEPTANCE_WEBP_QUALITIES } from '../common/generation';
import {
  inspectImageHeader,
  MAX_INLINE_ASSET_BYTES,
  MAX_INLINE_IMAGE_DIMENSION,
  MAX_INLINE_IMAGE_PIXELS,
} from './transaction-policy';

function decodeCanonicalBase64(data: string): Buffer {
  if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error('Generated preview data is not canonical base64.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.byteLength) throw new Error('Generated preview data is empty.');
  return bytes;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function ready(
  output: GeneratedOutput,
  sourceBytes: Buffer,
  acceptedBytes: Buffer,
  mimeType: GeneratedOutput['mimeType'],
  method: GenerationAcceptanceNormalization['method'],
  quality?: number,
): GeneratedAcceptancePreparation {
  const normalization: GenerationAcceptanceNormalization = {
    method,
    sourceOutputId: output.id,
    sourceMimeType: output.mimeType,
    acceptedMimeType: mimeType,
    sourceByteLength: sourceBytes.byteLength,
    acceptedByteLength: acceptedBytes.byteLength,
    sourceSha256: digest(sourceBytes),
    acceptedSha256: digest(acceptedBytes),
    width: output.width,
    height: output.height,
    ...(quality === undefined ? {} : { quality }),
  };
  return {
    status: 'ready',
    mimeType,
    data: acceptedBytes.toString('base64'),
    width: output.width,
    height: output.height,
    normalization,
  };
}

/**
 * Create a same-geometry accepted derivative without modifying the provider preview.
 * Lossless PNG is preferred, followed by the first fixed WebP quality that meets
 * the existing inline-asset byte ceiling. No resize or provider-policy change occurs.
 */
export async function normalizeGeneratedOutputForAcceptance(output: GeneratedOutput): Promise<GeneratedAcceptancePreparation> {
  const sourceBytes = decodeCanonicalBase64(output.data);
  const sourceHeader = inspectImageHeader(sourceBytes);
  if (sourceHeader.mimeType !== output.mimeType || sourceHeader.width !== output.width || sourceHeader.height !== output.height) {
    throw new Error('Generated preview MIME type or dimensions do not match its encoded image.');
  }
  if (output.width > MAX_INLINE_IMAGE_DIMENSION || output.height > MAX_INLINE_IMAGE_DIMENSION || output.width * output.height > MAX_INLINE_IMAGE_PIXELS) {
    return {
      status: 'preview-only',
      reason: 'inline-geometry-limit',
      message: `The generated preview is ${output.width}×${output.height}, outside the ${MAX_INLINE_IMAGE_DIMENSION}px / ${MAX_INLINE_IMAGE_PIXELS}-pixel editable-asset limit.`,
      guidance: 'Generate a smaller result; AIDraw keeps this provider output available for preview and does not change the document.',
    };
  }
  if (sourceBytes.byteLength <= MAX_INLINE_ASSET_BYTES) {
    return { status: 'ready', mimeType: output.mimeType, data: output.data, width: output.width, height: output.height };
  }

  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(sourceBytes);
  } catch (error) {
    throw new Error(`Generated preview could not be decoded for acceptance: ${error instanceof Error ? error.message : 'unsupported image'}.`);
  }
  if (image.width !== output.width || image.height !== output.height) {
    throw new Error('Generated preview decoded dimensions do not match its declared dimensions.');
  }

  const canvas = createCanvas(output.width, output.height);
  canvas.getContext('2d').drawImage(image, 0, 0, output.width, output.height);
  const png = canvas.toBuffer('image/png');
  if (png.byteLength <= MAX_INLINE_ASSET_BYTES) return ready(output, sourceBytes, png, 'image/png', 'png-reencode');

  for (const quality of GENERATION_ACCEPTANCE_WEBP_QUALITIES) {
    const webp = canvas.toBuffer('image/webp', quality);
    if (webp.byteLength <= MAX_INLINE_ASSET_BYTES) return ready(output, sourceBytes, webp, 'image/webp', 'webp-quality', quality);
  }

  return {
    status: 'preview-only',
    reason: 'encoded-byte-limit',
    message: `The generated preview could not be normalized below the ${MAX_INLINE_ASSET_BYTES}-byte editable-asset limit without changing its dimensions.`,
    guidance: 'Generate a smaller or less complex result; AIDraw keeps this provider output available for preview and does not change the document.',
  };
}
