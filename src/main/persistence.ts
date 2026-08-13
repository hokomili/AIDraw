import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  CURRENT_SCHEMA_VERSION,
  findDocumentAssetReferences,
  migrateDocument,
  type AIDrawDocument,
  type DocumentAsset,
  type PaintLayer,
  type RasterStroke,
} from '@aidraw/core';
import type { DocumentCheckpointRecord, TransactionTraceEntry } from '../common/contracts';
import { paintTileCachePlan, parsePaintTileKey } from '../common/paint-tile-cache';
import { renderRasterStroke } from '../common/raster-brush';
import {
  checkpointDocumentMatchesMetadata,
  checkpointMetadataMatches,
  parseCheckpointRecord,
  parseCheckpointSummary,
} from './checkpoint-policy';
import {
  assertDocumentImageAssetMetadata,
  inspectDocumentImageAsset,
  inspectImageHeader,
  type ImageDecodeValidator,
} from './transaction-policy';
import { parseTransactionTraceEntry, parseTransactionTraceJsonl } from './trace-policy';
import { MAX_NATIVE_BINARY_ENTRY_BYTES } from './native-container-limits';

const TRANSPARENT_PREVIEW = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE/wH+Q5ZkAAAAAElFTkSuQmCC',
    'base64',
  ),
);

const MAX_NATIVE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_NATIVE_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_NATIVE_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_MANIFEST_BYTES = 1024 * 1024;
const MAX_NATIVE_ENTRIES = 20_000;

function safeArchiveEntryName(name: string): boolean {
  return Boolean(name) && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[a-z]:/i.test(name) && !name.split('/').some((part) => part === '..' || part === '.');
}

function validateNativeArchiveCrcs(bytes: Uint8Array, archive: ReturnType<typeof unzipSync>): void {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = view.length - 22, minimum = Math.max(0, view.length - 22 - 0xffff); offset >= minimum; offset -= 1) {
    if (view.readUInt32LE(offset) === 0x06054b50 && offset + 22 + view.readUInt16LE(offset + 20) === view.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('AIDraw container has no valid ZIP central directory.');
  if (view.readUInt16LE(end + 4) !== 0 || view.readUInt16LE(end + 6) !== 0) throw new Error('AIDraw container uses unsupported multi-disk ZIP metadata.');

  let entries = view.readUInt16LE(end + 10);
  let centralSize = view.readUInt32LE(end + 12);
  let centralOffset = view.readUInt32LE(end + 16);
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || view.readUInt32LE(locator) !== 0x07064b50 || view.readUInt32LE(locator + 4) !== 0 || view.readUInt32LE(locator + 16) !== 1) throw new Error('AIDraw container has invalid ZIP64 metadata.');
    const zip64Offset = view.readBigUInt64LE(locator + 8);
    if (zip64Offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('AIDraw container ZIP64 metadata exceeds safe integer bounds.');
    const zip64 = Number(zip64Offset);
    if (zip64 + 56 > view.length || view.readUInt32LE(zip64) !== 0x06064b50 || view.readUInt32LE(zip64 + 16) !== 0 || view.readUInt32LE(zip64 + 20) !== 0) throw new Error('AIDraw container has invalid ZIP64 metadata.');
    const zip64Entries = view.readBigUInt64LE(zip64 + 32);
    const zip64CentralSize = view.readBigUInt64LE(zip64 + 40);
    const zip64CentralOffset = view.readBigUInt64LE(zip64 + 48);
    if ([zip64Entries, zip64CentralSize, zip64CentralOffset].some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('AIDraw container ZIP64 metadata exceeds safe integer bounds.');
    entries = Number(zip64Entries); centralSize = Number(zip64CentralSize); centralOffset = Number(zip64CentralOffset);
  }
  if (entries > MAX_NATIVE_ENTRIES || centralOffset < 0 || centralSize < 0 || centralOffset + centralSize > view.length) throw new Error('AIDraw container has invalid ZIP central-directory bounds.');

  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || view.readUInt32LE(cursor) !== 0x02014b50) throw new Error('AIDraw container has an invalid ZIP central-directory entry.');
    const flags = view.readUInt16LE(cursor + 8);
    const expected = view.readUInt32LE(cursor + 16);
    const nameLength = view.readUInt16LE(cursor + 28);
    const extraLength = view.readUInt16LE(cursor + 30);
    const commentLength = view.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new Error('AIDraw container has a truncated ZIP central-directory entry.');
    const name = strFromU8(view.subarray(cursor + 46, cursor + 46 + nameLength), !(flags & 0x0800));
    const data = archive[name];
    if (!data) throw new Error(`AIDraw container central directory references a missing entry: ${name}`);
    if ((crc32(data) >>> 0) !== expected) throw new Error(`AIDraw container CRC-32 mismatch for ${name}.`);
    cursor = next;
  }
}

