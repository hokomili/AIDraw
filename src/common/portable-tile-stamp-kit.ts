import {
  CanvasOperationSchema,
  HUMAN_ACTOR,
  TILED_GID_MASK,
  assertImageCollectionTilemapMode,
  assertPixelSpriteUsesPalette,
  createId,
  decodePixelChunk,
  decodeTilemapChunk,
  decodeTiledGid,
  encodeTiledGid,
  isImageCollectionTileset,
  nextTilesetFirstGid,
  remapPixelCelIndices,
  tilesetHasLocalId,
  tilesetLocalIdSpan,
  type CanvasOperation,
  type PaletteEntry,
  type PixelAsset,
  type PixelDocument,
  type PixelSprite,
  type PixelTilemap,
  type PixelTileset,
  type TileStamp,
} from '@aidraw/core';
import { MAX_TILED_LAYERS, MAX_TILED_OBJECTS, MAX_TILED_TOTAL_CELLS } from './tiled-resource-policy';

export const MAX_PORTABLE_STAMP_KIT_ASSETS = 128;
export const MAX_PORTABLE_STAMP_KIT_TILESETS = 64;
export const MAX_PORTABLE_STAMP_KIT_SOURCE_PIXELS = 4_194_304;
export const MAX_PORTABLE_STAMP_KIT_OPERATION_BYTES = 1_500_000;

export interface PortableTileStampKitBundle {
  format: 'aidraw-stamp-library';
  version: 2;
  kind: 'tile';
  palette: PaletteEntry[];
  assets: Array<PixelSprite | PixelTileset>;
  tilesetIds: string[];
  stamps: TileStamp[];
}

export interface PortableTileStampDependencyPreview {
  sourceTilesetId: string;
  sourceTilesetName: string;
  sourceFirstGid: number;
  sourceLastGid: number;
  targetTilesetId: string;
  targetFirstGid: number;
  targetLastGid: number;
  disposition: 'reused' | 'copied';
}

export interface PortableTileStampSourcePreview {
  sourceAssetId: string;
  sourceAssetName: string;
  targetAssetId: string;
  disposition: 'reused' | 'copied';
}

export interface PortableTileStampImportPreview {
  formatVersion: 2;
  stampNames: string[];
  dependencies: PortableTileStampDependencyPreview[];
  sources: PortableTileStampSourcePreview[];
  paletteAdditions: PaletteEntry[];
  copiedSpriteCount: number;
  reusedSpriteCount: number;
  copiedTilesetCount: number;
  reusedTilesetCount: number;
  mapAttachments: Array<{ tilesetId: string; name: string }>;
  rebasedCellCount: number;
}

export interface PortableTileStampImportResult {
  importedStamps: TileStamp[];
  importedIds: string[];
  operations: CanvasOperation[];
  preview: PortableTileStampImportPreview;
}

export interface PortableTileStampImportOptions {
  makeId?: (prefix: string) => string;
  actorId?: string;
  timestamp?: string;
}

function firstIssue(result: { error: { issues: Array<{ message: string }> } }, fallback: string): Error {
  return new Error(result.error.issues[0]?.message ?? fallback);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateAsset(value: unknown): PixelSprite | PixelTileset {
  const result = CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: value });
  if (!result.success) throw firstIssue(result, 'The portable tile kit contains an invalid canonical asset.');
  if (result.data.kind !== 'pixel.asset.add' || result.data.asset.type === 'tilemap') {
    throw new Error('Portable tile kits may contain only sprite and tileset dependencies.');
  }
  return structuredClone(result.data.asset);
}

function sourceIdsForTileset(tileset: PixelTileset): string[] {
  if (tileset.spriteAssetId) return [tileset.spriteAssetId];
  return [...new Set(Object.values(tileset.tiles).map((tile) => tile.imageAssetId).filter((id): id is string => Boolean(id)))];
}

