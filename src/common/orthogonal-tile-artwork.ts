import {
  tiledTileTransformMatrix,
  type PixelDocument,
  type PixelTilemap,
  type TiledTileTransformMatrix,
} from '@aidraw/core';

import type { OrthogonalCellRect } from './orthogonal-projection';

export interface OrthogonalTileArtworkSize {
  width: number;
  height: number;
}

export interface OrthogonalTileArtworkBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The union of every attached orthogonal artwork footprint, expressed relative
 * to a cell's top-left corner. It includes both ordinary and diagonal Tiled
 * transforms so chunk culling can retain every cell whose artwork may show.
 */
export type OrthogonalTileArtworkEnvelope = OrthogonalTileArtworkBounds;

export interface OrthogonalTileArtworkPlacement {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  transform: TiledTileTransformMatrix;
  bounds: OrthogonalTileArtworkBounds;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number.`);
  return value;
}

function finiteCell(cell: OrthogonalCellRect): void {
  if (![cell.x, cell.y].every(Number.isFinite)) throw new RangeError('Orthogonal cell origin must be finite.');
  positive(cell.width, 'Orthogonal cell width');
  positive(cell.height, 'Orthogonal cell height');
}

/**
 * Places native tileset artwork in one orthogonal map cell. Before transforms,
 * artwork is left-aligned and bottom-aligned to the cell. Tiled's established
 * diagonal-first centered matrix is then applied inside that native footprint.
 */
export function orthogonalTileArtworkPlacement(
  cell: OrthogonalCellRect,
  mapTileWidth: number,
  mapTileHeight: number,
  artwork: OrthogonalTileArtworkSize,
  transforms: { hFlip?: boolean; vFlip?: boolean; diagonal?: boolean } = {},
): OrthogonalTileArtworkPlacement {
  finiteCell(cell);
  const canonicalCellWidth = positive(mapTileWidth, 'Map tile width');
  const canonicalCellHeight = positive(mapTileHeight, 'Map tile height');
  const artworkWidth = positive(artwork.width, 'Tileset artwork width');
  const artworkHeight = positive(artwork.height, 'Tileset artwork height');
  // Preserve the former rectangle's exact floating-point values for the
  // overwhelmingly common equal-size case, including interactive fit scales.
  const width = artworkWidth === canonicalCellWidth ? cell.width : cell.width * artworkWidth / canonicalCellWidth;
  const height = artworkHeight === canonicalCellHeight ? cell.height : cell.height * artworkHeight / canonicalCellHeight;
  const centerX = cell.x + width / 2;
  const centerY = cell.y + cell.height - height / 2;
  const transform = tiledTileTransformMatrix(transforms);
  const transformedWidth = Math.abs(transform.a) * width + Math.abs(transform.c) * height;
  const transformedHeight = Math.abs(transform.b) * width + Math.abs(transform.d) * height;
  return {
    centerX,
    centerY,
    width,
    height,
    transform,
    bounds: {
      left: centerX - transformedWidth / 2,
      top: centerY - transformedHeight / 2,
      right: centerX + transformedWidth / 2,
      bottom: centerY + transformedHeight / 2,
    },
  };
}

export function orthogonalTileArtworkIntersects(
  bounds: OrthogonalTileArtworkBounds,
  region: { x: number; y: number; width: number; height: number },
): boolean {
  return bounds.right > region.x
    && bounds.bottom > region.y
    && bounds.left < region.x + region.width
    && bounds.top < region.y + region.height;
}

/** Builds the exact conservative cell-relative envelope for known artwork sizes. */
export function orthogonalTileArtworkEnvelope(
  mapTileWidth: number,
  mapTileHeight: number,
  artworkSizes: readonly OrthogonalTileArtworkSize[],
): OrthogonalTileArtworkEnvelope {
  const cell = { x: 0, y: 0, width: positive(mapTileWidth, 'Map tile width'), height: positive(mapTileHeight, 'Map tile height') };
  if (!artworkSizes.length) throw new RangeError('Orthogonal artwork envelope requires at least one footprint.');
  const envelope: OrthogonalTileArtworkEnvelope = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const artwork of artworkSizes) for (const diagonal of [false, true]) {
    const placement = orthogonalTileArtworkPlacement(cell, mapTileWidth, mapTileHeight, artwork, { diagonal });
    envelope.left = Math.min(envelope.left, placement.bounds.left);
    envelope.top = Math.min(envelope.top, placement.bounds.top);
    envelope.right = Math.max(envelope.right, placement.bounds.right);
    envelope.bottom = Math.max(envelope.bottom, placement.bounds.bottom);
  }
  return envelope;
}

/**
 * Includes the nominal cell fallback plus every tileset actually attached to
 * the map. Missing or non-tileset IDs do not gain rendering authority.
 */
export function orthogonalMapTileArtworkEnvelope(
  document: PixelDocument,
  map: PixelTilemap,
): OrthogonalTileArtworkEnvelope {
  const artworkSizes: OrthogonalTileArtworkSize[] = [{ width: map.tileWidth, height: map.tileHeight }];
  for (const id of map.tilesetIds) {
    const asset = document.pixelAssets[id];
    if (asset?.type === 'tileset') artworkSizes.push({ width: asset.tileWidth, height: asset.tileHeight });
  }
  return orthogonalTileArtworkEnvelope(map.tileWidth, map.tileHeight, artworkSizes);
}
