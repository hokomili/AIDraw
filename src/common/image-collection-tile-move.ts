import {
  CanvasOperationSchema,
  TILED_GID_MASK,
  decodeTiledGid,
  decodeTilemapChunk,
  encodeTiledGid,
  isImageCollectionTileset,
  resolveTilesetForGid,
  tilesetHasLocalId,
  tilesetLocalIdSpan,
  writeTileRuns,
  type CanvasOperation,
  type PixelDocument,
  type PixelSpriteDependencyGuard,
  type PixelTilemap,
  type PixelTileset,
  type TileGidRun,
  type TileStamp,
} from '@aidraw/core';

import {
  imageCollectionSourceDependencyGuards,
  imageCollectionTileIds,
} from './image-collection-authoring';
import { MAX_TILED_TOTAL_CELLS } from './tiled-resource-policy';

export const MAX_IMAGE_COLLECTION_TILE_MOVE_OPERATIONS = 256;
export const MAX_IMAGE_COLLECTION_TILE_MOVE_OPERATION_BYTES = 1_500_000;

export interface ImageCollectionTileMoveMapImpact {
  mapId: string;
  mapName: string;
  mapRevision: number;
  orientation: PixelTilemap['orientation'];
  infinite: boolean;
  tileCellCount: number;
  tileObjectCount: number;
  layerIds: string[];
}

export interface ImageCollectionTileMoveAnimationImpact {
  tileId: number;
  frameCount: number;
}

export interface ImageCollectionTileMoveWangImpact {
  setId: string;
  setName: string;
  colorCount: number;
  tileCount: number;
}

export interface ImageCollectionTileMoveStampImpact {
  stampId: string;
  stampName: string;
  cellCount: number;
}

export interface ImageCollectionTileMoveImpact {
  tilesetId: string;
  tilesetName: string;
  sourceTileId: number;
  destinationTileId: number;
  sourceId: string;
  sourceName: string;
  sourceWidth: number;
  sourceHeight: number;
  oldBaseGid: number;
  newBaseGid: number;
  maximumLocalId: number;
  attachedMapCount: number;
  maps: ImageCollectionTileMoveMapImpact[];
  animations: ImageCollectionTileMoveAnimationImpact[];
  wangSets: ImageCollectionTileMoveWangImpact[];
  stamps: ImageCollectionTileMoveStampImpact[];
  mapCellCount: number;
  tileObjectCount: number;
  animationFrameCount: number;
  wangColorCount: number;
  wangTileCount: number;
  tileStampCellCount: number;
  scannedReferenceCount: number;
  rewrittenReferenceCount: number;
  operationCount: number;
}

export interface ImageCollectionTileMovePlan {
  operations: CanvasOperation[];
  tileset: PixelTileset;
  maps: PixelTilemap[];
  tileStamps: TileStamp[];
  impact: ImageCollectionTileMoveImpact;
  expectedDocumentRevision: number;
  expectedTilesetRevision: number;
  expectedSpriteDependencies: PixelSpriteDependencyGuard[];
}

function requirePixelDocument(document: PixelDocument): PixelDocument {
  if (document.kind !== 'pixel') throw new Error('Image-collection tile movement requires a pixel document.');
  return document;
}

function requireCollection(document: PixelDocument, tilesetId: string): PixelTileset {
  const tileset = document.pixelAssets[tilesetId];
  if (!tileset || tileset.type !== 'tileset' || !isImageCollectionTileset(tileset)) {
    throw new Error(`Image collection ${tilesetId} does not exist.`);
  }
  return tileset;
}

function consumeReferenceBudget(current: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_TILED_TOTAL_CELLS - current) {
    throw new RangeError(`Image-collection tile movement exceeds the ${MAX_TILED_TOTAL_CELLS.toLocaleString('en-US')}-entry reference-scan limit.`);
  }
  return current + amount;
}

function resolutionIdentity(value: ReturnType<typeof resolveTilesetForGid>): string | undefined {
  return value ? `${value.tileset.id}:${value.localId}` : undefined;
}

