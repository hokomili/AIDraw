import {
  HUMAN_ACTOR,
  TILED_GID_MASK,
  createId,
  decodeTiledGid,
  decodeTilemapChunk,
  isImageCollectionTileset,
  nextTilesetFirstGid,
  nowIso,
  resolveTilesetForGid,
  tilesetLocalIdSpan,
  type PixelDocument,
  type PixelSprite,
  type PixelSpriteDependencyGuard,
  type PixelTilemap,
  type PixelTileset,
  type TileDefinition,
} from '@aidraw/core';

import { MAX_TILED_TOTAL_CELLS } from './tiled-resource-policy';

export const MAX_AUTHORED_IMAGE_COLLECTION_SOURCES = 1_023;
export const MAX_AUTHORED_IMAGE_COLLECTION_PIXELS = 64 * 1024 * 1024;

export interface ImageCollectionCreationOptions {
  id?: string;
  createdAt?: string;
  createdBy?: string;
}

export interface ImageCollectionAppendPlan {
  tileset: PixelTileset;
  tileId: number;
  expectedSpriteDependencies: PixelSpriteDependencyGuard[];
}

export interface ImageCollectionSourceReplacementImpact {
  baseGid: number;
  attachedMapCount: number;
  directMapCellCount: number;
  animationReferenceCount: number;
  scannedCellCount: number;
}

export interface ImageCollectionSourceReplacementPlan {
  tileset: PixelTileset;
  tileId: number;
  previousSourceId: string;
  sourceId: string;
  impact: ImageCollectionSourceReplacementImpact;
  expectedSpriteDependencies: PixelSpriteDependencyGuard[];
}

export interface ImageCollectionSourceRemovalProof {
  baseGid: number;
  sourceId: string;
  sourceName: string;
  retainedTileCount: number;
  attachedMapCount: number;
  scannedCellCount: number;
  scannedObjectCount: number;
  scannedAnimationFrameCount: number;
  scannedTileStampCellCount: number;
  scannedReferenceCount: number;
}

export interface ImageCollectionSourceRemovalPlan {
  tileset: PixelTileset;
  tileId: number;
  sourceId: string;
  proof: ImageCollectionSourceRemovalProof;
  expectedSpriteDependencies: PixelSpriteDependencyGuard[];
}

export type ImageCollectionTileMetadataPatch = Partial<Pick<
  TileDefinition,
  'probability' | 'animation' | 'collisions' | 'properties'
>>;

export function imageCollectionTileIds(tileset: PixelTileset): number[] {
  if (!isImageCollectionTileset(tileset)) throw new Error('Sparse tile IDs require an image-collection tileset.');
  return Object.values(tileset.tiles).map((tile) => tile.id).sort((left, right) => left - right);
}

function requirePixelDocument(document: PixelDocument): PixelDocument {
  if (document.kind !== 'pixel') throw new Error('Image-collection authoring requires a pixel document.');
  return document;
}

function requireEligibleSource(document: PixelDocument, sourceId: string): PixelSprite {
  const source = document.pixelAssets[sourceId];
  if (!source) throw new Error(`Sprite source ${sourceId} does not exist in this document.`);
  if (source.type !== 'sprite') throw new Error(`Asset “${source.name}” is not a sprite source.`);
  if (source.frameIds.length !== 1) throw new Error(`Sprite “${source.name}” has ${source.frameIds.length} frames. Image-collection sources must be exact one-frame sprites.`);
  return source;
}

function imageCollectionSourcePixels(document: PixelDocument, sourceIds: readonly string[]): number {
  let total = 0;
  for (const sourceId of sourceIds) {
    const source = requireEligibleSource(document, sourceId);
    total += source.width * source.height;
    if (!Number.isSafeInteger(total) || total > MAX_AUTHORED_IMAGE_COLLECTION_PIXELS) {
      throw new RangeError('Image-collection sources exceed the 64-megapixel expanded artwork budget.');
    }
  }
  return total;
}

