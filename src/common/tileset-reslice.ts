import type { PixelTileset, TileDefinition, WangSet } from '@aidraw/core';

export const MAX_TILESET_SLICE_TILES = 1_048_576;

export type TilesetMetadataRemap = 'source-position' | 'tile-id';

export interface TilesetSliceLayout {
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
}

export interface TilesetResliceImpact {
  metadataTiles: number;
  preservedMetadataTiles: number;
  reframedMetadataTiles: number;
  remappedMetadataTileIds: number;
  droppedMetadataTiles: number;
  droppedAnimationFrames: number;
  droppedCollisionShapes: number;
  droppedCustomProperties: number;
  droppedWangColors: number;
  droppedWangTiles: number;
}

export interface TilesetReslicePlan {
  tileset: PixelTileset;
  mapTileId: (tileId: number) => number | undefined;
  impact: TilesetResliceImpact;
}

function integer(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}.`);
  return value;
}

function defaultTile(id: number, tileset: Pick<PixelTileset, 'tileWidth' | 'tileHeight' | 'margin' | 'spacing' | 'columns'>): TileDefinition {
  return {
    id,
    sourceX: tileset.margin + id % tileset.columns * (tileset.tileWidth + tileset.spacing),
    sourceY: tileset.margin + Math.floor(id / tileset.columns) * (tileset.tileHeight + tileset.spacing),
    probability: 1,
    animation: [],
    collisions: [],
    properties: {},
  };
}

function tileAt(tileset: PixelTileset, id: number): TileDefinition {
  return tileset.tiles[id] ?? defaultTile(id, tileset);
}

function hasMetadata(tile: TileDefinition): boolean {
  return tile.probability !== 1 || tile.animation.length > 0 || tile.collisions.length > 0 || Object.keys(tile.properties).length > 0;
}

function sourcePositionTarget(tile: TileDefinition, layout: PixelTileset): number | undefined {
  const stepX = layout.tileWidth + layout.spacing;
  const stepY = layout.tileHeight + layout.spacing;
  const localX = tile.sourceX - layout.margin;
  const localY = tile.sourceY - layout.margin;
  if (localX < 0 || localY < 0 || localX % stepX !== 0 || localY % stepY !== 0) return undefined;
  const column = localX / stepX;
  const row = localY / stepY;
  if (column >= layout.columns || row >= layout.rows) return undefined;
  return row * layout.columns + column;
}

function mappedWangSets(source: PixelTileset, mapTileId: (tileId: number) => number | undefined): WangSet[] {
  return source.wangSets.map((set) => {
    const colors = set.colors
      .flatMap((color) => {
        const tileId = mapTileId(color.tileId);
        return tileId === undefined ? [] : [{ ...structuredClone(color), tileId }];
      });
    const retainedColorIds = new Set(colors.map((color) => color.id));
    const tiles = set.tiles
      .flatMap((tile) => {
        const tileId = mapTileId(tile.tileId);
        return tileId === undefined ? [] : [{
          ...structuredClone(tile),
          tileId,
          wangId: tile.wangId.map((colorId) => colorId === 0 || retainedColorIds.has(colorId) ? colorId : 0) as typeof tile.wangId,
        }];
      })
      .filter((tile) => tile.wangId.some((colorId) => colorId > 0));
    return { ...structuredClone(set), colors, tiles };
  });
}

function total<T>(values: readonly T[], count: (value: T) => number): number {
  return values.reduce((sum, value) => sum + count(value), 0);
}

export function planTilesetReslice(
  source: PixelTileset,
  sourceSize: { width: number; height: number },
  requested: TilesetSliceLayout,
  remap: TilesetMetadataRemap,
): TilesetReslicePlan {
  if (remap !== 'source-position' && remap !== 'tile-id') throw new Error('Tileset metadata remap must use source positions or tile IDs.');
  const width = integer(sourceSize.width, 'Source width', 1);
  const height = integer(sourceSize.height, 'Source height', 1);
  const tileWidth = integer(requested.tileWidth, 'Tile width', 1);
  const tileHeight = integer(requested.tileHeight, 'Tile height', 1);
  const margin = integer(requested.margin, 'Margin', 0);
  const spacing = integer(requested.spacing, 'Spacing', 0);
  const usableWidth = width - margin * 2;
  const usableHeight = height - margin * 2;
  if (usableWidth < tileWidth || usableHeight < tileHeight) throw new Error('The requested tile and margins do not fit inside the source sprite.');
  const columns = Math.floor((usableWidth + spacing) / (tileWidth + spacing));
  const rows = Math.floor((usableHeight + spacing) / (tileHeight + spacing));
  const tileCount = columns * rows;
  if (!Number.isSafeInteger(tileCount) || tileCount > MAX_TILESET_SLICE_TILES) throw new Error(`The slice exceeds the ${MAX_TILESET_SLICE_TILES.toLocaleString('en-US')}-tile limit.`);

  const next: PixelTileset = {
    ...structuredClone(source),
    tileWidth,
    tileHeight,
    margin,
    spacing,
    columns,
    rows,
    tiles: {},
  };
  const oldTileCount = source.columns * source.rows;
  const sourceTiles = Object.values(source.tiles);
  const metadataTileIds = new Set(sourceTiles.filter(hasMetadata).map((tile) => tile.id));
  for (const tile of sourceTiles) for (const frame of tile.animation) metadataTileIds.add(frame.tileId);
  for (const set of source.wangSets) {
    for (const color of set.colors) metadataTileIds.add(color.tileId);
    for (const tile of set.tiles) metadataTileIds.add(tile.tileId);
  }
  const mapTileId = (oldId: number): number | undefined => {
    if (!Number.isInteger(oldId) || oldId < 0 || oldId >= oldTileCount) return undefined;
    if (remap === 'tile-id') return oldId < tileCount ? oldId : undefined;
    return sourcePositionTarget(tileAt(source, oldId), next);
  };
  const oldIdForTarget = new Map<number, number>();
  for (const oldId of metadataTileIds) {
    const targetId = mapTileId(oldId);
    if (targetId === undefined) continue;
    const previous = oldIdForTarget.get(targetId);
    if (previous !== undefined) throw new Error(`Source-position remap is ambiguous: tiles ${previous} and ${oldId} share one target. Use tile-ID remapping instead.`);
    oldIdForTarget.set(targetId, oldId);
  }

  for (const old of sourceTiles.filter(hasMetadata)) {
    const id = mapTileId(old.id);
    if (id === undefined) continue;
    const base = defaultTile(id, next);
    next.tiles[id] = {
      ...base,
      probability: old.probability,
      animation: old.animation.flatMap((frame) => {
        const mapped = mapTileId(frame.tileId);
        return mapped === undefined ? [] : [{ ...structuredClone(frame), tileId: mapped }];
      }),
      collisions: structuredClone(old.collisions),
      properties: structuredClone(old.properties),
    };
  }
  next.wangSets = mappedWangSets(source, mapTileId);

  const nextTiles = Object.values(next.tiles);
  const metadataTiles = [...metadataTileIds].map((id) => tileAt(source, id));
  const preservedMetadata = metadataTiles.filter((tile) => mapTileId(tile.id) !== undefined);
  const reframedMetadata = preservedMetadata.filter((tile) => {
    const mapped = defaultTile(mapTileId(tile.id)!, next);
    return tile.sourceX !== mapped.sourceX || tile.sourceY !== mapped.sourceY || source.tileWidth !== next.tileWidth || source.tileHeight !== next.tileHeight;
  });
  const sourceWangColors = total(source.wangSets, (set) => set.colors.length);
  const nextWangColors = total(next.wangSets, (set) => set.colors.length);
  const sourceWangTiles = total(source.wangSets, (set) => set.tiles.length);
  const nextWangTiles = total(next.wangSets, (set) => set.tiles.length);
  return {
    tileset: next,
    mapTileId,
    impact: {
      metadataTiles: metadataTiles.length,
      preservedMetadataTiles: preservedMetadata.length,
      reframedMetadataTiles: reframedMetadata.length,
      remappedMetadataTileIds: preservedMetadata.filter((tile) => mapTileId(tile.id) !== tile.id).length,
      droppedMetadataTiles: metadataTiles.length - preservedMetadata.length,
      droppedAnimationFrames: total(sourceTiles, (tile) => tile.animation.length) - total(nextTiles, (tile) => tile.animation.length),
      droppedCollisionShapes: total(sourceTiles, (tile) => tile.collisions.length) - total(nextTiles, (tile) => tile.collisions.length),
      droppedCustomProperties: total(sourceTiles, (tile) => Object.keys(tile.properties).length) - total(nextTiles, (tile) => Object.keys(tile.properties).length),
      droppedWangColors: sourceWangColors - nextWangColors,
      droppedWangTiles: sourceWangTiles - nextWangTiles,
    },
  };
}
