import type { PixelSelectionPoint, PixelSelectionTransform } from './pixel-selection';
import { pointInPolygon, type SelectionCombination } from './lasso';

export interface GridSelectionChange<T> extends PixelSelectionPoint { value: T }
export interface GridSelectionClipboard<T> {
  version: 1;
  originX: number;
  originY: number;
  width: number;
  height: number;
  cells: Array<GridSelectionChange<T>>;
}

function uniquePoints(points: PixelSelectionPoint[]): PixelSelectionPoint[] {
  return [...new Map(points.filter((point) => Number.isInteger(point.x) && Number.isInteger(point.y)).map((point) => [point.x + ',' + point.y, { x: point.x, y: point.y }])).values()];
}

export function combineGridSelection(current: PixelSelectionPoint[], incoming: PixelSelectionPoint[], mode: SelectionCombination): PixelSelectionPoint[] {
  const selected = new Map(uniquePoints(current).map((point) => [point.x + ',' + point.y, point]));
  const next = new Map(uniquePoints(incoming).map((point) => [point.x + ',' + point.y, point]));
  if (mode === 'replace') return [...next.values()];
  if (mode === 'add') { for (const [key, point] of next) selected.set(key, point); return [...selected.values()]; }
  if (mode === 'subtract') { for (const key of next.keys()) selected.delete(key); return [...selected.values()]; }
  return [...selected].filter(([key]) => next.has(key)).map(([, point]) => point);
}

export function rasterizeGridLasso(path: PixelSelectionPoint[]): PixelSelectionPoint[] {
  const polygon = uniquePoints(path);
  if (polygon.length < 3) return polygon;
  const minX = Math.min(...polygon.map((point) => point.x)); const maxX = Math.max(...polygon.map((point) => point.x));
  const minY = Math.min(...polygon.map((point) => point.y)); const maxY = Math.max(...polygon.map((point) => point.y));
  if ((maxX - minX + 1) * (maxY - minY + 1) > 1_000_000) throw new Error('Grid lassos are limited to one million candidate cells.');
  const boundary = new Map<string, PixelSelectionPoint>();
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index]; const to = polygon[(index + 1) % polygon.length];
    let x = from.x; let y = from.y; const dx = Math.abs(to.x - from.x); const dy = -Math.abs(to.y - from.y); const sx = from.x < to.x ? 1 : -1; const sy = from.y < to.y ? 1 : -1; let error = dx + dy;
    for (;;) { boundary.set(x + ',' + y, { x, y }); if (x === to.x && y === to.y) break; const doubled = 2 * error; if (doubled >= dy) { error += dy; x += sx; } if (doubled <= dx) { error += dx; y += sy; } }
  }
  const selected = new Map(boundary);
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) if (pointInPolygon({ x, y }, polygon)) selected.set(x + ',' + y, { x, y });
  return [...selected.values()];
}

export function captureGridSelection<T>(points: PixelSelectionPoint[], read: (x: number, y: number) => T): GridSelectionClipboard<T> {
  const source = uniquePoints(points);
  if (!source.length) throw new Error('Copy requires a non-empty grid selection.');
  if (source.length > 1_000_000) throw new Error('Grid clipboards are limited to one million cells.');
  const originX = Math.min(...source.map((point) => point.x)); const originY = Math.min(...source.map((point) => point.y));
  const right = Math.max(...source.map((point) => point.x)); const bottom = Math.max(...source.map((point) => point.y));
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
