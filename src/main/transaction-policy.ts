import { createHash } from 'node:crypto';
import { loadImage } from '@napi-rs/canvas';
import type {
  AIDrawDocument,
  Actor,
  CanvasOperation,
  CanvasTransaction,
  DocumentAsset,
  EntityBase,
  PixelAsset,
  PixelSprite,
} from '@aidraw/core';

export const MAX_INLINE_ASSET_BYTES = 1_500_000;
export const MAX_INLINE_IMAGE_DIMENSION = 8_192;
export const MAX_INLINE_IMAGE_PIXELS = 16_777_216;

export type JpegExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ImageHeader {
  mimeType: DocumentAsset['mimeType'];
  width: number;
  height: number;
  /** JPEG display transform. Omitted when no valid EXIF orientation exists. */
  orientation?: JpegExifOrientation;
}

export interface TransactionPolicyOptions {
  trustedProvenance?: boolean;
}

function pngHeader(bytes: Buffer): ImageHeader | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return undefined;
  let animated = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) break;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') animated = true;
    offset += length + 12;
  }
  return { mimeType: animated ? 'image/apng' : 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifHeader(bytes: Buffer): ImageHeader | undefined {
  const signature = bytes.toString('ascii', 0, 6);
  if (bytes.length < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) return undefined;
  return { mimeType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegExifOrientation(bytes: Buffer): JpegExifOrientation | undefined {
  if (bytes.byteLength < 14 || !bytes.subarray(0, 6).equals(Buffer.from('Exif\0\0', 'binary'))) return undefined;
  const tiff = 6;
  const byteOrder = bytes.toString('ascii', tiff, tiff + 2);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') return undefined;
  const uint16 = (offset: number): number | undefined => offset >= 0 && offset <= bytes.byteLength - 2
    ? littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset)
    : undefined;
  const uint32 = (offset: number): number | undefined => offset >= 0 && offset <= bytes.byteLength - 4
    ? littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
    : undefined;
  if (uint16(tiff + 2) !== 42) return undefined;
  const firstIfdOffset = uint32(tiff + 4);
  if (firstIfdOffset === undefined || firstIfdOffset > bytes.byteLength - tiff - 2) return undefined;
  const firstIfd = tiff + firstIfdOffset;
  const declaredEntries = uint16(firstIfd);
  if (declaredEntries === undefined) return undefined;
  const boundedEntries = Math.min(declaredEntries, Math.floor((bytes.byteLength - firstIfd - 2) / 12));
  for (let index = 0; index < boundedEntries; index += 1) {
    const entry = firstIfd + 2 + index * 12;
    if (uint16(entry) !== 0x0112 || uint16(entry + 2) !== 3 || uint32(entry + 4) !== 1) continue;
    const value = uint16(entry + 8);
    if (value !== undefined && value >= 1 && value <= 8) return value as JpegExifOrientation;
  }
  return undefined;
}

function jpegHeader(bytes: Buffer): ImageHeader | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2; let width: number | undefined; let height: number | undefined; let orientation: JpegExifOrientation | undefined;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (marker === 0xe1 && orientation === undefined) orientation = jpegExifOrientation(bytes.subarray(offset + 2, offset + length));
    if (startOfFrame.has(marker) && length >= 7 && width === undefined) {
      width = bytes.readUInt16BE(offset + 5); height = bytes.readUInt16BE(offset + 3);
    }
    offset += length;
  }
  return width !== undefined && height !== undefined ? { mimeType: 'image/jpeg', width, height, ...(orientation === undefined ? {} : { orientation }) } : undefined;
}

