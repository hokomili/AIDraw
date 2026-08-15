import type { WangSet, WangTile } from './model';

export type WangNeighborhood = Partial<Record<'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left' | 'topLeft', number>>;

const positions: Array<keyof WangNeighborhood> = ['top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left', 'topLeft'];

const wangTerrainNeighbors: Array<{ dx: number; dy: number; neighborSlots: number[] }> = [
  { dx: 0, dy: -1, neighborSlots: [4, 3, 5] },
  { dx: 1, dy: -1, neighborSlots: [5] },
  { dx: 1, dy: 0, neighborSlots: [6, 7, 5] },
  { dx: 1, dy: 1, neighborSlots: [7] },
  { dx: 0, dy: 1, neighborSlots: [0, 1, 7] },
  { dx: -1, dy: 1, neighborSlots: [1] },
  { dx: -1, dy: 0, neighborSlots: [2, 3, 1] },
  { dx: -1, dy: -1, neighborSlots: [3] },
];

const emptyWangId = (): WangTile['wangId'] => [0, 0, 0, 0, 0, 0, 0, 0];

function wangIdForTile(set: WangSet, tileId: number | undefined): WangTile['wangId'] {
  return [...(set.tiles.find((tile) => tile.tileId === tileId)?.wangId ?? emptyWangId())] as WangTile['wangId'];
}

function desiredWangTerrainCells(
  x: number,
  y: number,
  targetValue: number,
  getWangId: (x: number, y: number) => WangTile['wangId'],
): Map<string, { x: number; y: number; wangId: WangTile['wangId'] }> {
  const desired = new Map<string, { x: number; y: number; wangId: WangTile['wangId'] }>();
  desired.set(`${x},${y}`, { x, y, wangId: [targetValue, targetValue, targetValue, targetValue, targetValue, targetValue, targetValue, targetValue] });
  for (const neighbor of wangTerrainNeighbors) {
    const targetX = x + neighbor.dx;
    const targetY = y + neighbor.dy;
    const wangId = getWangId(targetX, targetY);
    for (const neighborSlot of neighbor.neighborSlots) wangId[neighborSlot] = targetValue;
    desired.set(`${targetX},${targetY}`, { x: targetX, y: targetY, wangId });
  }
  return desired;
}

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

export const MAX_WANG_TERRAIN_STROKE_POINTS = 65_536;
export const MAX_WANG_TERRAIN_COORDINATE = 16_777_216;

/**
 * Build a platform-stable pseudo-random stream for semantic Wang planning.
 * The caller owns the seed material; no document seed or ambient randomness is
 * read or advanced. Hashing UTF-16 code units bytewise keeps the result exact
 * across the browser and Node runtimes that share this package.
 */
export function createWangTerrainStrokeRandom(seedMaterial: string): () => number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seedMaterial.length; index += 1) {
    const code = seedMaterial.charCodeAt(index);
    state = Math.imul((state ^ (code & 0xff)) >>> 0, 0x01000193) >>> 0;
    state = Math.imul((state ^ (code >>> 8)) >>> 0, 0x01000193) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface WangTerrainStrokeOptions {
  erase?: boolean;
  random?: () => number;
  contains?: (x: number, y: number) => boolean;
}

interface WangTerrainStrokePlanBase {
  strokePointCount: number;
  affectedCellCount: number;
}

export type WangTerrainStrokePlan =
  | (WangTerrainStrokePlanBase & {
    status: 'ready';
    changes: Array<{ x: number; y: number; tileId: number }>;
    targetChangeCount: number;
    repairChangeCount: number;
  })
  | (WangTerrainStrokePlanBase & {
    status: 'unmatched';
    changes: [];
    unmatched: Array<{ x: number; y: number; wangId: WangTile['wangId'] }>;
    provisionalChangeCount: number;
  });

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
  const targetValue = erase ? 0 : colorId;
  const desired = desiredWangTerrainCells(x, y, targetValue, (targetX, targetY) => wangIdForTile(set, getTileId(targetX, targetY)));
  const result: WangTerrainPaintResult = { changes: [], unmatched: [] };
  for (const entry of desired.values()) {
    const neighborhood = Object.fromEntries(positions.map((position, index) => [position, entry.wangId[index]])) as WangNeighborhood;
    const tile = selectWangTile(set, neighborhood, random);
    if (tile) result.changes.push({ x: entry.x, y: entry.y, tileId: tile.tileId });
    else result.unmatched.push(entry);
  }
  return result;
}

/**
 * Accumulate every desired boundary across a complete terrain stroke before
 * selecting concrete tiles. A missing final in-map transition rejects the
 * complete plan instead of returning a partial mutation. The optional
 * containment predicate excludes nonexistent finite-map neighbors while
 * leaving signed infinite-map coordinates unrestricted.
 */