function assertExactMapTarget(
  document: PixelDocument,
  map: PixelTilemap,
  tileset: PixelTileset,
  tileId: number,
  context: 'source' | 'destination',
): void {
  const baseGid = tileset.firstGid + tileId;
  const seen = new Set<string>();
  const covering: string[] = [];
  for (const attachedId of map.tilesetIds) {
    if (seen.has(attachedId)) throw new Error(`Map “${map.name}” attaches tileset ${attachedId} more than once.`);
    seen.add(attachedId);
    const attached = document.pixelAssets[attachedId];
    if (!attached || attached.type !== 'tileset') throw new Error(`Map “${map.name}” is missing attached tileset ${attachedId}.`);
    const span = tilesetLocalIdSpan(attached);
    const lastGid = attached.firstGid + span - 1;
    if (!Number.isSafeInteger(attached.firstGid) || attached.firstGid < 1 || !Number.isSafeInteger(span) || span < 1
      || !Number.isSafeInteger(lastGid) || lastGid > TILED_GID_MASK) {
      throw new RangeError(`Map “${map.name}” has an unsafe attached GID range for tileset “${attached.name}”.`);
    }
    if (baseGid >= attached.firstGid && baseGid <= lastGid) covering.push(attached.id);
  }
  if (covering.length !== 1 || covering[0] !== tileset.id) {
    throw new Error(`Map “${map.name}” cannot prove one exact attached range for the moved tile ${context} GID ${baseGid}.`);
  }
  const resolved = resolveTilesetForGid(document, map, baseGid);
  if (!resolved || resolved.tileset.id !== tileset.id || resolved.localId !== tileId) {
    throw new Error(`Map “${map.name}” ${context} GID ${baseGid} is missing or shadowed by attached tileset precedence.`);
  }
}

function layerOrAncestorLocked(map: PixelTilemap, layerId: string): boolean {
  const visited = new Set<string>();
  let currentId: string | undefined = layerId;
  while (currentId) {
    if (visited.has(currentId)) throw new Error(`Map “${map.name}” has a cyclic layer ancestry at ${currentId}.`);
    visited.add(currentId);
    const layer: PixelTilemap['layers'][string] | undefined = map.layers[currentId];
    if (!layer) throw new Error(`Map “${map.name}” is missing layer ${currentId}.`);
    if (layer.locked) return true;
    currentId = layer.parentId;
  }
  return false;
}

function orderedLayerIds(map: PixelTilemap): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const visit = (layerId: string): void => {
    if (seen.has(layerId)) return;
    const layer = map.layers[layerId];
    if (!layer) throw new Error(`Map “${map.name}” is missing layer ${layerId}.`);
    seen.add(layerId);
    ordered.push(layerId);
    if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId);
  };
  for (const layerId of map.layerIds) visit(layerId);
  for (const layerId of Object.keys(map.layers)) visit(layerId);
  return ordered;
}

function appendTileRun(runs: TileGidRun[], x: number, y: number, gid: number): void {
  const previous = runs.at(-1);
  if (previous && previous.y === y && previous.gid === gid && previous.x + previous.length === x && previous.length < 65_536) {
    previous.length += 1;
  } else runs.push({ x, y, length: 1, gid });
}

function exactTransformedGid(raw: number, baseGid: number): number {
  const decoded = decodeTiledGid(raw);
  return encodeTiledGid(baseGid, decoded);
}

function assertReusableStampOwnership(document: PixelDocument, tileset: PixelTileset, baseGid: number): void {
  for (const asset of Object.values(document.pixelAssets)) {
    if (asset.type !== 'tileset' || asset.id === tileset.id) continue;
    if (asset.firstGid === tileset.firstGid) {
      throw new Error(`Reusable tile-stamp GID ${baseGid} is ambiguous because tilesets “${tileset.name}” and “${asset.name}” share firstGid ${tileset.firstGid}.`);
    }
    if (asset.firstGid > tileset.firstGid && asset.firstGid <= baseGid) {
      throw new Error(`Reusable tile-stamp GID ${baseGid} can be shadowed by higher-firstGid tileset “${asset.name}”.`);
    }
    if (asset.firstGid <= baseGid && tilesetHasLocalId(asset, baseGid - asset.firstGid)) {
      throw new Error(`Reusable tile-stamp GID ${baseGid} also names tile ${baseGid - asset.firstGid} in “${asset.name}”.`);
    }
  }
}

