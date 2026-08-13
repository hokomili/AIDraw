import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import UPNG from 'upng-js';
import { migrateDocument, type AIDrawDocument, type PaletteEntry } from '@aidraw/core';
import type { ExportFormat, ExportOptions } from '../common/contracts';
import type { QuantizeImageOptions } from './quantize-image';
import type { SpriteSheetSliceOptions } from '../common/sprite-sheet';
import type { ObservationRequest } from './capture-observation';
import {
  GENERATION_ACCEPTANCE_WEBP_QUALITIES,
  type GeneratedAcceptancePreparation,
  type GeneratedOutput,
  type GenerationRequest,
} from '../common/generation';
import { inspectImageHeader, MAX_INLINE_ASSET_BYTES, MAX_INLINE_IMAGE_DIMENSION, MAX_INLINE_IMAGE_PIXELS } from './transaction-policy';
import type { Fnd09QuantizationResultFault } from './utility-quantization-result-e2e-contract';
import type { Fnd09ExportResultFault } from './utility-export-result-e2e-contract';
import type { Fnd09ImportResultFault } from './utility-import-result-e2e-contract';
import type { Fnd09GenerationResultFixture } from './utility-generation-result-e2e-contract';
import { expectedExportArtifactIdentity, type ExportArtifactMemberIdentity } from './export-artifact-policy';
import {
  MAX_EXPORT_UTILITY_MEMBERS,
  MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES,
  MAX_GENERATION_PROGRESS_MESSAGE_BYTES,
  MAX_GENERATION_PROVIDER_METADATA_BYTES,
  MAX_GENERATION_PROVIDER_METADATA_DEPTH,
  MAX_GENERATION_PROVIDER_METADATA_NODES,
  MAX_IMPORT_UTILITY_DEPTH,
  MAX_IMPORT_UTILITY_NODES,
  MAX_IMPORT_UTILITY_SERIALIZED_BYTES,
  MAX_UTILITY_ERROR_CODE_BYTES,
  MAX_UTILITY_ERROR_MESSAGE_BYTES,
  MAX_UTILITY_REPORT_ENTRIES,
  MAX_UTILITY_REPORT_SERIALIZED_BYTES,
  MAX_UTILITY_TEXT_BYTES,
  assertUtilityAggregateByteLimit,
  assertUtilityJsonBudget,
  isBoundedUtilityString,
} from './utility-resource-policy';

export {
  MAX_EXPORT_UTILITY_MEMBERS,
  MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES,
  MAX_GENERATION_PROGRESS_MESSAGE_BYTES,
  MAX_GENERATION_PROVIDER_METADATA_BYTES,
  MAX_IMPORT_UTILITY_SERIALIZED_BYTES,
  MAX_UTILITY_ERROR_CODE_BYTES,
  MAX_UTILITY_ERROR_MESSAGE_BYTES,
  MAX_UTILITY_REPORT_ENTRIES,
  MAX_UTILITY_REPORT_SERIALIZED_BYTES,
  MAX_UTILITY_TEXT_BYTES,
} from './utility-resource-policy';

export const MAX_QUANTIZE_UTILITY_SOURCE_BYTES = MAX_INLINE_ASSET_BYTES;
export const MAX_QUANTIZE_UTILITY_BASE64_CHARACTERS = 2_000_000;
const MAX_EXPORT_UTILITY_BASE64_CHARACTERS = Math.ceil(MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES / 3) * 4;
/** PDF is the only multi-document importer and already caps its page/result count here. */
export const MAX_IMPORT_UTILITY_DOCUMENTS = 256;
/** captureObservation already rejects a static PNG above this decoded-byte ceiling. */
export const MAX_OBSERVATION_PNG_BYTES = 4 * 1024 * 1024;
/** Includes the maximum base64 PNG plus bounded JSON observation metadata. */
export const MAX_OBSERVATION_UTILITY_RESULT_SERIALIZED_BYTES = Math.ceil(MAX_OBSERVATION_PNG_BYTES / 3) * 4 + 64 * 1024;
/** Provider adapters enforce these per-image limits before returning generated output. */
export const MAX_GENERATED_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_GENERATED_OUTPUT_SIDE = 8_192;
export const MAX_GENERATED_OUTPUT_PIXELS = 32 * 1024 * 1024;

interface QuantizeUtilityParameters {
  width?: unknown;
  height?: unknown;
  palette?: unknown;
  options?: { dithering?: unknown; alphaThreshold?: unknown } | null;
}

/** Keep supervisor admission and worker validation on the same quantization limits. */
export function assertQuantizeUtilityParameters(request: QuantizeUtilityParameters): void {
  if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || Number(request.width) < 1 || Number(request.height) < 1 || Number(request.width) > 8_192 || Number(request.height) > 8_192 || Number(request.width) * Number(request.height) > 1_000_000) throw new Error('Quantization dimensions exceed the one-million-pixel utility limit.');
  if (!Array.isArray(request.palette) || request.palette.length < 2 || request.palette.length > 256) throw new Error('Quantization requires a 2–256 entry palette.');
  if (!request.options || typeof request.options.dithering !== 'string' || !['none', 'bayer-4x4', 'floyd-steinberg'].includes(request.options.dithering) || typeof request.options.alphaThreshold !== 'number' || !Number.isFinite(request.options.alphaThreshold) || request.options.alphaThreshold < 0 || request.options.alphaThreshold > 1) throw new Error('Invalid quantization settings.');
}

export interface QuantizeUtilityRequest {
  id: string;
  kind: 'quantize-image';
  encodedBase64: string;
  width: number;
  height: number;
  palette: PaletteEntry[];
  options: QuantizeImageOptions;
  /** Fixed private packaged-QA fault; accepted only by the isolated worker gate. */
  e2eResultFault?: Fnd09QuantizationResultFault;
}

