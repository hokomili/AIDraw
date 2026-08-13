export interface IsometricExtent {
  width: number;
  height: number;
}

export interface IsometricCellRect extends IsometricExtent {
  x: number;
  y: number;
}

export interface IsometricCoordinate {
  x: number;
  y: number;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

/**
 * Returns the exact projected bounds for a finite right-down isometric grid.
 * AIDraw anchors the left edge with the final map row and uses half-cell steps
 * on both axes, matching the projection used by its Tiled interchange path.
 */
export function isometricProjectionExtent(
  columns: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
): IsometricExtent {
  const width = positive(cellWidth, 'Isometric cell width');
  const height = positive(cellHeight, 'Isometric cell height');
  if (!Number.isFinite(columns) || columns < 0 || !Number.isFinite(rows) || rows < 0) {
    throw new Error('Isometric map dimensions must be finite nonnegative numbers.');
  }
  return { width: (columns + rows) * width / 2, height: (columns + rows) * height / 2 };
}

/** Returns the projected bounding rectangle for one map cell. */
export function isometricCellRect(
  x: number,
  y: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
): IsometricCellRect {
  const width = positive(cellWidth, 'Isometric cell width');
  const height = positive(cellHeight, 'Isometric cell height');
  return {
    x: (x - y + rows - 1) * width / 2,
    y: (x + y) * height / 2,
    width,
    height,
  };
}

/**
 * Inverts a projected point. Integer coordinates identify cell top vertices;
 * adding half a cell in Y identifies that cell's interior center.
 */
export function isometricCoordinateFromScreen(
  screenX: number,
  screenY: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
): IsometricCoordinate {
  const width = positive(cellWidth, 'Isometric cell width');
  const height = positive(cellHeight, 'Isometric cell height');
  const difference = 2 * (screenX - rows * width / 2) / width;
  const sum = 2 * screenY / height;
  return { x: (difference + sum) / 2, y: (sum - difference) / 2 };
}

/** Converts a projected screen delta into a continuous map-cell delta. */
export function isometricCoordinateDeltaFromScreen(
  screenX: number,
  screenY: number,
  cellWidth: number,
  cellHeight: number,
): IsometricCoordinate {
  const width = positive(cellWidth, 'Isometric cell width');
  const height = positive(cellHeight, 'Isometric cell height');
  const difference = 2 * screenX / width;
  const sum = 2 * screenY / height;
  return { x: (difference + sum) / 2, y: (sum - difference) / 2 };
}

/** Maps Tiled-style object pixel coordinates into the projected editor plane. */
export function isometricObjectMatrix(
  rows: number,
  mapTileWidth: number,
  mapTileHeight: number,
  cellWidth: number,
  cellHeight: number,
): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const tileWidth = positive(mapTileWidth, 'Map tile width');
  const tileHeight = positive(mapTileHeight, 'Map tile height');
  const width = positive(cellWidth, 'Isometric cell width');
  const height = positive(cellHeight, 'Isometric cell height');
  return {
    a: width / (2 * tileWidth),
    b: height / (2 * tileWidth),
    c: -width / (2 * tileHeight),
    d: height / (2 * tileHeight),
    e: rows * width / 2,
    f: 0,
  };
}