function assertAtlasSourceGeometry(tileset: PixelTileset, sprite: PixelSprite): void {
  const right = tileset.margin + tileset.columns * tileset.tileWidth + Math.max(0, tileset.columns - 1) * tileset.spacing;
  const bottom = tileset.margin + tileset.rows * tileset.tileHeight + Math.max(0, tileset.rows - 1) * tileset.spacing;
  if (right > sprite.width || bottom > sprite.height) throw new Error(`Tileset “${tileset.name}” exceeds its bundled atlas sprite bounds.`);
  for (const tile of Object.values(tileset.tiles)) {
    if (tile.sourceX + tileset.tileWidth > sprite.width || tile.sourceY + tileset.tileHeight > sprite.height) {
      throw new Error(`Tile ${tile.id} in “${tileset.name}” exceeds its bundled atlas sprite bounds.`);
    }
  }
}

function assertPortableResourceBudget(sprites: readonly PixelSprite[]): void {
  let logicalPixels = 0;
  let storedPixels = 0;
  for (const sprite of sprites) {
    logicalPixels += sprite.width * sprite.height * sprite.frameIds.length;
    for (const cel of Object.values(sprite.cels)) for (const chunk of Object.values(cel.chunks ?? {})) {
      storedPixels += decodePixelChunk(chunk).length;
    }
    if (logicalPixels > MAX_PORTABLE_STAMP_KIT_SOURCE_PIXELS || storedPixels > MAX_PORTABLE_STAMP_KIT_SOURCE_PIXELS) {
      throw new Error('Portable tile kits are limited to 4,194,304 logical and stored source pixels.');
    }
  }
}

function productionResolutionOrder(tilesets: readonly PixelTileset[]): PixelTileset[] {
  return tilesets.map((tileset, index) => ({ tileset, index }))
    .sort((left, right) => right.tileset.firstGid - left.tileset.firstGid || left.index - right.index)
    .map(({ tileset }) => tileset);
}

function resolveFromProductionOrder(tilesets: readonly PixelTileset[], gid: number): { tileset: PixelTileset; localId: number } | undefined {
  const tileset = tilesets.find((candidate) => candidate.firstGid <= gid);
  if (!tileset) return undefined;
  const localId = gid - tileset.firstGid;
  return tilesetHasLocalId(tileset, localId) ? { tileset, localId } : undefined;
}

function productionLikeResolve(tilesets: readonly PixelTileset[], gid: number): { tileset: PixelTileset; localId: number } | undefined {
  return resolveFromProductionOrder(productionResolutionOrder(tilesets), gid);
}

function exactUniqueResolution(tilesets: readonly PixelTileset[], gid: number, context: string): { tileset: PixelTileset; localId: number } {
  const resolved = productionLikeResolve(tilesets, gid);
  const covering = tilesets.filter((tileset) => tileset.firstGid <= gid && tilesetHasLocalId(tileset, gid - tileset.firstGid));
  if (!resolved) throw new Error(`${context} uses GID ${gid}, which is missing or shadowed by an attached tileset gap.`);
  if (covering.length !== 1 || covering[0]?.id !== resolved.tileset.id) {
    throw new Error(`${context} uses GID ${gid}, whose attached tileset meaning is ambiguous.`);
  }
  return resolved;
}

function assertCompleteGidSpan(firstGid: number, span: number, name: string): void {
  const lastGid = firstGid + span - 1;
  if (!Number.isSafeInteger(firstGid) || firstGid < 1 || !Number.isSafeInteger(span) || span < 1
    || !Number.isSafeInteger(lastGid) || lastGid > TILED_GID_MASK) {
    throw new RangeError(`Tileset “${name}” does not fit its complete local-ID span inside the supported 28-bit GID range.`);
  }
}

function assertDistinctAssetIds(assets: readonly (PixelSprite | PixelTileset)[]): void {
  const ids = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error(`Portable tile kit asset ID ${asset.id} is duplicated.`);
    ids.add(asset.id);
  }
}