export interface ExportUtilityRequest {
  id: string;
  kind: 'export-document';
  document: AIDrawDocument;
  format: ExportFormat;
  options: ExportOptions;
  /** Fixed private packaged-QA fault; accepted only by the isolated worker gate. */
  e2eArtifactFault?: Fnd09ExportResultFault;
}

export interface ImportUtilityRequest {
  id: string;
  kind: 'import-document';
  filePath: string;
  pixelMode: boolean;
  spriteSheet?: {
    options: SpriteSheetSliceOptions;
    name: string;
    mimeType: string;
    expectedSha256: string;
  };
  /** Fixed private packaged-QA fault; accepted only by the isolated worker gate. */
  e2eResultFault?: Fnd09ImportResultFault;
}

export interface ObservationUtilityRequest {
  id: string;
  kind: 'capture-observation';
  document: AIDrawDocument;
  request: ObservationRequest;
  maxPixels: number;
  /** Fixed private packaged-QA fault; accepted only by the isolated worker gate. */
  e2eCorruptIdat?: true;
}

export interface GenerationUtilityRequest {
  id: string;
  kind: 'generation-run';
  jobId: string;
  document: AIDrawDocument;
  request: GenerationRequest;
  credential?: string;
  /** Fixed provider-free packaged-QA result; accepted only by the isolated worker gate. */
  e2eResultFixture?: Fnd09GenerationResultFixture;
}

export interface NormalizeGenerationAcceptanceUtilityRequest {
  id: string;
  kind: 'normalize-generation-acceptance';
  output: GeneratedOutput;
}

export interface UtilityCancelRequest {
  id: string;
  kind: 'utility-cancel';
}

/** Fixed packaged-QA probe; unavailable unless the isolated FND-09 hook is enabled. */
export interface UtilityContainmentProbeRequest {
  id: string;
  kind: 'containment-probe';
  mode: 'crash' | 'hang' | 'pressure-gate';
}

export interface SerializedExportArtifact {
  dataBase64: string;
  mimeType: string;
  extension: string;
  report: { warnings: string[]; rasterized: string[] };
  companion?: { dataBase64: string; extension: string; mimeType: string; name?: string };
  companions?: Array<{ dataBase64: string; extension: string; mimeType: string; name: string }>;
}

export type UtilityRequest = QuantizeUtilityRequest | ExportUtilityRequest | ImportUtilityRequest | ObservationUtilityRequest | GenerationUtilityRequest | NormalizeGenerationAcceptanceUtilityRequest | UtilityContainmentProbeRequest;

export type UtilityResponse =
  | { id: string; ok: true; kind: 'quantize-image'; changes: Array<{ x: number; y: number; index: number }> }
  | { id: string; ok: true; kind: 'export-document'; artifact: SerializedExportArtifact }
  | { id: string; ok: true; kind: 'import-document'; documents: AIDrawDocument[]; warnings: string[] }
  | { id: string; ok: true; kind: 'capture-observation'; result: Record<string, unknown> }
  | { id: string; ok: true; kind: 'generation-run'; outputs: GeneratedOutput[] }
  | { id: string; ok: true; kind: 'normalize-generation-acceptance'; result: GeneratedAcceptancePreparation }
  | { id: string; ok: true; kind: 'containment-probe' }
  | { id: string; ok: true; kind: 'generation-progress'; progress: number; message: string }
  | { id: string; ok: false; error: { code: string; message: string } };

/** Reject compromised/malformed quantization output before it can become canonical operations. */
export function assertQuantizeUtilityResponse(
  request: QuantizeUtilityRequest,
  value: unknown,
): asserts value is Extract<UtilityResponse, { ok: true; kind: 'quantize-image' }> {
  if (!value || typeof value !== 'object') throw new Error('Raster utility returned a malformed quantization result.');
  const response = value as { kind?: unknown; changes?: unknown };
  if (response.kind !== 'quantize-image' || !Array.isArray(response.changes)) throw new Error('Raster utility returned a malformed quantization result.');
  const pixelBudget = request.width * request.height;
  if (response.changes.length > pixelBudget) throw new Error(`Raster utility quantization result exceeds its ${pixelBudget}-pixel output budget.`);
  const seen = new Uint8Array(pixelBudget);
  for (const candidate of response.changes) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Raster utility returned a malformed quantization result.');
    const change = candidate as { x?: unknown; y?: unknown; index?: unknown };
    if (!Number.isInteger(change.x) || !Number.isInteger(change.y) || !Number.isInteger(change.index)
      || Number(change.x) < 0 || Number(change.y) < 0 || Number(change.x) >= request.width || Number(change.y) >= request.height
      || Number(change.index) < 0 || Number(change.index) >= request.palette.length) {
      throw new Error('Raster utility returned a malformed quantization result.');
    }
    const offset = Number(change.y) * request.width + Number(change.x);
    if (seen[offset]) throw new Error('Raster utility returned a malformed quantization result.');
    seen[offset] = 1;
  }
}

function base64Sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/** Worker serialization is Buffer.toString('base64'); validate that exact syntax without decoding. */
function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bodyLength = value.length - padding;
  for (let index = 0; index < bodyLength; index += 1) if (base64Sextet(value.charCodeAt(index)) < 0) return false;
  for (let index = bodyLength; index < value.length; index += 1) if (value.charCodeAt(index) !== 61) return false;
  if (padding === 2 && (base64Sextet(value.charCodeAt(value.length - 3)) & 0x0f) !== 0) return false;
  if (padding === 1 && (base64Sextet(value.charCodeAt(value.length - 2)) & 0x03) !== 0) return false;
  return true;
}