function unzipNativeArchive(bytes: Uint8Array): ReturnType<typeof unzipSync> {
  if (bytes.byteLength > MAX_NATIVE_ARCHIVE_BYTES) throw new Error('AIDraw container exceeds the 512 MiB compressed-size limit.');
  const names = new Set<string>(); let expandedBytes = 0; let entries = 0;
  const archive = unzipSync(bytes, { filter: (entry) => {
    entries += 1;
    if (entries > MAX_NATIVE_ENTRIES) throw new Error(`AIDraw container exceeds the ${MAX_NATIVE_ENTRIES.toLocaleString()}-entry limit.`);
    if (!safeArchiveEntryName(entry.name)) throw new Error(`AIDraw container contains an unsafe entry path: ${entry.name}`);
    if (names.has(entry.name)) throw new Error(`AIDraw container contains a duplicate entry: ${entry.name}`); names.add(entry.name);
    const entryLimit = entry.name === 'manifest.json' ? MAX_NATIVE_MANIFEST_BYTES : entry.name.endsWith('.json') || entry.name.endsWith('.jsonl') ? MAX_NATIVE_METADATA_BYTES : MAX_NATIVE_BINARY_ENTRY_BYTES;
    if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > entryLimit) throw new Error(`AIDraw container entry ${entry.name} exceeds its expanded-size limit.`);
    expandedBytes += entry.originalSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_NATIVE_EXPANDED_BYTES) throw new Error('AIDraw container exceeds the 512 MiB expanded-size limit.');
    return true;
  } });
  validateNativeArchiveCrcs(bytes, archive);
  return archive;
}

export interface NativeManifest {
  format: 'AIDraw';
  schemaVersion: 1 | 2;
  documentId: string;
  documentKind: AIDrawDocument['kind'];
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  assetCount: number;
  savedBy: { application: 'AIDraw'; version: string };
}

export interface LoadedNativeDocument {
  document: AIDrawDocument;
  manifest: NativeManifest;
  trace: TransactionTraceEntry[];
  checkpoints: DocumentCheckpointRecord[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNativeManifest(value: unknown): NativeManifest {
  if (!isRecord(value)) throw new Error('AIDraw manifest is malformed.');
  if (value.format !== 'AIDraw') throw new Error('This file is not a valid AIDraw container.');
  if (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion) || value.schemaVersion !== 1 && value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    if (typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion)) throw new Error(`Unsupported AIDraw schema version: ${String(value.schemaVersion)}`);
    throw new Error('AIDraw manifest is malformed.');
  }
  if (typeof value.documentId !== 'string' || !value.documentId
    || value.documentKind !== 'illustration' && value.documentKind !== 'pixel'
    || typeof value.name !== 'string' || !value.name
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
    || typeof value.assetCount !== 'number' || !Number.isSafeInteger(value.assetCount) || value.assetCount < 0
    || !isRecord(value.savedBy) || value.savedBy.application !== 'AIDraw' || typeof value.savedBy.version !== 'string') {
    throw new Error('AIDraw manifest is malformed.');
  }
  return value as unknown as NativeManifest;
}

function assertNativeManifestMatchesDocument(manifest: NativeManifest, value: unknown): void {
  if (!isRecord(value)) return;
  const comparisons: Array<[keyof NativeManifest, unknown]> = [
    ['schemaVersion', value.schemaVersion],
    ['documentId', value.id],
    ['documentKind', value.kind],
    ['name', value.name],
    ['revision', value.revision],
    ['createdAt', value.createdAt],
    ['updatedAt', value.updatedAt],
    ['assetCount', isRecord(value.assets) ? Object.keys(value.assets).length : undefined],
  ];
  for (const [field, documentValue] of comparisons) {
    if (manifest[field] !== documentValue) throw new Error(`AIDraw manifest is inconsistent with document.json: ${field}.`);
  }
}

