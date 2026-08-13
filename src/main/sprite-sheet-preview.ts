import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { spriteSheetPreviewDimensions } from '../common/sprite-sheet';
import {
  displayImageDimensions,
  inspectImageHeader,
  MAX_INLINE_ASSET_BYTES,
  MAX_INLINE_IMAGE_DIMENSION,
  MAX_INLINE_IMAGE_PIXELS,
} from './transaction-policy';
import { MAX_SPRITE_SHEET_PREVIEW_BYTES } from './utility-contract';

export type SpriteSheetSourceMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface SpriteSheetSourceIdentity {
  mimeType: SpriteSheetSourceMimeType;
  width: number;
  height: number;
}

export interface SpriteSheetInspection extends SpriteSheetSourceIdentity {
  sha256: string;
  previewPng: Buffer;
}

function spriteSheetMimeType(value: string): value is SpriteSheetSourceMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

export function inspectSpriteSheetSource(bytes: Buffer): SpriteSheetSourceIdentity {
  let header: ReturnType<typeof inspectImageHeader>;
  try { header = inspectImageHeader(bytes); }
  catch { throw new Error('The selected sprite sheet is corrupt or uses an unsupported codec.'); }
  if (!spriteSheetMimeType(header.mimeType)) throw new Error('Sprite sheets must use static PNG, JPEG, or WebP bytes.');
  const display = displayImageDimensions(header);
  if (display.width < 1 || display.height < 1 || display.width > MAX_INLINE_IMAGE_DIMENSION || display.height > MAX_INLINE_IMAGE_DIMENSION || display.width * display.height > MAX_INLINE_IMAGE_PIXELS) {
    throw new Error('Sprite sheet must be at most 8192px per side and 16 megapixels.');
  }
  return { mimeType: header.mimeType, width: display.width, height: display.height };
}

export async function readBoundedSpriteSheetSource(filePath: string): Promise<Buffer> {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error('Sprite-sheet source is not a regular file.');
  if (details.size < 1 || details.size > MAX_INLINE_ASSET_BYTES) throw new Error("Sprite-sheet source exceeds AIDraw's 1,500,000-byte editable-asset limit.");
  const bytes = await readFile(filePath);
  if (bytes.byteLength !== details.size) throw new Error('The selected sprite-sheet source changed while it was being read; choose it again.');
  return bytes;
}

export async function inspectSpriteSheetBytes(bytes: Buffer): Promise<SpriteSheetInspection> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_INLINE_ASSET_BYTES) throw new Error("Sprite-sheet source exceeds AIDraw's 1,500,000-byte editable-asset limit.");
  const source = inspectSpriteSheetSource(bytes);
  let image: Awaited<ReturnType<typeof loadImage>>;
  try { image = await loadImage(bytes); }
  catch { throw new Error('The selected sprite sheet is corrupt or uses an unsupported codec.'); }
  if (image.width !== source.width || image.height !== source.height) throw new Error('Decoded sprite-sheet dimensions disagree with its display-oriented file header.');
  const previewSize = spriteSheetPreviewDimensions(source.width, source.height);
  const preview = createCanvas(previewSize.width, previewSize.height);
  try {
    const context = preview.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, previewSize.width, previewSize.height);
    const previewPng = preview.toBuffer('image/png');
    if (previewPng.byteLength < 1 || previewPng.byteLength > MAX_SPRITE_SHEET_PREVIEW_BYTES) throw new Error('Sprite-sheet preview exceeds its 4 MiB result limit.');
    return { ...source, sha256: createHash('sha256').update(bytes).digest('hex'), previewPng };
  } finally {
    preview.width = 1;
    preview.height = 1;
  }
}

export async function inspectSpriteSheetFile(filePath: string): Promise<SpriteSheetInspection> {
  return inspectSpriteSheetBytes(await readBoundedSpriteSheetSource(filePath));
}