function webpHeader(bytes: Buffer): ImageHeader | undefined {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return undefined;
  const type = bytes.toString('ascii', 12, 16);
  if (type === 'VP8X') {
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    return { mimeType: 'image/webp', width, height };
  }
  if (type === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { mimeType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { mimeType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return undefined;
}

export function inspectImageHeader(bytes: Buffer): ImageHeader {
  const header = pngHeader(bytes) ?? gifHeader(bytes) ?? jpegHeader(bytes) ?? webpHeader(bytes);
  if (!header) throw new Error('Inline assets must be a supported PNG, APNG, JPEG, WebP, or GIF image with a valid header.');
  return header;
}

export function displayImageDimensions(header: ImageHeader): { width: number; height: number } {
  return header.mimeType === 'image/jpeg' && header.orientation !== undefined && header.orientation >= 5
    ? { width: header.height, height: header.width }
    : { width: header.width, height: header.height };
}

export async function validateInlineDocumentAsset(asset: DocumentAsset): Promise<void> {
  if (!asset.data) throw new Error(`Inline asset ${asset.id} is missing base64 data.`);
  if (asset.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) {
    throw new Error(`Inline asset ${asset.id} is not canonical base64.`);
  }
  const bytes = Buffer.from(asset.data, 'base64');
  if (bytes.byteLength > MAX_INLINE_ASSET_BYTES) throw new Error(`Inline asset ${asset.id} exceeds the 1.5 MB decoded-byte limit.`);
  if (asset.byteLength !== bytes.byteLength) throw new Error(`Inline asset ${asset.id} declared ${asset.byteLength} bytes but decoded to ${bytes.byteLength}.`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (asset.sha256.toLowerCase() !== digest) throw new Error(`Inline asset ${asset.id} SHA-256 does not match its decoded bytes.`);

  const header = inspectImageHeader(bytes);
  if (asset.mimeType !== header.mimeType) throw new Error(`Inline asset ${asset.id} declares ${asset.mimeType} but its bytes are ${header.mimeType}.`);
  const display = displayImageDimensions(header);
  if (display.width < 1 || display.height < 1 || display.width > MAX_INLINE_IMAGE_DIMENSION || display.height > MAX_INLINE_IMAGE_DIMENSION || display.width * display.height > MAX_INLINE_IMAGE_PIXELS) {
    throw new Error(`Inline asset ${asset.id} dimensions ${display.width}×${display.height} exceed the 8192 px / 16 MP safety limit.`);
  }
  try {
    const decoded = await loadImage(bytes);
    if (decoded.width !== display.width || decoded.height !== display.height) {
      throw new Error(header.mimeType === 'image/jpeg' && header.orientation !== undefined
        ? 'decoded dimensions differ from the file header and EXIF orientation'
        : 'decoded dimensions differ from the file header');
    }
  } catch (error) {
    throw new Error(`Inline asset ${asset.id} could not be decoded safely: ${error instanceof Error ? error.message : 'unsupported image'}.`);
  }
}

function normalizeEntity<T extends EntityBase>(entity: T, actor: Actor, timestamp: string, current?: EntityBase): T {
  return {
    ...structuredClone(entity),
    revision: current?.revision ?? 0,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: current?.updatedAt ?? timestamp,
    createdBy: current?.createdBy ?? actor.id,
  };
}

function normalizePixelAsset(asset: PixelAsset, actor: Actor, timestamp: string, current?: PixelAsset): PixelAsset {
  if (current && current.type !== asset.type) throw new Error('A pixel asset replacement cannot change the asset type.');
  const normalized = normalizeEntity(asset, actor, timestamp, current);
  if (normalized.type === 'sprite') {
    const prior = current?.type === 'sprite' ? current : undefined;
    normalized.layers = Object.fromEntries(Object.entries(normalized.layers).map(([id, layer]) => [id, normalizeEntity(layer, actor, timestamp, prior?.layers[id])]));
    normalized.frames = Object.fromEntries(Object.entries(normalized.frames).map(([id, frame]) => [id, normalizeEntity(frame, actor, timestamp, prior?.frames[id])]));
    normalized.cels = Object.fromEntries(Object.entries(normalized.cels).map(([id, cel]) => [id, normalizeEntity(cel, actor, timestamp, prior?.cels[id])]));
  } else if (normalized.type === 'tilemap') {
    const prior = current?.type === 'tilemap' ? current : undefined;
    normalized.layers = Object.fromEntries(Object.entries(normalized.layers).map(([id, layer]) => [id, normalizeEntity(layer, actor, timestamp, prior?.layers[id])]));
  }
  return normalized;
}

function normalizeEntityOperation(document: AIDrawDocument, operation: CanvasOperation, actor: Actor, timestamp: string): CanvasOperation {
  switch (operation.kind) {
    case 'illustration.layer.add':
      return { ...operation, layer: normalizeEntity(operation.layer, actor, timestamp) };
    case 'illustration.layer.replace':
      return { ...operation, layer: normalizeEntity(operation.layer, actor, timestamp, document.kind === 'illustration' ? document.layers[operation.layer.id] : undefined) };
    case 'illustration.object.add':
      return { ...operation, object: normalizeEntity(operation.object, actor, timestamp) };
    case 'illustration.object.replace':
      return { ...operation, object: normalizeEntity(operation.object, actor, timestamp, document.kind === 'illustration' ? document.objects[operation.object.id] : undefined) };
    case 'illustration.paint.stroke':
      return { ...operation, stroke: { ...structuredClone(operation.stroke), actorId: actor.id } };
    case 'illustration.animation.keyframe.upsert':
      return { ...operation, keyframe: normalizeEntity(operation.keyframe, actor, timestamp, document.kind === 'illustration' ? document.animation.keyframes[operation.keyframe.id] : undefined) };
    case 'pixel.frame.add':
      return {
        ...operation,
        frame: normalizeEntity(operation.frame, actor, timestamp),
        cels: operation.cels.map((cel) => normalizeEntity(cel, actor, timestamp)),
      };
    case 'pixel.frame.replace': {
      const asset = document.kind === 'pixel' ? document.pixelAssets[operation.spriteId] : undefined;
      const sprite: PixelSprite | undefined = asset?.type === 'sprite' ? asset : undefined;
      return { ...operation, frame: normalizeEntity(operation.frame, actor, timestamp, sprite?.frames[operation.frame.id]) };
    }
    case 'pixel.asset.add':
      return { ...operation, asset: normalizePixelAsset(operation.asset, actor, timestamp) };
    case 'pixel.asset.replace': {
      const current = document.kind === 'pixel' ? document.pixelAssets[operation.asset.id] : undefined;
      return { ...operation, asset: normalizePixelAsset(operation.asset, actor, timestamp, current) };
    }
    default:
      return structuredClone(operation);
  }
}

export async function prepareTransactionForCommit(
  document: AIDrawDocument,
  transaction: CanvasTransaction,
  timestamp: string,
  options: TransactionPolicyOptions = {},
): Promise<CanvasTransaction> {
  if (!options.trustedProvenance && transaction.operations.some((operation) => operation.kind === 'provenance.add' || operation.kind === 'provenance.delete')) {
    throw new Error('Verified provenance can only be created or removed by AIDraw’s generation engine.');
  }

  const operations: CanvasOperation[] = [];
  for (const sourceOperation of transaction.operations) {
    const operation = normalizeEntityOperation(document, sourceOperation, transaction.actor, timestamp);
    if (operation.kind === 'asset.add') {
      await validateInlineDocumentAsset(operation.asset);
      operations.push({
        ...operation,
        asset: transaction.actor.kind === 'agent' ? { ...operation.asset, source: 'embedded' } : operation.asset,
      });
    } else if (operation.kind === 'provenance.add') {
      operations.push({ ...operation, provenance: { ...operation.provenance, createdAt: timestamp } });
    } else operations.push(operation);
  }

  return { ...transaction, actor: structuredClone(transaction.actor), createdAt: timestamp, operations };
}