function requireUniqueSourceIds(sourceIds: readonly string[]): void {
  if (sourceIds.length < 1) throw new Error('Choose at least one exact sprite source.');
  if (sourceIds.length > MAX_AUTHORED_IMAGE_COLLECTION_SOURCES) {
    throw new RangeError(`Image collections support at most ${MAX_AUTHORED_IMAGE_COLLECTION_SOURCES.toLocaleString('en-US')} authorable sprite sources.`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error('Image-collection source identities must be unique.');
}

export function imageCollectionSourceEligibility(document: PixelDocument, sourceId: string): string | undefined {
  try {
    requirePixelDocument(document);
    requireEligibleSource(document, sourceId);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'This asset is not an eligible image-collection source.';
  }
}

/** Binds a chooser selection to the exact sprite state the human observed. */
export function imageCollectionSourceObservationGuardError(
  observed: PixelDocument,
  current: PixelDocument,
  sourceIds: readonly string[],
): string | undefined {
  if (observed.id !== current.id) return 'The active document changed. Re-open the image-collection source chooser.';
  for (const sourceId of sourceIds) {
    const observedSource = observed.pixelAssets[sourceId];
    const currentSource = current.pixelAssets[sourceId];
    if (observedSource?.type !== 'sprite' || currentSource?.type !== 'sprite') return `Sprite source ${sourceId} is missing or changed kind. Re-open the chooser.`;
    if (
      currentSource.revision !== observedSource.revision
      || currentSource.width !== observedSource.width
      || currentSource.height !== observedSource.height
    ) return `Sprite “${observedSource.name}” changed. Re-open the chooser before using it.`;
  }
  return undefined;
}

function sourceTile(id: number, imageAssetId: string): TileDefinition {
  return { id, sourceX: 0, sourceY: 0, imageAssetId, probability: 1, animation: [], collisions: [], properties: {} };
}

/**
 * Builds one collection without copying sprite pixels. The caller owns the
 * source order; human callers pass canonical asset order, while semantic
 * callers pass their explicit bounded order.
 */
export function createImageCollectionTileset(
  document: PixelDocument,
  name: string,
  sourceIds: readonly string[],
  options: ImageCollectionCreationOptions = {},
): PixelTileset {
  requirePixelDocument(document);
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 200) throw new Error('Image-collection names must contain 1–200 characters.');
  requireUniqueSourceIds(sourceIds);
  imageCollectionSourcePixels(document, sourceIds);
  const sources = sourceIds.map((id) => requireEligibleSource(document, id));
  const tilesets = document.assetIds
    .map((id) => document.pixelAssets[id])
    .filter((asset): asset is PixelTileset => asset?.type === 'tileset');
  const firstGid = nextTilesetFirstGid(tilesets);
  if (firstGid + sourceIds.length - 1 > TILED_GID_MASK) throw new RangeError('No safe Tiled GID range remains for this image collection.');
  const createdAt = options.createdAt ?? nowIso();
  return {
    id: options.id ?? createId('tileset'),
    revision: 0,
    name: normalizedName,
    type: 'tileset',
    createdAt,
    updatedAt: createdAt,
    createdBy: options.createdBy ?? HUMAN_ACTOR.id,
    firstGid,
    tileWidth: Math.max(...sources.map((source) => source.width)),
    tileHeight: Math.max(...sources.map((source) => source.height)),
    margin: 0,
    spacing: 0,
    tileOffset: { x: 0, y: 0 },
    objectAlignment: 'unspecified',
    columns: 0,
    rows: 0,
    tiles: Object.fromEntries(sourceIds.map((sourceId, id) => [id, sourceTile(id, sourceId)])),
    wangSets: [],
    transformations: { hFlip: true, vFlip: true, rotate: true },
  };
}

function assertAppendRangeAvailable(document: PixelDocument, tileset: PixelTileset, tileId: number): void {
  const firstGid = tileset.firstGid;
  const lastGid = firstGid + tileId;
  if (!Number.isSafeInteger(lastGid) || lastGid > TILED_GID_MASK) throw new RangeError('Appending this source would exceed the 28-bit Tiled GID range.');
  for (const assetId of document.assetIds) {
    const other = document.pixelAssets[assetId];
    if (other?.type !== 'tileset' || other.id === tileset.id) continue;
    const span = tilesetLocalIdSpan(other);
    const otherLastGid = other.firstGid + span - 1;
    if (span > 0 && firstGid <= otherLastGid && other.firstGid <= lastGid) {
      throw new Error(`Appending local tile ${tileId} would leave image collection “${tileset.name}” overlapping tileset “${other.name}” in the Tiled GID space.`);
    }
  }
}

function exactMapTilesetForLocalId(
  document: PixelDocument,
  map: PixelTilemap,
  tileset: PixelTileset,
  tileId: number,
): void {
  const baseGid = tileset.firstGid + tileId;
  const covering = new Set<string>();
  for (const attachedId of map.tilesetIds) {
    const attached = document.pixelAssets[attachedId];
    if (attached?.type !== 'tileset') continue;
    const span = tilesetLocalIdSpan(attached);
    const lastGid = attached.firstGid + span - 1;
    if (span > 0 && (!Number.isSafeInteger(lastGid) || attached.firstGid < 1 || lastGid > TILED_GID_MASK)) {
      throw new RangeError(`Map “${map.name}” has an unsafe attached GID range for tileset “${attached.name}”.`);
    }
    if (span > 0 && baseGid >= attached.firstGid && baseGid <= lastGid) covering.add(attached.id);
  }
  if (covering.size !== 1 || !covering.has(tileset.id)) {
    throw new Error(`Map “${map.name}” does not resolve image-collection tile ${tileId} through one exact attached GID range.`);
  }
  const resolved = resolveTilesetForGid(document, map, baseGid);
  if (!resolved || resolved.tileset.id !== tileset.id || resolved.localId !== tileId) {
    throw new Error(`Map “${map.name}” does not resolve base GID ${baseGid} exactly to image-collection tile ${tileId}; attached tileset precedence shadows the target.`);
  }
}

/**
 * Counts the exact direct orthogonal-map and animation references affected by a
 * stable local-ID source replacement. Stored chunks are scanned lazily and
 * bounded across every attached map; no nominal map plane is synthesized.
 */
export function imageCollectionSourceReplacementImpact(
  document: PixelDocument,
  tilesetId: string,
  tileId: number,
): ImageCollectionSourceReplacementImpact {
  requirePixelDocument(document);
  const tileset = document.pixelAssets[tilesetId];
  if (!tileset || tileset.type !== 'tileset' || !isImageCollectionTileset(tileset)) throw new Error(`Image collection ${tilesetId} does not exist.`);
  if (!Number.isSafeInteger(tileId) || tileId < 0 || tileId >= 1_048_576 || !tileset.tiles[tileId]?.imageAssetId) {
    throw new Error(`Image-collection tile ${tileId} is unavailable.`);
  }
  const baseGid = tileset.firstGid + tileId;
  if (!Number.isSafeInteger(baseGid) || baseGid < 1 || baseGid > TILED_GID_MASK) throw new RangeError(`Image-collection tile ${tileId} has an unsafe Tiled GID.`);

  let attachedMapCount = 0;
  let directMapCellCount = 0;
  let scannedCellCount = 0;
  for (const assetId of document.assetIds) {
    const map = document.pixelAssets[assetId];
    if (map?.type !== 'tilemap' || !map.tilesetIds.includes(tileset.id)) continue;
    if (map.orientation !== 'orthogonal') throw new Error(`Map “${map.name}” must remain orthogonal before replacing an image-collection source.`);
    exactMapTilesetForLocalId(document, map, tileset, tileId);
    attachedMapCount += 1;
    const visited = new Set<string>();
    const visit = (layerId: string): void => {
      if (visited.has(layerId)) return;
      visited.add(layerId);
      const layer = map.layers[layerId];
      if (!layer) throw new Error(`Map “${map.name}” is missing layer ${layerId}.`);
      if (layer.type === 'group') {
        for (const childId of layer.childIds ?? []) visit(childId);
        return;
      }
      if (layer.type !== 'tile') return;
      for (const chunk of Object.values(layer.chunks ?? {})) {
        const chunkCells = chunk.width * chunk.height;
        if (!Number.isSafeInteger(chunkCells) || chunkCells > MAX_TILED_TOTAL_CELLS - scannedCellCount) {
          throw new RangeError(`Image-collection replacement impact exceeds the ${MAX_TILED_TOTAL_CELLS.toLocaleString('en-US')}-cell scan limit.`);
        }
        scannedCellCount += chunkCells;
        const values = decodeTilemapChunk(chunk);
        if (values.length !== chunkCells) throw new Error(`Map “${map.name}” layer “${layer.name}” has an invalid tile chunk payload.`);
        for (let index = 0; index < values.length; index += 1) {
          const x = chunk.x + index % chunk.width;
          const y = chunk.y + Math.floor(index / chunk.width);
          if (!map.infinite && (x < 0 || y < 0 || x >= map.width || y >= map.height)) continue;
          if (decodeTiledGid(values[index]).gid === baseGid) directMapCellCount += 1;
        }
      }
    };
    for (const layerId of map.layerIds) visit(layerId);
  }

  let animationReferenceCount = 0;
  for (const tile of Object.values(tileset.tiles)) for (const frame of tile.animation) {
    if (frame.tileId !== tileId) continue;
    animationReferenceCount += 1;
    if (!Number.isSafeInteger(animationReferenceCount)) throw new RangeError('Image-collection animation reference count is unsafe.');
  }
  return { baseGid, attachedMapCount, directMapCellCount, animationReferenceCount, scannedCellCount };
}

/** Appends one exact source above the collection's authored sparse span. */
export function appendImageCollectionSource(
  document: PixelDocument,
  tilesetId: string,
  sourceId: string,
): ImageCollectionAppendPlan {
  requirePixelDocument(document);
  const current = document.pixelAssets[tilesetId];
  if (!current || current.type !== 'tileset' || !isImageCollectionTileset(current)) throw new Error(`Image collection ${tilesetId} does not exist.`);
  const source = requireEligibleSource(document, sourceId);
  const existingIds = imageCollectionTileIds(current);
  if (existingIds.some((tileId) => current.tiles[tileId].imageAssetId === source.id)) throw new Error(`Sprite “${source.name}” already belongs to this image collection.`);
  if (existingIds.length >= MAX_AUTHORED_IMAGE_COLLECTION_SOURCES) {
    throw new RangeError(`Image collections support at most ${MAX_AUTHORED_IMAGE_COLLECTION_SOURCES.toLocaleString('en-US')} authorable sprite sources.`);
  }
  const sourceIds = [...existingIds.map((tileId) => current.tiles[tileId].imageAssetId!), source.id];
  imageCollectionSourcePixels(document, sourceIds);
  const tileId = tilesetLocalIdSpan(current);
  if (tileId >= 1_048_576) throw new RangeError('The image collection has no remaining local tile ID.');
  assertAppendRangeAvailable(document, current, tileId);
  const tileset = structuredClone(current);
  tileset.tiles[tileId] = sourceTile(tileId, source.id);
  tileset.tileWidth = Math.max(tileset.tileWidth, source.width);
  tileset.tileHeight = Math.max(tileset.tileHeight, source.height);
  return { tileset, tileId, expectedSpriteDependencies: imageCollectionSourceDependencyGuards(document, tileset) };
}

/** Replaces one exact sparse tile source without changing its canonical ID or metadata. */
export function replaceImageCollectionSource(
  document: PixelDocument,
  tilesetId: string,
  tileId: number,
  sourceId: string,
): ImageCollectionSourceReplacementPlan {
  requirePixelDocument(document);
  const current = document.pixelAssets[tilesetId];
  if (!current || current.type !== 'tileset' || !isImageCollectionTileset(current)) throw new Error(`Image collection ${tilesetId} does not exist.`);
  if (!Number.isSafeInteger(tileId) || tileId < 0 || tileId >= 1_048_576) throw new Error(`Image-collection tile ${tileId} is unavailable.`);
  const target = current.tiles[tileId];
  const previousSourceId = target?.imageAssetId;
  if (!previousSourceId) throw new Error(`Image-collection tile ${tileId} is unavailable.`);
  const source = requireEligibleSource(document, sourceId);
  if (source.id === previousSourceId) throw new Error(`Sprite “${source.name}” is already the source for tile ${tileId}.`);
  const existingIds = imageCollectionTileIds(current);
  if (existingIds.some((id) => id !== tileId && current.tiles[id].imageAssetId === source.id)) {
    throw new Error(`Sprite “${source.name}” already belongs to this image collection.`);
  }

  const postSourceIds = existingIds.map((id) => id === tileId ? source.id : current.tiles[id].imageAssetId!);
  imageCollectionSourcePixels(document, postSourceIds);
  const postSources = postSourceIds.map((id) => requireEligibleSource(document, id));
  const impact = imageCollectionSourceReplacementImpact(document, current.id, tileId);
  const tileset = structuredClone(current);
  tileset.tiles[tileId].imageAssetId = source.id;
  tileset.tileWidth = Math.max(...postSources.map((entry) => entry.width));
  tileset.tileHeight = Math.max(...postSources.map((entry) => entry.height));

  const expectedSpriteDependencies = imageCollectionSourceDependencyGuards(document, current);
  if (!expectedSpriteDependencies.some((guard) => guard.spriteId === source.id)) {
    expectedSpriteDependencies.push({ spriteId: source.id, expectedRevision: source.revision, width: source.width, height: source.height });
  }
  return { tileset, tileId, previousSourceId, sourceId: source.id, impact, expectedSpriteDependencies };
}

function consumeRemovalReferenceBudget(current: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_TILED_TOTAL_CELLS - current) {
    throw new RangeError(`Image-collection removal proof exceeds the ${MAX_TILED_TOTAL_CELLS.toLocaleString('en-US')}-entry reference-scan limit.`);
  }
  return current + amount;
}

