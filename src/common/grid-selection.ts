import type { PixelSelectionPoint, PixelSelectionTransform } from './pixel-selection';
import type { SelectionCombination } from './lasso';

export interface GridSelectionChange<T> extends PixelSelectionPoint { value: T }
export interface GridSelectionClipboard<T> {
  version: 1;
  originX: number;
  originY: number;
  width: number;
  height: number;
  cells: Array<GridSelectionChange<T>>;
}

export const MAX_GRID_LASSO_VERTICES = 4_096;
export const MAX_GRID_LASSO_CANDIDATE_CELLS = 1_000_000;
export const MAX_GRID_LASSO_BOUNDARY_STEPS = 4_000_000;

export interface GridLassoDraft {
  points: PixelSelectionPoint[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  openBoundarySteps: number;
}

function uniquePoints(points: PixelSelectionPoint[]): PixelSelectionPoint[] {
  return [...new Map(points.filter((point) => Number.isInteger(point.x) && Number.isInteger(point.y)).map((point) => [point.x + ',' + point.y, { x: point.x, y: point.y }])).values()];
}

function assertSafeGridLassoPoint(point: PixelSelectionPoint): void {
  if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) throw new RangeError('Grid lasso points must use safe-integer coordinates.');
}

function gridLassoEdgeSteps(from: PixelSelectionPoint, to: PixelSelectionPoint): number {
  const width = Math.abs(to.x - from.x); const height = Math.abs(to.y - from.y);
  const steps = Math.max(width, height) + 1;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(steps)) {
    throw new Error('Grid lasso points span an unsafe coordinate range.');
  }
  return steps;
}

function assertGridLassoEnvelope(draft: GridLassoDraft): void {
  if (draft.points.length < 3) return;
  const width = draft.maxX - draft.minX + 1; const height = draft.maxY - draft.minY + 1;
  if (![width, height].every(Number.isSafeInteger) || width < 1 || height < 1
    || width > MAX_GRID_LASSO_CANDIDATE_CELLS || height > Math.floor(MAX_GRID_LASSO_CANDIDATE_CELLS / width)) {
    throw new Error('Grid lassos are limited to one million candidate cells.');
  }
  const closingSteps = gridLassoEdgeSteps(draft.points.at(-1)!, draft.points[0]);
  if (!Number.isSafeInteger(draft.openBoundarySteps)
    || draft.openBoundarySteps > MAX_GRID_LASSO_BOUNDARY_STEPS - closingSteps) {
    throw new Error('Grid lassos are limited to four million boundary steps.');
  }
}

export function createGridLassoDraft(point: PixelSelectionPoint): GridLassoDraft {
  assertSafeGridLassoPoint(point);
  return { points: [{ ...point }], minX: point.x, maxX: point.x, minY: point.y, maxY: point.y, openBoundarySteps: 0 };
}

/**
 * Appends one sampled point and validates its work envelope incrementally.
 * Only a same-direction collinear middle point is removed. Returning
 * undefined is the exact vertex ceiling, never approximate decimation.
 */