function base64DecodedByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function hasKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return isBoundedUtilityString(value, MAX_UTILITY_TEXT_BYTES, false);
}

/**
 * Progress is advisory rather than a terminal utility result. Relay only the
 * established finite 0–1/string shape for the active generation request; a
 * malformed or cross-lane message stays invisible while the terminal result,
 * timeout, or cancellation path remains authoritative.
 */
export function isGenerationProgressUtilityResponse(
  request: UtilityRequest,
  value: unknown,
): value is Extract<UtilityResponse, { ok: true; kind: 'generation-progress' }> {
  if (request.kind !== 'generation-run' || !isRecord(value)) return false;
  return value.id === request.id
    && value.ok === true
    && value.kind === 'generation-progress'
    && typeof value.progress === 'number'
    && Number.isFinite(value.progress)
    && value.progress >= 0
    && value.progress <= 1
    && isBoundedUtilityString(value.message, MAX_GENERATION_PROGRESS_MESSAGE_BYTES);
}

export function isBoundedUtilityErrorResponse(value: unknown): value is { code: string; message: string } {
  return isRecord(value)
    && hasOnlyKeys(value, ['code', 'message'])
    && hasKeys(value, ['code', 'message'])
    && isBoundedUtilityString(value.code, MAX_UTILITY_ERROR_CODE_BYTES, false)
    && isBoundedUtilityString(value.message, MAX_UTILITY_ERROR_MESSAGE_BYTES);
}

interface ObservationRegionContract {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isObservationRegion(value: unknown): value is ObservationRegionContract {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, ['x', 'y', 'width', 'height'])
    && hasKeys(value, ['x', 'y', 'width', 'height'])
    && isNonNegativeInteger(value.x)
    && isNonNegativeInteger(value.y)
    && isPositiveInteger(value.width)
    && isPositiveInteger(value.height);
}

function regionsEqual(left: ObservationRegionContract, right: ObservationRegionContract): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

interface ObservationTargetContract {
  assetId?: string;
  frameId?: string;
  sourceWidth: number;
  sourceHeight: number;
}

/** Mirror only the existing observation target/geometry rules needed to validate a successful child result. */
function resolveObservationTarget(request: ObservationUtilityRequest): ObservationTargetContract | undefined {
  const selection = request.request;
  const document = request.document;
  if (document.kind === 'illustration') {
    if (selection.assetId || selection.frameId) return undefined;
    if (selection.illustrationTimeMs !== undefined && selection.illustrationTimeMs > document.animation.durationMs) return undefined;
    if (selection.layerId && !document.layers[selection.layerId]) return undefined;
    return { sourceWidth: document.artboard.width, sourceHeight: document.artboard.height };
  }

  if (selection.illustrationTimeMs !== undefined) return undefined;
  const assetId = selection.assetId ?? document.activeAssetId;
  const selectedAsset = document.pixelAssets[assetId];
  if (!selectedAsset) return undefined;
  const renderedAsset = selectedAsset.type === 'tileset' ? document.pixelAssets[selectedAsset.spriteAssetId] : selectedAsset;
  if (!renderedAsset || renderedAsset.type !== 'sprite' && renderedAsset.type !== 'tilemap') return undefined;
  if (renderedAsset.type === 'sprite') {
    const frameId = selection.frameId ?? renderedAsset.frameIds[0];
    if (!frameId || !renderedAsset.frames[frameId] || selection.layerId && !renderedAsset.layers[selection.layerId]) return undefined;
    return { assetId, frameId, sourceWidth: renderedAsset.width, sourceHeight: renderedAsset.height };
  }
  if (selection.frameId || selection.layerId && !renderedAsset.layers[selection.layerId]) return undefined;
  const sourceWidth = renderedAsset.orientation === 'isometric'
    ? Math.max(1, Math.ceil((renderedAsset.width + renderedAsset.height) * renderedAsset.tileWidth / 2))
    : renderedAsset.width * renderedAsset.tileWidth;
  const sourceHeight = renderedAsset.orientation === 'isometric'
    ? Math.max(1, Math.ceil((renderedAsset.width + renderedAsset.height) * renderedAsset.tileHeight / 2))
    : renderedAsset.height * renderedAsset.tileHeight;
  return { assetId, sourceWidth, sourceHeight };
}

function expectedObservationRegion(request: ObservationUtilityRequest, target: ObservationTargetContract): ObservationRegionContract {
  return request.request.region ?? { x: 0, y: 0, width: target.sourceWidth, height: target.sourceHeight };
}

