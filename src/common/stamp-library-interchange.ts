import {
  CanvasOperationSchema,
  createId,
  decodeTiledGid,
  resolveTilesetForGid,
  type CanvasOperation,
  type PaletteEntry,
  type PixelDocument,
  type PixelStamp,
  type PixelTilemap,
  type PixelTileset,
  type TileStamp,
} from '@aidraw/core';
import { z } from 'zod';

export const MAX_STAMP_LIBRARY_BYTES = 16 * 1024 * 1024;
export const MAX_STAMP_LIBRARY_CELLS = 262_144;

const TilesetReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  firstGid: z.number().int().min(1).max(0x0fff_ffff),
  tileCount: z.number().int().min(1).max(1_048_576),
  tileWidth: z.number().int().min(1).max(8_192),
  tileHeight: z.number().int().min(1).max(8_192),
  margin: z.number().int().nonnegative().max(8_192),
  spacing: z.number().int().nonnegative().max(8_192),
  columns: z.number().int().min(1).max(1_024),
  rows: z.number().int().min(1).max(1_024),
  spriteAssetId: z.string().min(1),
  spriteRevision: z.number().int().nonnegative(),
  spriteWidth: z.number().int().min(1).max(8_192),
  spriteHeight: z.number().int().min(1).max(8_192),
}).strict();

export type StampLibraryTilesetReference = z.infer<typeof TilesetReferenceSchema>;

export interface PixelStampLibraryBundle {
  format: 'aidraw-stamp-library';
  version: 1;
  kind: 'pixel';
  palette: PaletteEntry[];
  stamps: PixelStamp[];
}

export interface TileStampLibraryBundle {
  format: 'aidraw-stamp-library';
  version: 1;
  kind: 'tile';
  tilesets: StampLibraryTilesetReference[];
  stamps: TileStamp[];
}

export type StampLibraryBundle = PixelStampLibraryBundle | TileStampLibraryBundle;
export type StampLibraryImportMode = 'append' | 'replace';

export interface StampLibraryImportPlan {
  kind: 'pixel' | 'tile';
  mode: StampLibraryImportMode;
  incomingCount: number;
  totalCount: number;
  importedIds: string[];
  operations: CanvasOperation[];
}

const PixelEnvelopeSchema = z.object({
  format: z.literal('aidraw-stamp-library'),
  version: z.literal(1),
  kind: z.literal('pixel'),
  palette: z.unknown(),
  stamps: z.unknown(),
}).strict();

const TileEnvelopeSchema = z.object({
  format: z.literal('aidraw-stamp-library'),
  version: z.literal(1),
  kind: z.literal('tile'),
  tilesets: z.array(TilesetReferenceSchema).max(1_024),
  stamps: z.unknown(),
}).strict();

function firstIssue(result: { error: { issues: Array<{ message: string }> } }, fallback: string): Error {
  return new Error(result.error.issues[0]?.message ?? fallback);
}

function encodedBytes(text: string): number {
  if (text.length > MAX_STAMP_LIBRARY_BYTES) return text.length;
  return new TextEncoder().encode(text).byteLength;
}

function assertSerializedBound(text: string): void {
  if (encodedBytes(text) > MAX_STAMP_LIBRARY_BYTES) throw new Error('Stamp library JSON is limited to 16 MiB.');
}

function assertCellBudget(stamps: unknown): void {
  if (!Array.isArray(stamps) || stamps.length < 1) throw new Error('Stamp libraries require at least one stamp.');
  let cells = 0;
  for (const stamp of stamps) {
    if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) continue;
    const value = stamp as { cells?: unknown };
    if (!Array.isArray(value.cells)) continue;
    cells += value.cells.length;
    if (cells > MAX_STAMP_LIBRARY_CELLS) throw new Error('Stamp library interchange is limited to 262,144 total cells.');
  }
}

function validatePixelStamps(stamps: unknown): PixelStamp[] {
  assertCellBudget(stamps);
  const result = CanvasOperationSchema.safeParse({ kind: 'pixel.stamps.replace', stamps });
  if (!result.success) throw firstIssue(result, 'The pixel stamp library is invalid.');
  if (result.data.kind !== 'pixel.stamps.replace') throw new Error('The pixel stamp library is invalid.');
  return structuredClone(result.data.stamps);
}

