import type { Id, PixelStamp, PixelStampCell } from './model';

export type PixelStampTransform = 'flip-horizontal' | 'flip-vertical' | 'rotate-clockwise' | 'rotate-counterclockwise';

function uniquePoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()];
}

export function capturePixelStamp(
  id: Id,
  name: string,
  points: Array<{ x: number; y: number }>,
  readIndex: (x: number, y: number) => number,
): PixelStamp {
  const unique = uniquePoints(points);
  if (!id || !name.trim()) throw new Error('Pixel stamps require an id and name.');
  if (!unique.length) throw new Error('Select at least one cell to capture a stamp.');
  if (unique.length > 65_536) throw new Error('Pixel stamps are limited to 65,536 cells.');
  const minX = Math.min(...unique.map((point) => point.x)); const minY = Math.min(...unique.map((point) => point.y));
  const maxX = Math.max(...unique.map((point) => point.x)); const maxY = Math.max(...unique.map((point) => point.y));
  const width = maxX - minX + 1; const height = maxY - minY + 1;
  const cells = unique.map((point) => ({ x: point.x - minX, y: point.y - minY, index: readIndex(point.x, point.y) }));
  return { id, name: name.trim(), width, height, anchorX: Math.floor(width / 2), anchorY: Math.floor(height / 2), cells };
}

export function transformPixelStamp(stamp: PixelStamp, transform: PixelStampTransform): PixelStamp {
  const rotated = transform === 'rotate-clockwise' || transform === 'rotate-counterclockwise';
  const width = rotated ? stamp.height : stamp.width; const height = rotated ? stamp.width : stamp.height;
  const map = (cell: PixelStampCell): PixelStampCell => {
    if (transform === 'flip-horizontal') return { ...cell, x: stamp.width - 1 - cell.x };
    if (transform === 'flip-vertical') return { ...cell, y: stamp.height - 1 - cell.y };
    if (transform === 'rotate-clockwise') return { ...cell, x: stamp.height - 1 - cell.y, y: cell.x };
    return { ...cell, x: cell.y, y: stamp.width - 1 - cell.x };
  };
  const anchor = map({ x: stamp.anchorX, y: stamp.anchorY, index: 0 });
  return { ...structuredClone(stamp), width, height, anchorX: anchor.x, anchorY: anchor.y, cells: stamp.cells.map(map) };
}

export function placePixelStamp(
  stamp: PixelStamp,
  x: number,
  y: number,
  bounds?: { width: number; height: number },
): { changes: PixelStampCell[]; dropped: number } {
  const changes = stamp.cells.map((cell) => ({ x: x - stamp.anchorX + cell.x, y: y - stamp.anchorY + cell.y, index: cell.index }));
  if (!bounds) return { changes, dropped: 0 };
  const retained = changes.filter((cell) => cell.x >= 0 && cell.y >= 0 && cell.x < bounds.width && cell.y < bounds.height);
  return { changes: retained, dropped: changes.length - retained.length };
}

export function validatePixelStamp(stamp: PixelStamp): void {
  if (!stamp.id || !stamp.name.trim()) throw new Error('Pixel stamps require an id and name.');
  if (!Number.isInteger(stamp.width) || !Number.isInteger(stamp.height) || stamp.width < 1 || stamp.height < 1 || stamp.width > 8_192 || stamp.height > 8_192) throw new Error('Pixel stamp dimensions must be 1–8,192.');
  if (!Number.isInteger(stamp.anchorX) || !Number.isInteger(stamp.anchorY) || stamp.anchorX < 0 || stamp.anchorY < 0 || stamp.anchorX >= stamp.width || stamp.anchorY >= stamp.height) throw new Error('Pixel stamp anchor is outside its bounds.');
  if (!stamp.cells.length || stamp.cells.length > 65_536) throw new Error('Pixel stamps must contain 1–65,536 cells.');
  const seen = new Set<string>();
  for (const cell of stamp.cells) {
    if (![cell.x, cell.y, cell.index].every(Number.isInteger) || cell.x < 0 || cell.y < 0 || cell.x >= stamp.width || cell.y >= stamp.height || cell.index < 0 || cell.index > 255) throw new Error('Pixel stamp cells must use bounded integer coordinates and palette indices.');
    const key = `${cell.x},${cell.y}`; if (seen.has(key)) throw new Error('Pixel stamp cells may not overlap.'); seen.add(key);
  }
}