function normalizePath(filePath: string): string {
  return extname(filePath).toLowerCase() === '.aidraw' ? filePath : `${filePath}.aidraw`;
}

export function paintStrokePrefixSha256(strokes: RasterStroke[], count = strokes.length): string {
  return createHash('sha256').update(JSON.stringify(strokes.slice(0, count))).digest('hex');
}

function strokeTileRadius(stroke: RasterStroke): number {
  const size = Number.isFinite(stroke.size) ? Math.min(8_192, Math.max(0, Math.abs(stroke.size))) : 0;
  const scatter = Math.min(4, Math.max(0, Math.abs(stroke.dynamics?.scatter ?? 0)));
  const sizeJitter = Math.min(4, Math.max(0, Math.abs(stroke.dynamics?.sizeJitter ?? 0)));
  return Math.max(2, size * (1.25 + scatter + sizeJitter) + 4);
}

function strokesByTouchedTile(document: Extract<AIDrawDocument, { kind: 'illustration' }>, layer: PaintLayer, strokes: RasterStroke[] = layer.strokes): Map<string, RasterStroke[]> {
  const tileSize = layer.tileSize;
  const columns = Math.ceil(document.artboard.width / tileSize);
  const rows = Math.ceil(document.artboard.height / tileSize);
  const result = new Map<string, RasterStroke[]>();
  const addRange = (keys: Set<string>, from: RasterStroke['points'][number], to: RasterStroke['points'][number], radius: number) => {
    if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return;
    const left = Math.max(0, Math.floor((Math.min(from.x, to.x) - radius) / tileSize));
    const right = Math.min(columns - 1, Math.floor((Math.max(from.x, to.x) + radius) / tileSize));
    const top = Math.max(0, Math.floor((Math.min(from.y, to.y) - radius) / tileSize));
    const bottom = Math.min(rows - 1, Math.floor((Math.max(from.y, to.y) + radius) / tileSize));
    for (let tileY = top; tileY <= bottom; tileY += 1) for (let tileX = left; tileX <= right; tileX += 1) keys.add(`${tileX},${tileY}`);
  };
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const keys = new Set<string>();
    const radius = strokeTileRadius(stroke);
    addRange(keys, stroke.points[0], stroke.points[0], radius);
    for (let index = 1; index < stroke.points.length; index += 1) addRange(keys, stroke.points[index - 1], stroke.points[index], radius);
    for (const key of keys) {
      const strokes = result.get(key) ?? [];
      strokes.push(stroke);
      result.set(key, strokes);
    }
  }
  return result;
}

function comparePaintTileKeys(left: string, right: string): number {
  const leftCoordinates = parsePaintTileKey(left);
  const rightCoordinates = parsePaintTileKey(right);
  if (!leftCoordinates || !rightCoordinates) return left.localeCompare(right);
  return leftCoordinates.tileY - rightCoordinates.tileY || leftCoordinates.tileX - rightCoordinates.tileX || left.localeCompare(right);
}

function pruneUnreferencedPaintTiles(document: AIDrawDocument): void {
  for (const [assetId, asset] of Object.entries(document.assets)) {
    if (asset.source === 'rendered' && assetId.startsWith('paint-tile-') && findDocumentAssetReferences(document, assetId).length === 0) delete document.assets[assetId];
  }
}

async function validateNativeImageAsset(asset: DocumentAsset, imageDecoder?: ImageDecodeValidator): Promise<void> {
  const inspected = inspectDocumentImageAsset(asset, {
    maxBytes: MAX_NATIVE_BINARY_ENTRY_BYTES,
    limitLabel: '128 MiB',
    label: `AIDraw asset ${asset.id}`,
  });
  if (imageDecoder) {
    try { await imageDecoder(inspected.bytes, inspected.expected); }
    catch (error) {
      throw new Error(`AIDraw asset ${asset.id} could not be decoded safely: ${error instanceof Error ? error.message : 'unsupported image'}.`);
    }
  }
}

