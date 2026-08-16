import { createHash } from 'node:crypto';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  createPixelDocument,
  nowIso,
  writePixels,
  type AIDrawDocument,
  type CanvasOperation,
  type CanvasTransaction,
  type DocumentAsset,
  type ImageObject,
  type PaletteEntry,
  type PixelDocument,
} from '@aidraw/core';
import type { ApplyTransactionResponse, PixelSelectionClipboardReadResult, PixelSelectionPngPasteRequest } from '../common/contracts';
import {
  MAX_FRAGMENT_BYTES,
  exportIllustrationFragment,
  exportPixelFragment,
  importDocumentFragmentOperations,
  parseDocumentFragment,
  type AIDrawFragment,
} from '../common/document-fragment';
import { assertPixelSelectionPngGeometry, planPixelSelectionPngPaste } from '../common/pixel-selection-clipboard';
import { illustrationToSvg } from './export-document';
import {
  inspectDocumentImageAsset,
  MAX_INLINE_ASSET_BYTES,
  MAX_INLINE_IMAGE_DIMENSION,
  MAX_INLINE_IMAGE_PIXELS,
} from './transaction-policy';

export const AIDRAW_CLIPBOARD_HTML_VERSION = 1;
export const MAX_CLIPBOARD_HTML_BYTES = 16 * 1024 * 1024;
export const MAX_CLIPBOARD_FRAGMENT_BASE64_CHARACTERS = Math.ceil(MAX_FRAGMENT_BYTES / 3) * 4;

export interface ClipboardWriteData {
  text: string;
  html: string;
  png?: Buffer;
  pngSize?: { width: number; height: number };
}

export interface ClipboardPng {
  bytes: Buffer;
  width: number;
  height: number;
}

export interface ClipboardGateway {
  write(data: ClipboardWriteData): void;
  readHtml(): string;
  readPng(): ClipboardPng | undefined;
}

export interface ClipboardRasterGateway {
  renderPng(document: AIDrawDocument): Promise<Buffer>;
  quantizePng(
    bytes: Buffer,
    width: number,
    height: number,
    palette: PaletteEntry[],
    settings: { alphaThreshold: number; dithering: 'none' | 'bayer-4x4' | 'floyd-steinberg'; includeTransparent?: boolean },
  ): Promise<Array<{ x: number; y: number; index: number }>>;
}

export interface ClipboardWorkflowDependencies {
  clipboard: ClipboardGateway;
  raster: ClipboardRasterGateway;
  getActiveDocument(): AIDrawDocument | undefined;
  apply(transaction: CanvasTransaction): Promise<ApplyTransactionResponse>;
}

export type ParsedClipboardHtml =
  | { status: 'absent' }
  | { status: 'valid'; fragment: AIDrawFragment }
  | { status: 'invalid'; message: string };

function invalidClipboard(message: string): ParsedClipboardHtml {
  return { status: 'invalid', message: `AIDraw clipboard data is invalid: ${message}` };
}