function assertObservationPng(data: unknown, width: number, height: number): void {
  const maxBase64Characters = Math.ceil(MAX_OBSERVATION_PNG_BYTES / 3) * 4;
  if (typeof data !== 'string' || data.length > maxBase64Characters || !isCanonicalBase64(data)) {
    throw new Error('Raster utility returned a malformed observation image.');
  }
  const decodedBytes = base64DecodedByteLength(data);
  if (decodedBytes < 1) throw new Error('Raster utility returned a malformed observation image.');
  if (decodedBytes > MAX_OBSERVATION_PNG_BYTES) {
    throw new Error(`Raster utility observation result exceeds its ${MAX_OBSERVATION_PNG_BYTES}-byte PNG limit.`);
  }

  const bytes = Buffer.from(data, 'base64');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.byteLength < 45 || !bytes.subarray(0, 8).equals(signature)) throw new Error('Raster utility returned a malformed observation image.');
  let offset = 8;
  let imageWidth: number | undefined;
  let imageHeight: number | undefined;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = bytes.readUInt32BE(offset);
    if (chunkLength > bytes.byteLength - offset - 12) throw new Error('Raster utility returned a malformed observation image.');
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const type = bytes.toString('ascii', typeStart, dataStart);
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if ((crc32(bytes.subarray(typeStart, dataEnd)) >>> 0) !== expectedCrc) throw new Error('Raster utility returned a malformed observation image.');
    if (offset === 8) {
      if (type !== 'IHDR' || chunkLength !== 13) throw new Error('Raster utility returned a malformed observation image.');
      imageWidth = bytes.readUInt32BE(dataStart);
      imageHeight = bytes.readUInt32BE(dataStart + 4);
    } else if (type === 'IHDR' || type === 'acTL') {
      throw new Error('Raster utility returned a malformed observation image.');
    } else if (type === 'IDAT') {
      sawImageData = true;
    } else if (type === 'IEND') {
      if (chunkLength !== 0 || dataEnd + 4 !== bytes.byteLength) throw new Error('Raster utility returned a malformed observation image.');
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawImageData || !sawEnd || imageWidth !== width || imageHeight !== height) throw new Error('Raster utility returned a malformed observation image.');
  try {
    const decoded = UPNG.decode(Uint8Array.from(bytes).buffer);
    const frames = UPNG.toRGBA8(decoded);
    if (decoded.width !== width || decoded.height !== height || frames.length !== 1 || frames[0].byteLength !== width * height * 4) {
      throw new Error('Decoded observation geometry disagrees with its envelope.');
    }
  } catch {
    throw new Error('Raster utility returned an undecodable observation image.');
  }
}

function assertObservationError(request: ObservationUtilityRequest, result: Record<string, unknown>): void {
  if (!isNonEmptyString(result.error)) throw new Error('Raster utility returned a malformed observation result.');
  const target = resolveObservationTarget(request);
  const selectedAssetId = request.document.kind === 'pixel' ? request.request.assetId ?? request.document.activeAssetId : undefined;
  switch (result.error) {
    case 'invalid_observation_target':
      if (!hasOnlyKeys(result, ['error', 'message', 'assetId']) || !hasKeys(result, ['error', 'message']) || !isNonEmptyString(result.message)
        || result.assetId !== undefined && (!isNonEmptyString(result.assetId) || result.assetId !== selectedAssetId)) throw new Error('Raster utility returned a malformed observation result.');
      return;
    case 'animation_time_out_of_bounds':
      if (!hasOnlyKeys(result, ['error', 'illustrationTimeMs', 'durationMs']) || !hasKeys(result, ['error', 'illustrationTimeMs', 'durationMs'])
        || !isNonNegativeInteger(result.illustrationTimeMs) || !isNonNegativeInteger(result.durationMs)
        || result.illustrationTimeMs !== request.request.illustrationTimeMs
        || request.document.kind !== 'illustration' || result.durationMs !== request.document.animation.durationMs) throw new Error('Raster utility returned a malformed observation result.');
      return;
    case 'layer_not_found':
      if (!hasOnlyKeys(result, ['error', 'assetId', 'layerId']) || !hasKeys(result, ['error', 'layerId']) || !isNonEmptyString(result.layerId)
        || result.layerId !== request.request.layerId || result.assetId !== selectedAssetId) throw new Error('Raster utility returned a malformed observation result.');
      return;
    case 'asset_not_found':
      if (!hasOnlyKeys(result, ['error', 'assetId']) || !hasKeys(result, ['error', 'assetId']) || !isNonEmptyString(result.assetId)
        || request.document.kind !== 'pixel' || result.assetId !== selectedAssetId) throw new Error('Raster utility returned a malformed observation result.');
      return;
    case 'frame_not_found': {
      const expectedFrameId = request.document.kind === 'pixel' ? request.request.frameId : undefined;
      if (!hasOnlyKeys(result, ['error', 'assetId', 'frameId']) || !hasKeys(result, ['error', 'assetId', 'frameId']) || !isNonEmptyString(result.assetId)
        || result.assetId !== selectedAssetId || result.frameId !== expectedFrameId) throw new Error('Raster utility returned a malformed observation result.');
      return;
    }
    case 'region_out_of_bounds': {
      const source = result.source;
      if (!hasOnlyKeys(result, ['error', 'region', 'source', 'guidance']) || !hasKeys(result, ['error', 'region', 'source', 'guidance'])
        || !isObservationRegion(result.region) || !isRecord(source) || !hasOnlyKeys(source, ['width', 'height']) || !hasKeys(source, ['width', 'height'])
        || !isPositiveInteger(source.width) || !isPositiveInteger(source.height) || !isNonEmptyString(result.guidance)
        || !request.request.region || !regionsEqual(result.region, request.request.region)
        || target && (source.width !== target.sourceWidth || source.height !== target.sourceHeight)
        || result.region.x + result.region.width <= source.width && result.region.y + result.region.height <= source.height) throw new Error('Raster utility returned a malformed observation result.');
      return;
    }
    case 'observation_too_large': {
      const requested = result.requested;
      const limit = result.limit;
      const region = target && expectedObservationRegion(request, target);
      const expectedWidth = region && region.width * request.request.scale;
      const expectedHeight = region && region.height * request.request.scale;
      if (!hasOnlyKeys(result, ['error', 'requested', 'limit', 'guidance']) || !hasKeys(result, ['error', 'requested', 'limit', 'guidance'])
        || !isRecord(requested) || !hasOnlyKeys(requested, ['width', 'height', 'pixels']) || !hasKeys(requested, ['width', 'height', 'pixels'])
        || !isPositiveInteger(requested.width) || !isPositiveInteger(requested.height) || !Number.isSafeInteger(requested.pixels)
        || requested.pixels !== requested.width * requested.height || requested.pixels <= request.maxPixels
        || expectedWidth !== undefined && requested.width !== expectedWidth || expectedHeight !== undefined && requested.height !== expectedHeight
        || !isRecord(limit) || !hasOnlyKeys(limit, ['pixels']) || !hasKeys(limit, ['pixels']) || limit.pixels !== request.maxPixels
        || !isNonEmptyString(result.guidance)) throw new Error('Raster utility returned a malformed observation result.');
      return;
    }
    case 'observation_png_too_large': {
      const requested = result.requested;
      const limit = result.limit;
      const region = target && expectedObservationRegion(request, target);
      const expectedWidth = region && region.width * request.request.scale;
      const expectedHeight = region && region.height * request.request.scale;
      if (!hasOnlyKeys(result, ['error', 'requested', 'limit', 'guidance']) || !hasKeys(result, ['error', 'requested', 'limit', 'guidance'])
        || !isRecord(requested) || !hasOnlyKeys(requested, ['width', 'height', 'encodedBytes']) || !hasKeys(requested, ['width', 'height', 'encodedBytes'])
        || !isPositiveInteger(requested.width) || !isPositiveInteger(requested.height) || !isPositiveInteger(requested.encodedBytes)
        || requested.width * requested.height > request.maxPixels || requested.encodedBytes <= MAX_OBSERVATION_PNG_BYTES
        || expectedWidth !== undefined && requested.width !== expectedWidth || expectedHeight !== undefined && requested.height !== expectedHeight
        || !isRecord(limit) || !hasOnlyKeys(limit, ['encodedBytes']) || !hasKeys(limit, ['encodedBytes']) || limit.encodedBytes !== MAX_OBSERVATION_PNG_BYTES
        || !isNonEmptyString(result.guidance)) throw new Error('Raster utility returned a malformed observation result.');
      return;
    }
    default:
      throw new Error('Raster utility returned a malformed observation result.');
  }
}