export function planWangTerrainStroke(
  set: WangSet,
  points: ReadonlyArray<{ x: number; y: number }>,
  colorId: number,
  getTileId: (x: number, y: number) => number | undefined,
  options: WangTerrainStrokeOptions = {},
): WangTerrainStrokePlan {
  if (!set.colors.some((color) => color.id === colorId)) throw new Error('Wang color ' + colorId + ' does not exist in ' + set.name + '.');
  if (points.length > MAX_WANG_TERRAIN_STROKE_POINTS) throw new Error(`A Wang terrain stroke is limited to ${MAX_WANG_TERRAIN_STROKE_POINTS.toLocaleString('en-US')} points.`);

  const contains = options.contains ?? (() => true);
  const random = options.random ?? Math.random;
  const initial = new Map<string, number | undefined>();
  const desired = new Map<string, { x: number; y: number; wangId: WangTile['wangId'] }>();
  const pending = new Map<string, number>();
  const unresolved = new Map<string, { x: number; y: number; wangId: WangTile['wangId'] }>();
  const affected = new Set<string>();
  const targetKeys = new Set<string>();
  const uniquePoints: Array<{ x: number; y: number }> = [];

  const keyOf = (x: number, y: number) => `${x},${y}`;
  const assertCoordinate = (x: number, y: number): void => {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error('Wang terrain stroke coordinates must be safe integers.');
    if (Math.abs(x) > MAX_WANG_TERRAIN_COORDINATE || Math.abs(y) > MAX_WANG_TERRAIN_COORDINATE) throw new Error(`Wang terrain stroke coordinates must stay within ±${MAX_WANG_TERRAIN_COORDINATE.toLocaleString('en-US')}.`);
  };
  const initialTileAt = (x: number, y: number): number | undefined => {
    const key = keyOf(x, y);
    if (!initial.has(key)) initial.set(key, getTileId(x, y));
    return initial.get(key);
  };
  const desiredWangIdAt = (x: number, y: number): WangTile['wangId'] => {
    if (!contains(x, y)) return emptyWangId();
    assertCoordinate(x, y);
    const accumulated = desired.get(keyOf(x, y));
    return accumulated
      ? [...accumulated.wangId] as WangTile['wangId']
      : wangIdForTile(set, initialTileAt(x, y));
  };

  for (const point of points) {
    assertCoordinate(point.x, point.y);
    if (!contains(point.x, point.y)) throw new Error(`Wang terrain stroke point (${point.x}, ${point.y}) is outside the map.`);
    const key = keyOf(point.x, point.y);
    if (targetKeys.has(key)) continue;
    targetKeys.add(key);
    uniquePoints.push({ x: point.x, y: point.y });
  }

  const targetValue = options.erase ? 0 : colorId;
  for (const point of uniquePoints) {
    const pointDesired = desiredWangTerrainCells(point.x, point.y, targetValue, desiredWangIdAt);
    for (const entry of pointDesired.values()) {
      if (!contains(entry.x, entry.y)) continue;
      const key = keyOf(entry.x, entry.y);
      affected.add(key);
      desired.set(key, { x: entry.x, y: entry.y, wangId: [...entry.wangId] as WangTile['wangId'] });
    }
  }

  for (const [key, entry] of desired) {
    const neighborhood = Object.fromEntries(positions.map((position, index) => [position, entry.wangId[index]])) as WangNeighborhood;
    const tile = selectWangTile(set, neighborhood, random);
    if (tile) pending.set(key, tile.tileId);
    else {
      pending.delete(key);
      unresolved.set(key, { x: entry.x, y: entry.y, wangId: [...entry.wangId] as WangTile['wangId'] });
    }
  }

  const changed = [...pending.entries()]
    .filter(([key, tileId]) => {
      const [x, y] = key.split(',').map(Number);
      return initialTileAt(x, y) !== tileId;
    })
    .map(([key, tileId]) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y, tileId };
    })
    .sort((left, right) => left.y - right.y || left.x - right.x);

  if (unresolved.size) {
    return {
      status: 'unmatched',
      changes: [],
      unmatched: [...unresolved.values()].sort((left, right) => left.y - right.y || left.x - right.x),
      provisionalChangeCount: changed.length,
      strokePointCount: uniquePoints.length,
      affectedCellCount: affected.size,
    };
  }

  const targetChangeCount = changed.filter((change) => targetKeys.has(keyOf(change.x, change.y))).length;
  return {
    status: 'ready',
    changes: changed,
    targetChangeCount,
    repairChangeCount: changed.length - targetChangeCount,
    strokePointCount: uniquePoints.length,
    affectedCellCount: affected.size,
  };
}