async function hydrateNativeAssets(
  document: AIDrawDocument,
  archive: ReturnType<typeof unzipSync>,
  warnings: string[],
  checkpoint = false,
  imageDecoder?: ImageDecodeValidator,
): Promise<void> {
  for (const [assetId, candidate] of Object.entries(document.assets)) {
    const asset = assertDocumentImageAssetMetadata(assetId, candidate);
    delete asset.data;
    const bytes = archive[`assets/${asset.sha256}`];
    const label = checkpoint ? 'checkpoint asset' : 'asset';
    if (!bytes) {
      if (asset.byteLength > 0) warnings.push(`Embedded data for ${label} “${asset.name}” is missing.`);
      continue;
    }
    if (bytes.byteLength !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256.toLowerCase()) {
      warnings.push(`Embedded data for ${label} “${asset.name}” is corrupt and was ignored.`);
      continue;
    }
    asset.data = Buffer.from(bytes).toString('base64');
    try {
      await validateNativeImageAsset(asset, imageDecoder);
    } catch {
      delete asset.data;
      warnings.push(`Embedded data for ${label} “${asset.name}” is not a valid decodable image and was ignored.`);
    }
  }
}

async function validateSuppliedNativeAssets(
  document: AIDrawDocument,
  checkpoints: DocumentCheckpointRecord[],
  imageDecoder?: ImageDecodeValidator,
): Promise<void> {
  const documents = [document, ...checkpoints.slice(-32).map((checkpoint) => checkpoint.document)];
  for (const value of documents) for (const [assetId, candidate] of Object.entries(value.assets)) {
    const asset = assertDocumentImageAssetMetadata(assetId, candidate);
    if (asset.data !== undefined) {
      const bytes = Buffer.from(asset.data, 'base64');
      if (bytes.toString('base64') !== asset.data || bytes.byteLength !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256.toLowerCase()) {
        throw new Error('AIDraw asset data does not match its content metadata.');
      }
      await validateNativeImageAsset(asset, imageDecoder);
    }
  }
}

export function clearPaintTileCaches(document: AIDrawDocument): void {
  if (document.kind !== 'illustration') return;
  for (const layer of Object.values(document.layers)) {
    if (layer.type !== 'paint') continue;
    layer.tileAssetIds = {};
    delete layer.tileCache;
  }
  pruneUnreferencedPaintTiles(document);
}

function inspectPaintTileCache(document: Extract<AIDrawDocument, { kind: 'illustration' }>, layer: PaintLayer): { plan?: NonNullable<ReturnType<typeof paintTileCachePlan>>; reason?: string } {
  if (!layer.tileCache) return { reason: 'its metadata or referenced assets are incomplete' };
  const plan = paintTileCachePlan(layer, document.assets);
  if (!plan) return { reason: 'its metadata or referenced assets are incomplete' };
  if (paintStrokePrefixSha256(layer.strokes, plan.strokeCount) !== layer.tileCache.strokesSha256.toLowerCase()) return { reason: 'its editable stroke digest does not match' };
  const expectedKeys = new Set(strokesByTouchedTile(document, layer, layer.strokes.slice(0, plan.strokeCount)).keys());
  if (expectedKeys.size !== plan.entries.length || plan.entries.some((entry) => !expectedKeys.has(entry.key))) return { reason: 'its tile index does not match editable stroke coverage' };
  const columns = Math.ceil(document.artboard.width / layer.tileSize);
  const rows = Math.ceil(document.artboard.height / layer.tileSize);
  for (const entry of plan.entries) {
    if (entry.tileX < 0 || entry.tileY < 0 || entry.tileX >= columns || entry.tileY >= rows) return { reason: 'a tile falls outside the artboard' };
    try {
      const bytes = Buffer.from(entry.asset.data!, 'base64');
      const header = inspectImageHeader(bytes);
      if (header.mimeType !== 'image/png' || header.width !== layer.tileSize || header.height !== layer.tileSize || bytes.byteLength !== entry.asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== entry.asset.sha256.toLowerCase()) return { reason: 'a tile payload is inconsistent' };
    } catch { return { reason: 'a tile payload is corrupt' }; }
  }
  return { plan };
}

export interface PaintTileMaterializationResult {
  layers: number;
  renderedTiles: number;
  reusedTiles: number;
}