function privateAttributePattern(name: string, suffix = ''): RegExp {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[<\\s])${escapedName}${suffix}`, 'gu');
}

function attributeValue(html: string, name: string): string | undefined {
  const declarations = privateAttributePattern(name, '(?=\\s*=)');
  const firstDeclaration = declarations.exec(html);
  if (!firstDeclaration) return undefined;
  if (declarations.exec(html)) throw new Error(`duplicate ${name} attribute`);
  const expression = privateAttributePattern(name, '\\s*=\\s*(["\'])([^"\']*)\\1');
  return expression.exec(html)?.[2];
}

export function serializeAIDrawClipboardHtml(fragment: AIDrawFragment, visualMarkup: string): string {
  const normalized = parseDocumentFragment(fragment);
  const json = Buffer.from(JSON.stringify(normalized));
  if (json.byteLength > MAX_FRAGMENT_BYTES) throw new Error('Document fragment exceeds the 2 MiB exchange limit.');
  const encoded = json.toString('base64');
  const sha256 = createHash('sha256').update(json).digest('hex');
  const opening = `<div data-aidraw-version="${AIDRAW_CLIPBOARD_HTML_VERSION}" data-aidraw-sha256="${sha256}" data-aidraw="${encoded}">`;
  const complete = `${opening}${visualMarkup}</div>`;
  if (Buffer.byteLength(complete) <= MAX_CLIPBOARD_HTML_BYTES) return complete;
  return `${opening}<span>AIDraw artwork</span></div>`;
}

export function parseAIDrawClipboardHtml(html: string): ParsedClipboardHtml {
  const hasMarker = privateAttributePattern('data-aidraw', '(?=\\s*=)').test(html);
  if (!hasMarker) return { status: 'absent' };
  if (Buffer.byteLength(html) > MAX_CLIPBOARD_HTML_BYTES) return invalidClipboard('HTML envelope exceeds the 16 MiB limit.');
  let encoded: string | undefined;
  let version: string | undefined;
  let expectedSha256: string | undefined;
  try {
    encoded = attributeValue(html, 'data-aidraw');
    version = attributeValue(html, 'data-aidraw-version');
    expectedSha256 = attributeValue(html, 'data-aidraw-sha256');
  } catch (error) {
    return invalidClipboard(error instanceof Error ? error.message : 'duplicate private attributes');
  }
  if (!encoded) return invalidClipboard('private fragment attribute is malformed.');
  if (encoded.length > MAX_CLIPBOARD_FRAGMENT_BASE64_CHARACTERS) return invalidClipboard('fragment exceeds the 2 MiB exchange limit.');
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    return invalidClipboard('fragment is not canonical base64.');
  }
  const json = Buffer.from(encoded, 'base64');
  if (json.byteLength > MAX_FRAGMENT_BYTES || json.toString('base64') !== encoded) return invalidClipboard('fragment exceeds the 2 MiB exchange limit.');
  const currentEnvelope = version !== undefined || expectedSha256 !== undefined;
  if (currentEnvelope) {
    if (version !== String(AIDRAW_CLIPBOARD_HTML_VERSION) || !expectedSha256 || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
      return invalidClipboard('version or SHA-256 identity is malformed.');
    }
    const actualSha256 = createHash('sha256').update(json).digest('hex');
    if (actualSha256 !== expectedSha256) return invalidClipboard('fragment SHA-256 does not match.');
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(json);
    return { status: 'valid', fragment: parseDocumentFragment(JSON.parse(decoded)) };
  } catch {
    return invalidClipboard('fragment JSON or canonical content is malformed.');
  }
}

export function pixelSelectionPngDocument(value: unknown): PixelDocument {
  const fragment = parseDocumentFragment(value);
  if (fragment.kind !== 'pixel-selection') throw new Error('Only an indexed pixel selection can use the pixel-selection clipboard route.');
  assertClipboardImageGeometry(fragment.grid.width, fragment.grid.height);
  const document = createPixelDocument('sprite', 'Clipboard pixel selection');
  document.palette = fragment.palette.map((color, index) => ({
    id: `clipboard-palette-${index}`,
    name: index === 0 ? 'Transparent' : `Clipboard ${index}`,
    color,
  }));
  const sprite = document.pixelAssets[document.activeAssetId];
  if (!sprite || sprite.type !== 'sprite') throw new Error('The clipboard selection preview sprite is unavailable.');
  sprite.width = fragment.grid.width;
  sprite.height = fragment.grid.height;
  const cel = Object.values(sprite.cels)[0];
  if (!cel) throw new Error('The clipboard selection preview cel is unavailable.');
  writePixels(cel, fragment.grid.cells.map((cell) => ({ x: cell.x, y: cell.y, index: cell.value })));
  return document;
}

export async function copyPixelSelectionToClipboard(
  dependencies: Pick<ClipboardWorkflowDependencies, 'clipboard' | 'raster'>,
  value: unknown,
): Promise<{ copied: true }> {
  const fragment = parseDocumentFragment(value);
  if (fragment.kind !== 'pixel-selection') throw new Error('Only an indexed pixel selection can use the pixel-selection clipboard route.');
  const standardDocument = pixelSelectionPngDocument(fragment);
  const png = await dependencies.raster.renderPng(standardDocument);
  clipboardPngAsset({ bytes: png, width: fragment.grid.width, height: fragment.grid.height });
  dependencies.clipboard.write({
    text: JSON.stringify(fragment),
    html: serializeAIDrawClipboardHtml(fragment, '<span>AIDraw indexed pixel selection</span>'),
    png,
    pngSize: { width: fragment.grid.width, height: fragment.grid.height },
  });
  return { copied: true };
}

function parsedPixelSelectionPngPasteRequest(value: unknown): PixelSelectionPngPasteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The standard PNG paste target is invalid.');
  const request = value as Partial<PixelSelectionPngPasteRequest>;
  const keys = Object.keys(value).sort();
  if (keys.length !== 6 || keys.some((key, index) => key !== ['celId', 'documentId', 'expectedDocumentRevision', 'frameId', 'origin', 'spriteId'][index])) {
    throw new Error('The standard PNG paste target is invalid.');
  }
  if (![request.documentId, request.spriteId, request.frameId, request.celId].every((entry) => typeof entry === 'string' && entry.length > 0)
    || !Number.isSafeInteger(request.expectedDocumentRevision) || Number(request.expectedDocumentRevision) < 0
    || !request.origin || Object.keys(request.origin).sort().join(',') !== 'x,y'
    || !Number.isSafeInteger(request.origin.x) || !Number.isSafeInteger(request.origin.y)) {
    throw new Error('The standard PNG paste target is invalid.');
  }
  return request as PixelSelectionPngPasteRequest;
}

function selectedSpriteId(document: PixelDocument): string | undefined {
  const active = document.pixelAssets[document.activeAssetId];
  if (active?.type === 'sprite') return active.id;
  if (active?.type === 'tileset') return active.spriteAssetId;
  return undefined;
}

export async function readPixelSelectionFromClipboard(
  dependencies: Pick<ClipboardWorkflowDependencies, 'clipboard' | 'raster' | 'getActiveDocument'>,
  requestValue?: unknown,
): Promise<PixelSelectionClipboardReadResult> {
  let parsed: ParsedClipboardHtml;
  try {
    parsed = parseAIDrawClipboardHtml(dependencies.clipboard.readHtml());
  } catch {
    return { status: 'invalid', message: 'The system clipboard could not be read safely.' };
  }
  if (parsed.status === 'invalid') return parsed;
  if (parsed.status === 'valid') {
    if (parsed.fragment.kind !== 'pixel-selection') {
      return { status: 'incompatible', message: 'The AIDraw clipboard contains whole artwork rather than an indexed pixel selection.' };
    }
    return { status: 'valid', fragment: parsed.fragment };
  }

  try {
    const png = dependencies.clipboard.readPng();
    if (!png) return { status: 'absent', message: 'The system clipboard has no AIDraw indexed selection or standard PNG.' };
    clipboardPngAsset(png);
    if (requestValue === undefined) return { status: 'png', width: png.width, height: png.height };
    const request = parsedPixelSelectionPngPasteRequest(requestValue);
    const active = dependencies.getActiveDocument();
    if (!active || active.kind !== 'pixel' || active.id !== request.documentId) throw new Error('The active pixel document changed before the standard PNG could be pasted.');
    if (active.revision !== request.expectedDocumentRevision) throw new Error('The active pixel document changed; observe it again before pasting the standard PNG.');
    if (selectedSpriteId(active) !== request.spriteId) throw new Error('The selected sprite changed before the standard PNG could be pasted.');
    assertPixelSelectionPngGeometry(png.width, png.height);
    const sprite = active.pixelAssets[request.spriteId];
    if (!sprite || sprite.type !== 'sprite') throw new Error('The selected sprite is no longer available.');
    const palette = sprite.paletteOverrides[request.frameId] ?? active.palette;
    if (palette.length !== active.palette.length) throw new Error('The destination frame palette does not align with the document palette.');
    const changes = await dependencies.raster.quantizePng(png.bytes, png.width, png.height, palette, {
      alphaThreshold: active.conversionDefaults.alphaThreshold,
      dithering: active.conversionDefaults.dithering,
      includeTransparent: true,
    });
    const plan = planPixelSelectionPngPaste({
      document: active,
      spriteId: request.spriteId,
      frameId: request.frameId,
      celId: request.celId,
      origin: request.origin,
    }, { width: png.width, height: png.height, changes });
    return { status: 'png', width: png.width, height: png.height, plan };
  } catch (error) {
    return { status: 'invalid', message: error instanceof Error ? error.message : 'The standard PNG clipboard image is invalid.' };
  }
}

export function assertClipboardImageGeometry(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_INLINE_IMAGE_DIMENSION || height > MAX_INLINE_IMAGE_DIMENSION
    || width * height > MAX_INLINE_IMAGE_PIXELS) {
    throw new Error(`Clipboard image dimensions must fit ${MAX_INLINE_IMAGE_DIMENSION}px per side and ${MAX_INLINE_IMAGE_PIXELS.toLocaleString('en-US')} pixels.`);
  }
}

export function clipboardPngAsset(input: ClipboardPng): DocumentAsset {
  assertClipboardImageGeometry(input.width, input.height);
  if (input.bytes.byteLength > MAX_INLINE_ASSET_BYTES) {
    throw new Error(`Clipboard PNG exceeds AIDraw's ${MAX_INLINE_ASSET_BYTES.toLocaleString('en-US')}-byte editable-asset limit.`);
  }
  const asset: DocumentAsset = {
    id: createId('asset'),
    name: 'Clipboard image',
    mimeType: 'image/png',
    byteLength: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    source: 'imported',
    data: input.bytes.toString('base64'),
  };
  const inspected = inspectDocumentImageAsset(asset, { maxBytes: MAX_INLINE_ASSET_BYTES, limitLabel: '1.5 MB', label: 'Clipboard image' });
  if (inspected.expected.width !== input.width || inspected.expected.height !== input.height) {
    throw new Error('Clipboard image decoded geometry does not match its native clipboard geometry.');
  }
  return asset;
}

