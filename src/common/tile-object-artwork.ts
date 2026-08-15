import {
  decodeTiledGid,
  tiledTileTransformMatrix,
  type PixelTilemap,
  type PixelTileset,
  type TileMapObject,
  type TileObjectAlignment,
} from '@aidraw/core';

import type { MapObjectAffineMatrix, MapObjectRasterRegion } from './map-object-render';

export interface TileObjectArtworkPoint {
  x: number;
  y: number;
}

export interface TileObjectArtworkPlacement {
  anchor: TileObjectArtworkPoint;
  center: TileObjectArtworkPoint;
  width: number;
  height: number;
  transform: Pick<MapObjectAffineMatrix, 'a' | 'b' | 'c' | 'd'>;
  bounds: MapObjectRasterRegion;
  corners: readonly [TileObjectArtworkPoint, TileObjectArtworkPoint, TileObjectArtworkPoint, TileObjectArtworkPoint];
  resizeHandle: TileObjectArtworkPoint;
  alignment: Exclude<TileObjectAlignment, 'unspecified'>;
}

/** One bounded, renderer-neutral fallback for unresolved or non-sprite tile objects. */
export function tileObjectFallbackColor(gid: number): string {
  if (!Number.isInteger(gid) || gid < 0 || gid > 0x0fff_ffff) throw new RangeError('Tile-object fallback GID must be an unsigned 28-bit base GID.');
  return `hsl(${gid * 47 % 360} 55% 60%)`;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive and finite.`);
  return value;
}

function finite(values: readonly number[], label: string): void {
  if (!values.every(Number.isFinite)) throw new RangeError(`${label} must be finite.`);
}

export function effectiveTileObjectAlignment(
  alignment: TileObjectAlignment | undefined,
  orientation: PixelTilemap['orientation'],
): Exclude<TileObjectAlignment, 'unspecified'> {
  if (!alignment || alignment === 'unspecified') return orientation === 'isometric' ? 'bottom' : 'bottomleft';
  return alignment;
}

function alignmentFactors(alignment: Exclude<TileObjectAlignment, 'unspecified'>): { x: number; y: number } {
  const x = alignment.endsWith('left') || alignment === 'left' ? 0
    : alignment.endsWith('right') || alignment === 'right' ? 1 : 0.5;
  const y = alignment.startsWith('top') || alignment === 'top' ? 0
    : alignment.startsWith('bottom') || alignment === 'bottom' ? 1 : 0.5;
  return { x, y };
}

function transformedPoint(
  center: TileObjectArtworkPoint,
  transform: Pick<MapObjectAffineMatrix, 'a' | 'b' | 'c' | 'd'>,
  x: number,
  y: number,
): TileObjectArtworkPoint {
  return { x: center.x + transform.a * x + transform.c * y, y: center.y + transform.b * x + transform.d * y };
}

/**
 * Projects one canonical Tiled tile object into the object layer's raster
 * plane. Object alignment and rotation use the object's (x,y) anchor. Tiled's
 * drawing offset scales with the explicit object size, diagonal raw-GID state
 * applies its rectangular compensation, and clockwise object rotation carries
 * that complete placement around the anchor.
 */
export function tileObjectArtworkPlacement(
  object: TileMapObject,
  orientation: PixelTilemap['orientation'],
  objectMatrix: MapObjectAffineMatrix,
  pixelScale: number,
  tileset?: Pick<PixelTileset, 'objectAlignment' | 'tileOffset' | 'tileWidth' | 'tileHeight'>,
): TileObjectArtworkPlacement {
  finite([object.x, object.y, object.width, object.height, object.rotation], 'Tile-object geometry');
  finite([objectMatrix.a, objectMatrix.b, objectMatrix.c, objectMatrix.d, objectMatrix.e, objectMatrix.f], 'Tile-object projection');
  const scale = positive(pixelScale, 'Tile-object pixel scale');
  const width = positive(object.width * scale, 'Tile-object width');
  const height = positive(object.height * scale, 'Tile-object height');
  const alignment = effectiveTileObjectAlignment(tileset?.objectAlignment, orientation);
  const factors = alignmentFactors(alignment);
  const anchor = {
    x: objectMatrix.a * object.x + objectMatrix.c * object.y + objectMatrix.e,
    y: objectMatrix.b * object.x + objectMatrix.d * object.y + objectMatrix.f,
  };
  const radians = object.rotation * Math.PI / 180;
  const cosine = Math.cos(radians); const sine = Math.sin(radians);
  const decoded = decodeTiledGid(object.gid);
  const tiled = tiledTileTransformMatrix(decoded);
  const transform = {
    a: cosine * tiled.a - sine * tiled.b,
    b: sine * tiled.a + cosine * tiled.b,
    c: cosine * tiled.c - sine * tiled.d,
    d: sine * tiled.c + cosine * tiled.d,
  };
  const offset = tileset ? {
    x: tileset.tileOffset.x * width / positive(tileset.tileWidth, 'Tile-object source width'),
    y: tileset.tileOffset.y * height / positive(tileset.tileHeight, 'Tile-object source height'),
  } : { x: 0, y: 0 };
  const diagonalCompensation = decoded.diagonal ? (height - width) / 2 : 0;
  const localCenter = {
    x: (0.5 - factors.x) * width + offset.x + diagonalCompensation,
    y: (0.5 - factors.y) * height + offset.y + diagonalCompensation,
  };
  const center = {
    x: anchor.x + cosine * localCenter.x - sine * localCenter.y,
    y: anchor.y + sine * localCenter.x + cosine * localCenter.y,
  };
  const halfWidth = width / 2; const halfHeight = height / 2;
  const corners = [
    transformedPoint(center, transform, -halfWidth, -halfHeight),
    transformedPoint(center, transform, halfWidth, -halfHeight),
    transformedPoint(center, transform, halfWidth, halfHeight),
    transformedPoint(center, transform, -halfWidth, halfHeight),
  ] as const;
  const xs = corners.map((point) => point.x); const ys = corners.map((point) => point.y);
  const left = Math.min(...xs); const top = Math.min(...ys); const right = Math.max(...xs); const bottom = Math.max(...ys);
  return {
    anchor,
    center,
    width,
    height,
    transform,
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    corners,
    resizeHandle: corners[2],
    alignment,
  };
}

export function tileObjectArtworkIntersects(
  placement: TileObjectArtworkPlacement,
  region: MapObjectRasterRegion,
  padding = 0,
): boolean {
  finite([region.x, region.y, region.width, region.height, padding], 'Tile-object raster region');
  if (region.width <= 0 || region.height <= 0 || padding < 0) throw new RangeError('Tile-object raster region dimensions must be positive and padding must be nonnegative.');
  const { bounds } = placement;
  return bounds.x + bounds.width + padding > region.x && bounds.y + bounds.height + padding > region.y
    && bounds.x - padding < region.x + region.width && bounds.y - padding < region.y + region.height;
}

export function tileObjectArtworkContainsPoint(
  placement: TileObjectArtworkPlacement,
  point: TileObjectArtworkPoint,
  tolerance = 0,
): boolean {
  finite([point.x, point.y, tolerance], 'Tile-object hit-test point');
  if (tolerance < 0) throw new RangeError('Tile-object hit-test tolerance cannot be negative.');
  const { a, b, c, d } = placement.transform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < Number.EPSILON) return false;
  const dx = point.x - placement.center.x; const dy = point.y - placement.center.y;
  const localX = (d * dx - c * dy) / determinant;
  const localY = (-b * dx + a * dy) / determinant;
  return Math.abs(localX) <= placement.width / 2 + tolerance
    && Math.abs(localY) <= placement.height / 2 + tolerance;
}