export function materializePaintTiles(document: AIDrawDocument): PaintTileMaterializationResult {
  const result: PaintTileMaterializationResult = { layers: 0, renderedTiles: 0, reusedTiles: 0 };
  if (document.kind !== 'illustration') return result;
  for (const layer of Object.values(document.layers)) {
    if (layer.type !== 'paint') continue;
    result.layers += 1;
    const reusable = inspectPaintTileCache(document, layer).plan;
    const allTiles = strokesByTouchedTile(document, layer);
    const dirtyKeys = reusable
      ? new Set(strokesByTouchedTile(document, layer, layer.strokes.slice(reusable.strokeCount)).keys())
      : new Set(allTiles.keys());
    const nextTileAssetIds: Record<string, string> = reusable ? Object.fromEntries(reusable.entries.map((entry) => [entry.key, entry.assetId])) : {};
    result.reusedTiles += reusable?.entries.filter((entry) => !dirtyKeys.has(entry.key)).length ?? 0;
    const canvas = dirtyKeys.size ? createCanvas(layer.tileSize, layer.tileSize) : undefined;
    try {
      for (const key of [...dirtyKeys].sort(comparePaintTileKeys)) {
        const strokes = allTiles.get(key);
        if (!strokes?.length) { delete nextTileAssetIds[key]; continue; }
        const coordinates = parsePaintTileKey(key);
        if (!coordinates) continue;
        const context = canvas!.getContext('2d');
        context.reset();
        context.translate(-coordinates.tileX * layer.tileSize, -coordinates.tileY * layer.tileSize);
        context.lineCap = 'round';
        context.lineJoin = 'round';
        for (const stroke of strokes) renderRasterStroke(context, stroke);
        const bytes = canvas!.toBuffer('image/png');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const id = `paint-tile-${sha256}`;
        document.assets[id] = { id, name: `${layer.name} ${key}`, mimeType: 'image/png', byteLength: bytes.byteLength, sha256, source: 'rendered', data: bytes.toString('base64') };
        nextTileAssetIds[key] = id;
        result.renderedTiles += 1;
      }
    } finally { if (canvas) { canvas.width = 1; canvas.height = 1; } }
    layer.tileAssetIds = Object.fromEntries(Object.entries(nextTileAssetIds).sort(([left], [right]) => comparePaintTileKeys(left, right)));
    layer.tileCache = { version: 1, strokeCount: layer.strokes.length, strokesSha256: paintStrokePrefixSha256(layer.strokes) };
  }
  pruneUnreferencedPaintTiles(document);
  return result;
}

function validateLoadedPaintTileCaches(document: AIDrawDocument, warnings: string[]): void {
  if (document.kind !== 'illustration') return;
  for (const layer of Object.values(document.layers)) {
    if (layer.type !== 'paint') continue;
    if (!layer.tileCache) {
      layer.tileAssetIds = {};
      continue;
    }
    const { reason } = inspectPaintTileCache(document, layer);
    if (reason) {
      layer.tileAssetIds = {};
      delete layer.tileCache;
      warnings.push(`Paint cache for “${layer.name}” was ignored because ${reason}. Editable strokes were preserved.`);
    }
  }
  pruneUnreferencedPaintTiles(document);
}

function adoptPaintTileCaches(document: AIDrawDocument, persisted: AIDrawDocument): void {
  if (document.kind !== 'illustration' || persisted.kind !== 'illustration' || document.id !== persisted.id || document.artboard.width !== persisted.artboard.width || document.artboard.height !== persisted.artboard.height) return;
  for (const persistedLayer of Object.values(persisted.layers)) {
    if (persistedLayer.type !== 'paint' || !persistedLayer.tileCache) continue;
    const layer = document.layers[persistedLayer.id];
    if (!layer || layer.type !== 'paint' || layer.tileSize !== persistedLayer.tileSize || (layer.tileCache?.strokeCount ?? -1) > persistedLayer.tileCache.strokeCount) continue;
    if (persistedLayer.tileCache.strokeCount > layer.strokes.length || paintStrokePrefixSha256(layer.strokes, persistedLayer.tileCache.strokeCount) !== persistedLayer.tileCache.strokesSha256.toLowerCase()) continue;
    layer.tileAssetIds = structuredClone(persistedLayer.tileAssetIds);
    layer.tileCache = structuredClone(persistedLayer.tileCache);
    for (const assetId of new Set(Object.values(persistedLayer.tileAssetIds))) {
      const asset = persisted.assets[assetId];
      if (asset) document.assets[assetId] = structuredClone(asset);
    }
  }
  pruneUnreferencedPaintTiles(document);
}

