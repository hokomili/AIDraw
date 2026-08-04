export interface PixelSelectionPoint { x: number; y: number }
export interface PixelSelectionChange extends PixelSelectionPoint { index: number }
export type PixelSelectionTransform = 'move' | 'flip-horizontal' | 'flip-vertical' | 'rotate-clockwise' | 'rotate-counterclockwise';

export interface PixelSelectionBounds { x: number; y: number; width: number; height: number }

export interface PixelSelectionTransformResult {
  changes: PixelSelectionChange[];
  selection: PixelSelectionPoint[];
  sourceBounds: PixelSelectionBounds;
  destinationBounds?: PixelSelectionBounds;
  dropped: number;
}

function unique(points: PixelSelectionPoint[]): PixelSelectionPoint[] {
  return [...new Map(points.filter((point) => Number.isInteger(point.x) && Number.isInteger(point.y)).map((point) => [`${point.x},${point.y}`, { x: point.x, y: point.y }])).values()];
}

export function pixelSelectionBounds(points: PixelSelectionPoint[]): PixelSelectionBounds | undefined {
  const clean = unique(points); if (!clean.length) return undefined;
  const xs = clean.map((point) => point.x); const ys = clean.map((point) => point.y); const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1 };
}

export function transformPixelSelection(
  points: PixelSelectionPoint[],
  read: (x: number, y: number) => number,
  transform: PixelSelectionTransform,
  canvas: { width: number; height: number },
  offset: { x?: number; y?: number } = {},
): PixelSelectionTransformResult {
  const source = unique(points);
  const sourceBounds = pixelSelectionBounds(source);
  if (!sourceBounds) throw new Error('A pixel transform requires a non-empty selection.');
  if (source.length > 1_000_000) throw new Error('Pixel selection transforms are limited to one million cells.');
  const deltaX = Math.round(offset.x ?? 0); const deltaY = Math.round(offset.y ?? 0);
  const mapPoint = (entry: PixelSelectionPoint): PixelSelectionPoint => {
    const localX = entry.x - sourceBounds.x; const localY = entry.y - sourceBounds.y;
    if (transform === 'move') return { x: entry.x + deltaX, y: entry.y + deltaY };
    if (transform === 'flip-horizontal') return { x: sourceBounds.x + sourceBounds.width - 1 - localX, y: entry.y };
    if (transform === 'flip-vertical') return { x: entry.x, y: sourceBounds.y + sourceBounds.height - 1 - localY };
    if (transform === 'rotate-clockwise') return { x: sourceBounds.x + sourceBounds.height - 1 - localY, y: sourceBounds.y + localX };
    return { x: sourceBounds.x + localY, y: sourceBounds.y + sourceBounds.width - 1 - localX };
  };
  const captured = source.map((entry) => ({ ...entry, index: Math.max(0, Math.min(255, Math.round(read(entry.x, entry.y)))) }));
  const changes = new Map<string, PixelSelectionChange>();
  for (const entry of source) changes.set(`${entry.x},${entry.y}`, { ...entry, index: 0 });
  const selection: PixelSelectionPoint[] = []; let dropped = 0;
  for (const entry of captured) {
    const destination = mapPoint(entry);
    if (destination.x < 0 || destination.y < 0 || destination.x >= canvas.width || destination.y >= canvas.height) { dropped += 1; continue; }
    selection.push(destination); changes.set(`${destination.x},${destination.y}`, { ...destination, index: entry.index });
  }
  return { changes: [...changes.values()], selection: unique(selection), sourceBounds, destinationBounds: pixelSelectionBounds(selection), dropped };
}
