import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { migrateDocument, type AIDrawDocument, type DocumentAsset } from '@aidraw/core';
import type { TransactionTraceEntry } from '../common/contracts';

const TRANSPARENT_PREVIEW = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE/wH+Q5ZkAAAAAElFTkSuQmCC',
    'base64',
  ),
);

export interface NativeManifest {
  format: 'AIDraw';
  schemaVersion: 1;
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
  warnings: string[];
}

function normalizePath(filePath: string): string {
  return extname(filePath).toLowerCase() === '.aidraw' ? filePath : `${filePath}.aidraw`;
}

function materializePaintTiles(document: AIDrawDocument): void {
  if (document.kind !== 'illustration') return; const tileSize = 256;
  for (const layer of Object.values(document.layers)) {
    if (layer.type !== 'paint') continue; for (const assetId of Object.values(layer.tileAssetIds)) if (document.assets[assetId]?.source === 'rendered') delete document.assets[assetId]; layer.tileAssetIds = {};
    const touched = new Set<string>(); for (const stroke of layer.strokes) for (const point of stroke.points) { const radius = Math.max(1, stroke.size / 2); const left = Math.floor((point.x - radius) / tileSize); const right = Math.floor((point.x + radius) / tileSize); const top = Math.floor((point.y - radius) / tileSize); const bottom = Math.floor((point.y + radius) / tileSize); for (let tileY = top; tileY <= bottom; tileY += 1) for (let tileX = left; tileX <= right; tileX += 1) touched.add(`${tileX},${tileY}`); }
    for (const key of touched) { const [tileX, tileY] = key.split(',').map(Number); const canvas = createCanvas(tileSize, tileSize); const context = canvas.getContext('2d'); context.translate(-tileX * tileSize, -tileY * tileSize); context.lineCap = 'round'; context.lineJoin = 'round';
      for (const stroke of layer.strokes) { if (!stroke.points.length) continue; context.save(); context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'; context.globalAlpha = stroke.opacity; context.strokeStyle = stroke.color; context.lineWidth = stroke.size; if (stroke.preset === 'soft-round' || stroke.preset === 'airbrush') { context.shadowColor = stroke.color; context.shadowBlur = stroke.size * (stroke.preset === 'airbrush' ? 0.9 : 0.45); } context.beginPath(); context.moveTo(stroke.points[0].x, stroke.points[0].y); for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y); if (stroke.points.length === 1) context.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y); context.stroke(); context.restore(); }
      const bytes = canvas.toBuffer('image/png'); const sha256 = createHash('sha256').update(bytes).digest('hex'); const id = `paint-tile-${sha256}`; document.assets[id] ??= { id, name: `${layer.name} ${key}`, mimeType: 'image/png', byteLength: bytes.byteLength, sha256, source: 'rendered', data: bytes.toString('base64') }; layer.tileAssetIds[key] = id;
    }
  }
}

function buildArchive(document: AIDrawDocument, appVersion: string, preview?: Uint8Array, trace: TransactionTraceEntry[] = []): Uint8Array {
  const persisted = structuredClone(document);
  persisted.dirty = false;
  delete persisted.filePath;
  materializePaintTiles(persisted);
  const files: Record<string, Uint8Array> = {};
  const assetMetadata: Record<string, DocumentAsset> = {};

  for (const asset of Object.values(persisted.assets)) {
    const metadata = structuredClone(asset);
    if (metadata.data) {
      files[`assets/${metadata.sha256}`] = Uint8Array.from(Buffer.from(metadata.data, 'base64'));
      delete metadata.data;
    }
    assetMetadata[metadata.id] = metadata;
  }
  persisted.assets = assetMetadata;

  const manifest: NativeManifest = {
    format: 'AIDraw',
    schemaVersion: 1,
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
  files['trace/transactions.jsonl'] = strToU8(trace.map((entry) => JSON.stringify(entry)).join('\n') + (trace.length ? '\n' : ''));
  files['preview.png'] = preview ?? TRANSPARENT_PREVIEW;
  return zipSync(files, { level: 6 });
}

export async function readNativeDocument(filePath: string): Promise<LoadedNativeDocument> {
  const archive = unzipSync(new Uint8Array(await readFile(filePath)));
  if (!archive['manifest.json'] || !archive['document.json']) {
    throw new Error('This file is not a valid AIDraw container.');
  }
  const manifest = JSON.parse(strFromU8(archive['manifest.json'])) as NativeManifest;
  if (manifest.format !== 'AIDraw' || manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported AIDraw schema version: ${String(manifest.schemaVersion)}`);
  }
  const document = migrateDocument(JSON.parse(strFromU8(archive['document.json'])));
  const warnings: string[] = [];
  const trace: TransactionTraceEntry[] = [];
  if (archive['trace/transactions.jsonl']) {
    for (const line of strFromU8(archive['trace/transactions.jsonl']).split(/\r?\n/).filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as TransactionTraceEntry;
        if (entry.version === 1 && entry.documentId === document.id && entry.transaction) trace.push(entry);
        else warnings.push('An invalid transaction trace entry was ignored.');
      } catch { warnings.push('A corrupt transaction trace entry was ignored.'); }
    }
  }
  for (const asset of Object.values(document.assets)) {
    const bytes = archive[`assets/${asset.sha256}`];
    if (bytes) asset.data = Buffer.from(bytes).toString('base64');
    else if (asset.byteLength > 0) warnings.push(`Embedded data for asset “${asset.name}” is missing.`);
  }
  document.filePath = filePath;
  document.dirty = false;
  return { document, manifest, trace, warnings };
}

export async function writeNativeDocument(
  filePath: string,
  document: AIDrawDocument,
  appVersion: string,
  preview?: Uint8Array,
  trace: TransactionTraceEntry[] = [],
): Promise<string> {
  const destination = normalizePath(filePath);
  await mkdir(dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const bytes = buildArchive(document, appVersion, preview, trace);
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await readNativeDocument(temp);
    await rename(temp, destination);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
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