function validateTileStamps(stamps: unknown): TileStamp[] {
  assertCellBudget(stamps);
  const result = CanvasOperationSchema.safeParse({ kind: 'pixel.tile-stamps.replace', stamps });
  if (!result.success) throw firstIssue(result, 'The tile stamp library is invalid.');
  if (result.data.kind !== 'pixel.tile-stamps.replace') throw new Error('The tile stamp library is invalid.');
  return structuredClone(result.data.stamps);
}

function validatePalette(palette: unknown): PaletteEntry[] {
  const result = CanvasOperationSchema.safeParse({ kind: 'pixel.palette.replace', palette });
  if (!result.success) throw firstIssue(result, 'The stamp library palette is invalid.');
  if (result.data.kind !== 'pixel.palette.replace') throw new Error('The stamp library palette is invalid.');
  return structuredClone(result.data.palette);
}

function assertReferenceRanges(references: StampLibraryTilesetReference[]): void {
  if (new Set(references.map((reference) => reference.id)).size !== references.length) throw new Error('Tile stamp library tileset IDs must be unique.');
  const ordered = [...references].sort((left, right) => left.firstGid - right.firstGid);
  for (let index = 0; index < ordered.length; index += 1) {
    const reference = ordered[index];
    if (reference.tileCount !== reference.columns * reference.rows) throw new Error(`Tileset “${reference.name}” has inconsistent tile geometry.`);
    if (reference.firstGid + reference.tileCount - 1 > 0x0fff_ffff) throw new Error(`Tileset “${reference.name}” exceeds the supported GID range.`);
    const prior = ordered[index - 1];
    if (prior && reference.firstGid < prior.firstGid + prior.tileCount) throw new Error(`Tilesets “${prior.name}” and “${reference.name}” have overlapping GID ranges.`);
  }
}

function referenceForGid(references: StampLibraryTilesetReference[], gid: number): StampLibraryTilesetReference | undefined {
  return [...references].filter((reference) => reference.firstGid <= gid).sort((left, right) => right.firstGid - left.firstGid).find((reference) => gid - reference.firstGid < reference.tileCount);
}

function assertTileStampReferences(stamps: TileStamp[], references: StampLibraryTilesetReference[]): void {
  assertReferenceRanges(references);
  for (const stamp of stamps) for (const cell of stamp.cells) {
    const { gid } = decodeTiledGid(cell.gid);
    if (gid !== 0 && !referenceForGid(references, gid)) throw new Error(`Tile stamp “${stamp.name}” uses GID ${gid}, which is outside its declared tilesets.`);
  }
}

export function parseStampLibraryJson(text: string): StampLibraryBundle {
  assertSerializedBound(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Stamp library JSON is malformed.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Stamp library JSON must contain an object.');
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind === 'pixel') {
    const envelope = PixelEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) throw firstIssue(envelope, 'The pixel stamp library envelope is invalid.');
    return { ...envelope.data, palette: validatePalette(envelope.data.palette), stamps: validatePixelStamps(envelope.data.stamps) };
  }
  if (kind === 'tile') {
    const envelope = TileEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) throw firstIssue(envelope, 'The tile stamp library envelope is invalid.');
    const stamps = validateTileStamps(envelope.data.stamps);
    assertTileStampReferences(stamps, envelope.data.tilesets);
    return { ...envelope.data, tilesets: structuredClone(envelope.data.tilesets), stamps };
  }
  throw new Error('Stamp library JSON must declare pixel or tile stamps.');
}

function serializeBundle(bundle: StampLibraryBundle): string {
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  assertSerializedBound(text);
  return text;
}

export function serializePixelStampLibrary(document: PixelDocument): string {
  const stamps = validatePixelStamps(document.stamps);
  return serializeBundle({ format: 'aidraw-stamp-library', version: 1, kind: 'pixel', palette: validatePalette(document.palette), stamps });
}