/**
 * Proves that one exact sparse tile has no retained canonical reference.
 * Unsupported Wang state and ambiguous map resolution refuse rather than
 * treating an unproven source as unused.
 */
export function imageCollectionSourceRemovalProof(
  document: PixelDocument,
  tilesetId: string,
  tileId: number,
): ImageCollectionSourceRemovalProof {
  requirePixelDocument(document);
  const tileset = document.pixelAssets[tilesetId];
  if (!tileset || tileset.type !== 'tileset' || !isImageCollectionTileset(tileset)) throw new Error(`Image collection ${tilesetId} does not exist.`);
  if (!Number.isSafeInteger(tileId) || tileId < 0 || tileId >= 1_048_576) throw new Error(`Image-collection tile ${tileId} is unavailable.`);
  const target = tileset.tiles[tileId];
  if (!target?.imageAssetId) throw new Error(`Image-collection tile ${tileId} is unavailable.`);
  const source = requireEligibleSource(document, target.imageAssetId);
  const retainedIds = imageCollectionTileIds(tileset).filter((id) => id !== tileId);
  if (retainedIds.length === 0) throw new Error('The final image-collection source cannot be removed. Append or retain another source first.');
  if (tileset.wangSets.length > 0) {
    throw new Error('Image-collection removal cannot prove safety while unsupported Wang metadata is present. Remove that metadata through a supported repair workflow first.');
  }
  const baseGid = tileset.firstGid + tileId;
  if (!Number.isSafeInteger(baseGid) || baseGid < 1 || baseGid > TILED_GID_MASK) throw new RangeError(`Image-collection tile ${tileId} has an unsafe Tiled GID.`);

  let attachedMapCount = 0;
  let scannedCellCount = 0;
  let scannedObjectCount = 0;
  let scannedAnimationFrameCount = 0;
  let scannedTileStampCellCount = 0;
  let scannedReferenceCount = 0;
  for (const assetId of document.assetIds) {
    const map = document.pixelAssets[assetId];
    if (map?.type !== 'tilemap' || !map.tilesetIds.includes(tileset.id)) continue;
    if (map.orientation !== 'orthogonal') throw new Error(`Map “${map.name}” must remain orthogonal before removing an image-collection source.`);
    exactMapTilesetForLocalId(document, map, tileset, tileId);
    attachedMapCount += 1;
    const visited = new Set<string>();
    const visit = (layerId: string): void => {
      if (visited.has(layerId)) return;
      visited.add(layerId);
      const layer = map.layers[layerId];
      if (!layer) throw new Error(`Map “${map.name}” is missing layer ${layerId}.`);
      if (layer.type === 'group') {
        for (const childId of layer.childIds ?? []) visit(childId);
        return;
      }
      if (layer.type === 'tile') {
        for (const chunk of Object.values(layer.chunks ?? {})) {
          const chunkCells = chunk.width * chunk.height;
          scannedReferenceCount = consumeRemovalReferenceBudget(scannedReferenceCount, chunkCells);
          scannedCellCount += chunkCells;
          const values = decodeTilemapChunk(chunk);
          if (values.length !== chunkCells) throw new Error(`Map “${map.name}” layer “${layer.name}” has an invalid tile chunk payload.`);
          if (values.some((rawGid) => decodeTiledGid(rawGid).gid === baseGid)) {
            throw new Error(`Map “${map.name}” tile layer “${layer.name}” still references image-collection tile ${tileId}. Clear every transformed GID before removing its source.`);
          }
        }
        return;
      }
      const objects = layer.objects ?? [];
      scannedReferenceCount = consumeRemovalReferenceBudget(scannedReferenceCount, objects.length);
      scannedObjectCount += objects.length;
      const referenced = objects.find((object) => object.type === 'tile' && decodeTiledGid(object.gid).gid === baseGid);
      if (referenced?.type === 'tile') {
        throw new Error(`Map “${map.name}” object layer “${layer.name}” tile object “${referenced.name || referenced.id}” still references image-collection tile ${tileId}. Collection-backed tile objects are not removable in this workflow.`);
      }
    };
    for (const layerId of map.layerIds) visit(layerId);
    for (const layerId of Object.keys(map.layers)) visit(layerId);
  }

  for (const retainedId of retainedIds) {
    const frames = tileset.tiles[retainedId].animation;
    scannedReferenceCount = consumeRemovalReferenceBudget(scannedReferenceCount, frames.length);
    scannedAnimationFrameCount += frames.length;
    if (frames.some((frame) => frame.tileId === tileId)) {
      throw new Error(`Image-collection tile ${retainedId} animation still references tile ${tileId}. Remove that ordered animation frame before detaching the source.`);
    }
  }
  for (const stamp of document.tileStamps) {
    scannedReferenceCount = consumeRemovalReferenceBudget(scannedReferenceCount, stamp.cells.length);
    scannedTileStampCellCount += stamp.cells.length;
    if (stamp.cells.some((cell) => decodeTiledGid(cell.gid).gid === baseGid)) {
      throw new Error(`Reusable tile stamp “${stamp.name}” still stores image-collection tile ${tileId}'s transformed GID. Collection-backed stamp cleanup is not part of this workflow.`);
    }
  }

  return {
    baseGid,
    sourceId: source.id,
    sourceName: source.name,
    retainedTileCount: retainedIds.length,
    attachedMapCount,
    scannedCellCount,
    scannedObjectCount,
    scannedAnimationFrameCount,
    scannedTileStampCellCount,
    scannedReferenceCount,
  };
}

