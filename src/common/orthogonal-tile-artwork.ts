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
  offset?: OrthogonalTileArtworkOffset;
}

export interface OrthogonalTileArtworkOffset {
  x: number;
  y: number;
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

function finiteOffset(offset: OrthogonalTileArtworkOffset): void {
  if (![offset.x, offset.y].every(Number.isFinite)) throw new RangeError('Tileset drawing offset must be finite.');
}

/**
 * Places native tileset artwork in one orthogonal map cell. Before transforms,
 * artwork is left-aligned and bottom-aligned to the cell. Tiled's established
 * diagonal-first centered matrix is then applied inside that native footprint,
 * after which the tileset drawing offset translates the final placement.
 */
export function orthogonalTileArtworkPlacement(
  cell: OrthogonalCellRect,
  mapTileWidth: number,
  mapTileHeight: number,
  artwork: OrthogonalTileArtworkSize,
  transforms: { hFlip?: boolean; vFlip?: boolean; diagonal?: boolean } = {},
  offset: OrthogonalTileArtworkOffset = { x: 0, y: 0 },
): OrthogonalTileArtworkPlacement {
  finiteCell(cell);
  const canonicalCellWidth = positive(mapTileWidth, 'Map tile width');
  const canonicalCellHeight = positive(mapTileHeight, 'Map tile height');
  const artworkWidth = positive(artwork.width, 'Tileset artwork width');
  const artworkHeight = positive(artwork.height, 'Tileset artwork height');
  finiteOffset(offset);
  // Preserve the former rectangle's exact floating-point values for the
  // overwhelmingly common equal-size case, including interactive fit scales.
  const width = artworkWidth === canonicalCellWidth ? cell.width : cell.width * artworkWidth / canonicalCellWidth;
  const height = artworkHeight === canonicalCellHeight ? cell.height : cell.height * artworkHeight / canonicalCellHeight;
  const centerX = cell.x + width / 2 + offset.x * cell.width / canonicalCellWidth;
  const centerY = cell.y + cell.height - height / 2 + offset.y * cell.height / canonicalCellHeight;
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
    const placement = orthogonalTileArtworkPlacement(cell, mapTileWidth, mapTileHeight, artwork, { diagonal }, artwork.offset);
    envelope.left = Math.min(envelope.left, placement.bounds.left);
    envelope.top = Math.min(envelope.top, placement.bounds.top);
    envelope.right = Math.max(envelope.right, placement.bounds.right);
    envelope.bottom = Math.max(envelope.bottom, placement.bounds.bottom);
  }
  return envelope;
}

/**
 * Includes the nominal cell fallback plus every renderable sprite-backed
 * tileset actually attached to the map. Missing/non-sprite sources retain the
 * nominal, unoffset fallback and do not gain native-artwork drawing authority.
 */
export function orthogonalMapTileArtworkEnvelope(
  document: PixelDocument,
  map: PixelTilemap,
): OrthogonalTileArtworkEnvelope {
  const artworkSizes: OrthogonalTileArtworkSize[] = [{ width: map.tileWidth, height: map.tileHeight }];
  for (const id of map.tilesetIds) {
    const asset = document.pixelAssets[id];
    const source = asset?.type === 'tileset' ? document.pixelAssets[asset.spriteAssetId] : undefined;
    if (asset?.type === 'tileset' && source?.type === 'sprite') artworkSizes.push({ width: asset.tileWidth, height: asset.tileHeight, offset: asset.tileOffset });
  }
  return orthogonalTileArtworkEnvelope(map.tileWidth, map.tileHeight, artworkSizes);
}
