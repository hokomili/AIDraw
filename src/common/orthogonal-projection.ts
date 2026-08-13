export interface OrthogonalExtent {
  width: number;
  height: number;
}

export interface OrthogonalCellRect extends OrthogonalExtent {
  x: number;
  y: number;
}

export interface OrthogonalCoordinate {
  x: number;
  y: number;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

/** Returns the exact bounds of a finite orthogonal grid. */
export function orthogonalProjectionExtent(
  columns: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
): OrthogonalExtent {
  const width = positive(cellWidth, 'Orthogonal cell width');
  const height = positive(cellHeight, 'Orthogonal cell height');
  if (!Number.isFinite(columns) || columns < 0 || !Number.isFinite(rows) || rows < 0) {
    throw new Error('Orthogonal map dimensions must be finite nonnegative numbers.');
  }
  return { width: columns * width, height: rows * height };
}

/** Returns the projected bounding rectangle for one orthogonal map cell. */
export function orthogonalCellRect(
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
): OrthogonalCellRect {
  const width = positive(cellWidth, 'Orthogonal cell width');
  const height = positive(cellHeight, 'Orthogonal cell height');
  return { x: x * width, y: y * height, width, height };
}

/** Inverts a point in the orthogonal editor plane into continuous cell coordinates. */
export function orthogonalCoordinateFromScreen(
  screenX: number,
  screenY: number,
  cellWidth: number,
  cellHeight: number,
): OrthogonalCoordinate {
  const width = positive(cellWidth, 'Orthogonal cell width');
  const height = positive(cellHeight, 'Orthogonal cell height');
  return { x: screenX / width, y: screenY / height };
}

/** Converts a screen delta into a continuous orthogonal cell delta. */
export function orthogonalCoordinateDeltaFromScreen(
  screenX: number,
  screenY: number,
  cellWidth: number,
  cellHeight: number,
): OrthogonalCoordinate {
  return orthogonalCoordinateFromScreen(screenX, screenY, cellWidth, cellHeight);
}

/** Maps canonical map-object pixels into the orthogonal editor plane. */
export function orthogonalObjectMatrix(
  mapTileWidth: number,
  mapTileHeight: number,
  cellWidth: number,
  cellHeight: number,
): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const tileWidth = positive(mapTileWidth, 'Map tile width');
  const tileHeight = positive(mapTileHeight, 'Map tile height');
  const width = positive(cellWidth, 'Orthogonal cell width');
  const height = positive(cellHeight, 'Orthogonal cell height');
  return { a: width / tileWidth, b: 0, c: 0, d: height / tileHeight, e: 0, f: 0 };
}