export function appendGridLassoPoint(draft: GridLassoDraft, point: PixelSelectionPoint): GridLassoDraft | undefined {
  assertSafeGridLassoPoint(point);
  const path = draft.points;
  if (path.length > MAX_GRID_LASSO_VERTICES) return undefined;
  const last = path.at(-1)!;
  if (last.x === point.x && last.y === point.y) return { ...draft, points: path.slice() };
  let points: PixelSelectionPoint[];
  let openBoundarySteps: number;
  if (path.length >= 2) {
    const before = path[path.length - 2];
    const firstX = last!.x - before.x; const firstY = last!.y - before.y;
    const secondX = point.x - last!.x; const secondY = point.y - last!.y;
    const cross = firstX * secondY - firstY * secondX;
    const dot = firstX * secondX + firstY * secondY;
    if (Number.isSafeInteger(cross) && Number.isSafeInteger(dot) && cross === 0 && dot > 0) {
      points = [...path.slice(0, -1), { ...point }];
      openBoundarySteps = draft.openBoundarySteps - gridLassoEdgeSteps(before, last) + gridLassoEdgeSteps(before, point);
    } else {
      if (path.length >= MAX_GRID_LASSO_VERTICES) return undefined;
      points = [...path, { ...point }];
      openBoundarySteps = draft.openBoundarySteps + gridLassoEdgeSteps(last, point);
    }
  } else {
    points = [...path, { ...point }];
    openBoundarySteps = gridLassoEdgeSteps(last, point);
  }
  const next = {
    points,
    minX: Math.min(draft.minX, point.x),
    maxX: Math.max(draft.maxX, point.x),
    minY: Math.min(draft.minY, point.y),
    maxY: Math.max(draft.maxY, point.y),
    openBoundarySteps,
  };
  assertGridLassoEnvelope(next);
  return next;
}

export function combineGridSelection(current: PixelSelectionPoint[], incoming: PixelSelectionPoint[], mode: SelectionCombination): PixelSelectionPoint[] {
  const selected = new Map(uniquePoints(current).map((point) => [point.x + ',' + point.y, point]));
  const next = new Map(uniquePoints(incoming).map((point) => [point.x + ',' + point.y, point]));
  if (mode === 'replace') return [...next.values()];
  if (mode === 'add') { for (const [key, point] of next) selected.set(key, point); return [...selected.values()]; }
  if (mode === 'subtract') { for (const key of next.keys()) selected.delete(key); return [...selected.values()]; }
  return [...selected].filter(([key]) => next.has(key)).map(([, point]) => point);
}

function validatedGridLasso(path: PixelSelectionPoint[]): {
  polygon: PixelSelectionPoint[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
} {
  if (path.length > MAX_GRID_LASSO_VERTICES) throw new Error(`Grid lassos are limited to ${MAX_GRID_LASSO_VERTICES.toLocaleString('en-US')} path vertices.`);
  if (path.some((point) => !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y))) throw new Error('Grid lasso points must use safe-integer coordinates.');
  const polygon = uniquePoints(path);
  if (polygon.length < 3) return { polygon, minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
  let minX = polygon[0].x; let maxX = polygon[0].x; let minY = polygon[0].y; let maxY = polygon[0].y;
  for (const point of polygon.slice(1)) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  const width = maxX - minX + 1; const height = maxY - minY + 1;
  if (![width, height].every(Number.isSafeInteger) || width < 1 || height < 1
    || width > MAX_GRID_LASSO_CANDIDATE_CELLS || height > Math.floor(MAX_GRID_LASSO_CANDIDATE_CELLS / width)) {
    throw new Error('Grid lassos are limited to one million candidate cells.');
  }
  let boundarySteps = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index]; const to = polygon[(index + 1) % polygon.length];
    boundarySteps += Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) + 1;
    if (!Number.isSafeInteger(boundarySteps) || boundarySteps > MAX_GRID_LASSO_BOUNDARY_STEPS) {
      throw new Error('Grid lassos are limited to four million boundary steps.');
    }
  }
  return { polygon, minX, maxX, minY, maxY, width, height };
}