function buildArchive(document: AIDrawDocument, appVersion: string, preview?: Uint8Array, trace: TransactionTraceEntry[] = [], checkpoints: DocumentCheckpointRecord[] = []): Uint8Array {
  const persisted = structuredClone(document);
  persisted.dirty = false;
  delete persisted.filePath;
  materializePaintTiles(persisted);
  const files: Record<string, Uint8Array> = {};
  const externalizeAssets = (value: AIDrawDocument) => {
    const assetMetadata: Record<string, DocumentAsset> = {};
    for (const [assetId, candidate] of Object.entries(value.assets)) {
      const asset = assertDocumentImageAssetMetadata(assetId, candidate);
      const metadata = structuredClone(asset);
      if (metadata.data !== undefined) {
        const bytes = Buffer.from(metadata.data, 'base64');
        if (bytes.toString('base64') !== metadata.data || bytes.byteLength !== metadata.byteLength || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256.toLowerCase()) {
          throw new Error('AIDraw asset data does not match its content metadata.');
        }
        files[`assets/${metadata.sha256}`] ??= Uint8Array.from(bytes);
        delete metadata.data;
      }
      assetMetadata[metadata.id] = metadata;
    }
    value.assets = assetMetadata;
  };
  externalizeAssets(persisted);

  const checkpointIds = new Set<string>();
  const persistedCheckpoints = checkpoints.slice(-32).map((checkpoint) => {
    const parsed = parseCheckpointRecord(checkpoint, persisted.id);
    if (!parsed || checkpointIds.has(parsed.id) || !checkpointDocumentMatchesMetadata(parsed, parsed.document)) {
      throw new Error('AIDraw checkpoint contains invalid or inconsistent metadata.');
    }
    checkpointIds.add(parsed.id);
    const copy = structuredClone(checkpoint);
    copy.document.dirty = false;
    delete copy.document.filePath;
    clearPaintTileCaches(copy.document);
    externalizeAssets(copy.document);
    return copy;
  });

  const manifest: NativeManifest = {
    format: 'AIDraw',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    documentId: persisted.id,
    documentKind: persisted.kind,
    name: persisted.name,
    revision: persisted.revision,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
    assetCount: Object.keys(persisted.assets).length,
    savedBy: { application: 'AIDraw', version: appVersion },
  };

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['document.json'] = strToU8(JSON.stringify(persisted));
  files['activity.json'] = strToU8(JSON.stringify(persisted.activity));
  const persistedTrace = trace.map((entry) => {
    const parsed = parseTransactionTraceEntry(entry, persisted.id);
    if (!parsed) throw new Error('AIDraw transaction trace contains an invalid entry.');
    return parsed;
  });
  files['trace/transactions.jsonl'] = strToU8(persistedTrace.map((entry) => JSON.stringify(entry)).join('\n') + (persistedTrace.length ? '\n' : ''));
  files['checkpoints/index.json'] = strToU8(JSON.stringify(persistedCheckpoints.map((checkpoint) => ({
    id: checkpoint.id, documentId: checkpoint.documentId, name: checkpoint.name, createdAt: checkpoint.createdAt,
    createdBy: checkpoint.createdBy, sourceRevision: checkpoint.sourceRevision, kind: checkpoint.kind,
  }))));
  for (const checkpoint of persistedCheckpoints) files[`checkpoints/${checkpoint.id}.json`] = strToU8(JSON.stringify(checkpoint));
  files['preview.png'] = preview ?? TRANSPARENT_PREVIEW;
  return zipSync(files, { level: 6 });
}

