import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { gunzipSync, inflateSync } from 'node:zlib';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { createCanvas, DOMMatrix, ImageData, Path2D, loadImage, type Canvas } from '@napi-rs/canvas';
import { initializeCanvas as initializePsdCanvas, readPsd, type Layer as PsdLayer } from 'ag-psd';
import { XMLParser } from 'fast-xml-parser';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  MAX_ILLUSTRATION_TEXT_LENGTH,
  createId,
  createIllustrationDocument,
  createPixelDocument,
  createPixelSprite,
  createPixelTileset,
  migrateDocument,
  nowIso,
  writePixels,
  writeTiles,
  type AIDrawDocument,
  type CollisionShape,
  type DocumentAsset,
  type BlendMode,
  type IllustrationLayer,
  type ImageObject,
  type PaletteEntry,
  type PixelCel,
  type PixelLayer,
  type PixelSprite,
  type TextObject,
  type TextStyleRange,
  type TileDefinition,
  type WangSet,
} from '@aidraw/core';
import { quantizeImageToPalette, quantizeRgbaToPalette } from './quantize-image';
import { decodeApng } from './apng';
import { inspectGif, visitDecodedGifFrames, type DecodedGifFrame } from './gif';
import { calculateSpriteSheetLayout, validateSpriteSheetSliceOptions, type SpriteSheetSliceOptions } from '../common/sprite-sheet';
import { createExactAnimationPalettePlanner, exactAnimationFrameChanges, exactSharedIndexedPaletteChanges, planExactSharedIndexedPalette, type ExactAnimationPalettePlan } from '../common/animation-palette';
import { tryAppendInterchangeFidelityEntry, type InterchangeFidelityEntry } from '../common/interchange-fidelity';
import { aidrawPsdTextGeometry, aidrawPsdTextObjectName, psdLayerHasPartialLock, psdLayerIsLockedAll } from '../common/psd-text';
import { MAX_PSD_EXPANDED_LAYER_PIXELS, MAX_PSD_LAYER_NESTING_DEPTH, MAX_PSD_LAYER_RECORDS } from '../common/psd-limits';
import { MAX_TILED_DEPTH, MAX_TILED_LAYERS, MAX_TILED_LAYER_CELLS, MAX_TILED_OBJECTS, MAX_TILED_TOTAL_CELLS } from '../common/tiled-resource-policy';
import { displayImageDimensions, inspectImageHeader, MAX_INLINE_ASSET_BYTES, MAX_INLINE_IMAGE_DIMENSION, MAX_INLINE_IMAGE_PIXELS } from './transaction-policy';
import { importEditableSvg } from './svg-import';
import { MAX_IMPORT_UTILITY_DOCUMENTS, MAX_IMPORT_UTILITY_SERIALIZED_BYTES } from './utility-contract';
import { jsonStringSerializedByteLength } from './utility-resource-policy';
import { inspectSpriteSheetSource } from './sprite-sheet-preview';
import { readBoundedRegularFile } from './bounded-file-read';

initializePsdCanvas(createCanvas as unknown as (width: number, height: number) => HTMLCanvasElement);

export interface ImportResult { documents: AIDrawDocument[]; warnings: string[]; fidelity?: InterchangeFidelityEntry[] }

const ANIMATION_PALETTE_FALLBACK_WARNING = 'One or more animation frames contain more than 255 visible RGBA colors after the alpha threshold; frames were quantized to the document palette and the original source remains embedded.';

export const MAX_STRUCTURED_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_BINARY_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_SPRITE_SHEET_FRAMES = 4_096;
const MAX_SPRITE_SHEET_EXPANDED_PIXELS = 64 * 1024 * 1024;
const MAX_PSD_DECODED_BYTES = (MAX_PSD_EXPANDED_LAYER_PIXELS + MAX_INLINE_IMAGE_PIXELS) * 4;
const MAX_PDF_PAGES = MAX_IMPORT_UTILITY_DOCUMENTS;
const MAX_PDF_EXPANDED_PIXELS = 64 * 1024 * 1024;
const INVALID_CANONICAL_PDF_ERROR = "PDF extracted text exceeds AIDraw's canonical illustration limits.";
const PDF_TEXT_TRANSFER_LIMIT_ERROR = `PDF editable text exceeds the ${Math.floor(MAX_IMPORT_UTILITY_SERIALIZED_BYTES / 1024 / 1024)} MiB imported-document transfer limit.`;
const INVALID_CANONICAL_PSD_ERROR = "PSD import produced content outside AIDraw's canonical document limits.";
const PSD_TEXT_TRANSFER_LIMIT_ERROR = `PSD editable text exceeds the ${Math.floor(MAX_IMPORT_UTILITY_SERIALIZED_BYTES / 1024 / 1024)} MiB imported-document transfer limit.`;
const PSD_PALETTE_FALLBACK_WARNING = 'PSD raster layers contain more than 255 visible RGBA colors after the alpha threshold; layers were quantized to the document palette.';
const MAX_TILESET_TILES = 1_048_576;

export async function renderPdfPagePng(
  width: number,
  height: number,
  render: (context: CanvasRenderingContext2D) => Promise<unknown>,
  canvasFactory: (width: number, height: number) => Canvas = createCanvas,
): Promise<Buffer> {
  assertImageDimensions(width, height, 'PDF page');
  const canvas = canvasFactory(width, height);
  try {
    await render(canvas.getContext('2d') as unknown as CanvasRenderingContext2D);
    return canvas.toBuffer('image/png');
  } finally {
    // The encoded PNG owns its bytes. Release the native page surface before
    // raster admission/text extraction or the next PDF page begins.
    canvas.width = 1;
    canvas.height = 1;
  }
}

function accountImportedEditableText(serializedBytes: number, text: string, canonicalError: string, transferError: string): number {
  if (!Number.isSafeInteger(serializedBytes) || serializedBytes < 0 || serializedBytes > MAX_IMPORT_UTILITY_SERIALIZED_BYTES) throw new Error(transferError);
  if (text.length > MAX_ILLUSTRATION_TEXT_LENGTH) throw new Error(canonicalError);
  const itemBytes = jsonStringSerializedByteLength(text);
  if (itemBytes > MAX_IMPORT_UTILITY_SERIALIZED_BYTES - serializedBytes) throw new Error(transferError);
  return serializedBytes + itemBytes;
}

export function accountPdfEditableText(serializedBytes: number, text: string): number {
  return accountImportedEditableText(serializedBytes, text, INVALID_CANONICAL_PDF_ERROR, PDF_TEXT_TRANSFER_LIMIT_ERROR);
}

export function accountPsdEditableText(serializedBytes: number, text: string): number {
  return accountImportedEditableText(serializedBytes, text, INVALID_CANONICAL_PSD_ERROR, PSD_TEXT_TRANSFER_LIMIT_ERROR);
}

function validateImportedDocument(document: AIDrawDocument, errorMessage: string): AIDrawDocument {
  try { return migrateDocument(document); }
  catch { throw new Error(errorMessage); }
}

function validateImportedPdfDocument(document: AIDrawDocument): AIDrawDocument {
  return validateImportedDocument(document, INVALID_CANONICAL_PDF_ERROR);
}

function validateImportedPsdDocument(document: AIDrawDocument): AIDrawDocument {
  return validateImportedDocument(document, INVALID_CANONICAL_PSD_ERROR);
}