function tilesetReference(document: PixelDocument, tileset: PixelTileset): StampLibraryTilesetReference {
  const source = document.pixelAssets[tileset.spriteAssetId];
  if (!source || source.type !== 'sprite') throw new Error(`Tileset “${tileset.name}” is missing its source sprite.`);
  return {
    id: tileset.id,
    name: tileset.name,
    revision: tileset.revision,
    firstGid: tileset.firstGid,
    tileCount: tileset.columns * tileset.rows,
    tileWidth: tileset.tileWidth,
    tileHeight: tileset.tileHeight,
    margin: tileset.margin,
    spacing: tileset.spacing,
    columns: tileset.columns,
    rows: tileset.rows,
    spriteAssetId: source.id,
    spriteRevision: source.revision,
    spriteWidth: source.width,
    spriteHeight: source.height,
  };
}

export function serializeTileStampLibrary(document: PixelDocument, map: PixelTilemap): string {
  const stamps = validateTileStamps(document.tileStamps);
  const references = new Map<string, StampLibraryTilesetReference>();
  for (const stamp of stamps) for (const cell of stamp.cells) {
    const { gid } = decodeTiledGid(cell.gid);
    if (gid === 0) continue;
    const resolved = resolveTilesetForGid(document, map, gid);
    if (!resolved) throw new Error(`Tile stamp “${stamp.name}” uses GID ${gid}, which the active map cannot resolve.`);
    references.set(resolved.tileset.id, tilesetReference(document, resolved.tileset));
  }
  const tilesets = [...references.values()].sort((left, right) => left.firstGid - right.firstGid);
  assertTileStampReferences(stamps, tilesets);
  return serializeBundle({ format: 'aidraw-stamp-library', version: 1, kind: 'tile', tilesets, stamps });
}

function uniqueId(prefix: string, used: Set<string>, makeId: (prefix: string) => string): string {
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const id = makeId(prefix);
    if (id && !used.has(id)) { used.add(id); return id; }
  }
  throw new Error('Could not allocate a unique imported stamp ID.');
}

