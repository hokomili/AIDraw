import { createHash } from 'node:crypto';
import type {
  AIDrawDocument,
  Actor,
  CanvasOperation,
  CanvasTransaction,
  DocumentAsset,
  EntityBase,
  IllustrationObject,
  PixelAsset,
  PixelSprite,
} from '@aidraw/core';
import { inspectNativeEditableSvgPathData } from '../common/path-conversion';

export const MAX_INLINE_ASSET_BYTES = 1_500_000;
export const MAX_INLINE_IMAGE_DIMENSION = 8_192;
export const MAX_INLINE_IMAGE_PIXELS = 16_777_216;
export const MAX_TRANSACTION_IMAGE_DECODES = 16;
export const MAX_TRANSACTION_IMAGE_DECODE_MS = 30_000;

export type JpegExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ImageHeader {
  mimeType: DocumentAsset['mimeType'];
  width: number;
  height: number;
  /** JPEG display transform. Omitted when no valid EXIF orientation exists. */
  orientation?: JpegExifOrientation;
}

export interface ExpectedDecodedImage {
  mimeType: DocumentAsset['mimeType'];
  width: number;
  height: number;
}

export interface InspectedDocumentImageAsset {
  bytes: Buffer;
  expected: ExpectedDecodedImage;
}

export interface InspectedDocumentImageAssetEntry extends InspectedDocumentImageAsset {
  assetId: string;
  asset: DocumentAsset;
}

