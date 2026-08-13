export const MAX_TILED_OBJECT_ID = 0xffff_ffff;

export interface TiledObjectIdAllocator {
  next(sourceId: string): number;
}

function exactTiledObjectId(sourceId: string): number | undefined {
  if (!/^[1-9]\d*$/.test(sourceId)) return undefined;
  const value = Number(sourceId);
  return Number.isSafeInteger(value) && value <= MAX_TILED_OBJECT_ID ? value : undefined;
}

/**
 * Allocate one deterministic positive uint32 namespace for an emitted Tiled
 * artifact. An exact numeric canonical ID survives only when it is unique;
 * every other occurrence receives the lowest unreserved ID in output order.
 */
export function createTiledObjectIdAllocator(sourceIds: Iterable<string>): TiledObjectIdAllocator {
  const candidateCounts = new Map<number, number>();
  for (const sourceId of sourceIds) {
    const candidate = exactTiledObjectId(sourceId);
    if (candidate !== undefined) candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
  }
  const reserved = new Set([...candidateCounts].filter(([, count]) => count === 1).map(([candidate]) => candidate));
  const used = new Set<number>();
  let nextAvailable = 1;
  return {
    next(sourceId) {
      const candidate = exactTiledObjectId(sourceId);
      if (candidate !== undefined && candidateCounts.get(candidate) === 1 && !used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
      while (reserved.has(nextAvailable) || used.has(nextAvailable)) nextAvailable += 1;
      if (nextAvailable > MAX_TILED_OBJECT_ID) throw new RangeError('Tiled export exhausted its positive 32-bit object-ID namespace.');
      const allocated = nextAvailable;
      used.add(allocated);
      nextAvailable += 1;
      return allocated;
    },
  };
}