function operationBytes(operations: readonly CanvasOperation[]): number {
  return new TextEncoder().encode(JSON.stringify(operations)).byteLength;
}

export function firstUnusedImageCollectionTileId(tileset: PixelTileset, sourceTileId: number): number {
  if (!isImageCollectionTileset(tileset)) throw new Error('Tile-ID movement requires an image collection.');
  const ids = imageCollectionTileIds(tileset);
  const maximumLocalId = ids.at(-1);
  if (maximumLocalId === undefined || !tileset.tiles[sourceTileId]?.imageAssetId) throw new Error(`Image-collection tile ${sourceTileId} is unavailable.`);
  if (sourceTileId === maximumLocalId) throw new Error(`Tile ${sourceTileId} is the collection’s highest authored local ID and cannot move in this bounded workflow.`);
  const occupied = new Set(ids);
  for (let candidate = 0; candidate <= maximumLocalId; candidate += 1) if (!occupied.has(candidate)) return candidate;
  throw new Error(`Image collection “${tileset.name}” has no unused local-ID gap inside its authored span.`);
}

/**
 * Moves one non-highest sparse collection tile into one existing gap while
 * rewriting every supported direct reference in a single canonical plan.
 */
export function planImageCollectionTileIdMove(
  document: PixelDocument,
  tilesetId: string,
  sourceTileId: number,
  destinationTileId: number,
): ImageCollectionTileMovePlan {
  requirePixelDocument(document);
  const current = requireCollection(document, tilesetId);
  const ids = imageCollectionTileIds(current);
  const maximumLocalId = ids.at(-1);
  if (maximumLocalId === undefined) throw new Error(`Image collection “${current.name}” has no authored tiles.`);
  if (!Number.isSafeInteger(sourceTileId) || sourceTileId < 0 || sourceTileId > 1_048_575 || !current.tiles[sourceTileId]?.imageAssetId) {
    throw new Error(`Image-collection tile ${sourceTileId} is unavailable.`);
  }
  if (sourceTileId === maximumLocalId) {
    throw new Error(`Tile ${sourceTileId} is the collection’s highest authored local ID and cannot move in this bounded workflow.`);
  }
  if (!Number.isSafeInteger(destinationTileId) || destinationTileId < 0 || destinationTileId > 1_048_575) {
    throw new Error('The destination local ID must be a whole number from 0 through 1,048,575.');
  }
  if (destinationTileId === sourceTileId) throw new Error('The destination local ID must differ from the selected tile ID.');
  if (destinationTileId > maximumLocalId) {
    throw new Error(`Destination tile ${destinationTileId} falls outside the unchanged authored span 0–${maximumLocalId}.`);
  }
  if (current.tiles[destinationTileId]?.imageAssetId) throw new Error(`Destination tile ${destinationTileId} is already occupied.`);

  const expectedSpriteDependencies = imageCollectionSourceDependencyGuards(document, current);
  const target = current.tiles[sourceTileId];
  const sourceId = target.imageAssetId!;
  const source = document.pixelAssets[sourceId];
  if (!source || source.type !== 'sprite') throw new Error(`Image-collection tile ${sourceTileId} is missing its sprite source.`);
  const oldBaseGid = current.firstGid + sourceTileId;
  const newBaseGid = current.firstGid + destinationTileId;
  if (!Number.isSafeInteger(oldBaseGid) || oldBaseGid < 1 || oldBaseGid > TILED_GID_MASK
    || !Number.isSafeInteger(newBaseGid) || newBaseGid < 1 || newBaseGid > TILED_GID_MASK) {
    throw new RangeError('The requested image-collection tile move exceeds the supported 28-bit GID range.');
  }

  let scannedReferenceCount = 0;
  const animations: ImageCollectionTileMoveAnimationImpact[] = [];
  let animationFrameCount = 0;
  const tileset = structuredClone(current);
  for (const tileId of ids) {
    const tile = tileset.tiles[tileId];
    scannedReferenceCount = consumeReferenceBudget(scannedReferenceCount, tile.animation.length);
    for (const frame of tile.animation) {
      if (!current.tiles[frame.tileId]?.imageAssetId) throw new Error(`Image-collection tile ${tileId} animation references missing sparse tile ${frame.tileId}.`);
    }
    const matching = tile.animation.filter((frame) => frame.tileId === sourceTileId).length;
    if (matching > 0) {
      animationFrameCount += matching;
      animations.push({ tileId, frameCount: matching });
      tile.animation = tile.animation.map((frame) => frame.tileId === sourceTileId ? { ...frame, tileId: destinationTileId } : frame);
    }
  }
  const movedTile = tileset.tiles[sourceTileId];
  delete tileset.tiles[sourceTileId];
  movedTile.id = destinationTileId;
  tileset.tiles[destinationTileId] = movedTile;

  const wangSets: ImageCollectionTileMoveWangImpact[] = [];
  let wangColorCount = 0;
  let wangTileCount = 0;
  for (const set of tileset.wangSets) {
    scannedReferenceCount = consumeReferenceBudget(scannedReferenceCount, set.colors.length + set.tiles.length);
    for (const color of set.colors) if (!current.tiles[color.tileId]?.imageAssetId) {
      throw new Error(`Wang set “${set.name}” color “${color.name}” references missing sparse tile ${color.tileId}.`);
    }
    for (const tile of set.tiles) if (!current.tiles[tile.tileId]?.imageAssetId) {
      throw new Error(`Wang set “${set.name}” references missing sparse tile ${tile.tileId}.`);
    }
    const colorCount = set.colors.filter((color) => color.tileId === sourceTileId).length;
    const tileCount = set.tiles.filter((tile) => tile.tileId === sourceTileId).length;
    if (colorCount > 0) set.colors = set.colors.map((color) => color.tileId === sourceTileId ? { ...color, tileId: destinationTileId } : color);
    if (tileCount > 0) set.tiles = set.tiles.map((tile) => tile.tileId === sourceTileId ? { ...tile, tileId: destinationTileId } : tile);
    if (colorCount > 0 || tileCount > 0) {
      wangColorCount += colorCount;
      wangTileCount += tileCount;
      wangSets.push({ setId: set.id, setName: set.name, colorCount, tileCount });
    }
  }

  if (tilesetLocalIdSpan(current) !== maximumLocalId + 1 || tilesetLocalIdSpan(tileset) !== maximumLocalId + 1) {
    throw new Error('The tile move would change the collection’s authored local-ID span.');
  }
  if (current.firstGid !== tileset.firstGid || current.tileWidth !== tileset.tileWidth || current.tileHeight !== tileset.tileHeight) {
    throw new Error('The tile move would change collection range or nominal source geometry.');
  }

  const projectedDocument: PixelDocument = {
    ...document,
    pixelAssets: { ...document.pixelAssets, [tileset.id]: tileset },
  };
  const maps: PixelTilemap[] = [];
  const mapImpacts: ImageCollectionTileMoveMapImpact[] = [];
  let attachedMapCount = 0;
  let mapCellCount = 0;
  let tileObjectCount = 0;

  for (const assetId of document.assetIds) {
    const map = document.pixelAssets[assetId];
    if (!map || map.type !== 'tilemap' || !map.tilesetIds.includes(current.id)) continue;
    attachedMapCount += 1;
    assertExactMapTarget(document, map, current, sourceTileId, 'source');
    assertExactMapTarget(projectedDocument, map, tileset, destinationTileId, 'destination');
    const nextMap = structuredClone(map);
    const changedLayerIds: string[] = [];
    let changedCells = 0;
    let changedObjects = 0;

    for (const layerId of orderedLayerIds(map)) {
      const layer = map.layers[layerId];
      const nextLayer = nextMap.layers[layerId];
      let layerChanged = false;
      if (layer.type === 'tile') {
        const runs: TileGidRun[] = [];
        for (const chunk of Object.values(layer.chunks ?? {})) {
          const chunkCells = chunk.width * chunk.height;
          scannedReferenceCount = consumeReferenceBudget(scannedReferenceCount, chunkCells);
          const values = decodeTilemapChunk(chunk);
          if (values.length !== chunkCells) throw new Error(`Map “${map.name}” layer “${layer.name}” has an invalid tile chunk payload.`);
          for (let index = 0; index < values.length; index += 1) {
            const raw = values[index] ?? 0;
            if (raw === 0) continue;
            const decoded = decodeTiledGid(raw);
            if (decoded.gid === newBaseGid) {
              throw new Error(`Map “${map.name}” layer “${layer.name}” already stores destination GID ${newBaseGid}; moving the tile would change that retained reference from unresolved to resolved.`);
            }
            if (decoded.gid === oldBaseGid) {
              if (layerOrAncestorLocked(map, layerId)) throw new Error(`Map “${map.name}” layer “${layer.name}” is locked and contains a moved tile reference.`);
              const x = chunk.x + index % chunk.width;
              const y = chunk.y + Math.floor(index / chunk.width);
              appendTileRun(runs, x, y, exactTransformedGid(raw, newBaseGid));
              changedCells += 1;
              layerChanged = true;
              continue;
            }
            const before = resolutionIdentity(resolveTilesetForGid(document, map, decoded.gid));
            const after = resolutionIdentity(resolveTilesetForGid(projectedDocument, map, decoded.gid));
            if (before !== after) throw new Error(`Map “${map.name}” layer “${layer.name}” GID ${decoded.gid} would change unrelated production resolution from ${before ?? 'unresolved'} to ${after ?? 'unresolved'}.`);
          }
        }
        if (runs.length > 0) {
          if (!nextLayer.chunks) throw new Error(`Map “${map.name}” layer “${layer.name}” is missing tile chunks.`);
          writeTileRuns(nextLayer.chunks, runs);
        }
      } else if (layer.type === 'object') {
        const objects = layer.objects ?? [];
        scannedReferenceCount = consumeReferenceBudget(scannedReferenceCount, objects.length);
        const nextObjects = nextLayer.objects ?? [];
        for (let index = 0; index < objects.length; index += 1) {
          const object = objects[index];
          if (object.type !== 'tile') continue;
          const decoded = decodeTiledGid(object.gid);
          if (decoded.gid === newBaseGid) {
            throw new Error(`Map “${map.name}” tile object “${object.name || object.id}” already stores destination GID ${newBaseGid}; moving the tile would change that retained reference from unresolved to resolved.`);
          }
          if (decoded.gid === oldBaseGid) {
            if (layerOrAncestorLocked(map, layerId)) throw new Error(`Map “${map.name}” layer “${layer.name}” is locked and contains moved tile object “${object.name || object.id}”.`);
            const nextObject = nextObjects[index];
            if (!nextObject || nextObject.type !== 'tile' || nextObject.id !== object.id) throw new Error(`Map “${map.name}” tile object order changed during planning.`);
            nextObject.gid = exactTransformedGid(object.gid, newBaseGid);
            changedObjects += 1;
            layerChanged = true;
            continue;
          }
          const before = resolutionIdentity(resolveTilesetForGid(document, map, decoded.gid));
          const after = resolutionIdentity(resolveTilesetForGid(projectedDocument, map, decoded.gid));
          if (before !== after) throw new Error(`Map “${map.name}” tile object “${object.name || object.id}” GID ${decoded.gid} would change unrelated production resolution from ${before ?? 'unresolved'} to ${after ?? 'unresolved'}.`);
        }
      }
      if (layerChanged) changedLayerIds.push(layerId);
    }

    if (changedCells > 0 || changedObjects > 0) {
      maps.push(nextMap);
      mapCellCount += changedCells;
      tileObjectCount += changedObjects;
      mapImpacts.push({
        mapId: map.id,
        mapName: map.name,
        mapRevision: map.revision,
        orientation: map.orientation,
        infinite: map.infinite,
        tileCellCount: changedCells,
        tileObjectCount: changedObjects,
        layerIds: changedLayerIds,
      });
    }
  }

  let tileStampCellCount = 0;
  const stampImpacts: ImageCollectionTileMoveStampImpact[] = [];
  const tileStamps = structuredClone(document.tileStamps);
  let stampOwnershipProven = false;
  for (let stampIndex = 0; stampIndex < document.tileStamps.length; stampIndex += 1) {
    const stamp = document.tileStamps[stampIndex];
    const nextStamp = tileStamps[stampIndex];
    scannedReferenceCount = consumeReferenceBudget(scannedReferenceCount, stamp.cells.length);
    let changedCells = 0;
    for (let cellIndex = 0; cellIndex < stamp.cells.length; cellIndex += 1) {
      const cell = stamp.cells[cellIndex];
      const decoded = decodeTiledGid(cell.gid);
      if (decoded.gid === newBaseGid) {
        throw new Error(`Reusable tile stamp “${stamp.name}” already stores destination GID ${newBaseGid}; its unresolved or unrelated meaning cannot change silently.`);
      }
      if (decoded.gid !== oldBaseGid) continue;
      if (!stampOwnershipProven) {
        assertReusableStampOwnership(document, current, oldBaseGid);
        assertReusableStampOwnership(projectedDocument, tileset, newBaseGid);
        stampOwnershipProven = true;
      }
      nextStamp.cells[cellIndex].gid = exactTransformedGid(cell.gid, newBaseGid);
      changedCells += 1;
    }
    if (changedCells > 0) {
      tileStampCellCount += changedCells;
      stampImpacts.push({ stampId: stamp.id, stampName: stamp.name, cellCount: changedCells });
    }
  }

  const operations: CanvasOperation[] = [{
    kind: 'pixel.asset.replace',
    asset: tileset,
    expectedRevision: current.revision,
    expectedSpriteDependencies,
  }];
  for (const map of maps) operations.push({ kind: 'pixel.asset.replace', asset: map, expectedRevision: document.pixelAssets[map.id].revision });
  if (tileStampCellCount > 0) operations.push({ kind: 'pixel.tile-stamps.replace', stamps: tileStamps });
  if (operations.length > MAX_IMAGE_COLLECTION_TILE_MOVE_OPERATIONS) {
    throw new RangeError(`Image-collection tile movement would require ${operations.length.toLocaleString('en-US')} canonical operations; the transaction limit is ${MAX_IMAGE_COLLECTION_TILE_MOVE_OPERATIONS}.`);
  }
  for (const operation of operations) {
    const parsed = CanvasOperationSchema.safeParse(operation);
    if (!parsed.success) throw new Error(`Image-collection tile movement produced an invalid canonical operation: ${parsed.error.issues[0]?.message ?? 'unknown operation error'}.`);
  }
  const serializedBytes = operationBytes(operations);
  if (serializedBytes > MAX_IMAGE_COLLECTION_TILE_MOVE_OPERATION_BYTES) {
    throw new RangeError(`Image-collection tile movement would require ${serializedBytes.toLocaleString('en-US')} operation bytes; the bounded limit is ${MAX_IMAGE_COLLECTION_TILE_MOVE_OPERATION_BYTES.toLocaleString('en-US')}.`);
  }

  const rewrittenReferenceCount = mapCellCount + tileObjectCount + animationFrameCount + wangColorCount + wangTileCount + tileStampCellCount;
  const impact: ImageCollectionTileMoveImpact = {
    tilesetId: current.id,
    tilesetName: current.name,
    sourceTileId,
    destinationTileId,
    sourceId,
    sourceName: source.name,
    sourceWidth: source.width,
    sourceHeight: source.height,
    oldBaseGid,
    newBaseGid,
    maximumLocalId,
    attachedMapCount,
    maps: mapImpacts,
    animations,
    wangSets,
    stamps: stampImpacts,
    mapCellCount,
    tileObjectCount,
    animationFrameCount,
    wangColorCount,
    wangTileCount,
    tileStampCellCount,
    scannedReferenceCount,
    rewrittenReferenceCount,
    operationCount: operations.length,
  };
  return {
    operations,
    tileset,
    maps,
    tileStamps,
    impact,
    expectedDocumentRevision: document.revision,
    expectedTilesetRevision: current.revision,
    expectedSpriteDependencies,
  };
}