/** Validate the established observation discriminants and bounded static-PNG result before caller/MCP use. */
export function assertObservationUtilityResponse(
  request: ObservationUtilityRequest,
  value: unknown,
): asserts value is Extract<UtilityResponse, { ok: true; kind: 'capture-observation' }> {
  if (!isRecord(value)) throw new Error('Raster utility returned a malformed observation result.');
  const response = value as Record<string, unknown>;
  if (response.kind !== request.kind || !isRecord(response.result)) throw new Error('Raster utility returned a malformed observation result.');
  const result = response.result;
  assertUtilityJsonBudget(result, {
    label: 'Raster utility observation result',
    maxBytes: MAX_OBSERVATION_UTILITY_RESULT_SERIALIZED_BYTES,
    maxNodes: 4_096,
    maxDepth: 16,
  });
  if (result.available !== true) { assertObservationError(request, result); return; }
  if (!hasOnlyKeys(result, ['available', 'mimeType', 'width', 'height', 'scale', 'region', 'background', 'assetId', 'frameId', 'layerId', 'illustrationTimeMs', 'data'])
    || !hasKeys(result, ['available', 'mimeType', 'width', 'height', 'scale', 'region', 'background', 'data'])
    || result.mimeType !== 'image/png' || !isPositiveInteger(result.width) || !isPositiveInteger(result.height)
    || result.scale !== request.request.scale || result.background !== request.request.background || !isObservationRegion(result.region)) {
    throw new Error('Raster utility returned a malformed observation result.');
  }
  const target = resolveObservationTarget(request);
  if (!target) throw new Error('Raster utility returned a malformed observation result.');
  const region = expectedObservationRegion(request, target);
  const width = region.width * request.request.scale;
  const height = region.height * request.request.scale;
  const pixels = width * height;
  if (!regionsEqual(result.region, region) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || result.width !== width || result.height !== height || !Number.isSafeInteger(pixels) || pixels > request.maxPixels
    || result.assetId !== target.assetId || result.frameId !== target.frameId || result.layerId !== request.request.layerId
    || result.illustrationTimeMs !== request.request.illustrationTimeMs) {
    throw new Error(`Raster utility observation result exceeds or contradicts its ${request.maxPixels}-pixel request contract.`);
  }
  assertObservationPng(result.data, width, height);
}

function expectedGeneratedSeed(request: GenerationUtilityRequest, index: number): number | undefined {
  if (request.request.provider === 'stability') return request.request.seed === undefined ? undefined : request.request.seed + index;
  if (request.request.provider === 'comfyui') return request.request.seed;
  return undefined;
}