export async function readNativeDocument(filePath: string, imageDecoder?: ImageDecodeValidator): Promise<LoadedNativeDocument> {
  const archive = unzipNativeArchive(new Uint8Array(await readFile(filePath)));
  if (!archive['manifest.json'] || !archive['document.json']) {
    throw new Error('This file is not a valid AIDraw container.');
  }
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(strFromU8(archive['manifest.json'])); } catch { throw new Error('AIDraw manifest is malformed.'); }
  const manifest = parseNativeManifest(manifestValue);
  const documentValue: unknown = JSON.parse(strFromU8(archive['document.json']));
  assertNativeManifestMatchesDocument(manifest, documentValue);
  const document = migrateDocument(documentValue);
  const warnings: string[] = [];
  const trace: TransactionTraceEntry[] = [];
  const checkpoints: DocumentCheckpointRecord[] = [];
  if (archive['trace/transactions.jsonl']) {
    const parsed = parseTransactionTraceJsonl(strFromU8(archive['trace/transactions.jsonl']), document.id);
    trace.push(...parsed.entries);
    if (parsed.ignored === 1) warnings.push('A malformed transaction trace entry was ignored.');
    else if (parsed.ignored > 1) warnings.push(`${parsed.ignored.toLocaleString('en-US')} malformed transaction trace entries were ignored.`);
  }
  await hydrateNativeAssets(document, archive, warnings, false, imageDecoder);
  validateLoadedPaintTileCaches(document, warnings);
  if (archive['checkpoints/index.json']) {
    try {
      const summaries = JSON.parse(strFromU8(archive['checkpoints/index.json'])) as unknown;
      if (!Array.isArray(summaries)) throw new Error('Checkpoint index is not an array.');
      const checkpointIds = new Set<string>();
      for (const value of summaries.slice(-32)) {
        const summary = parseCheckpointSummary(value, document.id);
        if (!summary || checkpointIds.has(summary.id)) { warnings.push('An invalid checkpoint entry was ignored.'); continue; }
        checkpointIds.add(summary.id);
        const bytes = archive[`checkpoints/${summary.id}.json`]; if (!bytes) { warnings.push(`Checkpoint “${summary.id}” is missing.`); continue; }
        try {
          const parsed = parseCheckpointRecord(JSON.parse(strFromU8(bytes)), document.id);
          if (!parsed || !checkpointMetadataMatches(summary, parsed)) throw new Error('Checkpoint metadata is inconsistent.');
          const checkpointDocument = migrateDocument(parsed.document);
          if (!checkpointDocumentMatchesMetadata(parsed, checkpointDocument)) throw new Error('Checkpoint metadata is inconsistent.');
          await hydrateNativeAssets(checkpointDocument, archive, warnings, true, imageDecoder);
          validateLoadedPaintTileCaches(checkpointDocument, warnings);
          checkpoints.push({ ...parsed, document: checkpointDocument });
        } catch { warnings.push(`Checkpoint “${summary.id}” is corrupt and was ignored.`); }
      }
    } catch { warnings.push('The checkpoint index is corrupt and was ignored.'); }
  }
  document.filePath = filePath;
  document.dirty = false;
  return { document, manifest, trace, checkpoints, warnings };
}

export interface NativeSaveHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface NativeSaveFileSystem {
  openExclusive(filePath: string): Promise<NativeSaveHandle>;
  replace(source: string, destination: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

export type NativePreviewSource = Uint8Array | (() => Promise<Uint8Array | undefined>);

export const nativeSaveFileSystem: NativeSaveFileSystem = {
  openExclusive: async (filePath) => {
    const handle = await open(filePath, 'wx');
    return {
      writeFile: async (data) => { await handle.writeFile(data); },
      sync: async () => { await handle.sync(); },
      close: async () => { await handle.close(); },
    };
  },
  replace: rename,
  remove: unlink,
};

export async function writeNativeDocument(
  filePath: string,
  document: AIDrawDocument,
  appVersion: string,
  preview?: NativePreviewSource,
  trace: TransactionTraceEntry[] = [],
  checkpoints: DocumentCheckpointRecord[] = [],
  fileSystem: NativeSaveFileSystem = nativeSaveFileSystem,
  imageDecoder?: ImageDecodeValidator,
): Promise<string> {
  const destination = normalizePath(filePath);
  await validateSuppliedNativeAssets(document, checkpoints, imageDecoder);
  const resolvedPreview = typeof preview === 'function' ? await preview() : preview;
  await mkdir(dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const bytes = buildArchive(document, appVersion, resolvedPreview, trace, checkpoints);
  try {
    const handle = await fileSystem.openExclusive(temp);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const persisted = (await readNativeDocument(temp, imageDecoder)).document;
    await fileSystem.replace(temp, destination);
    adoptPaintTileCaches(document, persisted);
  } catch (error) {
    // Preserve the original failure. An OS-locked temp may remain as an uncommitted sibling, but it is never promoted or used for recovery implicitly.
    await fileSystem.remove(temp).catch(() => undefined);
    throw error;
  }
  return destination;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