export async function copySelectionToClipboard(
  dependencies: ClipboardWorkflowDependencies,
  objectIds: string[],
): Promise<{ copied: boolean; kind?: string }> {
  const document = dependencies.getActiveDocument();
  if (!document) return { copied: false };
  let fragment: AIDrawFragment;
  let standardDocument: AIDrawDocument;
  let svg = '';
  if (document.kind === 'illustration') {
    standardDocument = structuredClone(document);
    fragment = exportIllustrationFragment(document, objectIds);
    if (fragment.kind !== 'illustration-objects') throw new Error('Illustration copy produced an incompatible fragment.');
    const ids = new Set(fragment.objects.map((object) => object.id));
    standardDocument.objects = Object.fromEntries(fragment.objects.map((object) => [object.id, object]));
    for (const layer of Object.values(standardDocument.layers)) {
      if (layer.type === 'vector') layer.objectIds = layer.objectIds.filter((objectId) => ids.has(objectId));
    }
    svg = illustrationToSvg(standardDocument);
  } else {
    standardDocument = structuredClone(document);
    fragment = exportPixelFragment(document);
  }
  const png = await dependencies.raster.renderPng(standardDocument);
  const text = svg || JSON.stringify(fragment);
  dependencies.clipboard.write({
    text,
    html: serializeAIDrawClipboardHtml(fragment, svg || '<span>AIDraw pixel artwork</span>'),
    png,
  });
  return { copied: true, kind: fragment.kind };
}