export interface ImageDecodeControl {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ImageDecodeValidator = (bytes: Buffer, expected: ExpectedDecodedImage, control?: ImageDecodeControl) => Promise<void>;

export interface TransactionPolicyOptions {
  imageDecoder?: ImageDecodeValidator;
  /** Internal context started by a public ingress before any image materialization work. */
  imageWorkContext?: TransactionImageWorkContext;
  /** Test/internal override; public transactions cannot choose their safety budget. */
  maxImageDecodes?: number;
  /** Test/internal override; public transactions cannot choose their safety budget. */
  imageDecodeBudgetMs?: number;
}

const DOCUMENT_ASSET_SOURCES = new Set(['imported', 'generated', 'embedded', 'rendered']);

/**
 * Main-owned strict admission shared by canonical service, IPC-through-service,
 * and recovery-journal transaction boundaries. Passive snapshots and exact
 * compatibility history intentionally do not call this policy.
 */
export function assertStrictNativeEditableTransaction(transaction: CanvasTransaction): void {
  for (const operation of transaction.operations) {
    if ((operation.kind === 'illustration.object.add' || operation.kind === 'illustration.object.replace')
      && operation.object.type === 'path') {
      inspectNativeEditableSvgPathData(operation.object.pathData);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertDocumentImageAssetMetadata(assetId: string, candidate: unknown): DocumentAsset {
  if (!isRecord(candidate) || candidate.id !== assetId || typeof candidate.name !== 'string' || !candidate.name
    || typeof candidate.mimeType !== 'string' || !candidate.mimeType
    || typeof candidate.byteLength !== 'number' || !Number.isSafeInteger(candidate.byteLength) || candidate.byteLength < 0
    || typeof candidate.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(candidate.sha256)
    || typeof candidate.source !== 'string' || !DOCUMENT_ASSET_SOURCES.has(candidate.source)
    || candidate.data !== undefined && typeof candidate.data !== 'string') {
    throw new Error('AIDraw document contains invalid asset metadata.');
  }
  return candidate as unknown as DocumentAsset;
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
  if (!header) throw new Error('Image assets must be a supported PNG, APNG, JPEG, WebP, or GIF image with a valid header.');
  return header;
}

export function displayImageDimensions(header: ImageHeader): { width: number; height: number } {
  return header.mimeType === 'image/jpeg' && header.orientation !== undefined && header.orientation >= 5
    ? { width: header.height, height: header.width }
    : { width: header.width, height: header.height };
}

export function inspectDocumentImageAsset(
  asset: DocumentAsset,
  options: { maxBytes: number; limitLabel: string; label?: string } = {
    maxBytes: MAX_INLINE_ASSET_BYTES,
    limitLabel: '1.5 MB',
  },
): InspectedDocumentImageAsset {
  const label = options.label ?? `Inline asset ${asset.id}`;
  if (!asset.data) throw new Error(`${label} is missing base64 data.`);
  if (asset.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) {
    throw new Error(`${label} is not canonical base64.`);
  }
  const bytes = Buffer.from(asset.data, 'base64');
  if (bytes.byteLength > options.maxBytes) throw new Error(`${label} exceeds the ${options.limitLabel} decoded-byte limit.`);
  if (asset.byteLength !== bytes.byteLength) throw new Error(`${label} declared ${asset.byteLength} bytes but decoded to ${bytes.byteLength}.`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (asset.sha256.toLowerCase() !== digest) throw new Error(`${label} SHA-256 does not match its decoded bytes.`);

  const header = inspectImageHeader(bytes);
  if (asset.mimeType !== header.mimeType) throw new Error(`${label} declares ${asset.mimeType} but its bytes are ${header.mimeType}.`);
  const display = displayImageDimensions(header);
  if (display.width < 1 || display.height < 1 || display.width > MAX_INLINE_IMAGE_DIMENSION || display.height > MAX_INLINE_IMAGE_DIMENSION || display.width * display.height > MAX_INLINE_IMAGE_PIXELS) {
    throw new Error(`${label} dimensions ${display.width}×${display.height} exceed the 8192 px / 16 MP safety limit.`);
  }
  return { bytes, expected: { mimeType: header.mimeType, width: display.width, height: display.height } };
}

interface ImageAssetByteIdentity {
  readonly mimeType: DocumentAsset['mimeType'];
  readonly byteLength: number;
  readonly sha256: string;
  readonly data: string;
}

interface TransactionImageInspectionRecord {
  readonly identity: ImageAssetByteIdentity;
  readonly inspected: InspectedDocumentImageAsset;
}

export class TransactionImageProjectionCursor {
  private readonly generations = new Map<string, number>();

  key(assetId: string): string {
    return JSON.stringify([assetId, this.generations.get(assetId) ?? 0]);
  }

  invalidate(assetId: string): void {
    this.generations.set(assetId, (this.generations.get(assetId) ?? 0) + 1);
  }
}

/**
 * One non-serializable ingress-to-commit workload boundary. Projection admission
 * happens before base64 decode or hashing, and the retained inspection buffer is
 * shared with commit instead of being duplicated by each validation layer.
 */
export class TransactionImageWorkContext {
  readonly deadline: number;
  readonly maximum: number;
  readonly signal?: AbortSignal;
  private admitted = 0;
  private readonly inspections = new Map<string, TransactionImageInspectionRecord>();

  constructor(options: { maximum?: number; budgetMs?: number; startedAt?: number; signal?: AbortSignal } = {}) {
    this.maximum = options.maximum ?? MAX_TRANSACTION_IMAGE_DECODES;
    const budgetMs = options.budgetMs ?? MAX_TRANSACTION_IMAGE_DECODE_MS;
    const startedAt = options.startedAt ?? Date.now();
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1) throw new Error('Transaction image projection maximum must be a positive safe integer.');
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isFinite(startedAt)) throw new Error('Transaction image workload deadline must be finite and positive.');
    this.deadline = startedAt + budgetMs;
    this.signal = options.signal;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  assertActive(): void {
    if (this.signal?.aborted) throw this.signal.reason instanceof Error ? this.signal.reason : new Error('The transaction image workload was cancelled.');
  }

  inspectProjection(
    cursor: TransactionImageProjectionCursor,
    assetId: string,
    candidate: unknown,
    label: string,
  ): InspectedDocumentImageAsset {
    this.assertActive();
    const asset = assertDocumentImageAssetMetadata(assetId, candidate);
    const key = cursor.key(assetId);
    const cached = this.inspections.get(key);
    if (cached) {
      if (asset.data === undefined
        || cached.identity.mimeType !== asset.mimeType
        || cached.identity.byteLength !== asset.byteLength
        || cached.identity.sha256 !== asset.sha256.toLowerCase()
        || cached.identity.data !== asset.data) {
        throw new Error(`Image asset projection ${assetId} changed while its transaction was being prepared.`);
      }
      return cached.inspected;
    }
    if (this.remainingMs() === 0) throw new Error('The transaction image-work deadline expired before all distinct assets could be inspected.');
    if (this.admitted >= this.maximum) throw new Error(`One transaction may inspect or decode at most ${this.maximum} distinct image-asset projections.`);
    this.admitted += 1;
    const inspected = inspectDocumentImageAsset(asset, {
      maxBytes: MAX_INLINE_ASSET_BYTES,
      limitLabel: '1.5 MB',
      label,
    });
    this.assertActive();
    if (this.remainingMs() === 0) throw new Error('The transaction image-work deadline expired while an asset was being inspected.');
    this.inspections.set(key, {
      identity: { mimeType: asset.mimeType, byteLength: asset.byteLength, sha256: asset.sha256.toLowerCase(), data: asset.data! },
      inspected,
    });
    return inspected;
  }
}

export function inspectEmbeddedDocumentImageAssets(
  document: AIDrawDocument,
  options: { maxBytes: number; limitLabel: string; labelPrefix: string },
): InspectedDocumentImageAssetEntry[] {
  const inspected: InspectedDocumentImageAssetEntry[] = [];
  for (const [assetId, candidate] of Object.entries(document.assets)) {
    const asset = assertDocumentImageAssetMetadata(assetId, candidate);
    if (asset.data === undefined) continue;
    inspected.push({
      assetId,
      asset,
      ...inspectDocumentImageAsset(asset, {
        maxBytes: options.maxBytes,
        limitLabel: options.limitLabel,
        label: `${options.labelPrefix} ${assetId}`,
      }),
    });
  }
  return inspected;
}

async function inspectAndDecodeDocumentImageAsset(
  assetId: string,
  candidate: unknown,
  imageDecoder: ImageDecodeValidator | undefined,
  label: string,
  context: TransactionImageWorkContext,
  cursor: TransactionImageProjectionCursor,
): Promise<InspectedDocumentImageAsset> {
  const inspected = context.inspectProjection(cursor, assetId, candidate, label);
  if (!imageDecoder) return inspected;
  const remainingMs = context.remainingMs();
  if (remainingMs === 0) throw new Error('The transaction image-work deadline expired before a supervised decode could start.');
  context.assertActive();
  const controller = new AbortController();
  const cancelFromIngress = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener('abort', cancelFromIngress, { once: true });
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const decoding = imageDecoder(inspected.bytes, inspected.expected, {
      signal: controller.signal,
      timeoutMs: remainingMs,
    });
    await Promise.race([
      decoding,
      new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('transaction image-work deadline expired')), { once: true })),
    ]);
    if (context.remainingMs() === 0) throw new Error('transaction image-work deadline expired');
  } catch (error) {
    throw new Error(`${label} could not be decoded safely: ${error instanceof Error ? error.message : 'unsupported image'}.`);
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener('abort', cancelFromIngress);
  }
  return inspected;
}

