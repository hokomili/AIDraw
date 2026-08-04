import type { WangSet, WangTile } from './model';

export type WangNeighborhood = Partial<Record<'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left' | 'topLeft', number>>;

const positions: Array<keyof WangNeighborhood> = ['top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left', 'topLeft'];

export function matchingWangTiles(set: WangSet, neighborhood: WangNeighborhood): WangTile[] {
  return set.tiles.filter((tile) => positions.every((position, index) => {
    const wanted = neighborhood[position];
    return wanted === undefined || tile.wangId[index] === wanted;
  }));
}
export function selectWangTile(set: WangSet, neighborhood: WangNeighborhood, random = Math.random): WangTile | undefined {
  const matches = matchingWangTiles(set, neighborhood);
  if (matches.length === 0) return undefined;
  const weights = matches.map((tile) => {
    const colors = tile.wangId.filter((id) => id > 0);
    if (colors.length === 0) return 1;
    return colors.reduce((weight, id) => weight * (set.colors.find((color) => color.id === id)?.probability ?? 1), 1 / colors.length);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = Math.max(0, Math.min(0.999999999, random())) * total;
  for (let index = 0; index < matches.length; index += 1) {
    target -= weights[index];
    if (target <= 0) return matches[index];
  }
  return matches.at(-1);
}

export interface WangTerrainPaintResult {
  changes: Array<{ x: number; y: number; tileId: number }>;
  unmatched: Array<{ x: number; y: number; wangId: WangTile['wangId'] }>;
}

export function paintWangTerrain(
  set: WangSet,
  x: number,
  y: number,
  colorId: number,
  getTileId: (x: number, y: number) => number | undefined,
  erase = false,
  random = Math.random,
): WangTerrainPaintResult {
  if (!set.colors.some((color) => color.id === colorId)) throw new Error('Wang color ' + colorId + ' does not exist in ' + set.name + '.');
  const empty = (): WangTile['wangId'] => [0, 0, 0, 0, 0, 0, 0, 0];
  const existing = (targetX: number, targetY: number): WangTile['wangId'] => {
    const tileId = getTileId(targetX, targetY);
    return [...(set.tiles.find((tile) => tile.tileId === tileId)?.wangId ?? empty())] as WangTile['wangId'];
  };
  const desired = new Map<string, { x: number; y: number; wangId: WangTile['wangId'] }>();
  const targetValue = erase ? 0 : colorId;
  desired.set(x + ',' + y, { x, y, wangId: [targetValue, targetValue, targetValue, targetValue, targetValue, targetValue, targetValue, targetValue] });
  const neighbors: Array<{ dx: number; dy: number; pairs: Array<[number, number]> }> = [
    { dx: 0, dy: -1, pairs: [[0, 4], [1, 3], [7, 5]] },
    { dx: 1, dy: -1, pairs: [[1, 5]] },
    { dx: 1, dy: 0, pairs: [[2, 6], [1, 7], [3, 5]] },
    { dx: 1, dy: 1, pairs: [[3, 7]] },
    { dx: 0, dy: 1, pairs: [[4, 0], [3, 1], [5, 7]] },
    { dx: -1, dy: 1, pairs: [[5, 1]] },
    { dx: -1, dy: 0, pairs: [[6, 2], [5, 3], [7, 1]] },
    { dx: -1, dy: -1, pairs: [[7, 3]] },
  ];
  for (const neighbor of neighbors) {
    const targetX = x + neighbor.dx; const targetY = y + neighbor.dy; const wangId = existing(targetX, targetY);
    for (const [, neighborSlot] of neighbor.pairs) wangId[neighborSlot] = targetValue;
    desired.set(targetX + ',' + targetY, { x: targetX, y: targetY, wangId });
  }
  const result: WangTerrainPaintResult = { changes: [], unmatched: [] };
  for (const entry of desired.values()) {
    const neighborhood = Object.fromEntries(positions.map((position, index) => [position, entry.wangId[index]])) as WangNeighborhood;
    const tile = selectWangTile(set, neighborhood, random);
    if (tile) result.changes.push({ x: entry.x, y: entry.y, tileId: tile.tileId });
    else result.unmatched.push(entry);
  }
  return result;
}