/** Validate provider-worker output before it can become preview, job, or canonical provenance input. */
export function assertGenerationUtilityResponse(
  request: GenerationUtilityRequest,
  value: unknown,
): asserts value is Extract<UtilityResponse, { ok: true; kind: 'generation-run' }> {
  if (!isRecord(value)) throw new Error('Generation utility returned a malformed result.');
  const response = value as Record<string, unknown>;
  if (response.kind !== request.kind || !Array.isArray(response.outputs)) throw new Error('Generation utility returned a malformed result.');
  if (response.outputs.length > request.request.resultCount) {
    throw new Error(`Generation utility returned more than the requested ${request.request.resultCount} result${request.request.resultCount === 1 ? '' : 's'}.`);
  }

  const seenIds = new Set<string>();
  const maxBase64Characters = Math.ceil(MAX_GENERATED_OUTPUT_BYTES / 3) * 4;
  for (const [index, candidate] of response.outputs.entries()) {
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, ['id', 'mimeType', 'data', 'width', 'height', 'seed', 'providerMetadata'])
      || !hasKeys(candidate, ['id', 'mimeType', 'data', 'width', 'height'])
      || !isNonEmptyString(candidate.id) || seenIds.has(candidate.id)
      || !['image/png', 'image/webp', 'image/jpeg'].includes(String(candidate.mimeType))
      || typeof candidate.data !== 'string' || candidate.data.length > maxBase64Characters || !isCanonicalBase64(candidate.data)
      || !isPositiveInteger(candidate.width) || !isPositiveInteger(candidate.height)
      || candidate.width > MAX_GENERATED_OUTPUT_SIDE || candidate.height > MAX_GENERATED_OUTPUT_SIDE
      || !Number.isSafeInteger(candidate.width * candidate.height) || candidate.width * candidate.height > MAX_GENERATED_OUTPUT_PIXELS
      || candidate.seed !== expectedGeneratedSeed(request, index)
      || candidate.providerMetadata !== undefined && !isRecord(candidate.providerMetadata)) {
      throw new Error('Generation utility returned a malformed result.');
    }
    if (candidate.providerMetadata !== undefined) {
      assertUtilityJsonBudget(candidate.providerMetadata, {
        label: 'Generation utility provider metadata',
        maxBytes: MAX_GENERATION_PROVIDER_METADATA_BYTES,
        maxNodes: MAX_GENERATION_PROVIDER_METADATA_NODES,
        maxDepth: MAX_GENERATION_PROVIDER_METADATA_DEPTH,
      });
    }
    const decodedBytes = base64DecodedByteLength(candidate.data);
    if (decodedBytes < 1) throw new Error('Generation utility returned a malformed image result.');
    if (decodedBytes > MAX_GENERATED_OUTPUT_BYTES) {
      throw new Error(`Generation utility image result exceeds its ${MAX_GENERATED_OUTPUT_BYTES}-byte limit.`);
    }
    const bytes = Buffer.from(candidate.data, 'base64');
    try {
      const header = inspectImageHeader(bytes);
      if (header.mimeType !== candidate.mimeType || header.width !== candidate.width || header.height !== candidate.height) throw new Error('header mismatch');
    } catch {
      throw new Error('Generation utility returned a malformed image result.');
    }
    seenIds.add(candidate.id);
  }
}

/** Validate the retained provider output before sending it to the acceptance normalizer. */
export function assertNormalizeGenerationAcceptanceInput(output: unknown): asserts output is GeneratedOutput {
  if (!isRecord(output)
    || !hasOnlyKeys(output, ['id', 'mimeType', 'data', 'width', 'height', 'seed', 'providerMetadata'])
    || !hasKeys(output, ['id', 'mimeType', 'data', 'width', 'height'])
    || !isNonEmptyString(output.id)
    || !['image/png', 'image/webp', 'image/jpeg'].includes(String(output.mimeType))
    || typeof output.data !== 'string'
    || output.data.length > Math.ceil(MAX_GENERATED_OUTPUT_BYTES / 3) * 4
    || !isCanonicalBase64(output.data)
    || !isPositiveInteger(output.width) || !isPositiveInteger(output.height)
    || output.width > MAX_GENERATED_OUTPUT_SIDE || output.height > MAX_GENERATED_OUTPUT_SIDE
    || !Number.isSafeInteger(output.width * output.height) || output.width * output.height > MAX_GENERATED_OUTPUT_PIXELS
    || output.seed !== undefined && !Number.isSafeInteger(output.seed)
    || output.providerMetadata !== undefined && !isRecord(output.providerMetadata)) {
    throw new Error('Generated acceptance input is malformed.');
  }
  if (output.providerMetadata !== undefined) {
    assertUtilityJsonBudget(output.providerMetadata, {
      label: 'Generated acceptance provider metadata',
      maxBytes: MAX_GENERATION_PROVIDER_METADATA_BYTES,
      maxNodes: MAX_GENERATION_PROVIDER_METADATA_NODES,
      maxDepth: MAX_GENERATION_PROVIDER_METADATA_DEPTH,
    });
  }
  const decodedBytes = base64DecodedByteLength(output.data);
  if (decodedBytes < 1 || decodedBytes > MAX_GENERATED_OUTPUT_BYTES) throw new Error('Generated acceptance input exceeds the preview byte contract.');
  try {
    const header = inspectImageHeader(Buffer.from(output.data, 'base64'));
    if (header.mimeType !== output.mimeType || header.width !== output.width || header.height !== output.height) throw new Error('header mismatch');
  } catch {
    throw new Error('Generated acceptance input has a malformed image contract.');
  }
}