export async function validateInlineDocumentAsset(asset: DocumentAsset, imageDecoder?: ImageDecodeValidator): Promise<void> {
  await inspectAndDecodeDocumentImageAsset(
    asset.id,
    asset,
    imageDecoder,
    `Inline asset ${asset.id}`,
    new TransactionImageWorkContext(),
    new TransactionImageProjectionCursor(),
  );
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

async function normalizeIllustrationImageOperation(
  operation: CanvasOperation,
  availableAssets: ReadonlyMap<string, DocumentAsset>,
  inspectionCache: Map<string, { asset: DocumentAsset; inspected: InspectedDocumentImageAsset }>,
  imageWorkContext: TransactionImageWorkContext,
  projectionCursor: TransactionImageProjectionCursor,
  imageDecoder?: ImageDecodeValidator,
): Promise<CanvasOperation> {
  if ((operation.kind !== 'illustration.object.add' && operation.kind !== 'illustration.object.replace') || operation.object.type !== 'image') return operation;
  const source = operation.object;
  const candidate = availableAssets.get(source.assetId);
  if (!candidate) throw new Error(`Image object ${source.id} references missing asset ${source.assetId}.`);
  const cached = inspectionCache.get(source.assetId);
  const asset = cached?.asset === candidate ? cached.asset : assertDocumentImageAssetMetadata(source.assetId, candidate);
  const inspected = cached?.asset === asset
    ? cached.inspected
    : await inspectAndDecodeDocumentImageAsset(
      source.assetId,
      asset,
      imageDecoder,
      `Image object ${source.id} asset ${source.assetId}`,
      imageWorkContext,
      projectionCursor,
    );
  if (cached?.asset !== asset) inspectionCache.set(source.assetId, { asset, inspected });
  if (source.sourceWidth !== undefined && source.sourceWidth !== inspected.expected.width) {
    throw new Error(`Image object ${source.id} sourceWidth must match embedded asset width ${inspected.expected.width}.`);
  }
  if (source.sourceHeight !== undefined && source.sourceHeight !== inspected.expected.height) {
    throw new Error(`Image object ${source.id} sourceHeight must match embedded asset height ${inspected.expected.height}.`);
  }
  const object: IllustrationObject = {
    ...source,
    sourceWidth: inspected.expected.width,
    sourceHeight: inspected.expected.height,
  };
  if (object.type === 'image' && object.crop
    && (object.crop.x + object.crop.width > inspected.expected.width || object.crop.y + object.crop.height > inspected.expected.height)) {
    throw new Error(`Image object ${source.id} crop must fit inside embedded asset geometry ${inspected.expected.width}×${inspected.expected.height}.`);
  }
  return { ...operation, object } as CanvasOperation;
}

export async function prepareTransactionForCommit(
  document: AIDrawDocument,
  transaction: CanvasTransaction,
  timestamp: string,
  options: TransactionPolicyOptions = {},
): Promise<CanvasTransaction> {
  if (transaction.operations.some((operation) => operation.kind === 'provenance.add' || operation.kind === 'provenance.delete')) {
    throw new Error('Historical provider provenance is read-only compatibility metadata.');
  }

  const operations: CanvasOperation[] = [];
  const availableAssets = new Map(Object.entries(document.assets));
  const inspectionCache = new Map<string, { asset: DocumentAsset; inspected: InspectedDocumentImageAsset }>();
  const imageWorkContext = options.imageWorkContext ?? new TransactionImageWorkContext({
    maximum: options.maxImageDecodes,
    budgetMs: options.imageDecodeBudgetMs,
  });
  const projectionCursor = new TransactionImageProjectionCursor();
  for (const sourceOperation of transaction.operations) {
    let operation = normalizeEntityOperation(document, sourceOperation, transaction.actor, timestamp);
    if (operation.kind === 'asset.add') {
      projectionCursor.invalidate(operation.asset.id);
      const inspected = await inspectAndDecodeDocumentImageAsset(
        operation.asset.id,
        operation.asset,
        options.imageDecoder,
        `Inline asset ${operation.asset.id}`,
        imageWorkContext,
        projectionCursor,
      );
      operation = {
        ...operation,
        asset: transaction.actor.kind === 'agent' ? { ...operation.asset, source: 'embedded' } : operation.asset,
      };
      availableAssets.set(operation.asset.id, operation.asset);
      inspectionCache.set(operation.asset.id, { asset: operation.asset, inspected });
    } else if (operation.kind === 'asset.delete') {
      availableAssets.delete(operation.assetId);
      inspectionCache.delete(operation.assetId);
      projectionCursor.invalidate(operation.assetId);
    } else operation = await normalizeIllustrationImageOperation(
      operation,
      availableAssets,
      inspectionCache,
      imageWorkContext,
      projectionCursor,
      options.imageDecoder,
    );
    operations.push(operation);
  }

  return { ...transaction, actor: structuredClone(transaction.actor), createdAt: timestamp, operations };
}