function validatePortableGraph(bundle: PortableTileStampKitBundle): PortableTileStampKitBundle {
  if (bundle.assets.length < 2 || bundle.assets.length > MAX_PORTABLE_STAMP_KIT_ASSETS) {
    throw new Error(`Portable tile kits require 2–${MAX_PORTABLE_STAMP_KIT_ASSETS} canonical dependency assets.`);
  }
  if (bundle.tilesetIds.length < 1 || bundle.tilesetIds.length > MAX_PORTABLE_STAMP_KIT_TILESETS) {
    throw new Error(`Portable tile kits require 1–${MAX_PORTABLE_STAMP_KIT_TILESETS} tilesets.`);
  }
  const assets = bundle.assets.map(validateAsset);
  assertDistinctAssetIds(assets);
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const tilesets = bundle.tilesetIds.map((id) => {
    const asset = byId.get(id);
    if (!asset || asset.type !== 'tileset') throw new Error(`Portable tile kit tileset ${id} is missing or not a tileset.`);
    return asset;
  });
  if (new Set(bundle.tilesetIds).size !== bundle.tilesetIds.length) throw new Error('Portable tile kit tileset IDs must be unique.');
  const everyTileset = assets.filter((asset): asset is PixelTileset => asset.type === 'tileset');
  if (everyTileset.length !== tilesets.length || everyTileset.some((tileset) => !bundle.tilesetIds.includes(tileset.id))) {
    throw new Error('Portable tile kits must list every bundled tileset exactly once.');
  }
  const requiredSources = new Set<string>();
  for (const tileset of tilesets) {
    const span = tilesetLocalIdSpan(tileset);
    assertCompleteGidSpan(tileset.firstGid, span, tileset.name);
    for (const sourceId of sourceIdsForTileset(tileset)) {
      requiredSources.add(sourceId);
      const source = byId.get(sourceId);
      if (!source || source.type !== 'sprite') throw new Error(`Tileset “${tileset.name}” is missing bundled sprite ${sourceId}.`);
      if (source.frameIds.length < 1) throw new Error(`Sprite “${source.name}” has no renderable frame.`);
    }
    if (!isImageCollectionTileset(tileset)) {
      const source = byId.get(tileset.spriteAssetId!);
      if (!source || source.type !== 'sprite') throw new Error(`Tileset “${tileset.name}” is missing its bundled atlas sprite.`);
      assertAtlasSourceGeometry(tileset, source);
    }
  }
  const bundledSprites = assets.filter((asset): asset is PixelSprite => asset.type === 'sprite');
  if (bundledSprites.some((sprite) => !requiredSources.has(sprite.id)) || requiredSources.size !== bundledSprites.length) {
    throw new Error('Portable tile kits may not contain unrelated sprite assets.');
  }
  for (const sprite of bundledSprites) assertPixelSpriteUsesPalette(sprite, bundle.palette);
  assertPortableResourceBudget(bundledSprites);
  const reachedTilesetIds = new Set<string>();
  for (const stamp of bundle.stamps) for (const cell of stamp.cells) {
    const { gid } = decodeTiledGid(cell.gid);
    if (gid !== 0) reachedTilesetIds.add(exactUniqueResolution(tilesets, gid, `Tile stamp “${stamp.name}”`).tileset.id);
  }
  const unusedTileset = tilesets.find((tileset) => !reachedTilesetIds.has(tileset.id));
  if (unusedTileset) {
    throw new Error(`Portable tile kit tileset “${unusedTileset.name}” is not reached by any nonzero stamp cell.`);
  }
  return { ...bundle, palette: structuredClone(bundle.palette), assets, tilesetIds: [...bundle.tilesetIds], stamps: structuredClone(bundle.stamps) };
}

export function validatePortableTileStampKit(bundle: PortableTileStampKitBundle): PortableTileStampKitBundle {
  return validatePortableGraph(bundle);
}

function requiredTilesetsForStamps(document: PixelDocument, map: PixelTilemap, stamps: readonly TileStamp[]): PixelTileset[] {
  const attached = map.tilesetIds.map((id) => document.pixelAssets[id]).filter((asset): asset is PixelTileset => asset?.type === 'tileset');
  const required = new Set<string>();
  for (const stamp of stamps) for (const cell of stamp.cells) {
    const { gid } = decodeTiledGid(cell.gid);
    if (gid === 0) continue;
    const resolved = exactUniqueResolution(attached, gid, `Tile stamp “${stamp.name}”`);
    required.add(resolved.tileset.id);
  }
  return map.tilesetIds.flatMap((id) => {
    const tileset = document.pixelAssets[id];
    return tileset?.type === 'tileset' && required.has(id) ? [tileset] : [];
  });
}