export async function pasteFromClipboard(
  dependencies: ClipboardWorkflowDependencies,
): Promise<ApplyTransactionResponse> {
  const document = dependencies.getActiveDocument();
  if (!document) return { status: 'conflict', message: 'No active document.' };
  const parsed = parseAIDrawClipboardHtml(dependencies.clipboard.readHtml());
  if (parsed.status === 'invalid') return { status: 'conflict', message: parsed.message };
  const operations: CanvasOperation[] = [];
  if (parsed.status === 'valid') {
    try {
      if (parsed.fragment.kind === 'pixel-selection') throw new Error('Paste indexed selections from the sprite selection controls.');
      operations.push(...importDocumentFragmentOperations(document, parsed.fragment));
    } catch (error) {
      return { status: 'conflict', message: error instanceof Error ? error.message : 'The AIDraw fragment is invalid.' };
    }
  } else {
    let png: ClipboardPng | undefined;
    let asset: DocumentAsset;
    try {
      png = dependencies.clipboard.readPng();
      if (!png) return { status: 'conflict', message: 'Clipboard has no AIDraw objects or image.' };
      asset = clipboardPngAsset(png);
    } catch (error) {
      return { status: 'conflict', message: error instanceof Error ? error.message : 'The clipboard image is invalid.' };
    }
    if (document.kind === 'illustration') {
      const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
      if (!layer || layer.type !== 'vector') return { status: 'conflict', message: 'Add a vector layer before pasting.' };
      const timestamp = nowIso();
      const object: ImageObject = {
        id: createId('object'), revision: 0, name: 'Clipboard image', createdAt: timestamp, updatedAt: timestamp,
        createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal',
        transform: { ...IDENTITY_TRANSFORM, x: 16, y: 16 }, type: 'image', assetId: asset.id,
        width: png.width, height: png.height, sourceWidth: png.width, sourceHeight: png.height, filters: [],
      };
      operations.push({ kind: 'asset.add', asset }, { kind: 'illustration.object.add', object });
    } else {
      const sprite = document.pixelAssets[document.activeAssetId];
      if (sprite?.type !== 'sprite') return { status: 'conflict', message: 'Choose a sprite before pasting pixels.' };
      const frameId = sprite.frameIds[0];
      const layerId = [...sprite.layerIds].reverse().find((entry) => sprite.layers[entry]?.type === 'pixel');
      const cel = Object.values(sprite.cels).find((entry) => entry.frameId === frameId && entry.layerId === layerId);
      if (!cel) return { status: 'conflict', message: 'The sprite has no editable cel.' };
      try {
        const changes = await dependencies.raster.quantizePng(png.bytes, sprite.width, sprite.height, document.palette, {
          alphaThreshold: document.conversionDefaults.alphaThreshold,
          dithering: document.conversionDefaults.dithering,
        });
        operations.push({ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes, expectedRevision: cel.revision });
      } catch (error) {
        return { status: 'conflict', message: `Clipboard image conversion failed: ${error instanceof Error ? error.message : 'unsupported image'}.` };
      }
    }
  }
  const transaction: CanvasTransaction = {
    id: createId('tx'), clientOperationId: createId('clipboard'), documentId: document.id, actor: HUMAN_ACTOR,
    label: 'Paste', createdAt: nowIso(), operations, playback: { mode: 'instant', speed: 1 },
  };
  return dependencies.apply(transaction);
}
