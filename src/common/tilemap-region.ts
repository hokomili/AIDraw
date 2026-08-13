export interface TilemapRegionChunk {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TilemapRasterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TilemapProjectionGeometry {
  orientation: 'orthogonal' | 'isometric';
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
}

function intersects(
  left: number,
  top: number,
  right: number,
  bottom: number,
  region: TilemapRasterRegion,
): boolean {
  return right > region.x && bottom > region.y && left < region.x + region.width && top < region.y + region.height;
}

/**
 * Keeps only stored chunks whose projected cell envelope can reach a raster
 * region. The max-axis padding is conservative for every stored Tiled GID
 * transform, so filtering cannot hide a rotated rectangular cell. This scans
 * each chunk's geometry once; it is payload/cell pruning, not a spatial index.
 */
export function tilemapChunksIntersectingRegion<T extends TilemapRegionChunk>(
  chunks: readonly T[],
  geometry: TilemapProjectionGeometry,
  region: TilemapRasterRegion,
): T[] {
  positiveSafeInteger(geometry.rows, 'Tilemap row count');
  positiveSafeInteger(geometry.tileWidth, 'Tile width');
  positiveSafeInteger(geometry.tileHeight, 'Tile height');
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger)
    || region.width < 1 || region.height < 1) throw new RangeError('Tilemap raster region must use safe-integer coordinates and positive dimensions.');
  const padding = Math.max(geometry.tileWidth, geometry.tileHeight) / 2;
  return chunks.filter((chunk) => {
    if (![chunk.x, chunk.y, chunk.width, chunk.height].every(Number.isSafeInteger)
      || chunk.width < 1 || chunk.height < 1) throw new RangeError('Tilemap chunk geometry must use safe integers and positive dimensions.');
    const minX = chunk.x;
    const minY = chunk.y;
    const maxX = chunk.x + chunk.width - 1;
    const maxY = chunk.y + chunk.height - 1;
    if (geometry.orientation === 'orthogonal') {
      const left = (minX + 0.5) * geometry.tileWidth - padding;
      const right = (maxX + 0.5) * geometry.tileWidth + padding;
      const top = (minY + 0.5) * geometry.tileHeight - padding;
      const bottom = (maxY + 0.5) * geometry.tileHeight + padding;
      return intersects(left, top, right, bottom, region);
    }
    const left = (minX - maxY + geometry.rows) * geometry.tileWidth / 2 - padding;
    const right = (maxX - minY + geometry.rows) * geometry.tileWidth / 2 + padding;
    const top = (minX + minY + 1) * geometry.tileHeight / 2 - padding;
    const bottom = (maxX + maxY + 1) * geometry.tileHeight / 2 + padding;
    return intersects(left, top, right, bottom, region);
  });
}