export function createPortableTileStampKit(document: PixelDocument, map: PixelTilemap, stamps: TileStamp[]): PortableTileStampKitBundle {
  const tilesets = requiredTilesetsForStamps(document, map, stamps);
  if (!tilesets.length) throw new Error('Portable tile kits require at least one nonempty tile-stamp cell.');
  if (tilesets.some(isImageCollectionTileset)) assertImageCollectionTilemapMode(document, map);
  const sourceIds = new Set(tilesets.flatMap(sourceIdsForTileset));
  const sprites = document.assetIds.flatMap((id) => {
    const asset = document.pixelAssets[id];
    return asset?.type === 'sprite' && sourceIds.has(id) ? [structuredClone(asset)] : [];
  });
  if (sprites.length !== sourceIds.size) throw new Error('A required tileset source sprite is missing from the canonical project order.');
  const bundle: PortableTileStampKitBundle = {
    format: 'aidraw-stamp-library',
    version: 2,
    kind: 'tile',
    palette: structuredClone(document.palette),
    assets: [...sprites, ...tilesets.map((tileset) => structuredClone(tileset))],
    tilesetIds: tilesets.map((tileset) => tileset.id),
    stamps: structuredClone(stamps),
  };
  return validatePortableGraph(bundle);
}

function allocateId(prefix: string, used: Set<string>, makeId: (prefix: string) => string): string {
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const id = makeId(prefix);
    if (id && !used.has(id)) { used.add(id); return id; }
  }
  throw new Error(`Could not allocate a unique ${prefix} ID.`);
}

function exactPaletteEntry(left: PaletteEntry, right: PaletteEntry): boolean {
  return left.name === right.name && left.color.toLowerCase() === right.color.toLowerCase();
}

function preparePaletteMapping(
  destination: PixelDocument,
  sourcePalette: readonly PaletteEntry[],
  usedIds: Set<string>,
  makeId: (prefix: string) => string,
): { palette: PaletteEntry[]; mapping: number[]; additions: PaletteEntry[] } {
  const palette = structuredClone(destination.palette);
  const mapping = Array.from({ length: sourcePalette.length }, () => -1);
  const reserved = new Set<number>();
  const transparent = sourcePalette[0];
  if (!transparent || !palette[0] || !exactPaletteEntry(transparent, palette[0])) {
    throw new Error('Portable tile kit transparency does not exactly match the destination palette slot 0.');
  }
  mapping[0] = 0;
  reserved.add(0);
  const additions: PaletteEntry[] = [];
  for (let sourceIndex = 1; sourceIndex < sourcePalette.length; sourceIndex += 1) {
    const source = sourcePalette[sourceIndex]!;
    let targetIndex = palette.findIndex((entry, index) => !reserved.has(index) && exactPaletteEntry(source, entry));
    if (targetIndex < 0) {
      if (palette.length >= 256) throw new Error(`The destination palette is full and cannot preserve “${source.name}” (${source.color}).`);
      targetIndex = palette.length;
      const addition = { ...structuredClone(source), id: allocateId('palette', usedIds, makeId) };
      palette.push(addition);
      additions.push(structuredClone(addition));
    }
    mapping[sourceIndex] = targetIndex;
    reserved.add(targetIndex);
  }
  return { palette, mapping, additions };
}

function freshEntity<T extends PixelSprite | PixelTileset>(source: T, id: string, timestamp: string, actorId: string): T {
  return { ...structuredClone(source), id, revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: actorId };
}

function copySprite(
  source: PixelSprite,
  id: string,
  timestamp: string,
  actorId: string,
  palette: readonly PaletteEntry[],
  mapping: readonly number[],
): PixelSprite {
  const copy = freshEntity(source, id, timestamp, actorId);
  for (const cel of Object.values(copy.cels)) remapPixelCelIndices(cel, mapping);
  for (const [frameId, override] of Object.entries(copy.paletteOverrides)) {
    const remapped: PaletteEntry[] = palette.map((entry) => structuredClone(entry));
    for (let sourceIndex = 0; sourceIndex < override.length; sourceIndex += 1) {
      const targetIndex = mapping[sourceIndex];
      const entry = override[sourceIndex];
      if (entry && targetIndex !== undefined && targetIndex >= 0) remapped[targetIndex] = { ...structuredClone(entry), id: palette[targetIndex]!.id };
    }
    copy.paletteOverrides[frameId] = remapped;
  }
  assertPixelSpriteUsesPalette(copy, palette);
  return copy;
}

