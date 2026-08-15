import {
  tiledTileTransformMatrix,
  type PixelDocument,
  type PixelTilemap,
  type TiledTileTransformMatrix,
} from '@aidraw/core';

import type { IsometricCellRect } from './isometric-projection';

export interface IsometricTileArtworkSize {
  width: number;
  height: number;
  offset?: IsometricTileArtworkOffset;
}

export interface IsometricTileArtworkOffset {
  x: number;
  y: number;
}

export interface IsometricTileArtworkBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The union of every attached isometric artwork footprint, expressed relative
 * to the projected cell bounding rectangle's top-left corner. It includes the
 * nominal fallback plus ordinary and diagonal native footprints.
 */
export type IsometricTileArtworkEnvelope = IsometricTileArtworkBounds;

export interface IsometricTileArtworkPlacement {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  transform: TiledTileTransformMatrix;
  bounds: IsometricTileArtworkBounds;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number.`);
  return value;
}

function finiteCell(cell: IsometricCellRect): void {
  if (![cell.x, cell.y].every(Number.isFinite)) throw new RangeError('Isometric cell origin must be finite.');
  positive(cell.width, 'Isometric cell width');
  positive(cell.height, 'Isometric cell height');
}

function finiteOffset(offset: IsometricTileArtworkOffset): void {
  if (![offset.x, offset.y].every(Number.isFinite)) throw new RangeError('Tileset drawing offset must be finite.');
}

/**
 * Places native tileset artwork in one isometric tile-layer cell.
 *
 * Tiled 1.12.2's IsometricRenderer passes the projected cell rectangle's
 * left/bottom point to CellRenderer::render with BottomLeft origin. The cell
 * renderer applies tile offset in screen axes, compensates a diagonal
 * dimension swap around that same anchor, then applies H/V flips. This keeps
 * non-square transformed bounds left- and bottom-anchored without projecting
 * the artwork dimensions or offset through the isometric map matrix.
 */
export function isometricTileArtworkPlacement(
  cell: IsometricCellRect,
  mapTileWidth: number,
  mapTileHeight: number,
  artwork: IsometricTileArtworkSize,
  transforms: { hFlip?: boolean; vFlip?: boolean; diagonal?: boolean } = {},
  offset: IsometricTileArtworkOffset = { x: 0, y: 0 },
): IsometricTileArtworkPlacement {
  finiteCell(cell);
  const canonicalCellWidth = positive(mapTileWidth, 'Map tile width');
  const canonicalCellHeight = positive(mapTileHeight, 'Map tile height');
  const artworkWidth = positive(artwork.width, 'Tileset artwork width');
  const artworkHeight = positive(artwork.height, 'Tileset artwork height');
  finiteOffset(offset);

  // Preserve the prior values exactly when artwork and map cell dimensions
  // match, including fractional interactive fit scales.
  const width = artworkWidth === canonicalCellWidth ? cell.width : cell.width * artworkWidth / canonicalCellWidth;
  const height = artworkHeight === canonicalCellHeight ? cell.height : cell.height * artworkHeight / canonicalCellHeight;
  const offsetX = offset.x * cell.width / canonicalCellWidth;
  const offsetY = offset.y * cell.height / canonicalCellHeight;
  const transformedWidth = transforms.diagonal ? height : width;
  const transformedHeight = transforms.diagonal ? width : height;
  const left = cell.x + offsetX;
  const bottom = cell.y + cell.height + offsetY;
  const bounds = {
    left,
    top: bottom - transformedHeight,
    right: left + transformedWidth,
    bottom,
  };

  return {
    centerX: (bounds.left + bounds.right) / 2,
    centerY: (bounds.top + bounds.bottom) / 2,
    width,
    height,
    transform: tiledTileTransformMatrix(transforms),
    bounds,
  };
}

export function isometricTileArtworkIntersects(
  bounds: IsometricTileArtworkBounds,
  region: { x: number; y: number; width: number; height: number },
): boolean {
  return bounds.right > region.x
    && bounds.bottom > region.y
    && bounds.left < region.x + region.width
    && bounds.top < region.y + region.height;
}

/** Builds the exact conservative nominal-plus-sprite envelope for known artwork sizes. */
export function isometricTileArtworkEnvelope(
  mapTileWidth: number,
  mapTileHeight: number,
  artworkSizes: readonly IsometricTileArtworkSize[],
): IsometricTileArtworkEnvelope {
  const cell = { x: 0, y: 0, width: positive(mapTileWidth, 'Map tile width'), height: positive(mapTileHeight, 'Map tile height') };
  const envelope: IsometricTileArtworkEnvelope = { left: 0, top: 0, right: cell.width, bottom: cell.height };
  for (const artwork of artworkSizes) for (const diagonal of [false, true]) {
    const placement = isometricTileArtworkPlacement(cell, mapTileWidth, mapTileHeight, artwork, { diagonal }, artwork.offset);
    envelope.left = Math.min(envelope.left, placement.bounds.left);
    envelope.top = Math.min(envelope.top, placement.bounds.top);
    envelope.right = Math.max(envelope.right, placement.bounds.right);
    envelope.bottom = Math.max(envelope.bottom, placement.bounds.bottom);
  }
  return envelope;
}

/**
 * Includes the nominal cell fallback plus every renderable sprite-backed
 * tileset attached to the map. Missing/non-sprite sources retain the nominal,
 * unoffset fallback and do not gain native-artwork drawing authority.
 */
export function isometricMapTileArtworkEnvelope(
  document: PixelDocument,
  map: PixelTilemap,
): IsometricTileArtworkEnvelope {
  const artworkSizes: IsometricTileArtworkSize[] = [];
  for (const id of map.tilesetIds) {
    const asset = document.pixelAssets[id];
    const source = asset?.type === 'tileset' ? document.pixelAssets[asset.spriteAssetId] : undefined;
    if (asset?.type === 'tileset' && source?.type === 'sprite') artworkSizes.push({ width: asset.tileWidth, height: asset.tileHeight, offset: asset.tileOffset });
  }
  return isometricTileArtworkEnvelope(map.tileWidth, map.tileHeight, artworkSizes);
}