/** Removes one proven-unused sparse tile record without deleting its source sprite. */
export function removeUnusedImageCollectionSource(
  document: PixelDocument,
  tilesetId: string,
  tileId: number,
): ImageCollectionSourceRemovalPlan {
  const proof = imageCollectionSourceRemovalProof(document, tilesetId, tileId);
  const current = document.pixelAssets[tilesetId];
  if (!current || current.type !== 'tileset' || !isImageCollectionTileset(current)) throw new Error(`Image collection ${tilesetId} does not exist.`);
  const retainedIds = imageCollectionTileIds(current).filter((id) => id !== tileId);
  const retainedSourceIds = retainedIds.map((id) => current.tiles[id].imageAssetId!);
  imageCollectionSourcePixels(document, retainedSourceIds);
  const retainedSources = retainedSourceIds.map((id) => requireEligibleSource(document, id));
  const expectedSpriteDependencies = imageCollectionSourceDependencyGuards(document, current);
  const tileset = structuredClone(current);
  delete tileset.tiles[tileId];
  tileset.tileWidth = Math.max(...retainedSources.map((source) => source.width));
  tileset.tileHeight = Math.max(...retainedSources.map((source) => source.height));
  return { tileset, tileId, sourceId: proof.sourceId, proof, expectedSpriteDependencies };
}