function appendPortableStampCopies(existing: readonly TileStamp[], incoming: readonly TileStamp[], makeId: (prefix: string) => string): { stamps: TileStamp[]; importedIds: string[] } {
  const used = new Set(existing.map((stamp) => stamp.id));
  const copies = incoming.map((stamp) => ({ ...structuredClone(stamp), id: allocateId('tile-stamp', used, makeId) }));
  return { stamps: [...structuredClone(existing), ...copies], importedIds: copies.map((stamp) => stamp.id) };
}

function assertOperationBudget(operations: readonly CanvasOperation[]): void {
  if (operations.length > 256) throw new Error('Portable tile kit import exceeds the 256-operation transaction limit.');
  const bytes = new TextEncoder().encode(JSON.stringify(operations)).byteLength;
  if (bytes > MAX_PORTABLE_STAMP_KIT_OPERATION_BYTES) throw new Error('Portable tile kit import exceeds the 1,500,000-byte operation plan limit.');
}

function sameResolution(
  left: ReturnType<typeof productionLikeResolve>,
  right: ReturnType<typeof productionLikeResolve>,
): boolean {
  return left?.tileset.id === right?.tileset.id && left?.localId === right?.localId;
}

function resolutionDescription(resolved: ReturnType<typeof productionLikeResolve>): string {
  return resolved ? `tileset “${resolved.tileset.name}” (${resolved.tileset.id}) local ID ${resolved.localId}` : 'unresolved';
}

function assertDestinationReferenceSemantics(
  map: PixelTilemap,
  beforeTilesets: readonly PixelTileset[],
  afterTilesets: readonly PixelTileset[],
  retainedStamps: readonly TileStamp[],
): void {
  const beforeOrder = productionResolutionOrder(beforeTilesets);
  const afterOrder = productionResolutionOrder(afterTilesets);
  const resolutionCache = new Map<number, { before: ReturnType<typeof productionLikeResolve>; after: ReturnType<typeof productionLikeResolve> }>();
  const assertRawGid = (rawGid: number, context: string): void => {
    const { gid } = decodeTiledGid(rawGid);
    if (gid === 0) return;
    let resolutions = resolutionCache.get(gid);
    if (!resolutions) {
      resolutions = { before: resolveFromProductionOrder(beforeOrder, gid), after: resolveFromProductionOrder(afterOrder, gid) };
      if (resolutionCache.size < 4_096) resolutionCache.set(gid, resolutions);
    }
    const { before, after } = resolutions;
    if (!sameResolution(before, after)) {
      throw new Error(`Portable tile kit attachment would change ${context} base GID ${gid} from ${resolutionDescription(before)} to ${resolutionDescription(after)}. Existing destination GIDs are never rewritten.`);
    }
  };

  let layerCount = 0;
  let cellCount = 0;
  let objectCount = 0;
  const visited = new Set<string>();
  const visit = (layerId: string): void => {
    if (visited.has(layerId)) return;
    visited.add(layerId);
    layerCount += 1;
    if (layerCount > MAX_TILED_LAYERS) throw new RangeError(`Portable tile kit attachment proof exceeds the ${MAX_TILED_LAYERS.toLocaleString('en-US')}-layer scan limit.`);
    const layer = map.layers[layerId];
    if (!layer) throw new Error(`Map “${map.name}” is missing layer ${layerId} during portable attachment proof.`);
    if (layer.type === 'group') {
      for (const childId of layer.childIds ?? []) visit(childId);
      return;
    }
    if (layer.type === 'tile') {
      for (const chunk of Object.values(layer.chunks ?? {})) {
        const chunkCells = chunk.width * chunk.height;
        if (!Number.isSafeInteger(chunkCells) || chunkCells < 0 || chunkCells > MAX_TILED_TOTAL_CELLS - cellCount) {
          throw new RangeError(`Portable tile kit attachment proof exceeds the ${MAX_TILED_TOTAL_CELLS.toLocaleString('en-US')}-cell scan limit.`);
        }
        cellCount += chunkCells;
        const values = decodeTilemapChunk(chunk);
        if (values.length !== chunkCells) throw new Error(`Map “${map.name}” layer “${layer.name}” has an invalid tile chunk payload.`);
        values.forEach((rawGid, index) => assertRawGid(rawGid, `map “${map.name}” layer “${layer.name}” cell ${index}`));
      }
      return;
    }
    const objects = layer.objects ?? [];
    if (objects.length > MAX_TILED_OBJECTS - objectCount) {
      throw new RangeError(`Portable tile kit attachment proof exceeds the ${MAX_TILED_OBJECTS.toLocaleString('en-US')}-object scan limit.`);
    }
    objectCount += objects.length;
    for (const object of objects) if (object.type === 'tile') {
      assertRawGid(object.gid, `map “${map.name}” tile object “${object.name || object.id}”`);
    }
  };
  for (const layerId of map.layerIds) visit(layerId);
  for (const layerId of Object.keys(map.layers)) visit(layerId);

  let stampCellCount = 0;
  for (const stamp of retainedStamps) {
    if (stamp.cells.length > 262_144 - stampCellCount) {
      throw new RangeError('Portable tile kit attachment proof exceeds the 262,144 retained-stamp-cell scan limit.');
    }
    stampCellCount += stamp.cells.length;
    for (const cell of stamp.cells) assertRawGid(cell.gid, `retained tile stamp “${stamp.name}”`);
  }
}