function uniqueName(name: string, used: Set<string>): string {
  const original = name.trim();
  if (!used.has(original.toLowerCase())) { used.add(original.toLowerCase()); return original; }
  for (let number = 2; number <= 1_024; number += 1) {
    const suffix = ` (import ${number})`;
    const candidate = `${original.slice(0, Math.max(1, 200 - suffix.length)).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) { used.add(candidate.toLowerCase()); return candidate; }
  }
  throw new Error(`Could not allocate a unique name for “${name}”.`);
}

function appendPixelStampCopies(existing: PixelStamp[], imported: PixelStamp[], makeId: (prefix: string) => string): { stamps: PixelStamp[]; importedIds: string[] } {
  const usedIds = new Set(existing.map((stamp) => stamp.id)); const usedNames = new Set(existing.map((stamp) => stamp.name.toLowerCase())); const copies: PixelStamp[] = [];
  for (const source of imported) copies.push({ ...structuredClone(source), id: uniqueId('stamp', usedIds, makeId), name: uniqueName(source.name, usedNames) });
  return { stamps: [...structuredClone(existing), ...copies], importedIds: copies.map((stamp) => stamp.id) };
}

function appendTileStampCopies(existing: TileStamp[], imported: TileStamp[], makeId: (prefix: string) => string): { stamps: TileStamp[]; importedIds: string[] } {
  const usedIds = new Set(existing.map((stamp) => stamp.id)); const usedNames = new Set(existing.map((stamp) => stamp.name.toLowerCase())); const copies: TileStamp[] = [];
  for (const source of imported) copies.push({ ...structuredClone(source), id: uniqueId('tile-stamp', usedIds, makeId), name: uniqueName(source.name, usedNames) });
  return { stamps: [...structuredClone(existing), ...copies], importedIds: copies.map((stamp) => stamp.id) };
}

function preparePixelPalette(document: PixelDocument, bundle: PixelStampLibraryBundle, makeId: (prefix: string) => string): { palette: PaletteEntry[]; mapping: number[] } {
  const palette = structuredClone(document.palette); const usedIds = new Set(palette.map((entry) => entry.id)); const mapping = bundle.palette.map(() => 0);
  const usedIndices = [...new Set(bundle.stamps.flatMap((stamp) => stamp.cells.map((cell) => cell.index)))].sort((left, right) => left - right);
  for (const sourceIndex of usedIndices) {
    if (sourceIndex === 0) { mapping[0] = 0; continue; }
    const source = bundle.palette[sourceIndex];
    if (!source) throw new Error(`Pixel stamp library references missing palette index ${sourceIndex}.`);
    let targetIndex = palette.findIndex((entry, index) => index > 0 && entry.color.toLowerCase() === source.color.toLowerCase());
    if (targetIndex < 0) {
      if (palette.length >= 256) throw new Error(`The destination palette is full and does not contain ${source.color}.`);
      targetIndex = palette.length;
      palette.push({ ...structuredClone(source), id: uniqueId('palette', usedIds, makeId) });
    }
    mapping[sourceIndex] = targetIndex;
  }
  return { palette, mapping };
}

function assertTargetTilesetCompatibility(document: PixelDocument, map: PixelTilemap, reference: StampLibraryTilesetReference): void {
  if (!map.tilesetIds.includes(reference.id)) throw new Error(`The active map does not use required tileset “${reference.name}” (${reference.id}).`);
  const target = document.pixelAssets[reference.id];
  if (!target || target.type !== 'tileset') throw new Error(`Required tileset “${reference.name}” is unavailable.`);
  const actual = tilesetReference(document, target);
  if (JSON.stringify(actual) !== JSON.stringify(reference)) throw new Error(`Tileset “${reference.name}” does not match the exported identity, revision, GID range, geometry, or source sprite.`);
}

export function prepareStampLibraryImport(
  document: PixelDocument,
  bundle: StampLibraryBundle,
  mode: StampLibraryImportMode,
  options: { map?: PixelTilemap; makeId?: (prefix: string) => string } = {},
): StampLibraryImportPlan {
  const makeId = options.makeId ?? createId;
  if (bundle.kind === 'pixel') {
    const { palette, mapping } = preparePixelPalette(document, bundle, makeId);
    const imported = bundle.stamps.map((stamp) => ({ ...structuredClone(stamp), cells: stamp.cells.map((cell) => ({ ...cell, index: mapping[cell.index] ?? 0 })) }));
    const merged = mode === 'append' ? appendPixelStampCopies(document.stamps, imported, makeId) : { stamps: imported, importedIds: imported.map((stamp) => stamp.id) };
    const stampOperation = CanvasOperationSchema.safeParse({ kind: 'pixel.stamps.replace', stamps: merged.stamps });
    if (!stampOperation.success) throw firstIssue(stampOperation, 'The imported pixel stamp library is invalid.');
    const operations: CanvasOperation[] = [];
    if (palette.length !== document.palette.length) operations.push({ kind: 'pixel.palette.replace', palette });
    operations.push({ kind: 'pixel.stamps.replace', stamps: merged.stamps });
    return { kind: 'pixel', mode, incomingCount: imported.length, totalCount: merged.stamps.length, importedIds: merged.importedIds, operations };
  }
  const map = options.map;
  if (!map) throw new Error('Choose a tilemap before importing a tile stamp library.');
  for (const reference of bundle.tilesets) assertTargetTilesetCompatibility(document, map, reference);
  for (const stamp of bundle.stamps) for (const cell of stamp.cells) {
    const { gid } = decodeTiledGid(cell.gid);
    if (gid === 0) continue;
    const resolved = resolveTilesetForGid(document, map, gid);
    const reference = referenceForGid(bundle.tilesets, gid);
    if (!resolved || !reference || resolved.tileset.id !== reference.id) throw new Error(`Tile stamp “${stamp.name}” cannot resolve GID ${gid} through the active map's declared tilesets.`);
  }
  const imported = structuredClone(bundle.stamps);
  const merged = mode === 'append' ? appendTileStampCopies(document.tileStamps, imported, makeId) : { stamps: imported, importedIds: imported.map((stamp) => stamp.id) };
  const stampOperation = CanvasOperationSchema.safeParse({ kind: 'pixel.tile-stamps.replace', stamps: merged.stamps });
  if (!stampOperation.success) throw firstIssue(stampOperation, 'The imported tile stamp library is invalid.');
  return { kind: 'tile', mode, incomingCount: imported.length, totalCount: merged.stamps.length, importedIds: merged.importedIds, operations: [{ kind: 'pixel.tile-stamps.replace', stamps: merged.stamps }] };
}