export function imageCollectionSourceDependencyGuards(
  document: PixelDocument,
  tileset: PixelTileset,
): PixelSpriteDependencyGuard[] {
  if (!isImageCollectionTileset(tileset)) throw new Error('Sprite dependency guards require an image collection.');
  const guards = new Map<string, PixelSpriteDependencyGuard>();
  for (const tileId of imageCollectionTileIds(tileset)) {
    const sourceId = tileset.tiles[tileId].imageAssetId;
    const source = sourceId ? document.pixelAssets[sourceId] : undefined;
    if (source?.type !== 'sprite') throw new Error(`Image-collection tile ${tileId} is missing its sprite source.`);
    guards.set(source.id, { spriteId: source.id, expectedRevision: source.revision, width: source.width, height: source.height });
  }
  imageCollectionSourcePixels(document, [...guards.keys()]);
  return [...guards.values()];
}

/** Replaces only editable metadata while preserving the collection's exact sparse source topology. */
export function replaceImageCollectionTileMetadata(
  tileset: PixelTileset,
  tileId: number,
  patch: ImageCollectionTileMetadataPatch,
): PixelTileset {
  if (!isImageCollectionTileset(tileset)) throw new Error('Image-collection metadata editing requires an image collection.');
  const tile = tileset.tiles[tileId];
  if (!tile?.imageAssetId) throw new Error(`Image-collection tile ${tileId} is unavailable.`);
  if (patch.animation?.some((frame) => !tileset.tiles[frame.tileId]?.imageAssetId)) {
    throw new Error('Image-collection animation frames must use existing sparse tile IDs.');
  }
  const next = structuredClone(tileset);
  const target = next.tiles[tileId];
  if (patch.probability !== undefined) target.probability = patch.probability;
  if (patch.animation !== undefined) target.animation = structuredClone(patch.animation);
  if (patch.collisions !== undefined) target.collisions = structuredClone(patch.collisions);
  if (patch.properties !== undefined) target.properties = structuredClone(patch.properties);
  return next;
}

