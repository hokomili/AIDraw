import type { WangSet, WangTile } from './model';

export type WangNeighborhood = Partial<Record<'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left' | 'topLeft', number>>;

const positions: Array<keyof WangNeighborhood> = ['top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left', 'topLeft'];

type WangSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

const wangSlots: WangSlot[] = [0, 1, 2, 3, 4, 5, 6, 7];
const wangTerrainNeighbors: Array<{ dx: number; dy: number; sharedSlots: Array<{ source: WangSlot; neighbor: WangSlot }> }> = [
  { dx: 0, dy: -1, sharedSlots: [{ source: 0, neighbor: 4 }, { source: 1, neighbor: 3 }, { source: 7, neighbor: 5 }] },
  { dx: 1, dy: -1, sharedSlots: [{ source: 1, neighbor: 5 }] },
  { dx: 1, dy: 0, sharedSlots: [{ source: 2, neighbor: 6 }, { source: 1, neighbor: 7 }, { source: 3, neighbor: 5 }] },
  { dx: 1, dy: 1, sharedSlots: [{ source: 3, neighbor: 7 }] },
  { dx: 0, dy: 1, sharedSlots: [{ source: 4, neighbor: 0 }, { source: 3, neighbor: 1 }, { source: 5, neighbor: 7 }] },
  { dx: -1, dy: 1, sharedSlots: [{ source: 5, neighbor: 1 }] },
  { dx: -1, dy: 0, sharedSlots: [{ source: 6, neighbor: 2 }, { source: 5, neighbor: 3 }, { source: 7, neighbor: 1 }] },
  { dx: -1, dy: -1, sharedSlots: [{ source: 7, neighbor: 3 }] },
];

const wangTerrainNeighborsBySlot = wangSlots.map((slot) => wangTerrainNeighbors.flatMap((neighbor) => (
  neighbor.sharedSlots
    .filter((shared) => shared.source === slot)
    .map((shared) => ({ dx: neighbor.dx, dy: neighbor.dy, neighborSlot: shared.neighbor }))
)));

const emptyWangId = (): WangTile['wangId'] => [0, 0, 0, 0, 0, 0, 0, 0];

function wangIdForTile(set: WangSet, tileId: number | undefined): WangTile['wangId'] {
  return [...(set.tiles.find((tile) => tile.tileId === tileId)?.wangId ?? emptyWangId())] as WangTile['wangId'];
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
export const MAX_WANG_TERRAIN_PLAN_CELLS = MAX_WANG_TERRAIN_STROKE_POINTS * 9;

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
  const plan = planWangTerrainStroke(set, [{ x, y }], colorId, getTileId, { erase, random });
  return plan.status === 'ready'
    ? { changes: plan.changes, unmatched: [] }
    : { changes: [], unmatched: plan.unmatched };
}

