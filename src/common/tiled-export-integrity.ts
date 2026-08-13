import {
  decodeTiledGid,
  decodeTilemapChunk,
  TILED_GID_MASK,
  type PixelDocument,
  type PixelSprite,
  type PixelTilemap,
  type PixelTileset,
} from '@aidraw/core';
import { MAX_TILED_TILESETS, assertTiledExportResourceBudget } from './tiled-resource-policy';

export interface TiledExportTilesetReference {
  tileset: PixelTileset;
  sprite: PixelSprite;
  firstGid: number;
  lastGid: number;
}

export interface TiledExportReferencePlan {
  /** References remain in the map's authored order for artifact emission. */
  tilesets: TiledExportTilesetReference[];
  /** Map-only ranges are sorted for deterministic overlap checks and lookup. */
  ranges: TiledExportTilesetReference[];
}

export interface TiledExportChunkData {
  x: number;
  y: number;
  width: number;
  height: number;
  data: number[];
}

export type TiledExportTileLayerData =
  | { infinite: true; chunks: TiledExportChunkData[] }
  | { infinite: false; data: number[] };

export interface TiledMapExportPlan extends TiledExportReferencePlan {
  tileLayers: ReadonlyMap<string, TiledExportTileLayerData>;
}

function requireSourceSprite(document: PixelDocument, tileset: PixelTileset): PixelSprite {
  const source = document.pixelAssets[tileset.spriteAssetId];
  if (source?.type !== 'sprite') throw new Error(`Tiled export tileset “${tileset.name}” is missing its source sprite.`);
  return source;
}

function mapTilesetReferences(document: PixelDocument, map: PixelTilemap): TiledExportTilesetReference[] {
  if (map.tilesetIds.length > MAX_TILED_TILESETS) {
    throw new RangeError(`Tiled export exceeds the ${MAX_TILED_TILESETS.toLocaleString('en-US')}-tileset safety limit.`);
  }
  const seen = new Set<string>();
  return map.tilesetIds.map((id) => {
    if (seen.has(id)) throw new Error(`Tiled export map references tileset ${id} more than once.`);
    seen.add(id);
    const tileset = document.pixelAssets[id];
    if (tileset?.type !== 'tileset') throw new Error(`Tiled export map references missing tileset ${id}.`);
    const sprite = requireSourceSprite(document, tileset);
    if (!Number.isSafeInteger(tileset.firstGid) || tileset.firstGid < 1 || tileset.firstGid > TILED_GID_MASK) {
      throw new RangeError(`Tiled export tileset “${tileset.name}” falls outside the supported 28-bit GID range.`);
    }
    const tileCount = tileset.columns * tileset.rows;
    const lastGid = tileset.firstGid + tileCount - 1;
    if (!Number.isSafeInteger(lastGid) || lastGid > TILED_GID_MASK) {
      throw new RangeError(`Tiled export tileset “${tileset.name}” exceeds the supported 28-bit GID range.`);
    }
    return { tileset, sprite, firstGid: tileset.firstGid, lastGid };
  });
}

/**
 * Resolve the complete source-backed tileset graph that a Tiled artifact emits.
 * Missing canonical references remain recoverable in AIDraw, but cannot become
 * a partial or ambiguous interchange artifact.
 */
export function planTiledExportReferences(
  document: PixelDocument,
  active: PixelTilemap | PixelTileset,
): TiledExportReferencePlan {
  if (active.type === 'tileset') {
    const sprite = requireSourceSprite(document, active);
    return {
      tilesets: [{ tileset: active, sprite, firstGid: active.firstGid, lastGid: active.firstGid }],
      ranges: [],
    };
  }

  const tilesets = mapTilesetReferences(document, active);
  const ranges = [...tilesets].sort((left, right) => left.firstGid - right.firstGid);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (current.firstGid <= previous.lastGid) {
      throw new Error(`Tiled export tilesets “${previous.tileset.name}” and “${current.tileset.name}” have overlapping GID ranges.`);
    }
  }
  return { tilesets, ranges };
}