/**
 * Binds an authoring action to the exact rendered collection and all of its
 * per-tile sprite revisions. The canonical asset replacement performs the
 * final revision check; this guard prevents submitting edits from stale source
 * dimensions or collection membership.
 */
export function imageCollectionAuthoringGuardError(
  observed: PixelDocument,
  current: PixelDocument,
  tilesetId: string,
): string | undefined {
  if (observed.id !== current.id) return 'The active document changed. Re-open the image collection before editing it.';
  const observedTileset = observed.pixelAssets[tilesetId];
  const currentTileset = current.pixelAssets[tilesetId];
  if (observedTileset?.type !== 'tileset' || !isImageCollectionTileset(observedTileset)) return 'The observed image collection is unavailable.';
  if (currentTileset?.type !== 'tileset' || !isImageCollectionTileset(currentTileset)) return 'The image collection changed or is unavailable. Re-open it before editing.';
  if (currentTileset.revision !== observedTileset.revision) return 'The image collection changed. Re-open it before editing.';
  const observedIds = imageCollectionTileIds(observedTileset);
  const currentIds = imageCollectionTileIds(currentTileset);
  if (observedIds.length !== currentIds.length || observedIds.some((id, index) => id !== currentIds[index])) return 'The image collection tile IDs changed. Re-open it before editing.';
  for (const tileId of observedIds) {
    const observedTile = observedTileset.tiles[tileId];
    const currentTile = currentTileset.tiles[tileId];
    if (!observedTile.imageAssetId || currentTile?.imageAssetId !== observedTile.imageAssetId) return `Image-collection tile ${tileId} changed source. Re-open it before editing.`;
    const observedSource = observed.pixelAssets[observedTile.imageAssetId];
    const currentSource = current.pixelAssets[observedTile.imageAssetId];
    if (observedSource?.type !== 'sprite' || currentSource?.type !== 'sprite') return `Image-collection tile ${tileId} is missing its sprite source.`;
    if (currentSource.revision !== observedSource.revision || currentSource.width !== observedSource.width || currentSource.height !== observedSource.height) return `Image-collection tile ${tileId} source changed. Re-open it before editing.`;
  }
  return undefined;
}