export function rasterizeGridLasso(path: PixelSelectionPoint[]): PixelSelectionPoint[] {
  const { polygon, minX, maxX, minY, maxY, width, height } = validatedGridLasso(path);
  if (polygon.length < 3) return polygon;
  const boundary = new Map<string, PixelSelectionPoint>();
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index]; const to = polygon[(index + 1) % polygon.length];
    let x = from.x; let y = from.y; const dx = Math.abs(to.x - from.x); const dy = -Math.abs(to.y - from.y); const sx = from.x < to.x ? 1 : -1; const sy = from.y < to.y ? 1 : -1; let error = dx + dy;
    for (;;) { boundary.set(x + ',' + y, { x, y }); if (x === to.x && y === to.y) break; const doubled = 2 * error; if (doubled >= dy) { error += dy; x += sx; } if (doubled <= dx) { error += dx; y += sy; } }
  }
  const selected = new Map(boundary);
  // Scan along the shorter axis. This preserves even-odd point membership
  // while bounding edge checks by vertices × min(width, height), at most
  // about four million under the independent area and vertex ceilings.
  if (height <= width) {
    for (let y = minY; y <= maxY; y += 1) {
      const crossings: number[] = [];
      for (let index = 0; index < polygon.length; index += 1) {
        const from = polygon[index]; const to = polygon[(index + 1) % polygon.length];
        if ((from.y > y) !== (to.y > y)) crossings.push(from.x + (to.x - from.x) * (y - from.y) / (to.y - from.y));
      }
      crossings.sort((left, right) => left - right);
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        const start = Math.max(minX, Math.ceil(crossings[index]));
        const end = Math.min(maxX, Math.ceil(crossings[index + 1]) - 1);
        for (let x = start; x <= end; x += 1) selected.set(x + ',' + y, { x, y });
      }
    }
  } else {
    for (let x = minX; x <= maxX; x += 1) {
      const crossings: number[] = [];
      for (let index = 0; index < polygon.length; index += 1) {
        const from = polygon[index]; const to = polygon[(index + 1) % polygon.length];
        if ((from.x > x) !== (to.x > x)) crossings.push(from.y + (to.y - from.y) * (x - from.x) / (to.x - from.x));
      }
      crossings.sort((top, bottom) => top - bottom);
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        const start = Math.max(minY, Math.ceil(crossings[index]));
        const end = Math.min(maxY, Math.ceil(crossings[index + 1]) - 1);
        for (let y = start; y <= end; y += 1) selected.set(x + ',' + y, { x, y });
      }
    }
  }
  return [...selected.values()];
}

