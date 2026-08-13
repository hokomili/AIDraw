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

export interface RasterViewportProjection {
  viewportWidth: number;
  viewportHeight: number;
  viewOffsetX: number;
  viewOffsetY: number;
  layerOffsetX: number;
  layerOffsetY: number;
  projectionScale: number;
}

export interface TilemapGridGeometry {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

export interface TilemapGridLineRange {
  columnStart: number;
  columnEnd: number;
  rowStart: number;
  rowEnd: number;
}

export interface GridRunOffsetRange {
  start: number;
  end: number;
}

export interface GridRasterRegionFilter {
  cellIntersects(x: number, y: number): boolean;
  runOffsets(x: number, y: number, length: number): GridRunOffsetRange;
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
 * Builds one validated, allocation-free filter for transient grid overlays.
 * Cell bounds are conservative for the isometric diamond. Horizontal runs are
 * clipped algebraically, avoiding expansion of compact million-cell replay or
 * fill records merely to discover that their pixels are outside the viewport.
 */
export function createGridRasterRegionFilter(
  geometry: TilemapProjectionGeometry,
  region: TilemapRasterRegion,
  paddingPixels = 0,
): GridRasterRegionFilter {
  positiveSafeInteger(geometry.rows, 'Grid row count');
  positiveSafeInteger(geometry.tileWidth, 'Grid cell width');
  positiveSafeInteger(geometry.tileHeight, 'Grid cell height');
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger)
    || region.width < 1 || region.height < 1) throw new RangeError('Grid raster region must use safe-integer coordinates and positive dimensions.');
  if (!Number.isSafeInteger(paddingPixels) || paddingPixels < 0) throw new RangeError('Grid raster padding must be a nonnegative safe integer.');
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  const left = region.x - paddingPixels;
  const top = region.y - paddingPixels;
  const expandedRight = right + paddingPixels;
  const expandedBottom = bottom + paddingPixels;
  if (![left, top, expandedRight, expandedBottom].every(Number.isSafeInteger)) throw new RangeError('Grid raster region exceeds safe coordinates after padding.');
  const expanded = { x: left, y: top, width: expandedRight - left, height: expandedBottom - top };
  const empty = (): GridRunOffsetRange => ({ start: 0, end: 0 });

  const cellIntersects = (x: number, y: number): boolean => {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return false;
    if (geometry.orientation === 'orthogonal') {
      const cellLeft = x * geometry.tileWidth;
      const cellTop = y * geometry.tileHeight;
      return [cellLeft, cellTop].every(Number.isFinite)
        && intersects(cellLeft, cellTop, cellLeft + geometry.tileWidth, cellTop + geometry.tileHeight, expanded);
    }
    const cellLeft = (x - y + geometry.rows - 1) * geometry.tileWidth / 2;
    const cellTop = (x + y) * geometry.tileHeight / 2;
    return [cellLeft, cellTop].every(Number.isFinite)
      && intersects(cellLeft, cellTop, cellLeft + geometry.tileWidth, cellTop + geometry.tileHeight, expanded);
  };

  const runOffsets = (x: number, y: number, length: number): GridRunOffsetRange => {
    if (![x, y, length].every(Number.isSafeInteger) || length < 1 || !Number.isSafeInteger(x + length)) return empty();
    let candidateStart: number;
    let candidateEnd: number;
    if (geometry.orientation === 'orthogonal') {
      const cellTop = y * geometry.tileHeight;
      if (!Number.isFinite(cellTop) || !intersects(expanded.x, cellTop, expanded.x + expanded.width, cellTop + geometry.tileHeight, expanded)) return empty();
      candidateStart = Math.floor(expanded.x / geometry.tileWidth) - 1;
      candidateEnd = Math.ceil((expanded.x + expanded.width) / geometry.tileWidth) + 1;
    } else {
      const lower = Math.max(
        2 * expanded.x / geometry.tileWidth + y - geometry.rows - 1,
        2 * expanded.y / geometry.tileHeight - y - 2,
      );
      const upper = Math.min(
        2 * (expanded.x + expanded.width) / geometry.tileWidth + y - geometry.rows + 1,
        2 * (expanded.y + expanded.height) / geometry.tileHeight - y,
      );
      if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) return empty();
      // One candidate of numerical slack on either side prevents floating-
      // point division at an exact projected edge from dropping a real cell.
      candidateStart = Math.floor(lower) - 1;
      candidateEnd = Math.ceil(upper) + 1;
    }
    const first = Math.max(x, candidateStart);
    const end = Math.min(x + length, candidateEnd);
    return end > first ? { start: first - x, end: end - x } : empty();
  };

  return { cellIntersects, runOffsets };
}

/**
 * Returns the smallest integer canonical-map raster region covering a CSS
 * viewport after the editor's uniform projection and per-layer translation.
 * Outward rounding keeps fractional wheel pan, layout, and parallax safe.
 */
export function coveringRasterViewportRegion(view: RasterViewportProjection): TilemapRasterRegion {
  const values = [view.viewportWidth, view.viewportHeight, view.viewOffsetX, view.viewOffsetY, view.layerOffsetX, view.layerOffsetY, view.projectionScale];
  if (!values.every(Number.isFinite) || view.viewportWidth <= 0 || view.viewportHeight <= 0 || view.projectionScale <= 0) {
    throw new RangeError('Tilemap viewport projection must use finite offsets and positive finite dimensions and scale.');
  }
  const left = (-view.viewOffsetX - view.layerOffsetX) / view.projectionScale;
  const top = (-view.viewOffsetY - view.layerOffsetY) / view.projectionScale;
  const right = (view.viewportWidth - view.viewOffsetX - view.layerOffsetX) / view.projectionScale;
  const bottom = (view.viewportHeight - view.viewOffsetY - view.layerOffsetY) / view.projectionScale;
  const x = Math.floor(left); const y = Math.floor(top); const maxX = Math.ceil(right); const maxY = Math.ceil(bottom);
  if (![x, y, maxX, maxY].every(Number.isSafeInteger)) throw new RangeError('Tilemap viewport projection exceeds safe canonical raster coordinates.');
  return { x, y, width: maxX - x, height: maxY - y };
}

/** Returns nominal orthogonal grid-line indexes covering a raster region. */
export function tilemapGridLineRange(region: TilemapRasterRegion, geometry: TilemapGridGeometry, overscanLines = 1): TilemapGridLineRange {
  for (const [value, label] of [[geometry.columns, 'Tilemap column count'], [geometry.rows, 'Tilemap row count'], [geometry.tileWidth, 'Tile width'], [geometry.tileHeight, 'Tile height']] as const) positiveSafeInteger(value, label);
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) || region.width < 1 || region.height < 1) throw new RangeError('Tilemap grid region must use safe-integer coordinates and positive dimensions.');
  if (!Number.isSafeInteger(overscanLines) || overscanLines < 0) throw new RangeError('Tilemap grid overscan must be a nonnegative safe integer.');
  return {
    columnStart: Math.max(0, Math.floor(region.x / geometry.tileWidth) - overscanLines),
    columnEnd: Math.min(geometry.columns, Math.ceil((region.x + region.width) / geometry.tileWidth) + overscanLines),
    rowStart: Math.max(0, Math.floor(region.y / geometry.tileHeight) - overscanLines),
    rowEnd: Math.min(geometry.rows, Math.ceil((region.y + region.height) / geometry.tileHeight) + overscanLines),
  };
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
