import type { Id, TileStamp, TileStampCell } from './model';
import type { PixelStampTransform } from './stamps';

export function captureTileStamp(id: Id, name: string, points: Array<{ x: number; y: number }>, readGid: (x: number, y: number) => number): TileStamp {
  const unique = [...new Map(points.map((point) => [point.x + ',' + point.y, point])).values()];
  if (!id || !name.trim()) throw new Error('Tile stamps require an id and name.');
  if (!unique.length || unique.length > 65_536) throw new Error('Tile stamps require 1–65,536 selected cells.');
  const minX = Math.min(...unique.map((point) => point.x)); const minY = Math.min(...unique.map((point) => point.y)); const maxX = Math.max(...unique.map((point) => point.x)); const maxY = Math.max(...unique.map((point) => point.y));
  const width = maxX - minX + 1; const height = maxY - minY + 1;
  return { id, name: name.trim(), width, height, anchorX: Math.floor(width / 2), anchorY: Math.floor(height / 2), cells: unique.map((point) => ({ x: point.x - minX, y: point.y - minY, gid: readGid(point.x, point.y) >>> 0 })) };
}

export function transformTileStamp(stamp: TileStamp, transform: PixelStampTransform): TileStamp {
  const rotated = transform === 'rotate-clockwise' || transform === 'rotate-counterclockwise'; const width = rotated ? stamp.height : stamp.width; const height = rotated ? stamp.width : stamp.height;
  const map = (cell: TileStampCell): TileStampCell => {
    if (transform === 'flip-horizontal') return { ...cell, x: stamp.width - 1 - cell.x };
    if (transform === 'flip-vertical') return { ...cell, y: stamp.height - 1 - cell.y };
    if (transform === 'rotate-clockwise') return { ...cell, x: stamp.height - 1 - cell.y, y: cell.x };
    return { ...cell, x: cell.y, y: stamp.width - 1 - cell.x };
  };
  const anchor = map({ x: stamp.anchorX, y: stamp.anchorY, gid: 0 });
  return { ...structuredClone(stamp), width, height, anchorX: anchor.x, anchorY: anchor.y, cells: stamp.cells.map(map) };
}

export function placeTileStamp(stamp: TileStamp, x: number, y: number, bounds?: { width: number; height: number }): { changes: TileStampCell[]; dropped: number } {
  const changes = stamp.cells.map((cell) => ({ x: x - stamp.anchorX + cell.x, y: y - stamp.anchorY + cell.y, gid: cell.gid >>> 0 }));
  if (!bounds) return { changes, dropped: 0 };
  const retained = changes.filter((cell) => cell.x >= 0 && cell.y >= 0 && cell.x < bounds.width && cell.y < bounds.height);
  return { changes: retained, dropped: changes.length - retained.length };
}