/** Validate a normalized accepted copy before it can reach quantization or canonical state. */
export function assertNormalizeGenerationAcceptanceUtilityResponse(
  request: NormalizeGenerationAcceptanceUtilityRequest,
  value: unknown,
): asserts value is Extract<UtilityResponse, { ok: true; kind: 'normalize-generation-acceptance' }> {
  assertNormalizeGenerationAcceptanceInput(request.output);
  if (!isRecord(value) || value.kind !== request.kind || !isRecord(value.result)) {
    throw new Error('Raster utility returned a malformed generation-acceptance result.');
  }
  const result = value.result;
  const sourceByteLength = base64DecodedByteLength(request.output.data);
  const exceedsInlineGeometry = request.output.width > MAX_INLINE_IMAGE_DIMENSION || request.output.height > MAX_INLINE_IMAGE_DIMENSION || request.output.width * request.output.height > MAX_INLINE_IMAGE_PIXELS;
  if (result.status === 'preview-only') {
    if (!hasOnlyKeys(result, ['status', 'reason', 'message', 'guidance'])
      || !hasKeys(result, ['status', 'reason', 'message', 'guidance'])
      || !isNonEmptyString(result.message) || !isNonEmptyString(result.guidance)
      || result.reason === 'inline-geometry-limit' && !exceedsInlineGeometry
      || result.reason === 'encoded-byte-limit' && (exceedsInlineGeometry || sourceByteLength <= MAX_INLINE_ASSET_BYTES)
      || result.reason !== 'inline-geometry-limit' && result.reason !== 'encoded-byte-limit') {
      throw new Error('Raster utility returned a malformed generation preview-only result.');
    }
    return;
  }
  if (result.status !== 'ready'
    || !hasOnlyKeys(result, ['status', 'mimeType', 'data', 'width', 'height', 'normalization'])
    || !hasKeys(result, ['status', 'mimeType', 'data', 'width', 'height'])
    || exceedsInlineGeometry
    || !['image/png', 'image/webp', 'image/jpeg'].includes(String(result.mimeType))
    || typeof result.data !== 'string' || !isCanonicalBase64(result.data)
    || result.width !== request.output.width || result.height !== request.output.height) {
    throw new Error('Raster utility returned a malformed generation-acceptance result.');
  }
  const acceptedByteLength = base64DecodedByteLength(result.data);
  if (acceptedByteLength < 1 || acceptedByteLength > MAX_INLINE_ASSET_BYTES) {
    throw new Error(`Raster utility generation acceptance exceeds the ${MAX_INLINE_ASSET_BYTES}-byte limit.`);
  }
  const acceptedBytes = Buffer.from(result.data, 'base64');
  try {
    const header = inspectImageHeader(acceptedBytes);
    if (header.mimeType !== result.mimeType || header.width !== result.width || header.height !== result.height) throw new Error('header mismatch');
  } catch {
    throw new Error('Raster utility returned a malformed normalized image.');
  }

  if (sourceByteLength <= MAX_INLINE_ASSET_BYTES) {
    if (result.normalization !== undefined || result.mimeType !== request.output.mimeType || result.data !== request.output.data) {
      throw new Error('Raster utility changed a generation result that already met acceptance policy.');
    }
    return;
  }
  if (!isRecord(result.normalization)) throw new Error('Raster utility omitted generation normalization provenance.');
  const normalization = result.normalization;
  if (!hasOnlyKeys(normalization, ['method', 'sourceOutputId', 'sourceMimeType', 'acceptedMimeType', 'sourceByteLength', 'acceptedByteLength', 'sourceSha256', 'acceptedSha256', 'width', 'height', 'quality'])
    || !hasKeys(normalization, ['method', 'sourceOutputId', 'sourceMimeType', 'acceptedMimeType', 'sourceByteLength', 'acceptedByteLength', 'sourceSha256', 'acceptedSha256', 'width', 'height'])
    || normalization.sourceOutputId !== request.output.id
    || normalization.sourceMimeType !== request.output.mimeType
    || normalization.acceptedMimeType !== result.mimeType
    || normalization.sourceByteLength !== sourceByteLength
    || normalization.acceptedByteLength !== acceptedByteLength
    || normalization.sourceSha256 !== createHash('sha256').update(Buffer.from(request.output.data, 'base64')).digest('hex')
    || normalization.acceptedSha256 !== createHash('sha256').update(acceptedBytes).digest('hex')
    || normalization.width !== request.output.width || normalization.height !== request.output.height
    || normalization.method === 'png-reencode' && (result.mimeType !== 'image/png' || normalization.quality !== undefined)
    || normalization.method === 'webp-quality' && (result.mimeType !== 'image/webp' || !GENERATION_ACCEPTANCE_WEBP_QUALITIES.includes(normalization.quality as never))
    || normalization.method !== 'png-reencode' && normalization.method !== 'webp-quality') {
    throw new Error('Raster utility returned contradictory generation normalization provenance.');
  }
}

function isMimeType(value: unknown): value is string {
  return isBoundedUtilityString(value, 256, false) && /^[^\s/]+\/[^\s/]+$/.test(value);
}