function resolvesBaseGid(plan: TiledExportReferencePlan, gid: number): boolean {
  let low = 0;
  let high = plan.ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (plan.ranges[middle].firstGid <= gid) low = middle + 1;
    else high = middle - 1;
  }
  return high >= 0 && gid <= plan.ranges[high].lastGid;
}

function assertResolvedGid(
  plan: TiledExportReferencePlan,
  raw: number,
  layer: PixelTilemap['layers'][string],
  x: number,
  y: number,
): void {
  if (raw === 0) return;
  const { gid } = decodeTiledGid(raw);
  if (gid !== 0 && resolvesBaseGid(plan, gid)) return;
  const rawDetail = raw === gid ? '' : ` (raw ${raw})`;
  throw new Error(`Tiled export layer “${layer.name}” uses unresolved tile GID ${gid}${rawDetail} at (${x}, ${y}).`);
}

function decodedChunk(
  layer: PixelTilemap['layers'][string],
  chunk: NonNullable<PixelTilemap['layers'][string]['chunks']>[string],
): number[] {
  const values = decodeTilemapChunk(chunk);
  const expected = chunk.width * chunk.height;
  if (values.length !== expected) {
    throw new Error(`Tiled export layer “${layer.name}” has an invalid ${chunk.x},${chunk.y} chunk payload.`);
  }
  return Array.from(values);
}

/**
 * Build and validate exactly the tile payload the writers consume: every
 * stored infinite-map chunk cell, or the final nominal finite-map plane.
 */
function planTiledExportLayerData(
  map: PixelTilemap,
  plan: TiledExportReferencePlan,
): ReadonlyMap<string, TiledExportTileLayerData> {
  const tileLayers = new Map<string, TiledExportTileLayerData>();
  const visit = (layerId: string): void => {
    const layer = map.layers[layerId];
    if (!layer) throw new Error(`Tiled export layer ${layerId} is missing.`);
    if (layer.type === 'group') {
      for (const childId of layer.childIds ?? []) visit(childId);
      return;
    }
    if (layer.type !== 'tile') return;

    const chunks = Object.values(layer.chunks ?? {});
    if (map.infinite) {
      const plannedChunks: TiledExportChunkData[] = [];
      for (const chunk of chunks) {
        const values = decodedChunk(layer, chunk);
        for (let index = 0; index < values.length; index += 1) {
          assertResolvedGid(plan, values[index], layer, chunk.x + index % chunk.width, chunk.y + Math.floor(index / chunk.width));
        }
        plannedChunks.push({ x: chunk.x, y: chunk.y, width: chunk.width, height: chunk.height, data: values });
      }
      tileLayers.set(layerId, { infinite: true, chunks: plannedChunks });
      return;
    }

    const plane = Array<number>(map.width * map.height).fill(0);
    for (const chunk of chunks) {
      const values = decodedChunk(layer, chunk);
      for (let localY = 0; localY < chunk.height; localY += 1) for (let localX = 0; localX < chunk.width; localX += 1) {
        const x = chunk.x + localX;
        const y = chunk.y + localY;
        if (x >= 0 && y >= 0 && x < map.width && y < map.height) plane[y * map.width + x] = values[localY * chunk.width + localX];
      }
    }
    for (let index = 0; index < plane.length; index += 1) {
      assertResolvedGid(plan, plane[index], layer, index % map.width, Math.floor(index / map.width));
    }
    tileLayers.set(layerId, { infinite: false, data: plane });
  };

  for (const layerId of map.layerIds) visit(layerId);
  return tileLayers;
}

/** Resource admission deliberately precedes reference traversal and decoding. */
export function planTiledMapExport(document: PixelDocument, map: PixelTilemap): TiledMapExportPlan {
  assertTiledExportResourceBudget(map);
  const plan = planTiledExportReferences(document, map);
  return { ...plan, tileLayers: planTiledExportLayerData(map, plan) };
}
