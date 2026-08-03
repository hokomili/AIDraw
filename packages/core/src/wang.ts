import type { WangSet, WangTile } from './model';

export type WangNeighborhood = Partial<Record<'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left' | 'topLeft', number>>;

const positions: Array<keyof WangNeighborhood> = ['top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left', 'topLeft'];

export function matchingWangTiles(set: WangSet, neighborhood: WangNeighborhood): WangTile[] {
  return set.tiles.filter((tile) => positions.every((position, index) => {
    const wanted = neighborhood[position];
    return wanted === undefined || wanted === 0 || tile.wangId[index] === wanted;
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
