import type { PixelCel } from './model';
import { PIXEL_CHUNK_SIZE, chunkCoordinate, chunkKey, decodePixelChunk } from './pixel';

export const MAX_PIXEL_TOOL_CELLS = 1_000_000;
export const MAX_PIXEL_TOOL_RUNS = 65_536;

export interface PixelToolPoint {
  x: number;
  y: number;
}

export interface PixelCellRun {
  x: number;
  y: number;
  length: number;
}

export type PixelRegionResult =
  | { ok: true; runs: PixelCellRun[]; cellCount: number }
  | { ok: false; reason: 'cells' | 'runs'; limit: number };

interface PixelToolLimits {
  maxCells?: number;
  maxRuns?: number;
}

interface FloodPixelRegionOptions extends PixelToolLimits {
  width: number;
  height: number;
  start: PixelToolPoint;
  read: (x: number, y: number) => number;
}

interface ReplacePixelRegionOptions extends PixelToolLimits {
  width: number;
  height: number;
  region?: { x: number; y: number; width: number; height: number };
  matchIndex: number;
  read: (x: number, y: number) => number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer.`);
  return value;
}

function limits(options: PixelToolLimits): { maxCells: number; maxRuns: number } {
  return {
    maxCells: positiveInteger(options.maxCells ?? MAX_PIXEL_TOOL_CELLS, 'maxCells'),
    maxRuns: positiveInteger(options.maxRuns ?? MAX_PIXEL_TOOL_RUNS, 'maxRuns'),
  };
}

/**
 * Returns a cached reader with the same malformed-chunk fallback as readPixel.
 * A source chunk is decoded at most once for the lifetime of the returned reader.
 */
export function createPixelCelReader(cel: PixelCel): (x: number, y: number) => number {
  const decoded = new Map<string, Uint8Array | undefined>();
  return (x, y) => {
    const chunkX = chunkCoordinate(x);
    const chunkY = chunkCoordinate(y);
    const key = chunkKey(chunkX, chunkY);
    if (!decoded.has(key)) {
      const chunk = cel.chunks?.[key];
      if (!chunk) decoded.set(key, undefined);
      else {
        try {
          decoded.set(key, decodePixelChunk(chunk));
        } catch {
          decoded.set(key, undefined);
        }
      }
    }
    const values = decoded.get(key);
    if (!values) return 0;
    const localX = ((x % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
    const localY = ((y % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
    return values[localY * PIXEL_CHUNK_SIZE + localX] ?? 0;
  };
}

/**
 * Finds one four-connected indexed region as compact row runs. The cell budget
 * applies to the connected result rather than the containing canvas, and an
 * overflow never returns a partial region.
 */
export function floodPixelRegion(options: FloodPixelRegionOptions): PixelRegionResult {
  const width = positiveInteger(options.width, 'width');
  const height = positiveInteger(options.height, 'height');
  const startX = nonnegativeInteger(options.start.x, 'start.x');
  const startY = nonnegativeInteger(options.start.y, 'start.y');
  if (startX >= width || startY >= height) throw new Error('Flood-fill seed is outside the pixel region.');
  const { maxCells, maxRuns } = limits(options);
  const totalCells = width * height;
  if (!Number.isSafeInteger(totalCells)) throw new Error('Pixel dimensions exceed safe integer accounting.');

  const target = options.read(startX, startY);
  const visited = new Uint8Array(Math.ceil(totalCells / 8));
  const isVisited = (cell: number) => Boolean(visited[cell >>> 3] & (1 << (cell & 7)));
  const markVisited = (cell: number) => { visited[cell >>> 3] |= 1 << (cell & 7); };
  const pending = [startY * width + startX];
  const runs: PixelCellRun[] = [];
  let cellCount = 0;

  while (pending.length) {
    const cell = pending.pop()!;
    if (isVisited(cell)) continue;
    const y = Math.floor(cell / width);
    const seedX = cell - y * width;
    if (options.read(seedX, y) !== target) continue;

    let left = seedX;
    while (left > 0) {
      const candidate = y * width + left - 1;
      if (isVisited(candidate) || options.read(left - 1, y) !== target) break;
      left -= 1;
    }
    let right = seedX;
    while (right + 1 < width) {
      const candidate = y * width + right + 1;
      if (isVisited(candidate) || options.read(right + 1, y) !== target) break;
      right += 1;
    }

    const length = right - left + 1;
    if (cellCount + length > maxCells) return { ok: false, reason: 'cells', limit: maxCells };
    if (runs.length >= maxRuns) return { ok: false, reason: 'runs', limit: maxRuns };
    runs.push({ x: left, y, length });
    cellCount += length;
    for (let x = left; x <= right; x += 1) markVisited(y * width + x);

    for (const nextY of [y - 1, y + 1]) {
      if (nextY < 0 || nextY >= height) continue;
      let x = left;
      while (x <= right) {
        while (x <= right && (isVisited(nextY * width + x) || options.read(x, nextY) !== target)) x += 1;
        if (x > right) break;
        pending.push(nextY * width + x);
        x += 1;
        while (x <= right && !isVisited(nextY * width + x) && options.read(x, nextY) === target) x += 1;
      }
    }
  }

  runs.sort((leftRun, rightRun) => leftRun.y - rightRun.y || leftRun.x - rightRun.x);
  return { ok: true, runs, cellCount };
}

/** Finds all matching cells in a bounded rectangle as compact row runs. */
export function replacePixelRegion(options: ReplacePixelRegionOptions): PixelRegionResult {
  const width = positiveInteger(options.width, 'width');
  const height = positiveInteger(options.height, 'height');
  const region = options.region ?? { x: 0, y: 0, width, height };
  const x = nonnegativeInteger(region.x, 'region.x');
  const y = nonnegativeInteger(region.y, 'region.y');
  const regionWidth = positiveInteger(region.width, 'region.width');
  const regionHeight = positiveInteger(region.height, 'region.height');
  if (x + regionWidth > width || y + regionHeight > height) throw new Error('Replacement region must fit completely inside the pixel canvas.');
  const { maxCells, maxRuns } = limits(options);
  const targetCells = regionWidth * regionHeight;
  if (!Number.isSafeInteger(targetCells) || targetCells > maxCells) return { ok: false, reason: 'cells', limit: maxCells };

  const runs: PixelCellRun[] = [];
  let cellCount = 0;
  for (let row = y; row < y + regionHeight; row += 1) {
    let runStart: number | undefined;
    const flush = (end: number) => {
      if (runStart === undefined) return true;
      if (runs.length >= maxRuns) return false;
      const length = end - runStart;
      runs.push({ x: runStart, y: row, length });
      cellCount += length;
      runStart = undefined;
      return true;
    };
    for (let column = x; column < x + regionWidth; column += 1) {
      if (options.read(column, row) === options.matchIndex) runStart ??= column;
      else if (!flush(column)) return { ok: false, reason: 'runs', limit: maxRuns };
    }
    if (!flush(x + regionWidth)) return { ok: false, reason: 'runs', limit: maxRuns };
  }
  return { ok: true, runs, cellCount };
}

/** Removes doubled orthogonal corners without discarding later revisits. */
export function pixelPerfectStrokePoints(points: readonly PixelToolPoint[]): PixelToolPoint[] {
  const ordered: PixelToolPoint[] = [];
  for (const point of points) {
    const previous = ordered.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y) ordered.push({ x: point.x, y: point.y });
  }
  if (ordered.length < 3) return ordered;
  const result = [ordered[0]];
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const before = result.at(-1)!;
    const point = ordered[index];
    const after = ordered[index + 1];
    const beforeStep = Math.abs(before.x - point.x) + Math.abs(before.y - point.y);
    const afterStep = Math.abs(after.x - point.x) + Math.abs(after.y - point.y);
    const doubledCorner = beforeStep === 1 && afterStep === 1
      && Math.abs(before.x - after.x) === 1 && Math.abs(before.y - after.y) === 1;
    if (!doubledCorner) result.push(point);
  }
  result.push(ordered.at(-1)!);
  return result;
}

/** Returns a symmetric integer outline inside the inclusive endpoint box. */
export function ellipsePixels(x0: number, y0: number, x1: number, y1: number): PixelToolPoint[] {
  const left = Math.min(Math.round(x0), Math.round(x1));
  const right = Math.max(Math.round(x0), Math.round(x1));
  const top = Math.min(Math.round(y0), Math.round(y1));
  const bottom = Math.max(Math.round(y0), Math.round(y1));
  if (left === right && top === bottom) return [{ x: left, y: top }];
  if (left === right) return Array.from({ length: bottom - top + 1 }, (_, offset) => ({ x: left, y: top + offset }));
  if (top === bottom) return Array.from({ length: right - left + 1 }, (_, offset) => ({ x: left + offset, y: top }));

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = (right - left) / 2;
  const radiusY = (bottom - top) / 2;
  const points = new Map<string, PixelToolPoint>();
  const add = (x: number, y: number) => points.set(`${x},${y}`, { x, y });

  for (let x = left; x <= right; x += 1) {
    const normalized = (x - centerX) / radiusX;
    const offset = Math.round(radiusY * Math.sqrt(Math.max(0, 1 - normalized * normalized)));
    const upper = Math.round(centerY - offset);
    add(x, upper);
    add(x, top + bottom - upper);
  }
  for (let y = top; y <= bottom; y += 1) {
    const normalized = (y - centerY) / radiusY;
    const offset = Math.round(radiusX * Math.sqrt(Math.max(0, 1 - normalized * normalized)));
    const leftmost = Math.round(centerX - offset);
    add(leftmost, y);
    add(left + right - leftmost, y);
  }
  return [...points.values()];
}