function exactTilesetsForIds(
  ids: readonly string[],
  assets: ReadonlyMap<string, PixelAsset>,
  mapName: string,
): PixelTileset[] {
  return ids.map((id) => {
    const asset = assets.get(id);
    if (!asset || asset.type !== 'tileset') throw new Error(`Map “${mapName}” is missing attached tileset ${id}.`);
    return asset;
  });
}

export function preparePortableTileStampKitImport(
  document: PixelDocument,
  map: PixelTilemap,
  input: PortableTileStampKitBundle,
  mode: 'append' | 'replace',
  options: PortableTileStampImportOptions = {},
): PortableTileStampImportResult {
  const bundle = validatePortableGraph(input);
  const canonicalMap = document.pixelAssets[map.id];
  if (!canonicalMap || canonicalMap.type !== 'tilemap' || !jsonEqual(canonicalMap, map)) {
    throw new Error('The destination map changed before portable tile kit planning. Reopen the reviewed import.');
  }
  const importsImageCollection = bundle.assets.some((asset) => asset.type === 'tileset' && isImageCollectionTileset(asset));
  if (importsImageCollection && map.orientation !== 'orthogonal') {
    throw new Error('Portable image-collection tile kits require an orthogonal destination map.');
  }
  if (importsImageCollection) assertImageCollectionTilemapMode(document, map);
  const makeId = options.makeId ?? createId;
  const timestamp = options.timestamp ?? new Date().toISOString();
  const actorId = options.actorId ?? HUMAN_ACTOR.id;
  const usedAssetIds = new Set(Object.keys(document.pixelAssets));
  const usedEntityIds = new Set([...document.palette.map((entry) => entry.id), ...usedAssetIds]);
  const bundleById = new Map(bundle.assets.map((asset) => [asset.id, asset]));
  const sourceSprites = bundle.assets.filter((asset): asset is PixelSprite => asset.type === 'sprite');
  const sourceTilesets = bundle.tilesetIds.map((id) => bundleById.get(id) as PixelTileset);
  const wholePaletteEqual = jsonEqual(bundle.palette, document.palette);
  const spriteTargetIds = new Map<string, string>();
  const sourcePreviews: PortableTileStampSourcePreview[] = [];
  const copiedSourceIds = new Set<string>();
  let reusedSpriteCount = 0;
  for (const source of sourceSprites) {
    const target = document.pixelAssets[source.id];
    if (wholePaletteEqual && target?.type === 'sprite' && jsonEqual(source, target)) {
      spriteTargetIds.set(source.id, source.id);
      reusedSpriteCount += 1;
      sourcePreviews.push({ sourceAssetId: source.id, sourceAssetName: source.name, targetAssetId: source.id, disposition: 'reused' });
    } else {
      const targetId = allocateId('sprite', usedAssetIds, makeId);
      spriteTargetIds.set(source.id, targetId);
      copiedSourceIds.add(source.id);
      sourcePreviews.push({ sourceAssetId: source.id, sourceAssetName: source.name, targetAssetId: targetId, disposition: 'copied' });
    }
  }
  const palettePlan = copiedSourceIds.size
    ? preparePaletteMapping(document, bundle.palette, usedEntityIds, makeId)
    : { palette: structuredClone(document.palette), mapping: bundle.palette.map((_, index) => index), additions: [] as PaletteEntry[] };
  const copiedSprites = sourceSprites.filter((source) => copiedSourceIds.has(source.id)).map((source) => copySprite(
    source,
    spriteTargetIds.get(source.id)!,
    timestamp,
    actorId,
    palettePlan.palette,
    palettePlan.mapping,
  ));

  const tilesetTargetIds = new Map<string, string>();
  const targetTilesets: PixelTileset[] = Object.values(document.pixelAssets)
    .filter((asset): asset is PixelTileset => asset.type === 'tileset')
    .map((asset) => structuredClone(asset));
  const copiedTilesets: PixelTileset[] = [];
  const dependencies: PortableTileStampDependencyPreview[] = [];
  let reusedTilesetCount = 0;
  for (const source of sourceTilesets) {
    const sourceSpan = tilesetLocalIdSpan(source);
    const target = document.pixelAssets[source.id];
    const sourcesReused = sourceIdsForTileset(source).every((sourceId) => spriteTargetIds.get(sourceId) === sourceId);
    let resolved: PixelTileset;
    let disposition: 'reused' | 'copied';
    if (map.tilesetIds.includes(source.id) && sourcesReused && target?.type === 'tileset' && jsonEqual(source, target)) {
      resolved = target;
      disposition = 'reused';
      reusedTilesetCount += 1;
    } else {
      const id = allocateId('tileset', usedAssetIds, makeId);
      const firstGid = nextTilesetFirstGid(targetTilesets);
      assertCompleteGidSpan(firstGid, sourceSpan, source.name);
      resolved = freshEntity(source, id, timestamp, actorId);
      resolved.firstGid = firstGid;
      if (resolved.spriteAssetId) resolved.spriteAssetId = spriteTargetIds.get(resolved.spriteAssetId)!;
      for (const tile of Object.values(resolved.tiles)) if (tile.imageAssetId) tile.imageAssetId = spriteTargetIds.get(tile.imageAssetId)!;
      copiedTilesets.push(resolved);
      targetTilesets.push(resolved);
      disposition = 'copied';
    }
    tilesetTargetIds.set(source.id, resolved.id);
    const targetSpan = tilesetLocalIdSpan(resolved);
    if (sourceSpan !== targetSpan) throw new Error(`Tileset “${source.name}” changed its local-ID span during planning.`);
    assertCompleteGidSpan(resolved.firstGid, targetSpan, resolved.name);
    dependencies.push({
      sourceTilesetId: source.id,
      sourceTilesetName: source.name,
      sourceFirstGid: source.firstGid,
      sourceLastGid: source.firstGid + sourceSpan - 1,
      targetTilesetId: resolved.id,
      targetFirstGid: resolved.firstGid,
      targetLastGid: resolved.firstGid + targetSpan - 1,
      disposition,
    });
  }

  const targetTilesetById = new Map(targetTilesets.map((tileset) => [tileset.id, tileset]));
  let rebasedCellCount = 0;
  const imported = bundle.stamps.map((stamp) => ({
    ...structuredClone(stamp),
    cells: stamp.cells.map((cell) => {
      const decoded = decodeTiledGid(cell.gid);
      if (decoded.gid === 0) return structuredClone(cell);
      const resolved = exactUniqueResolution(sourceTilesets, decoded.gid, `Tile stamp “${stamp.name}”`);
      const targetId = tilesetTargetIds.get(resolved.tileset.id);
      const target = targetId ? targetTilesetById.get(targetId) : undefined;
      if (!target || !tilesetHasLocalId(target, resolved.localId)) throw new Error(`Tile stamp “${stamp.name}” lost local tile ${resolved.localId} during rebasing.`);
      const gid = target.firstGid + resolved.localId;
      if (gid > TILED_GID_MASK) throw new Error(`Tile stamp “${stamp.name}” exceeds the supported GID range after rebasing.`);
      rebasedCellCount += 1;
      return { ...structuredClone(cell), gid: encodeTiledGid(gid, decoded) };
    }),
  }));
  const merged = mode === 'append'
    ? appendPortableStampCopies(document.tileStamps, imported, makeId)
    : { stamps: imported, importedIds: imported.map((stamp) => stamp.id) };
  const stampOperation = CanvasOperationSchema.safeParse({ kind: 'pixel.tile-stamps.replace', stamps: merged.stamps });
  if (!stampOperation.success) throw firstIssue(stampOperation, 'The imported portable tile-stamp library is invalid.');

  const mapAttachments = dependencies.filter((dependency) => !map.tilesetIds.includes(dependency.targetTilesetId)).map((dependency) => ({
    tilesetId: dependency.targetTilesetId,
    name: dependency.sourceTilesetName,
  }));
  const nextMap = mapAttachments.length ? { ...structuredClone(map), tilesetIds: [...map.tilesetIds, ...mapAttachments.map((entry) => entry.tilesetId)] } : map;
  const completeAssets = new Map<string, PixelAsset>(Object.entries(document.pixelAssets));
  for (const sprite of copiedSprites) completeAssets.set(sprite.id, sprite);
  for (const tileset of copiedTilesets) completeAssets.set(tileset.id, tileset);
  const currentAssets = new Map<string, PixelAsset>(Object.entries(document.pixelAssets));
  const currentTargetTilesets = exactTilesetsForIds(map.tilesetIds, currentAssets, map.name);
  const resolvedTargetTilesets = exactTilesetsForIds(nextMap.tilesetIds, completeAssets, map.name);
  if (mapAttachments.length) {
    assertDestinationReferenceSemantics(map, currentTargetTilesets, resolvedTargetTilesets, mode === 'append' ? document.tileStamps : []);
  }
  for (const stamp of imported) for (const cell of stamp.cells) {
    const { gid } = decodeTiledGid(cell.gid);
    if (gid !== 0) exactUniqueResolution(resolvedTargetTilesets, gid, `Imported tile stamp “${stamp.name}”`);
  }

  const operations: CanvasOperation[] = [];
  if (palettePlan.additions.length) operations.push({ kind: 'pixel.palette.replace', palette: palettePlan.palette });
  for (const sprite of copiedSprites) operations.push({ kind: 'pixel.asset.add', asset: sprite });
  for (const tileset of copiedTilesets) operations.push({ kind: 'pixel.asset.add', asset: tileset });
  if (mapAttachments.length) operations.push({ kind: 'pixel.asset.replace', asset: nextMap, expectedRevision: map.revision });
  operations.push({ kind: 'pixel.tile-stamps.replace', stamps: merged.stamps });
  for (const operation of operations) {
    const result = CanvasOperationSchema.safeParse(operation);
    if (!result.success) throw firstIssue(result, 'The portable tile kit operation plan is invalid.');
  }
  assertOperationBudget(operations);
  return {
    importedStamps: imported,
    importedIds: merged.importedIds,
    operations,
    preview: {
      formatVersion: 2,
      stampNames: imported.map((stamp) => stamp.name),
      dependencies,
      sources: sourcePreviews,
      paletteAdditions: palettePlan.additions,
      copiedSpriteCount: copiedSprites.length,
      reusedSpriteCount,
      copiedTilesetCount: copiedTilesets.length,
      reusedTilesetCount,
      mapAttachments,
      rebasedCellCount,
    },
  };
}