/**
 * Accumulate every desired boundary across a complete terrain stroke, then
 * propagate only when an exact authored signature must change another shared
 * edge or corner. A missing final in-map transition or unfinished bounded
 * frontier rejects the complete plan instead of returning a partial mutation.
 * The optional containment predicate excludes nonexistent finite-map
 * neighbors while leaving signed infinite-map coordinates unrestricted.
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
  interface PlannedCell {
    x: number;
    y: number;
    wangId: WangTile['wangId'];
    required: boolean[];
  }
  interface SignatureGroup {
    wangId: WangTile['wangId'];
  }

  const initial = new Map<string, number | undefined>();
  const desired = new Map<string, PlannedCell>();
  const pending = new Map<string, number>();
  const unresolved = new Map<string, { x: number; y: number; wangId: WangTile['wangId'] }>();
  const targetKeys = new Set<string>();
  const uniquePoints: Array<{ x: number; y: number }> = [];
  const signatureGroups: SignatureGroup[] = [];
  const signatureKeys = new Set<string>();

  const keyOf = (x: number, y: number) => `${x},${y}`;
  const signatureKey = (wangId: WangTile['wangId']) => wangId.join(',');
  const assertCoordinate = (x: number, y: number): void => {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error('Wang terrain stroke coordinates must be safe integers.');
    if (Math.abs(x) > MAX_WANG_TERRAIN_COORDINATE || Math.abs(y) > MAX_WANG_TERRAIN_COORDINATE) throw new Error(`Wang terrain stroke coordinates must stay within ±${MAX_WANG_TERRAIN_COORDINATE.toLocaleString('en-US')}.`);
  };
  const initialTileAt = (x: number, y: number): number | undefined => {
    const key = keyOf(x, y);
    if (!initial.has(key)) initial.set(key, getTileId(x, y));
    return initial.get(key);
  };
  const ensureCell = (x: number, y: number): PlannedCell => {
    assertCoordinate(x, y);
    const key = keyOf(x, y);
    const current = desired.get(key);
    if (current) return current;
    if (desired.size >= MAX_WANG_TERRAIN_PLAN_CELLS) {
      throw new Error(`Wang terrain repair exceeds the ${MAX_WANG_TERRAIN_PLAN_CELLS.toLocaleString('en-US')}-cell planning limit at (${x}, ${y}); no terrain tiles changed.`);
    }
    const cell: PlannedCell = {
      x,
      y,
      wangId: wangIdForTile(set, initialTileAt(x, y)),
      required: wangSlots.map(() => false),
    };
    desired.set(key, cell);
    return cell;
  };
  const requireSlot = (cell: PlannedCell, slot: WangSlot, value: number): boolean => {
    if (cell.required[slot] && cell.wangId[slot] !== value) {
      throw new Error(`Wang terrain repair produced conflicting exact constraints at (${cell.x}, ${cell.y}) slot ${slot}; no terrain tiles changed.`);
    }
    const changed = cell.wangId[slot] !== value;
    cell.wangId[slot] = value;
    cell.required[slot] = true;
    return changed;
  };

  for (const tile of set.tiles) {
    const key = signatureKey(tile.wangId);
    if (signatureKeys.has(key)) continue;
    signatureKeys.add(key);
    signatureGroups.push({ wangId: [...tile.wangId] as WangTile['wangId'] });
  }

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
    const target = ensureCell(point.x, point.y);
    for (const slot of wangSlots) requireSlot(target, slot, targetValue);
    for (const neighbor of wangTerrainNeighbors) {
      const targetX = point.x + neighbor.dx;
      const targetY = point.y + neighbor.dy;
      if (!contains(targetX, targetY)) continue;
      const cell = ensureCell(targetX, targetY);
      for (const shared of neighbor.sharedSlots) requireSlot(cell, shared.neighbor, targetValue);
    }
  }

  const repairSignatureFor = (cell: PlannedCell): WangTile['wangId'] | undefined => {
    const requiredSlots = wangSlots.filter((slot) => cell.required[slot]);
    let selected: { group: SignatureGroup; differenceCount: number } | undefined;
    for (const group of signatureGroups) {
      if (requiredSlots.some((slot) => group.wangId[slot] !== cell.wangId[slot])) continue;
      const differenceCount = wangSlots.filter((slot) => group.wangId[slot] !== cell.wangId[slot]).length;
      if (!selected || differenceCount < selected.differenceCount) selected = { group, differenceCount };
    }
    return selected ? [...selected.group.wangId] as WangTile['wangId'] : undefined;
  };

  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueueIfUnmatched = (key: string, cell: PlannedCell): void => {
    if (signatureKeys.has(signatureKey(cell.wangId)) || queued.has(key)) return;
    queued.add(key);
    queue.push(key);
  };
  for (const [key, cell] of desired) enqueueIfUnmatched(key, cell);

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const key = queue[queueIndex];
    queued.delete(key);
    const cell = desired.get(key);
    if (!cell || signatureKeys.has(signatureKey(cell.wangId))) continue;
    const repaired = repairSignatureFor(cell);
    if (!repaired) {
      unresolved.set(key, { x: cell.x, y: cell.y, wangId: [...cell.wangId] as WangTile['wangId'] });
      continue;
    }
    unresolved.delete(key);
    const previous = [...cell.wangId] as WangTile['wangId'];
    cell.wangId = repaired;
    for (const slot of wangSlots) {
      if (previous[slot] === repaired[slot]) continue;
      cell.required[slot] = true;
      for (const neighbor of wangTerrainNeighborsBySlot[slot]) {
        const targetX = cell.x + neighbor.dx;
        const targetY = cell.y + neighbor.dy;
        if (!contains(targetX, targetY)) continue;
        const target = ensureCell(targetX, targetY);
        if (requireSlot(target, neighbor.neighborSlot, repaired[slot])) enqueueIfUnmatched(keyOf(targetX, targetY), target);
      }
    }
  }

  for (const [key, entry] of desired) {
    if (unresolved.has(key)) continue;
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
      affectedCellCount: desired.size,
    };
  }

  const targetChangeCount = changed.filter((change) => targetKeys.has(keyOf(change.x, change.y))).length;
  return {
    status: 'ready',
    changes: changed,
    targetChangeCount,
    repairChangeCount: changed.length - targetChangeCount,
    strokePointCount: uniquePoints.length,
    affectedCellCount: desired.size,
  };
}