function isExtension(value: unknown): value is string {
  return isBoundedUtilityString(value, 32, false) && /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function isLeafName(value: unknown, required: boolean): value is string | undefined {
  if (value === undefined) return !required;
  return isBoundedUtilityString(value, 1_024, false) && value !== '.' && value !== '..' && !value.includes('\0') && !/[\\/]/.test(value);
}

function assertBoundedStringArray(value: unknown, label: string, malformedMessage: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(malformedMessage);
  if (value.length > MAX_UTILITY_REPORT_ENTRIES) throw new Error(`${label} exceeds its ${MAX_UTILITY_REPORT_ENTRIES}-entry limit.`);
  for (const entry of value) if (!isBoundedUtilityString(entry, MAX_UTILITY_TEXT_BYTES)) throw new Error(malformedMessage);
  assertUtilityJsonBudget(value, {
    label,
    maxBytes: MAX_UTILITY_REPORT_SERIALIZED_BYTES,
    maxNodes: MAX_UTILITY_REPORT_ENTRIES + 1,
    maxDepth: 2,
  });
}

function assertSerializedExportMember(value: unknown, label: 'artifact' | 'companion', nameRequired: boolean): number {
  if (!isRecord(value) || label === 'companion' && !hasOnlyKeys(value, ['dataBase64', 'extension', 'mimeType', 'name']) || !hasKeys(value, ['dataBase64', 'extension', 'mimeType'])) throw new Error(`Raster utility returned a malformed export ${label}.`);
  const member = value as { dataBase64: unknown; extension: unknown; mimeType: unknown; name?: unknown };
  if (!isExtension(member.extension) || !isMimeType(member.mimeType) || !isLeafName(member.name, nameRequired)
    || typeof member.dataBase64 !== 'string' || member.dataBase64.length > MAX_EXPORT_UTILITY_BASE64_CHARACTERS
    || !isCanonicalBase64(member.dataBase64)) {
    throw new Error(`Raster utility returned a malformed export ${label}.`);
  }
  const decodedBytes = base64DecodedByteLength(member.dataBase64);
  if (decodedBytes < 1) throw new Error(`Raster utility returned a malformed export ${label}.`);
  return decodedBytes;
}

function hasExportMemberIdentity(
  member: { extension: string; mimeType: string; name?: string },
  expected: ExportArtifactMemberIdentity,
): boolean {
  return member.extension === expected.extension
    && member.mimeType === expected.mimeType
    && member.name === expected.name;
}

/** Validate the existing serialized export envelope before any permissive Buffer base64 decode. */
export function assertExportUtilityResponse(
  request: ExportUtilityRequest,
  value: unknown,
): asserts value is Extract<UtilityResponse, { ok: true; kind: 'export-document' }> {
  if (!isRecord(value)) throw new Error('Raster utility returned a malformed export artifact.');
  const response = value as { kind?: unknown; artifact?: unknown };
  if (response.kind !== request.kind || !isRecord(response.artifact)
    || !hasOnlyKeys(response.artifact, ['dataBase64', 'mimeType', 'extension', 'report', 'companion', 'companions'])
    || !hasKeys(response.artifact, ['dataBase64', 'mimeType', 'extension', 'report'])) throw new Error('Raster utility returned a malformed export artifact.');
  const artifact = response.artifact as unknown as SerializedExportArtifact;
  const expected = expectedExportArtifactIdentity(request.document, request.format);
  if (!expected || !hasExportMemberIdentity(artifact, expected.primary)) throw new Error('Raster utility returned a malformed export artifact.');
  const decodedLengths = [assertSerializedExportMember(artifact, 'artifact', false)];
  if (!isRecord(artifact.report) || !hasOnlyKeys(artifact.report, ['warnings', 'rasterized']) || !hasKeys(artifact.report, ['warnings', 'rasterized'])) throw new Error('Raster utility returned a malformed export artifact.');
  assertBoundedStringArray(artifact.report.warnings, 'Raster utility export warnings', 'Raster utility returned a malformed export artifact.');
  assertBoundedStringArray(artifact.report.rasterized, 'Raster utility export rasterization report', 'Raster utility returned a malformed export artifact.');
  if (artifact.companion !== undefined && artifact.companions !== undefined) throw new Error('Raster utility returned a malformed export companion.');
  if (expected.companion) {
    if (!artifact.companion || artifact.companions !== undefined) throw new Error('Raster utility returned a malformed export companion.');
    decodedLengths.push(assertSerializedExportMember(artifact.companion, 'companion', false));
    if (!hasExportMemberIdentity(artifact.companion, expected.companion)) throw new Error('Raster utility returned a malformed export companion.');
  } else if (expected.companions) {
    if (artifact.companion !== undefined || !Array.isArray(artifact.companions)) throw new Error('Raster utility returned a malformed export companion.');
    if (artifact.companions.length > MAX_EXPORT_UTILITY_MEMBERS - 1) throw new Error(`Raster utility export result exceeds its ${MAX_EXPORT_UTILITY_MEMBERS}-member limit.`);
    if (artifact.companions.length !== expected.companions.length) throw new Error('Raster utility returned a malformed export companion.');
    const expectedByName = new Map(expected.companions.map((companion) => [companion.name, companion]));
    const names = new Set<string>();
    for (const companion of artifact.companions) {
      decodedLengths.push(assertSerializedExportMember(companion, 'companion', true));
      if (names.has(companion.name)) throw new Error('Raster utility returned duplicate export companion names.');
      names.add(companion.name);
      const expectedCompanion = expectedByName.get(companion.name);
      if (!expectedCompanion || !hasExportMemberIdentity(companion, expectedCompanion)) throw new Error('Raster utility returned a malformed export companion.');
    }
  } else if (artifact.companion !== undefined || artifact.companions !== undefined) {
    throw new Error('Raster utility returned a malformed export companion.');
  }
  if (decodedLengths.length > MAX_EXPORT_UTILITY_MEMBERS) throw new Error(`Raster utility export result exceeds its ${MAX_EXPORT_UTILITY_MEMBERS}-member limit.`);
  assertUtilityAggregateByteLimit(decodedLengths, MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES, 'Raster utility export result');
}

/** Apply the established document migration/schema gate before imported output reaches callers. */
export function validateImportUtilityResponse(
  request: ImportUtilityRequest,
  value: unknown,
): { documents: AIDrawDocument[]; warnings: string[] } {
  if (!value || typeof value !== 'object') throw new Error('Raster utility returned a malformed import result.');
  const response = value as { kind?: unknown; documents?: unknown; warnings?: unknown };
  if (response.kind !== request.kind || !Array.isArray(response.documents)) throw new Error('Raster utility returned a malformed import result.');
  if (response.documents.length < 1 || response.documents.length > MAX_IMPORT_UTILITY_DOCUMENTS) {
    throw new Error(`Raster utility import result must contain 1–${MAX_IMPORT_UTILITY_DOCUMENTS} documents.`);
  }
  assertBoundedStringArray(response.warnings, 'Raster utility import warnings', 'Raster utility returned malformed import warnings.');
  assertUtilityJsonBudget(response.documents, {
    label: 'Raster utility imported documents',
    maxBytes: MAX_IMPORT_UTILITY_SERIALIZED_BYTES,
    maxNodes: MAX_IMPORT_UTILITY_NODES,
    maxDepth: MAX_IMPORT_UTILITY_DEPTH,
  });
  const documents: AIDrawDocument[] = [];
  for (const document of response.documents) {
    try { documents.push(migrateDocument(document)); }
    catch { throw new Error('Raster utility returned a malformed imported document.'); }
  }
  return { documents, warnings: [...response.warnings] };
}