export function captureGridSelection<T>(points: PixelSelectionPoint[], read: (x: number, y: number) => T): GridSelectionClipboard<T> {
  const source = uniquePoints(points);
  if (!source.length) throw new Error('Copy requires a non-empty grid selection.');
  if (source.length > 1_000_000) throw new Error('Grid clipboards are limited to one million cells.');
  let originX = source[0].x; let originY = source[0].y; let right = source[0].x; let bottom = source[0].y;
  for (const point of source.slice(1)) {
    originX = Math.min(originX, point.x); originY = Math.min(originY, point.y);
    right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  return { version: 1, originX, originY, width: right - originX + 1, height: bottom - originY + 1, cells: source.map((point) => ({ x: point.x - originX, y: point.y - originY, value: read(point.x, point.y) })) };
}

export function placeGridClipboard<T>(clipboard: GridSelectionClipboard<T>, origin: PixelSelectionPoint, bounds?: { width: number; height: number }): { changes: Array<GridSelectionChange<T>>; selection: PixelSelectionPoint[]; dropped: number } {
  if (clipboard.version !== 1 || clipboard.cells.length > 1_000_000) throw new Error('Unsupported or oversized grid clipboard.');
  const changes: Array<GridSelectionChange<T>> = []; const selection: PixelSelectionPoint[] = []; let dropped = 0;
  for (const cell of clipboard.cells) {
    const point = { x: Math.round(origin.x) + cell.x, y: Math.round(origin.y) + cell.y };
    if (bounds && (point.x < 0 || point.y < 0 || point.x >= bounds.width || point.y >= bounds.height)) { dropped += 1; continue; }
    changes.push({ ...point, value: cell.value }); selection.push(point);
  }
  return { changes, selection: uniquePoints(selection), dropped };
}

export function scaleGridSelection<T>(points: PixelSelectionPoint[], read: (x: number, y: number) => T, scaleX: number, scaleY: number, bounds: { width: number; height: number } | undefined, empty: T): { changes: Array<GridSelectionChange<T>>; selection: PixelSelectionPoint[]; dropped: number } {
  const source = uniquePoints(points); const xFactor = Math.round(scaleX); const yFactor = Math.round(scaleY);
  if (!source.length) throw new Error('Scaling requires a non-empty grid selection.');
  if (xFactor < 1 || yFactor < 1 || xFactor > 64 || yFactor > 64) throw new Error('Integer scale factors must be from 1 through 64.');
  if (source.length * xFactor * yFactor > 1_000_000) throw new Error('Scaled selections are limited to one million cells.');
  const minX = Math.min(...source.map((point) => point.x)); const minY = Math.min(...source.map((point) => point.y));
  const changes = new Map<string, GridSelectionChange<T>>(); for (const point of source) changes.set(point.x + ',' + point.y, { ...point, value: empty });
  const selection: PixelSelectionPoint[] = []; let dropped = 0;
  for (const point of source) {
    const value = read(point.x, point.y); const baseX = minX + (point.x - minX) * xFactor; const baseY = minY + (point.y - minY) * yFactor;
    for (let y = 0; y < yFactor; y += 1) for (let x = 0; x < xFactor; x += 1) {
      const destination = { x: baseX + x, y: baseY + y };
      if (bounds && (destination.x < 0 || destination.y < 0 || destination.x >= bounds.width || destination.y >= bounds.height)) { dropped += 1; continue; }
      selection.push(destination); changes.set(destination.x + ',' + destination.y, { ...destination, value });
    }
  }
  return { changes: [...changes.values()], selection: uniquePoints(selection), dropped };
}

export function transformGridSelection<T>(
  points: PixelSelectionPoint[],
  read: (x: number, y: number) => T,
  transform: PixelSelectionTransform,
  bounds: { width: number; height: number } | undefined,
  offset: { x?: number; y?: number } = {},
  empty: T,
): { changes: Array<GridSelectionChange<T>>; selection: PixelSelectionPoint[]; dropped: number } {
  const source = uniquePoints(points);
  if (!source.length) throw new Error('A grid transform requires a non-empty selection.');
  if (source.length > 1_000_000) throw new Error('Grid selection transforms are limited to one million cells.');
  const minX = Math.min(...source.map((point) => point.x)); const minY = Math.min(...source.map((point) => point.y)); const maxX = Math.max(...source.map((point) => point.x)); const maxY = Math.max(...source.map((point) => point.y)); const width = maxX - minX + 1; const height = maxY - minY + 1;
  const deltaX = Math.round(offset.x ?? 0); const deltaY = Math.round(offset.y ?? 0);
  const mapPoint = (point: PixelSelectionPoint) => {
    const localX = point.x - minX; const localY = point.y - minY;
    if (transform === 'move') return { x: point.x + deltaX, y: point.y + deltaY };
    if (transform === 'flip-horizontal') return { x: minX + width - 1 - localX, y: point.y };
    if (transform === 'flip-vertical') return { x: point.x, y: minY + height - 1 - localY };
    if (transform === 'rotate-clockwise') return { x: minX + height - 1 - localY, y: minY + localX };
    return { x: minX + localY, y: minY + width - 1 - localX };
  };
  const changes = new Map<string, GridSelectionChange<T>>(); for (const point of source) changes.set(point.x + ',' + point.y, { ...point, value: empty });
  const selection: PixelSelectionPoint[] = []; let dropped = 0;
  for (const point of source) {
    const destination = mapPoint(point);
    if (bounds && (destination.x < 0 || destination.y < 0 || destination.x >= bounds.width || destination.y >= bounds.height)) { dropped += 1; continue; }
    selection.push(destination); changes.set(destination.x + ',' + destination.y, { ...destination, value: read(point.x, point.y) });
  }
  return { changes: [...changes.values()], selection: [...new Map(selection.map((point) => [point.x + ',' + point.y, point])).values()], dropped };
}