function safeJson(bytes: Buffer, label: string): Record<string, any> {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('the root value must be an object');
    return value as Record<string, any>;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function assertSafeXml(bytes: Buffer, label: string): string {
  const text = bytes.toString('utf8');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error(`${label} cannot contain DTD or entity declarations.`);
  return text;
}

export async function readBoundedImportFile(filePath: string, maxBytes = MAX_BINARY_IMPORT_BYTES, label = 'Import file'): Promise<Buffer> {
  const limit = Math.floor(maxBytes / 1024 / 1024);
  return readBoundedRegularFile(filePath, {
    maxBytes,
    notFileMessage: `${label} is not a regular file.`,
    tooLargeMessage: `${label} exceeds the ${limit} MiB safety limit.`,
    changedMessage: `${label} changed or grew beyond the ${limit} MiB safety limit while it was being read.`,
  });
}

async function readCompanionFile(rootFilePath: string, sourceFilePath: string, reference: string, maxBytes: number, label: string): Promise<{ bytes: Buffer; path: string }> {
  if (!reference || reference.includes('\0') || isAbsolute(reference)) throw new Error(`${label} must use a non-empty relative path.`);
  const authorityRoot = await realpath(dirname(rootFilePath));
  const target = await realpath(resolve(dirname(sourceFilePath), reference));
  const fromRoot = relative(authorityRoot, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..\\`) || fromRoot.startsWith('../') || isAbsolute(fromRoot)) throw new Error(`${label} resolves outside the approved import folder.`);
  return { bytes: await readBoundedImportFile(target, maxBytes, label), path: target };
}

function assertImageDimensions(width: number, height: number, label: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_INLINE_IMAGE_DIMENSION || height > MAX_INLINE_IMAGE_DIMENSION || width * height > MAX_INLINE_IMAGE_PIXELS) {
    throw new Error(`${label} dimensions ${width}×${height} exceed AIDraw's 8192px/16MP import limit.`);
  }
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function entityBase(name: string, layerId: string) {
  const timestamp = nowIso();
  return { id: createId('object'), revision: 0, name, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: structuredClone(IDENTITY_TRANSFORM) };
}

export function assertImportedInlineAssetBytes(bytes: Buffer, label = 'Imported image'): void {
  if (bytes.byteLength > MAX_INLINE_ASSET_BYTES) {
    throw new Error(`${label} exceeds AIDraw's ${MAX_INLINE_ASSET_BYTES.toLocaleString('en-US')}-byte editable-asset limit.`);
  }
}

function imageAsset(name: string, mimeType: string, bytes: Buffer, source: DocumentAsset['source'] = 'imported'): DocumentAsset {
  assertImportedInlineAssetBytes(bytes, name);
  return { id: createId('asset'), name, mimeType, byteLength: bytes.byteLength, sha256: sha256(bytes), source, data: bytes.toString('base64') };
}

async function importRaster(bytes: Buffer, name: string, mimeType: string, pixelMode: boolean): Promise<ImportResult> {
  assertImportedInlineAssetBytes(bytes, 'Image source');
  const header = inspectImageHeader(bytes);
  const display = displayImageDimensions(header);
  assertImageDimensions(display.width, display.height, 'Image');
  let decoded;
  try { decoded = await loadImage(bytes); }
  catch { throw new Error('Image is corrupt or uses an unsupported codec.'); }
  const size = { width: decoded.width, height: decoded.height };
  if (size.width !== display.width || size.height !== display.height) {
    throw new Error(header.mimeType === 'image/jpeg' && header.orientation !== undefined
      ? 'Decoded image dimensions disagree with its file header and EXIF orientation.'
      : 'Decoded image dimensions disagree with its file header.');
  }
  const warnings = header.mimeType === 'image/jpeg' && header.orientation !== undefined && header.orientation !== 1
    ? [`JPEG EXIF orientation ${header.orientation} was applied; display geometry is ${display.width}×${display.height} from ${header.width}×${header.height} encoded pixels.`]
    : [];
  if (pixelMode) {
    const document = createPixelDocument('sprite', name);
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = size.width; sprite.height = size.height;
    const cel = Object.values(sprite.cels)[0];
    const asset = imageAsset(name, mimeType, bytes);
    document.assets[asset.id] = asset;
    writePixels(cel, await quantizeImageToPalette(bytes, size.width, size.height, document.palette, { alphaThreshold: document.conversionDefaults.alphaThreshold, dithering: document.conversionDefaults.dithering }));
    document.dirty = true;
    return { documents: [document], warnings: [...warnings, 'Full-color image quantized to the active indexed palette; the source image is embedded for reproducibility.'] };
  }
  const document = createIllustrationDocument(name);
  document.artboard.width = size.width; document.artboard.height = size.height; document.artboard.background = null;
  const layer = document.layerIds.map((id) => document.layers[id]).find((entry) => entry.type === 'vector')!;
  const asset = imageAsset(name, mimeType, bytes); document.assets[asset.id] = asset;
  const object: ImageObject = { ...entityBase(name, layer.id), type: 'image', assetId: asset.id, width: size.width, height: size.height, sourceWidth: size.width, sourceHeight: size.height, filters: [] };
  document.objects[object.id] = object; if (layer.type === 'vector') layer.objectIds.push(object.id);
  document.dirty = true;
  return { documents: [document], warnings };
}

function exactAnimationPlan(frames: Iterable<Uint8ClampedArray>, palette: PaletteEntry[], alphaThreshold: number): ExactAnimationPalettePlan | undefined {
  const planner = createExactAnimationPalettePlanner(palette, alphaThreshold);
  for (const frame of frames) if (!planner.addFrame(frame)) break;
  return planner.finish();
}

function setImportedFramePalette(sprite: PixelSprite, frameId: string, plan: ExactAnimationPalettePlan | undefined, frameIndex: number): void {
  const override = plan?.frames[frameIndex]?.paletteOverride;
  if (override) sprite.paletteOverrides[frameId] = structuredClone(override);
}

function visitCompositedGifFrames(
  decodeFrames: (visit: (frame: DecodedGifFrame, index: number) => void) => void,
  width: number,
  height: number,
  visit: (rgba: Uint8ClampedArray, index: number, frame: DecodedGifFrame) => boolean | void,
): void {
  const canvas = createCanvas(width, height); const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
  let active = true;
  try {
    decodeFrames((frame, index) => {
      if (!active) return;
      const restore = frame.disposalType === 3 ? context.getImageData(0, 0, width, height) : undefined;
      const patchCanvas = createCanvas(frame.dims.width, frame.dims.height);
      try {
        patchCanvas.getContext('2d').putImageData(new ImageData(frame.patch, frame.dims.width, frame.dims.height), 0, 0);
        context.drawImage(patchCanvas, frame.dims.left, frame.dims.top);
      } finally {
        patchCanvas.width = 1; patchCanvas.height = 1;
      }
      if (visit(context.getImageData(0, 0, width, height).data, index, frame) === false) { active = false; return; }
      if (frame.disposalType === 2) context.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
      else if (frame.disposalType === 3 && restore) context.putImageData(restore, 0, 0);
    });
  } finally {
    canvas.width = 1; canvas.height = 1;
  }
}

export function importApngBytes(bytes: Buffer, name: string): ImportResult | undefined {
  assertImportedInlineAssetBytes(bytes, 'APNG source');
  const decoded = decodeApng(bytes); if (!decoded) return undefined;
  const document = createPixelDocument('sprite', name); const sprite = createPixelSprite(name, decoded.width, decoded.height);
  document.pixelAssets = { [sprite.id]: sprite }; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id;
  const exactPlan = exactAnimationPlan(decoded.frames.map((frame) => frame.rgba), document.palette, document.conversionDefaults.alphaThreshold);
  if (exactPlan) document.palette = structuredClone(exactPlan.palette);
  const layerId = sprite.layerIds[0]; const firstFrameId = sprite.frameIds[0]; const firstCel = Object.values(sprite.cels)[0]; sprite.frames[firstFrameId].durationMs = decoded.frames[0]?.delayMs ?? 100;
  decoded.frames.forEach((frame, index) => {
    const changes = exactPlan
      ? exactAnimationFrameChanges(frame.rgba, decoded.width, decoded.height, exactPlan.frames[index], exactPlan.alphaThreshold)
      : quantizeRgbaToPalette(frame.rgba, decoded.width, decoded.height, document.palette, { alphaThreshold: document.conversionDefaults.alphaThreshold, dithering: document.conversionDefaults.dithering, includeTransparent: true });
    if (index === 0) {
      writePixels(firstCel, changes); setImportedFramePalette(sprite, firstFrameId, exactPlan, index); return;
    }
    const timestamp = nowIso(); const frameId = createId('frame'); const celId = createId('cel'); sprite.frameIds.push(frameId);
    sprite.frames[frameId] = { id: frameId, revision: 0, name: `Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: frame.delayMs };
    sprite.cels[celId] = { id: celId, revision: 0, name: `Pixels · Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, frameId, chunks: {} };
    writePixels(sprite.cels[celId], changes); setImportedFramePalette(sprite, frameId, exactPlan, index);
  });
  const source = imageAsset(`${name} source`, 'image/apng', bytes); document.assets[source.id] = source;
  document.dirty = true; return { documents: [document], warnings: exactPlan ? [] : [ANIMATION_PALETTE_FALLBACK_WARNING] };
}

export function importGifBytes(bytes: Buffer, name: string): ImportResult {
  assertImportedInlineAssetBytes(bytes, 'GIF source');
  const inspected = inspectGif(bytes);
  // Palette planning and cel writing replay the bounded source rather than
  // retaining every decoded RGBA patch across both compositing passes.
  const decodeFrames = (visit: (frame: DecodedGifFrame, index: number) => void) => visitDecodedGifFrames(bytes, visit, inspected);
  const width = inspected.width; const height = inspected.height; const document = createPixelDocument('sprite', name); const sprite = createPixelSprite(name, width, height);
  document.pixelAssets = { [sprite.id]: sprite }; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id;
  const planner = createExactAnimationPalettePlanner(document.palette, document.conversionDefaults.alphaThreshold);
  visitCompositedGifFrames(decodeFrames, width, height, (rgba) => planner.addFrame(rgba));
  const exactPlan = planner.finish(); if (exactPlan) document.palette = structuredClone(exactPlan.palette);
  const layerId = sprite.layerIds[0]; const firstFrameId = sprite.frameIds[0]; const firstCel = Object.values(sprite.cels)[0];
  visitCompositedGifFrames(decodeFrames, width, height, (rgba, index, frame) => {
    const changes = exactPlan
      ? exactAnimationFrameChanges(rgba, width, height, exactPlan.frames[index], exactPlan.alphaThreshold)
      : quantizeRgbaToPalette(rgba, width, height, document.palette, { alphaThreshold: document.conversionDefaults.alphaThreshold, dithering: document.conversionDefaults.dithering, includeTransparent: true });
    if (index === 0) {
      sprite.frames[firstFrameId].durationMs = Math.max(10, frame.delay || 100); writePixels(firstCel, changes); setImportedFramePalette(sprite, firstFrameId, exactPlan, index); return;
    }
    const timestamp = nowIso(); const frameId = createId('frame'); const celId = createId('cel'); sprite.frameIds.push(frameId);
    sprite.frames[frameId] = { id: frameId, revision: 0, name: `Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: Math.max(10, frame.delay || 100) };
    sprite.cels[celId] = { id: celId, revision: 0, name: `Pixels · Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, frameId, chunks: {} };
    writePixels(sprite.cels[celId], changes); setImportedFramePalette(sprite, frameId, exactPlan, index);
  });
  const source = imageAsset(`${name} source`, 'image/gif', bytes); document.assets[source.id] = source; document.dirty = true;
  return { documents: [document], warnings: exactPlan ? [] : [ANIMATION_PALETTE_FALLBACK_WARNING] };
}

async function importSpriteSheet(bytes: Buffer, name: string, filePath: string): Promise<ImportResult> {
  const metadata = safeJson(bytes, 'Sprite-sheet metadata'); const frameSources = Array.isArray(metadata.frames) ? metadata.frames : Object.entries(metadata.frames ?? {}).map(([filename, frame]) => ({ filename, ...(frame as Record<string, unknown>) }));
  if (!frameSources.length) throw new Error('Sprite-sheet metadata contains no frames.');
  if (frameSources.length > MAX_SPRITE_SHEET_FRAMES) throw new Error(`Sprite-sheet metadata exceeds the ${MAX_SPRITE_SHEET_FRAMES.toLocaleString('en-US')}-frame limit.`);
  const firstRect = frameSources[0].frame ?? frameSources[0]; const width = Number(firstRect.w ?? firstRect.width); const height = Number(firstRect.h ?? firstRect.height); assertImageDimensions(width, height, 'Sprite frame');
  if (width * height * frameSources.length > MAX_SPRITE_SHEET_EXPANDED_PIXELS) throw new Error('Sprite-sheet frames exceed the 64-megapixel expanded import budget.');
  const imageReference = String(metadata.meta?.image ?? `${name}.png`); const companion = await readCompanionFile(filePath, filePath, imageReference, MAX_BINARY_IMPORT_BYTES, 'Sprite-sheet image'); const imagePath = companion.path; const imageBytes = companion.bytes;
  assertImportedInlineAssetBytes(imageBytes, 'Sprite-sheet image');
  const imageHeader = inspectImageHeader(imageBytes); assertImageDimensions(imageHeader.width, imageHeader.height, 'Sprite-sheet image');
  let sourceImage;
  try { sourceImage = await loadImage(imageBytes); } catch { throw new Error(`Sprite-sheet image ${imageReference} is unreadable.`); }
  const sourceSize = { width: sourceImage.width, height: sourceImage.height }; if (sourceSize.width !== imageHeader.width || sourceSize.height !== imageHeader.height) throw new Error('Decoded sprite-sheet dimensions disagree with its file header.');
  const document = createPixelDocument('sprite', name); const sprite = createPixelSprite(name, width, height); document.pixelAssets = { [sprite.id]: sprite }; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id; const layerId = sprite.layerIds[0]; const importedFrameIds: string[] = [];
  for (let index = 0; index < frameSources.length; index += 1) { const source = frameSources[index]; const rect = source.frame ?? source; let frameId: string; let celId: string;
    const frameX = Number(rect.x ?? 0); const frameY = Number(rect.y ?? 0); const frameWidth = Number(rect.w ?? rect.width ?? width); const frameHeight = Number(rect.h ?? rect.height ?? height); const duration = Number(source.duration ?? 100);
    if (![frameX, frameY, frameWidth, frameHeight].every(Number.isInteger) || frameX < 0 || frameY < 0 || frameWidth < 1 || frameHeight < 1 || frameX + frameWidth > sourceSize.width || frameY + frameHeight > sourceSize.height) throw new Error(`Sprite-sheet frame ${index + 1} has an invalid or out-of-bounds rectangle.`);
    if (!Number.isFinite(duration) || duration < 1 || duration > 60_000) throw new Error(`Sprite-sheet frame ${index + 1} has an invalid duration.`);
    const frameCanvas = createCanvas(width, height); const frameContext = frameCanvas.getContext('2d'); frameContext.imageSmoothingEnabled = true; frameContext.imageSmoothingQuality = 'high'; frameContext.drawImage(sourceImage, frameX, frameY, frameWidth, frameHeight, 0, 0, width, height);
    if (index === 0) { frameId = sprite.frameIds[0]; celId = Object.values(sprite.cels)[0].id; sprite.frames[frameId].name = String(source.filename ?? source.name ?? 'Frame 1'); sprite.frames[frameId].durationMs = duration; }
    else { const timestamp = nowIso(); frameId = createId('frame'); celId = createId('cel'); sprite.frameIds.push(frameId); sprite.frames[frameId] = { id: frameId, revision: 0, name: String(source.filename ?? source.name ?? `Frame ${index + 1}`), createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: duration }; sprite.cels[celId] = { id: celId, revision: 0, name: `Pixels · Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, frameId, chunks: {} }; }
    importedFrameIds.push(frameId); writePixels(sprite.cels[celId], quantizeRgbaToPalette(frameContext.getImageData(0, 0, width, height).data, width, height, document.palette, { alphaThreshold: document.conversionDefaults.alphaThreshold, dithering: document.conversionDefaults.dithering }));
  }
  const tags = arrayify(metadata.meta?.frameTags ?? metadata.meta?.tags); if (tags.length > 1_024) throw new Error('Sprite-sheet metadata exceeds the 1,024-tag limit.'); sprite.tags = tags.map((tag: any) => { const from = typeof tag.from === 'number' ? importedFrameIds[tag.from] : importedFrameIds.includes(tag.fromFrameId) ? tag.fromFrameId : importedFrameIds[0]; const to = typeof tag.to === 'number' ? importedFrameIds[tag.to] : importedFrameIds.includes(tag.toFrameId) ? tag.toFrameId : importedFrameIds.at(-1)!; return { id: createId('tag'), name: String(tag.name ?? 'Animation'), fromFrameId: from, toFrameId: to, direction: tag.direction === 'reverse' || tag.direction === 'ping-pong' || tag.direction === 'pingpong' ? (tag.direction === 'reverse' ? 'reverse' : 'ping-pong') : 'forward', color: String(tag.color ?? '#9b87f5') }; });
  const embedded = imageAsset(basename(imagePath), `image/${extname(imagePath).slice(1).replace('jpg', 'jpeg') || 'png'}`, imageBytes); document.assets[embedded.id] = embedded; document.linkedAssets.push({ id: createId('link'), name: basename(imagePath), mode: 'linked', relativePath: relative(dirname(filePath), imagePath).replace(/\\/g, '/'), sha256: embedded.sha256, cachedPreviewAssetId: embedded.id }); document.dirty = true; return { documents: [document], warnings: [] };
}

function rgbaCrop(source: Uint8ClampedArray, sourceWidth: number, x: number, y: number, width: number, height: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const start = ((y + row) * sourceWidth + x) * 4;
    output.set(source.subarray(start, start + width * 4), row * width * 4);
  }
  return output;
}

export async function importSlicedSpriteSheetBytes(bytes: Buffer, name: string, mimeType: string, value: SpriteSheetSliceOptions): Promise<ImportResult> {
  assertImportedInlineAssetBytes(bytes, 'Sprite-sheet source');
  const options = validateSpriteSheetSliceOptions(value); const sourceIdentity = inspectSpriteSheetSource(bytes); if (sourceIdentity.mimeType !== mimeType) throw new Error('Sprite-sheet source MIME disagrees with its file header.'); const image = await loadImage(bytes);
  const width = image.width; const height = image.height;
  if (width !== sourceIdentity.width || height !== sourceIdentity.height) throw new Error('Decoded sprite-sheet dimensions disagree with its display-oriented file header.');
  const layout = calculateSpriteSheetLayout(width, height, options); const canvas = createCanvas(width, height); const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false; context.drawImage(image, 0, 0);
  const decoded = layout.frames.map((frame) => ({ frame, rgba: context.getImageData(frame.x, frame.y, frame.width, frame.height).data }));
  const kept = options.skipEmpty ? decoded.filter(({ rgba }) => { for (let offset = 3; offset < rgba.length; offset += 4) if (rgba[offset] > 0) return true; return false; }) : decoded;
  if (!kept.length) throw new Error('Every selected sprite-sheet frame is fully transparent.');
  let trim = { x: 0, y: 0, width: options.frameWidth, height: options.frameHeight }; let hasOpaque = false;
  if (options.trimTransparent) {
    let minX = options.frameWidth; let minY = options.frameHeight; let maxX = -1; let maxY = -1;
    for (const { rgba } of kept) for (let y = 0; y < options.frameHeight; y += 1) for (let x = 0; x < options.frameWidth; x += 1) if (rgba[(y * options.frameWidth + x) * 4 + 3] > 0) { hasOpaque = true; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    if (hasOpaque) trim = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }
  const document = createPixelDocument('sprite', name); const sprite = createPixelSprite(name, trim.width, trim.height); document.pixelAssets = { [sprite.id]: sprite }; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id;
  const layerId = sprite.layerIds[0]; const firstFrameId = sprite.frameIds[0]; const firstCel = Object.values(sprite.cels)[0];
  kept.forEach(({ frame, rgba }, index) => {
    const pixels = rgbaCrop(rgba, options.frameWidth, trim.x, trim.y, trim.width, trim.height); const changes = quantizeRgbaToPalette(pixels, trim.width, trim.height, document.palette, { alphaThreshold: document.conversionDefaults.alphaThreshold, dithering: document.conversionDefaults.dithering, includeTransparent: true });
    if (index === 0) { sprite.frames[firstFrameId].name = `Frame ${frame.index + 1}`; sprite.frames[firstFrameId].durationMs = options.durationMs; writePixels(firstCel, changes); return; }
    const timestamp = nowIso(); const frameId = createId('frame'); const celId = createId('cel'); sprite.frameIds.push(frameId); sprite.frames[frameId] = { id: frameId, revision: 0, name: `Frame ${frame.index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: options.durationMs }; sprite.cels[celId] = { id: celId, revision: 0, name: `Pixels · Frame ${frame.index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, frameId, chunks: {} }; writePixels(sprite.cels[celId], changes);
  });
  const source = imageAsset(`${name} source`, mimeType, bytes); document.assets[source.id] = source; document.dirty = true;
  const warnings = [`Sliced ${kept.length} frame${kept.length === 1 ? '' : 's'} from a ${layout.columns}×${layout.rows} grid; the source sheet is embedded.`];
  if (options.skipEmpty && kept.length !== decoded.length) warnings.push(`Skipped ${decoded.length - kept.length} fully transparent frame${decoded.length - kept.length === 1 ? '' : 's'}.`);
  if (options.trimTransparent && hasOpaque && (trim.width !== options.frameWidth || trim.height !== options.frameHeight)) warnings.push(`Trimmed the shared transparent border from ${options.frameWidth}×${options.frameHeight} to ${trim.width}×${trim.height} without changing frame alignment.`);
  else if (options.trimTransparent && !hasOpaque) warnings.push('No opaque pixels were available for shared-border trimming.');
  warnings.push('Full-color sheet pixels were quantized to the document indexed palette.');
  return { documents: [document], warnings };
}

function arrayify<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function importSvg(bytes: Buffer, name: string): ImportResult {
  const imported = importEditableSvg(assertSafeXml(bytes, 'SVG'), name);
  return { documents: [imported.document], warnings: imported.warnings };
}

function psdSectionEnd(bytes: Buffer, offset: number, label: string, eightByteLength = false): number {
  const lengthBytes = eightByteLength ? 8 : 4;
  if (offset > bytes.byteLength - lengthBytes) throw new Error(`PSD ${label} section length is truncated.`);
  let length: number;
  if (eightByteLength) {
    if (bytes.readUInt32BE(offset) !== 0) throw new Error(`PSD ${label} section exceeds the bounded file size.`);
    length = bytes.readUInt32BE(offset + 4);
  } else length = bytes.readUInt32BE(offset);
  const start = offset + lengthBytes;
  if (length > bytes.byteLength - start) throw new Error(`PSD ${label} section exceeds the bounded file size.`);
  return start + length;
}

function inspectPsdContainer(bytes: Buffer): { version: number; width: number; height: number } {
  if (bytes.byteLength < 26 || bytes.toString('ascii', 0, 4) !== '8BPS' || ![1, 2].includes(bytes.readUInt16BE(4))) throw new Error('PSD header is corrupt or unsupported.');
  const version = bytes.readUInt16BE(4); const height = bytes.readUInt32BE(14); const width = bytes.readUInt32BE(18); assertImageDimensions(width, height, 'PSD canvas');
  let offset = psdSectionEnd(bytes, 26, 'color-mode data');
  offset = psdSectionEnd(bytes, offset, 'image-resources');
  offset = psdSectionEnd(bytes, offset, 'layer-and-mask', version === 2);
  if (offset > bytes.byteLength - 2) throw new Error('PSD composite image data is truncated.');
  return { version, width, height };
}

function psdImagePixels(source: NonNullable<PsdLayer['imageData']>, label: string): number {
  assertImageDimensions(source.width, source.height, label); const pixels = source.width * source.height;
  if (source.data.byteLength !== pixels * 4) throw new Error(`${label} decoded byte length disagrees with its RGBA dimensions.`);
  return pixels;
}

function psdLayerIsGroup(layer: PsdLayer): layer is PsdLayer & { children: PsdLayer[] } {
  return Array.isArray(layer.children);
}

function inspectPsdLayers(layers: PsdLayer[] | undefined, depth = 0, budget = { count: 0, pixels: 0 }): void {
  if (depth > MAX_PSD_LAYER_NESTING_DEPTH) throw new Error(`PSD layer nesting exceeds the ${MAX_PSD_LAYER_NESTING_DEPTH}-level safety limit.`);
  for (const layer of layers ?? []) {
    budget.count += 1; if (budget.count > MAX_PSD_LAYER_RECORDS) throw new Error(`PSD exceeds the ${MAX_PSD_LAYER_RECORDS.toLocaleString('en-US')}-layer safety limit.`);
    if (layer.imageData) { budget.pixels += psdImagePixels(layer.imageData, `PSD layer ${budget.count}`); if (budget.pixels > MAX_PSD_EXPANDED_LAYER_PIXELS) throw new Error('PSD layer pixels exceed the 64-megapixel expanded safety budget.'); }
    if (psdLayerIsGroup(layer)) inspectPsdLayers(layer.children, depth + 1, budget);
  }
}

function psdRasterImages(layers: PsdLayer[] | undefined, result: Array<NonNullable<PsdLayer['imageData']>> = []): Array<NonNullable<PsdLayer['imageData']>> {
  for (const layer of layers ?? []) {
    if (psdLayerIsGroup(layer)) psdRasterImages(layer.children, result);
    else if (layer.imageData) result.push(layer.imageData);
  }
  return result;
}

function canvasImageData(source: NonNullable<PsdLayer['imageData']>): ImageData {
  return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
}

function* psdRasterRgba(images: Iterable<NonNullable<PsdLayer['imageData']>>): Generator<Uint8ClampedArray> {
  for (const image of images) yield canvasImageData(image).data;
}

function aidrawPsdBlendMode(value: PsdLayer['blendMode']): BlendMode {
  const normalized = String(value ?? 'normal').replace(/ /g, '-');
  return ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion'].includes(normalized)
    ? normalized as BlendMode
    : 'normal';
}

function recordPsdBlendModeSubstitution(
  fidelity: InterchangeFidelityEntry[],
  value: PsdLayer['blendMode'],
  subjectId: string,
  subjectName: string,
): boolean {
  const sourceMode = String(value ?? 'normal');
  if (aidrawPsdBlendMode(value) !== 'normal' || sourceMode === 'normal') return false;
  return tryAppendInterchangeFidelityEntry(fidelity, {
    code: 'blend-mode-substitution',
    subjectType: 'layer',
    subjectId,
    subjectName,
    detail: `PSD blend mode ${JSON.stringify(sourceMode)} is not supported by AIDraw and was imported as normal.`,
  });
}

function psdColorHex(value: unknown, fallback = '#000000'): string {
  if (!value || typeof value !== 'object') return fallback;
  const color = value as { r?: unknown; g?: unknown; b?: unknown; a?: unknown };
  if (![color.r, color.g, color.b].every((channel) => typeof channel === 'number' && Number.isFinite(channel))) return fallback;
  const channel = (entry: unknown) => Math.max(0, Math.min(255, Math.round(Number(entry)))).toString(16).padStart(2, '0');
  const alpha = typeof color.a === 'number' && Number.isFinite(color.a) ? channel(color.a <= 1 ? color.a * 255 : color.a) : '';
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${alpha}`;
}

function importedPsdText(layer: PsdLayer, layerId: string, visible: boolean): { object: TextObject; aidrawCompanion: boolean } | undefined {
  const source = layer.text; if (!source?.text) return undefined;
  const base = source.style ?? {}; const ranges: TextStyleRange[] = []; let offset = 0;
  const runs = source.styleRuns?.length ? source.styleRuns : [{ length: source.text.length, style: {} }];
  for (const run of runs) {
    if (offset >= source.text.length) break;
    const length = Math.max(0, Math.min(source.text.length - offset, Math.trunc(run.length))); if (!length) continue;
    const style = { ...base, ...run.style }; const fontSize = Math.max(1, Number(style.fontSize ?? 24)); const fontName = String(style.font?.name ?? 'sans-serif');
    ranges.push({ start: offset, end: offset + length, fontFamily: fontName, fontSize, fontWeight: style.fauxBold || /bold/i.test(fontName) ? 700 : 400, fontStyle: style.fauxItalic || /italic|oblique/i.test(fontName) ? 'italic' : 'normal', color: psdColorHex(style.fillColor), letterSpacing: Number.isFinite(style.tracking) ? Number(style.tracking) / 1_000 * fontSize : 0, underline: Boolean(style.underline) });
    offset += length;
  }
  if (offset < source.text.length) {
    const fontSize = Math.max(1, Number(base.fontSize ?? 24)); const fontName = String(base.font?.name ?? 'sans-serif');
    ranges.push({ start: offset, end: source.text.length, fontFamily: fontName, fontSize, fontWeight: base.fauxBold || /bold/i.test(fontName) ? 700 : 400, fontStyle: base.fauxItalic || /italic|oblique/i.test(fontName) ? 'italic' : 'normal', color: psdColorHex(base.fillColor), letterSpacing: Number.isFinite(base.tracking) ? Number(base.tracking) / 1_000 * fontSize : 0, underline: Boolean(base.underline) });
  }
  const first = ranges[0]; const transform = source.transform ?? []; const left = Number(layer.left ?? source.left ?? transform[4] ?? 0); const top = Number(layer.top ?? source.top ?? (Number(transform[5] ?? 0) - first.fontSize));
  const width = Math.max(1, Number((layer.right ?? source.right ?? left + Math.max(first.fontSize, source.text.length * first.fontSize * 0.6)) - left));
  const height = Math.max(1, Number((layer.bottom ?? source.bottom ?? top + first.fontSize * 1.4) - top));
  const aidrawGeometry = aidrawPsdTextGeometry(layer.name, source.transform, source.boxBounds, first.fontSize);
  const aidrawName = aidrawGeometry ? aidrawPsdTextObjectName(layer.name) : undefined;
  const justification = source.paragraphStyle?.justification;
  const object: TextObject = { ...entityBase((aidrawName ?? source.text.slice(0, 32)) || layer.name || 'PSD text', layerId), type: 'text', text: source.text, width: aidrawGeometry?.width ?? width, height: aidrawGeometry?.height ?? height, align: justification === 'center' || justification === 'justify-center' ? 'center' : justification === 'right' || justification === 'justify-right' ? 'right' : justification?.startsWith('justify') ? 'justify' : 'left', lineHeight: Math.max(0.5, Math.min(4, Number(base.leading ?? first.fontSize * 1.2) / first.fontSize)), ranges, visible: aidrawGeometry ? true : visible };
  object.transform = aidrawGeometry?.transform ?? { ...object.transform, x: left, y: top };
  if (aidrawGeometry) { object.opacity = layer.opacity ?? 1; object.blendMode = aidrawPsdBlendMode(layer.blendMode); object.locked = psdLayerIsLockedAll(layer); }
  return { object, aidrawCompanion: Boolean(aidrawGeometry) };
}

function addPsdRasterObject(document: Extract<AIDrawDocument, { kind: 'illustration' }>, layer: Extract<IllustrationLayer, { type: 'vector' }>, source: NonNullable<PsdLayer['imageData']>, name: string, visible: boolean, left = 0, top = 0): void {
  const canvas = createCanvas(source.width, source.height); canvas.getContext('2d').putImageData(canvasImageData(source), 0, 0); const png = canvas.toBuffer('image/png');
  const asset = imageAsset(name, 'image/png', png); document.assets[asset.id] = asset;
  const object: ImageObject = { ...entityBase(name, layer.id), type: 'image', assetId: asset.id, width: source.width, height: source.height, sourceWidth: source.width, sourceHeight: source.height, filters: [], visible };
  object.transform.x = left; object.transform.y = top; document.objects[object.id] = object; layer.objectIds.push(object.id);
}

function importPsd(bytes: Buffer, name: string, pixelMode: boolean): ImportResult {
  const inspected = inspectPsdContainer(bytes);
  const psd = readPsd(bytes, { useImageData: true, logMissingFeatures: false, totalMemoryLimit: MAX_PSD_DECODED_BYTES });
  assertImageDimensions(psd.width, psd.height, 'Decoded PSD canvas');
  if (psd.width !== inspected.width || psd.height !== inspected.height) throw new Error('Decoded PSD canvas dimensions disagree with its file header.');
  if (psd.imageData) { psdImagePixels(psd.imageData, 'Decoded PSD composite'); if (psd.imageData.width !== psd.width || psd.imageData.height !== psd.height) throw new Error('Decoded PSD composite dimensions disagree with its canvas.'); }
  inspectPsdLayers(psd.children);
  const fidelity: InterchangeFidelityEntry[] = [];
  if (pixelMode) {
    const document = createPixelDocument('project', name);
    const rasterImages = psdRasterImages(psd.children);
    const exactPalettePlan = planExactSharedIndexedPalette(psdRasterRgba(rasterImages), document.palette, document.conversionDefaults.alphaThreshold);
    if (exactPalettePlan) document.palette = structuredClone(exactPalettePlan.palette);
    const sprite = createPixelSprite(name, psd.width, psd.height); const frameId = sprite.frameIds[0];
    const fallbackLayerId = sprite.layerIds[0]; const fallbackLayer = sprite.layers[fallbackLayerId]; const fallbackCel = Object.values(sprite.cels)[0];
    sprite.layerIds = []; sprite.layers = {}; sprite.cels = {};
    const stats = { rasterLayers: 0, omittedLayers: 0, partialLocks: 0, blendModeSubstitutions: 0 };
    const addLayers = (layers: PsdLayer[] | undefined, parentId?: string): void => {
      for (const [index, source] of (layers ?? []).entries()) {
        const isGroup = psdLayerIsGroup(source); const imageData = source.imageData; const layerName = source.name ?? `${isGroup ? 'Group' : 'Layer'} ${index + 1}`;
        if (psdLayerHasPartialLock(source)) stats.partialLocks += 1;
        if (!isGroup && !imageData) { stats.omittedLayers += 1; continue; }
        const timestamp = nowIso(); const id = createId('layer');
        if (recordPsdBlendModeSubstitution(fidelity, source.blendMode, id, layerName)) stats.blendModeSubstitutions += 1;
        const common = { id, revision: 0, name: layerName, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: !source.hidden, locked: psdLayerIsLockedAll(source), opacity: source.opacity ?? 1, blendMode: aidrawPsdBlendMode(source.blendMode), ...(parentId ? { parentId } : {}) };
        const layer: PixelLayer = isGroup ? { ...common, type: 'group', childIds: [] } : { ...common, type: 'pixel' };
        sprite.layers[id] = layer;
        if (parentId) {
          const parent = sprite.layers[parentId]; if (parent?.type === 'group') parent.childIds?.push(id);
        } else sprite.layerIds.push(id);
        if (isGroup) { addLayers(source.children, id); continue; }
        if (!imageData) throw new Error(INVALID_CANONICAL_PSD_ERROR);

        const celId = createId('cel'); const cel: PixelCel = { id: celId, revision: 0, name: layerName, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: id, frameId, chunks: {} };
        sprite.cels[celId] = cel; stats.rasterLayers += 1;
        const left = source.left ?? 0; const top = source.top ?? 0;
        if (!Number.isSafeInteger(left) || !Number.isSafeInteger(top)) throw new Error(INVALID_CANONICAL_PSD_ERROR);
        const rgba = canvasImageData(imageData).data;
        const changes = exactPalettePlan
          ? exactSharedIndexedPaletteChanges(rgba, imageData.width, imageData.height, exactPalettePlan)
          : quantizeRgbaToPalette(rgba, imageData.width, imageData.height, document.palette, { alphaThreshold: document.conversionDefaults.alphaThreshold, dithering: document.conversionDefaults.dithering });
        for (const change of changes) { change.x += left; change.y += top; }
        writePixels(cel, changes);
      }
    };
    addLayers(psd.children);
    if (!stats.rasterLayers) {
      sprite.layers[fallbackLayerId] = fallbackLayer; sprite.layerIds.push(fallbackLayerId); sprite.cels[fallbackCel.id] = fallbackCel;
    }
    document.pixelAssets = { [sprite.id]: sprite }; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id;
    document.dirty = true;
    const warnings = ['PSD pixel import restored available folders and raster layers as one current-frame sprite hierarchy; raster pixels were indexed independently against one shared document palette. Unsupported effects use decoded raster fallbacks.'];
    if (rasterImages.length && !exactPalettePlan) warnings.push(PSD_PALETTE_FALLBACK_WARNING);
    if (stats.omittedLayers) warnings.push(`${stats.omittedLayers} PSD layer${stats.omittedLayers === 1 ? '' : 's'} without decoded raster pixels ${stats.omittedLayers === 1 ? 'was' : 'were'} omitted from the pixel sprite.`);
    if (stats.partialLocks) warnings.push(`${stats.partialLocks} PSD layer${stats.partialLocks === 1 ? '' : 's'} used a partial transparency, position, composite, or artboard lock and imported unlocked; AIDraw maps only Photoshop lock-all to its binary layer lock.`);
    if (stats.blendModeSubstitutions) warnings.push(`${stats.blendModeSubstitutions} PSD layer blend mode${stats.blendModeSubstitutions === 1 ? '' : 's'} ${stats.blendModeSubstitutions === 1 ? 'was' : 'were'} imported as normal; exact affected layers are listed in the interchange report.`);
    if (psd.bitsPerChannel !== undefined && psd.bitsPerChannel !== 8) warnings.push(`The ${psd.bitsPerChannel}-bit PSD was decoded into AIDraw's 8-bit indexed workflow.`);
    return { documents: [validateImportedPsdDocument(document)], warnings, fidelity };
  }
  const document = createIllustrationDocument(name); document.artboard.width = psd.width; document.artboard.height = psd.height; document.artboard.background = null;
  const initialLayers = [...document.layerIds]; for (const id of initialLayers) delete document.layers[id]; document.layerIds = [];
  const stats = { groups: 0, text: 0, effects: 0, vector: 0, adjustments: 0, partialLocks: 0, blendModeSubstitutions: 0 };
  let extractedTextSerializedBytes = 0;
  const addLayers = (layers: PsdLayer[] | undefined, parentId?: string) => {
    for (const [index, source] of (layers ?? []).entries()) {
      const timestamp = nowIso(); const id = createId('layer'); const isGroup = psdLayerIsGroup(source); const layerName = source.name ?? `${isGroup ? 'Group' : 'Layer'} ${index + 1}`;
      if (source.effects) stats.effects += 1; if (source.vectorMask || source.vectorFill || source.vectorStroke) stats.vector += 1; if (source.adjustment) stats.adjustments += 1;
      if (psdLayerHasPartialLock(source)) stats.partialLocks += 1;
      if (recordPsdBlendModeSubstitution(fidelity, source.blendMode, id, layerName)) stats.blendModeSubstitutions += 1;
      if (isGroup) {
        const group: IllustrationLayer = { id, revision: 0, name: layerName, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, parentId, visible: !source.hidden, locked: psdLayerIsLockedAll(source), opacity: source.opacity ?? 1, blendMode: aidrawPsdBlendMode(source.blendMode), type: 'group', childIds: [] };
        document.layers[id] = group; stats.groups += 1;
        if (parentId) { const parent = document.layers[parentId]; if (parent?.type === 'group') parent.childIds.push(id); } else document.layerIds.push(id);
        addLayers(source.children, id); continue;
      }
      const layer: IllustrationLayer = { id, revision: 0, name: layerName, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, parentId, visible: !source.hidden, locked: psdLayerIsLockedAll(source), opacity: source.opacity ?? 1, blendMode: aidrawPsdBlendMode(source.blendMode), type: 'vector', objectIds: [] };
      document.layers[id] = layer;
      if (parentId) { const parent = document.layers[parentId]; if (parent?.type === 'group') parent.childIds.push(id); } else document.layerIds.push(id);
      if (source.imageData) addPsdRasterObject(document, layer, source.imageData, `${layerName} · raster fallback`, true, source.left ?? 0, source.top ?? 0);
      if (source.text?.text) extractedTextSerializedBytes = accountPsdEditableText(extractedTextSerializedBytes, source.text.text);
      const importedText = importedPsdText(source, id, !source.hidden && !source.imageData); if (importedText) {
        const { object, aidrawCompanion } = importedText;
        if (aidrawCompanion) { layer.locked = false; layer.opacity = 1; layer.blendMode = 'normal'; }
        document.objects[object.id] = object; layer.objectIds.push(object.id); stats.text += 1;
      }
    }
  };
  addLayers(psd.children);
  if (psd.imageData) {
    const timestamp = nowIso(); const layer: IllustrationLayer = { id: createId('layer'), revision: 0, name: 'PSD composite fallback', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: document.layerIds.length === 0, locked: true, opacity: 1, blendMode: 'normal', type: 'vector', objectIds: [] };
    addPsdRasterObject(document, layer, psd.imageData, 'PSD composite fallback', true); document.layers[layer.id] = layer; document.layerIds.unshift(layer.id);
  }
  if (!document.layerIds.length) { const fallback = createIllustrationDocument(name); const id = fallback.layerIds.find((candidate) => fallback.layers[candidate].type === 'vector')!; document.layers[id] = fallback.layers[id]; document.layerIds.push(id); }
  document.dirty = true; const warnings = ['PSD layer hierarchy and raster fallbacks were preserved.'];
  if (stats.text) warnings.push(`${stats.text} text layer${stats.text === 1 ? '' : 's'} include hidden editable text beside the visible raster fallback when both were available.`);
  if (stats.effects) warnings.push(`${stats.effects} layer effect stack${stats.effects === 1 ? '' : 's'} remain rasterized.`);
  if (stats.vector) warnings.push(`${stats.vector} vector-mask/fill/stroke layer${stats.vector === 1 ? '' : 's'} retain raster fallbacks; editable Photoshop vector descriptors are not yet translated.`);
  if (stats.adjustments) warnings.push(`${stats.adjustments} adjustment layer${stats.adjustments === 1 ? '' : 's'} remain rasterized.`);
  if (stats.partialLocks) warnings.push(`${stats.partialLocks} PSD layer${stats.partialLocks === 1 ? '' : 's'} used a partial transparency, position, composite, or artboard lock and imported unlocked; AIDraw maps only Photoshop lock-all to its binary layer lock.`);
  if (stats.blendModeSubstitutions) warnings.push(`${stats.blendModeSubstitutions} PSD layer blend mode${stats.blendModeSubstitutions === 1 ? '' : 's'} ${stats.blendModeSubstitutions === 1 ? 'was' : 'were'} imported as normal; exact affected layers are listed in the interchange report.`);
  if (psd.bitsPerChannel !== undefined && psd.bitsPerChannel !== 8) warnings.push(`The ${psd.bitsPerChannel}-bit PSD was decoded into AIDraw's 8-bit sRGB workflow.`);
  return { documents: [validateImportedPsdDocument(document)], warnings, fidelity };
}

function tiledProperties(value: any): Record<string, string | number | boolean> {
  if (!value) return {};
  if (!Array.isArray(value) && typeof value === 'object' && !value.property && !(Object.hasOwn(value, 'name') && Object.hasOwn(value, 'value'))) {
    const entries = Object.entries(value); if (entries.every(([, entry]) => typeof entry === 'string' || typeof entry === 'number' && Number.isFinite(entry) || typeof entry === 'boolean')) return Object.fromEntries(entries) as Record<string, string | number | boolean>;
  }
  const result: Record<string, string | number | boolean> = {};
  for (const property of arrayify(value.property ?? value)) {
    const raw = property.value ?? property['#text'] ?? '';
    result[String(property.name ?? '')] = property.type === 'bool' ? raw === true || raw === 'true' : property.type === 'int' || property.type === 'float' ? Number(raw) : String(raw);
  }
  return result;
}

function tiledObject(source: any): CollisionShape {
  const polygon = source.polygon?.points ?? source.polygon; const polyline = source.polyline?.points ?? source.polyline;
  const explicitType = ['rectangle', 'ellipse', 'polygon', 'polyline'].includes(source.type) ? source.type as CollisionShape['type'] : undefined;
  const parsePoints = (value: unknown): Array<{ x: number; y: number }> | undefined => typeof value === 'string' ? value.split(/\s+/).filter(Boolean).map((point) => { const [x, y] = point.split(',').map(Number); return { x, y }; }) : Array.isArray(value) ? value.map((point: any) => ({ x: Number(point.x), y: Number(point.y) })) : undefined;
  return { id: String(source.id ?? createId('collision')), type: explicitType ?? (polygon ? 'polygon' : polyline ? 'polyline' : source.ellipse ? 'ellipse' : 'rectangle'), x: Number(source.x ?? 0), y: Number(source.y ?? 0), width: Number(source.width ?? 0), height: Number(source.height ?? 0), points: parsePoints(polygon ?? polyline) ?? parsePoints(source.points), properties: { name: String(source.name ?? ''), class: String(source.class ?? (explicitType ? '' : source.type) ?? ''), ...tiledProperties(source.properties) } };
}

function tiledCellCount(width: number, height: number, label: string): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 || width > 16_777_216 || height > 16_777_216) throw new Error(`${label} has invalid dimensions.`);
  const cells = width * height;
  if (!Number.isSafeInteger(cells) || cells > MAX_TILED_LAYER_CELLS) throw new Error(`${label} exceeds the ${MAX_TILED_LAYER_CELLS.toLocaleString('en-US')}-cell layer limit.`);
  return cells;
}

function validateGids(values: number[], expected: number, label: string): number[] {
  if (values.length > MAX_TILED_LAYER_CELLS || (expected > 0 && values.length !== expected)) throw new Error(`${label} contains ${values.length.toLocaleString('en-US')} cells; expected ${expected.toLocaleString('en-US')}.`);
  if (values.some((gid) => !Number.isSafeInteger(gid) || gid < 0 || gid > 0xffff_ffff)) throw new Error(`${label} contains an invalid tile GID.`);
  return values;
}

function tiledData(source: any, width: number, height: number): number[] {
  const expected = tiledCellCount(width, height, 'Tiled layer data');
  if (Array.isArray(source)) return validateGids(source.map(Number), expected, 'Tiled layer data');
  if (source?.tile) return validateGids(arrayify(source.tile).map((tile: any) => Number(tile.gid ?? 0)), expected, 'Tiled layer data');
  const text = String(source?.['#text'] ?? source ?? '').trim(); const encoding = source?.encoding;
  if (!text) return Array<number>(expected).fill(0);
  if (encoding === 'csv' || text.includes(',')) return validateGids(text.split(/[\s,]+/).filter(Boolean).map(Number), expected, 'Tiled CSV layer data');
  if (encoding === 'base64') {
    const compact = text.replace(/\s+/g, ''); if (!compact || compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error('Tiled layer data is not canonical base64.');
    let payload = Buffer.from(compact, 'base64'); const maxOutputLength = Math.max(4, expected * 4);
    if (source.compression === 'zlib') payload = inflateSync(payload, { maxOutputLength }); else if (source.compression === 'gzip') payload = gunzipSync(payload, { maxOutputLength }); else if (source.compression) throw new Error(`Unsupported Tiled layer compression: ${source.compression}`);
    if (payload.byteLength !== expected * 4) throw new Error(`Tiled binary layer data decodes to ${payload.byteLength} bytes; expected ${expected * 4}.`);
    const gids: number[] = []; for (let offset = 0; offset < payload.length; offset += 4) gids.push(payload.readUInt32LE(offset)); return validateGids(gids, expected, 'Tiled binary layer data');
  }
  return validateGids(text.split(/\s+/).filter(Boolean).map(Number), expected, 'Tiled layer data');
}

function xmlTileset(source: any): Record<string, any> {
  if (source.source) return { firstgid: source.firstgid, source: source.source };
  const tiles = arrayify(source.tile).map((tile: any) => ({ id: Number(tile.id), probability: Number(tile.probability ?? 1), properties: tiledProperties(tile.properties), animation: arrayify(tile.animation?.frame).map((frame: any) => ({ tileid: Number(frame.tileid), duration: Number(frame.duration ?? 100) })), objectgroup: tile.objectgroup ? { objects: arrayify(tile.objectgroup.object).map(tiledObject) } : undefined }));
  const wangsets = arrayify(source.wangsets?.wangset).map((set: any) => ({ name: set.name, type: set.type, wangcolors: arrayify(set.wangcolor).map((color: any) => ({ name: color.name, color: color.color, tile: Number(color.tile ?? -1), probability: Number(color.probability ?? 1) })), wangtiles: arrayify(set.wangtile).map((tile: any) => ({ tileid: Number(tile.tileid), wangid: String(tile.wangid ?? '').split(',').map(Number) })) }));
  return { ...source, type: 'tileset', image: source.image?.source, imagewidth: source.image?.width, imageheight: source.image?.height, tiles, wangsets, properties: tiledProperties(source.properties), transformations: source.transformations };
}

function xmlLayer(source: any, type: 'tilelayer' | 'objectgroup' | 'group', depth = 0, budget = { layers: 0, cells: 0 }): Record<string, any> {
  if (depth > MAX_TILED_DEPTH) throw new Error('Tiled group nesting exceeds the 64-level safety limit.');
  budget.layers += 1; if (budget.layers > MAX_TILED_LAYERS) throw new Error(`Tiled map exceeds the ${MAX_TILED_LAYERS.toLocaleString('en-US')}-layer limit.`);
  if (type === 'group') return { ...source, type, layers: [...arrayify(source.layer).map((entry) => xmlLayer(entry, 'tilelayer', depth + 1, budget)), ...arrayify(source.objectgroup).map((entry) => xmlLayer(entry, 'objectgroup', depth + 1, budget)), ...arrayify(source.group).map((entry) => xmlLayer(entry, 'group', depth + 1, budget))] };
  if (type === 'objectgroup') return { ...source, type, objects: arrayify(source.object).map(tiledObject) };
  const data = source.data ?? {}; const chunks = arrayify(data.chunk).map((chunk: any) => ({ x: Number(chunk.x), y: Number(chunk.y), width: Number(chunk.width), height: Number(chunk.height), data: tiledData({ ...chunk, encoding: data.encoding, compression: data.compression }, Number(chunk.width), Number(chunk.height)) }));
  const normalizedData = chunks.length ? undefined : tiledData(data, Number(source.width ?? 0), Number(source.height ?? 0)); budget.cells += chunks.length ? chunks.reduce((total, chunk) => total + chunk.data.length, 0) : normalizedData!.length;
  if (budget.cells > MAX_TILED_TOTAL_CELLS) throw new Error('Tiled layer data exceeds the 16,777,216-cell total import budget.');
  return { ...source, type, ...(chunks.length ? { chunks } : { data: normalizedData }) };
}

function parseTiled(bytes: Buffer, extension: string): Record<string, any> {
  if (extension === '.tmj' || extension === '.tsj' || extension === '.json') return safeJson(bytes, 'Tiled document');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: true, parseTagValue: false, trimValues: true }); const parsed = parser.parse(assertSafeXml(bytes, 'Tiled XML')) as Record<string, any>;
  if (parsed.tileset) return xmlTileset(parsed.tileset);
  const map = parsed.map; if (!map) throw new Error('Tiled XML contains neither a map nor a tileset.');
  const budget = { layers: 0, cells: 0 };
  return { ...map, type: 'map', properties: tiledProperties(map.properties), tilesets: arrayify(map.tileset).map(xmlTileset), layers: [...arrayify(map.layer).map((entry) => xmlLayer(entry, 'tilelayer', 0, budget)), ...arrayify(map.objectgroup).map((entry) => xmlLayer(entry, 'objectgroup', 0, budget)), ...arrayify(map.group).map((entry) => xmlLayer(entry, 'group', 0, budget))] };
}

function integerInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return number;
}

function validateObjectPoints(source: any, label: string): void {
  const points = source?.polygon?.points ?? source?.polygon ?? source?.polyline?.points ?? source?.polyline ?? source?.points;
  const count = typeof points === 'string' ? points.split(/\s+/).filter(Boolean).length : Array.isArray(points) ? points.length : 0;
  if (count > 65_536) throw new Error(`${label} exceeds the 65,536-point limit.`);
}

function validateTilesetStructure(source: any, fallbackTileWidth: number, fallbackTileHeight: number): void {
  const tileWidth = integerInRange(source.tilewidth ?? fallbackTileWidth, 1, MAX_INLINE_IMAGE_DIMENSION, 'Tileset tile width');
  const tileHeight = integerInRange(source.tileheight ?? fallbackTileHeight, 1, MAX_INLINE_IMAGE_DIMENSION, 'Tileset tile height');
  assertImageDimensions(tileWidth, tileHeight, 'Tileset tile');
  const imageWidth = Number(source.imagewidth ?? 0); const imageHeight = Number(source.imageheight ?? 0);
  if (imageWidth || imageHeight) assertImageDimensions(imageWidth, imageHeight, 'Tileset image');
  const imageColumns = imageWidth ? Math.max(1, Math.floor(imageWidth / tileWidth)) : 1; const imageRows = imageHeight ? Math.max(1, Math.floor(imageHeight / tileHeight)) : 1;
  const tileCount = integerInRange(source.tilecount ?? Math.max(1, imageColumns * imageRows, arrayify(source.tiles ?? source.tile).length), 0, MAX_TILESET_TILES, 'Tileset tile count');
  const columns = integerInRange(source.columns ?? imageColumns, 1, Math.max(1, MAX_TILESET_TILES), 'Tileset column count');
  if (tileCount > 0 && columns > tileCount) throw new Error('Tileset columns cannot exceed its tile count.');
  const tiles = arrayify(source.tiles ?? source.tile); if (tiles.length > MAX_TILESET_TILES) throw new Error('Tileset metadata exceeds the one-million-tile limit.');
  let animationFrames = 0; let collisionObjects = 0;
  for (const tile of tiles) {
    animationFrames += arrayify(tile.animation).length; if (animationFrames > MAX_TILESET_TILES) throw new Error('Tileset animation metadata exceeds the one-million-frame limit.');
    const collisions = arrayify(tile.objectgroup?.objects ?? tile.objectgroup?.object ?? tile.collisions); collisionObjects += collisions.length; if (collisionObjects > MAX_TILED_OBJECTS) throw new Error('Tileset collision metadata exceeds the 100,000-object limit.');
    collisions.forEach((object, index) => validateObjectPoints(object, `Tileset collision ${index + 1}`));
  }
  const wangSets = arrayify(source.wangsets); if (wangSets.length > 1_024) throw new Error('Tileset exceeds the 1,024-Wang-set limit.');
  let wangTiles = 0; for (const set of wangSets) { if (arrayify(set.colors ?? set.wangcolors).length > 256) throw new Error('A Wang set exceeds the 256-color limit.'); wangTiles += arrayify(set.wangtiles).length; }
  if (wangTiles > MAX_TILESET_TILES) throw new Error('Wang terrain metadata exceeds the one-million-tile limit.');
}

function normalizeTiledMapStructure(tiled: any): void {
  const infinite = Boolean(tiled.infinite); const mapWidth = integerInRange(tiled.width ?? 0, infinite ? 0 : 1, 16_777_216, 'Tiled map width'); const mapHeight = integerInRange(tiled.height ?? 0, infinite ? 0 : 1, 16_777_216, 'Tiled map height');
  const tileWidth = integerInRange(tiled.tilewidth ?? 16, 1, MAX_INLINE_IMAGE_DIMENSION, 'Tiled map tile width'); const tileHeight = integerInRange(tiled.tileheight ?? 16, 1, MAX_INLINE_IMAGE_DIMENSION, 'Tiled map tile height'); assertImageDimensions(tileWidth, tileHeight, 'Tiled map tile');
  if (!infinite) tiledCellCount(mapWidth, mapHeight, 'Tiled map');
  const tilesets = arrayify(tiled.tilesets); if (tilesets.length > 1_024) throw new Error('Tiled map exceeds the 1,024-tileset limit.');
  let layerCount = 0; let totalCells = 0; let objectCount = 0;
  const walk = (source: any, depth: number): void => {
    if (depth > MAX_TILED_DEPTH) throw new Error('Tiled group nesting exceeds the 64-level safety limit.');
    layerCount += 1; if (layerCount > MAX_TILED_LAYERS) throw new Error(`Tiled map exceeds the ${MAX_TILED_LAYERS.toLocaleString('en-US')}-layer limit.`);
    if (source.type === 'group') { for (const child of arrayify(source.layers)) walk(child, depth + 1); return; }
    if (source.type === 'objectgroup') {
      const objects = arrayify(source.objects); objectCount += objects.length; if (objectCount > MAX_TILED_OBJECTS) throw new Error('Tiled map exceeds the 100,000-object limit.'); objects.forEach((object, index) => validateObjectPoints(object, `Map object ${index + 1}`)); return;
    }
    const chunks = arrayify(source.chunks);
    if (chunks.length) {
      if (chunks.length > 65_536) throw new Error('A Tiled layer exceeds the 65,536-chunk limit.');
      for (const [index, chunk] of chunks.entries()) {
        integerInRange(chunk.x ?? 0, -16_777_216, 16_777_216, `Tiled chunk ${index + 1} x`); integerInRange(chunk.y ?? 0, -16_777_216, 16_777_216, `Tiled chunk ${index + 1} y`);
        const width = integerInRange(chunk.width, 1, 16_777_216, `Tiled chunk ${index + 1} width`); const height = integerInRange(chunk.height, 1, 16_777_216, `Tiled chunk ${index + 1} height`);
        const input = Array.isArray(chunk.data) ? chunk.data : { '#text': chunk.data, encoding: source.encoding, compression: source.compression }; chunk.data = tiledData(input, width, height); totalCells += chunk.data.length; if (totalCells > MAX_TILED_TOTAL_CELLS) throw new Error('Tiled layer data exceeds the 16,777,216-cell total import budget.');
      }
    } else {
      const width = integerInRange(source.width ?? mapWidth, 0, 16_777_216, 'Tiled layer width'); const height = integerInRange(source.height ?? mapHeight, 0, 16_777_216, 'Tiled layer height');
      const input = Array.isArray(source.data) ? source.data : { '#text': source.data, encoding: source.encoding, compression: source.compression }; source.data = tiledData(input, width, height); totalCells += source.data.length;
    }
    if (totalCells > MAX_TILED_TOTAL_CELLS) throw new Error('Tiled layer data exceeds the 16,777,216-cell total import budget.');
  };
  for (const layer of arrayify(tiled.layers)) walk(layer, 0);
}

function wangId(value: unknown): WangSet['tiles'][number]['wangId'] {
  const values = (Array.isArray(value) ? value : String(value ?? '').split(',')).map(Number); while (values.length < 8) values.push(0); return values.slice(0, 8) as WangSet['tiles'][number]['wangId'];
}

async function attachTileset(document: ReturnType<typeof createPixelDocument>, sourceReference: any, rootFilePath: string, fallbackTileWidth: number, fallbackTileHeight: number, warnings: string[]) {
  let source = sourceReference; let sourceFilePath = rootFilePath;
  if (sourceReference.source) {
    const external = await readCompanionFile(rootFilePath, rootFilePath, String(sourceReference.source), MAX_STRUCTURED_IMPORT_BYTES, 'External Tiled tileset'); sourceFilePath = external.path; source = parseTiled(external.bytes, extname(external.path).toLowerCase());
  }
  if (source.type === 'map') throw new Error('An external Tiled tileset reference resolved to a map.'); validateTilesetStructure(source, fallbackTileWidth, fallbackTileHeight);
  const tileWidth = Number(source.tilewidth ?? fallbackTileWidth); const tileHeight = Number(source.tileheight ?? fallbackTileHeight); let imageWidth = Number(source.imagewidth ?? 0); let imageHeight = Number(source.imageheight ?? 0); let imageBytes: Buffer | undefined; let imagePath: string | undefined;
  if (typeof source.image === 'string') {
    const companion = await readCompanionFile(rootFilePath, sourceFilePath, source.image, MAX_BINARY_IMPORT_BYTES, 'Tileset image'); imagePath = companion.path; imageBytes = companion.bytes;
    try { const header = inspectImageHeader(imageBytes); assertImageDimensions(header.width, header.height, 'Tileset image'); const decoded = await loadImage(imageBytes); const size = { width: decoded.width, height: decoded.height }; if (size.width !== header.width || size.height !== header.height) throw new Error('decoded dimensions disagree with the file header'); if ((imageWidth && imageWidth !== size.width) || (imageHeight && imageHeight !== size.height)) throw new Error('declared dimensions disagree with the image file'); imageWidth = size.width; imageHeight = size.height; } catch (error) { warnings.push(`Tileset image ${source.image} could not be decoded: ${error instanceof Error ? error.message : String(error)}.`); imageBytes = undefined; imagePath = undefined; }
  }
  const columns = Math.max(1, Number(source.columns ?? (Math.floor(imageWidth / tileWidth) || 1))); const tileCount = Math.max(1, Number(source.tilecount ?? columns * Math.max(1, Math.floor(imageHeight / tileHeight)))); const rows = Math.max(1, Math.ceil(tileCount / columns)); const spriteWidth = Math.max(tileWidth, imageWidth || columns * tileWidth); const spriteHeight = Math.max(tileHeight, imageHeight || rows * tileHeight); assertImageDimensions(spriteWidth, spriteHeight, 'Tileset pixel source'); const sprite = createPixelSprite(String(source.name ?? 'Tileset pixels'), spriteWidth, spriteHeight);
  if (imageBytes) { const cel = Object.values(sprite.cels)[0]; writePixels(cel, await quantizeImageToPalette(imageBytes, sprite.width, sprite.height, document.palette, { alphaThreshold: document.conversionDefaults.alphaThreshold, dithering: document.conversionDefaults.dithering })); const embedded = imageAsset(basename(imagePath!), `image/${extname(imagePath!).slice(1).replace('jpg', 'jpeg') || 'png'}`, imageBytes); document.assets[embedded.id] = embedded; document.linkedAssets.push({ id: createId('link'), name: basename(imagePath!), mode: 'linked', relativePath: relative(dirname(rootFilePath), imagePath!).replace(/\\/g, '/'), sha256: embedded.sha256, cachedPreviewAssetId: embedded.id }); }
  const tileset = createPixelTileset(String(source.name ?? 'Tileset'), sprite.id, tileWidth, tileHeight, columns, rows); tileset.firstGid = Math.max(1, Number(sourceReference.firstgid ?? 1)); const margin = Number(source.margin ?? 0); const spacing = Number(source.spacing ?? 0); tileset.margin = margin; tileset.spacing = spacing; const metadata = new Map(arrayify(source.tiles ?? source.tile).map((tile: any) => [Number(tile.id), tile]));
  for (let id = 0; id < tileCount; id += 1) { const tile = metadata.get(id); const definition: TileDefinition = { id, sourceX: margin + id % columns * (tileWidth + spacing), sourceY: margin + Math.floor(id / columns) * (tileHeight + spacing), probability: Number(tile?.probability ?? 1), animation: arrayify(tile?.animation).map((frame: any) => ({ tileId: Number(frame.tileid ?? frame.tileId), durationMs: Number(frame.duration ?? frame.durationMs ?? 100) })), collisions: arrayify(tile?.objectgroup?.objects ?? tile?.collisions).map(tiledObject), properties: tiledProperties(tile?.properties) }; tileset.tiles[id] = definition; }
  tileset.wangSets = arrayify(source.wangsets).map((set: any): WangSet => ({ id: createId('wang'), name: String(set.name ?? 'Terrain'), type: set.type === 'corner' || set.type === 'edge' ? set.type : 'mixed', colors: arrayify(set.colors ?? set.wangcolors).map((color: any, index) => ({ id: index + 1, name: String(color.name ?? `Terrain ${index + 1}`), color: String(color.color ?? '#ff00ff'), tileId: Number(color.tile ?? -1), probability: Number(color.probability ?? 1) })), tiles: arrayify(set.wangtiles).map((tile: any) => ({ tileId: Number(tile.tileid), wangId: wangId(tile.wangid) })) }));
  const transforms = source.transformations; if (transforms) tileset.transformations = { hFlip: transforms.hflip !== false && transforms.hflip !== 0, vFlip: transforms.vflip !== false && transforms.vflip !== 0, rotate: transforms.rotate !== false && transforms.rotate !== 0 };
  document.pixelAssets[sprite.id] = sprite; document.assetIds.push(sprite.id); document.pixelAssets[tileset.id] = tileset; document.assetIds.push(tileset.id); return tileset;
}

async function importTiled(bytes: Buffer, name: string, filePath: string): Promise<ImportResult> {
  const tiled = parseTiled(bytes, extname(filePath).toLowerCase()); const warnings: string[] = [];
  if (tiled.type === 'tileset') { const document = createPixelDocument('project', name); document.assetIds = []; document.pixelAssets = {}; const tileset = await attachTileset(document, tiled, filePath, Number(tiled.tilewidth ?? 16), Number(tiled.tileheight ?? 16), warnings); document.activeAssetId = tileset.id; document.dirty = true; return { documents: [document], warnings }; }
  if (tiled.type !== 'map') throw new Error('Tiled file is neither a map nor a tileset.');
  normalizeTiledMapStructure(tiled);
  const document = createPixelDocument('tilemap', name); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected map');
  map.name = String(tiled.name ?? name); map.orientation = tiled.orientation === 'isometric' ? 'isometric' : 'orthogonal'; if (!['orthogonal', 'isometric'].includes(String(tiled.orientation ?? 'orthogonal'))) warnings.push(`Tiled ${tiled.orientation} orientation was converted to orthogonal.`); map.infinite = Boolean(tiled.infinite); map.width = Number(tiled.width ?? 0); map.height = Number(tiled.height ?? 0); map.tileWidth = Number(tiled.tilewidth ?? 16); map.tileHeight = Number(tiled.tileheight ?? 16); map.properties = tiledProperties(tiled.properties); map.layerIds = []; map.layers = {}; map.tilesetIds = [];
  for (const source of arrayify(tiled.tilesets)) { const tileset = await attachTileset(document, source, filePath, map.tileWidth, map.tileHeight, warnings); map.tilesetIds.push(tileset.id); }
  const addLayer = (source: any, parentId?: string): string => {
    const timestamp = nowIso(); const id = createId('map-layer'); const type = source.type === 'objectgroup' ? 'object' as const : source.type === 'group' ? 'group' as const : 'tile' as const;
    const layer = { id, revision: 0, name: String(source.name ?? 'Layer'), createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, type, visible: source.visible !== false && source.visible !== 0, locked: false, opacity: Number(source.opacity ?? 1), parentId, childIds: type === 'group' ? [] : undefined, chunks: type === 'tile' ? {} : undefined, objects: type === 'object' ? arrayify(source.objects).map(tiledObject) : undefined, parallaxX: Number(source.parallaxx ?? 1), parallaxY: Number(source.parallaxy ?? 1) };
    map.layers[id] = layer; if (parentId) map.layers[parentId].childIds?.push(id); else map.layerIds.push(id);
    if (type === 'tile' && layer.chunks) for (const chunk of source.chunks ?? [{ x: 0, y: 0, width: Number(source.width ?? map.width), height: Number(source.height ?? map.height), data: source.data ?? [] }]) { const width = Number(chunk.width || map.width || 1); const changes = arrayify(chunk.data).map((gid, index) => ({ x: Number(chunk.x ?? 0) + index % width, y: Number(chunk.y ?? 0) + Math.floor(index / width), gid: Number(gid) })); writeTiles(layer.chunks, changes); }
    if (type === 'group') for (const child of arrayify(source.layers)) addLayer(child, id); return id;
  };
  for (const source of arrayify(tiled.layers)) addLayer(source); document.dirty = true; return { documents: [document], warnings };
}

async function importPdf(bytes: Buffer, name: string, pixelMode: boolean): Promise<ImportResult> {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const loadingTask = pdfjs.getDocument({ data: Uint8Array.from(bytes) }); const documents: AIDrawDocument[] = [];
  type PdfPage = Awaited<ReturnType<Awaited<typeof loadingTask.promise>['getPage']>>;
  type PdfViewport = ReturnType<PdfPage['getViewport']>;
  const acquiredPages: PdfPage[] = []; const cleanupAttempted = new Set<PdfPage>(); let pageCleanupFailed = false; let pageCleanupError: unknown;
  const cleanupPage = (page: PdfPage) => {
    if (cleanupAttempted.has(page)) return;
    cleanupAttempted.add(page);
    try { page.cleanup(); } catch (error) { if (!pageCleanupFailed) { pageCleanupFailed = true; pageCleanupError = error; } }
  };
  let result!: ImportResult; let importFailed = false; let importError: unknown;
  try {
    const source = await loadingTask.promise;
    if (source.numPages < 1 || source.numPages > MAX_PDF_PAGES) throw new Error(`PDF page count ${source.numPages} exceeds AIDraw's ${MAX_PDF_PAGES}-page import limit.`);
    const pages: Array<{ pageNumber: number; page: PdfPage; viewport: PdfViewport; width: number; height: number }> = []; let expandedPixels = 0;
    for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber += 1) {
      const page = await source.getPage(pageNumber); acquiredPages.push(page); const viewport = page.getViewport({ scale: 1 }); const width = Math.max(1, Math.ceil(viewport.width)); const height = Math.max(1, Math.ceil(viewport.height)); assertImageDimensions(width, height, `PDF page ${pageNumber}`); expandedPixels += width * height; if (expandedPixels > MAX_PDF_EXPANDED_PIXELS) throw new Error('PDF pages exceed the 64-megapixel expanded import budget.'); pages.push({ pageNumber, page, viewport, width, height });
    }
    let extractedTextItems = 0; let extractedTextSerializedBytes = 0;
    for (const { pageNumber, page, viewport, width, height } of pages) {
      let pageFailed = false; let pageError: unknown;
      try {
        const png = await renderPdfPagePng(width, height, async (canvasContext) => { await page.render({ canvas: null, canvasContext, viewport }).promise; });
        const pageName = source.numPages > 1 ? `${name} · Page ${pageNumber}` : name; const imported = await importRaster(png, pageName, 'image/png', pixelMode); const document = imported.documents[0];
        if (document.kind === 'illustration') {
          const timestamp = nowIso(); const textLayer: IllustrationLayer = { id: createId('layer'), revision: 0, name: 'Editable PDF text (hidden)', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, interchangeRole: 'pdf-extracted-text', visible: false, locked: false, opacity: 1, blendMode: 'normal', type: 'vector', objectIds: [] }; const text = await page.getTextContent(); extractedTextItems += text.items.length; if (extractedTextItems > 250_000) throw new Error('PDF exceeds the 250,000-item editable-text extraction limit.');
          for (const item of text.items) if ('str' in item && item.str) { extractedTextSerializedBytes = accountPdfEditableText(extractedTextSerializedBytes, item.str); const fontSize = Math.max(1, Math.hypot(item.transform[0], item.transform[1])); const object: TextObject = { ...entityBase(item.str.slice(0, 32), textLayer.id), type: 'text', text: item.str, width: Math.max(1, item.width), height: Math.max(1, item.height || fontSize), align: 'left', lineHeight: 1.2, ranges: [{ start: 0, end: item.str.length, fontFamily: item.fontName || 'sans-serif', fontSize, fontWeight: 400, fontStyle: 'normal', color: '#000000', letterSpacing: 0 }] }; object.transform.x = item.transform[4]; object.transform.y = viewport.height - item.transform[5] - fontSize; document.objects[object.id] = object; textLayer.objectIds.push(object.id); }
          if (textLayer.objectIds.length) { document.layers[textLayer.id] = textLayer; document.layerIds.push(textLayer.id); }
        }
        documents.push(validateImportedPdfDocument(document));
      } catch (error) { pageFailed = true; pageError = error; }
      cleanupPage(page);
      if (pageFailed) throw pageError;
      if (pageCleanupFailed) throw pageCleanupError;
    }
    result = { documents, warnings: ['PDF pages retain a faithful raster fallback. Extracted text is placed on a hidden editable layer and retained invisibly on PDF re-export when supported; unsupported operators and effects remain rasterized.'] };
  } catch (error) {
    importFailed = true; importError = error;
  }
  for (const page of acquiredPages) cleanupPage(page);
  let destroyFailed = false; let destroyError: unknown;
  try { await loadingTask.destroy(); } catch (error) { destroyFailed = true; destroyError = error; }
  if (importFailed) throw importError;
  if (pageCleanupFailed) throw pageCleanupError;
  if (destroyFailed) throw destroyError;
  return result;
}

export async function importDocument(filePath: string, pixelMode = false): Promise<ImportResult> {
  const extension = extname(filePath).toLowerCase(); const name = basename(filePath, extension); const supported = ['.png', '.apng', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.psd', '.pdf', '.json', '.tmj', '.tmx', '.tsj', '.tsx'];
  if (!supported.includes(extension)) throw new Error(`Unsupported import format: ${extension}`);
  const structured = ['.svg', '.json', '.tmj', '.tmx', '.tsj', '.tsx'].includes(extension); const bytes = await readBoundedImportFile(filePath, structured ? MAX_STRUCTURED_IMPORT_BYTES : MAX_BINARY_IMPORT_BYTES);
  if (['.png', '.apng', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) assertImportedInlineAssetBytes(bytes, 'Image source');
  if ((extension === '.png' || extension === '.apng') && pixelMode) { const animated = importApngBytes(bytes, name); if (animated) return animated; }
  if (extension === '.gif') { if (pixelMode) return importGifBytes(bytes, name); inspectGif(bytes); }
  if (['.png', '.apng', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return importRaster(bytes, name, extension === '.png' || extension === '.apng' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : 'image/jpeg', pixelMode);
  if (extension === '.svg') { if (!pixelMode) return importSvg(bytes, name); importSvg(bytes, name); const rendered = await loadImage(bytes); assertImageDimensions(rendered.width, rendered.height, 'SVG'); const canvas = createCanvas(rendered.width, rendered.height); canvas.getContext('2d').drawImage(rendered, 0, 0); return importRaster(canvas.toBuffer('image/png'), name, 'image/png', true); }
  if (extension === '.psd') return importPsd(bytes, name, pixelMode);
  if (extension === '.pdf') return importPdf(bytes, name, pixelMode);
  if (extension === '.json' && pixelMode) { const metadata = safeJson(bytes, 'JSON import'); if (metadata.frames && metadata.meta) return importSpriteSheet(bytes, name, filePath); }
  if (extension === '.tmj' || extension === '.tmx' || extension === '.tsj' || extension === '.tsx' || extension === '.json') return importTiled(bytes, name, filePath);
  throw new Error(`Unsupported import format: ${extension}`);
}
