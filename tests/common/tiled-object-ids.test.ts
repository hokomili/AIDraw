import { describe, expect, it } from 'vitest';
import { MAX_TILED_OBJECT_ID, createTiledObjectIdAllocator } from '../../src/common/tiled-object-ids';

function allocate(sourceIds: string[]): number[] {
  const allocator = createTiledObjectIdAllocator(sourceIds);
  return sourceIds.map((sourceId) => allocator.next(sourceId));
}

describe('Tiled object ID planning', () => {
  it('preserves only exact unique positive uint32 IDs and allocates every other occurrence deterministically', () => {
    const sourceIds = ['uuid-12-34', '1', '01', '5', '5', String(MAX_TILED_OBJECT_ID), String(MAX_TILED_OBJECT_ID + 1), '0', '-8'];
    const expected = [2, 1, 3, 4, 5, MAX_TILED_OBJECT_ID, 6, 7, 8];
    expect(allocate(sourceIds)).toEqual(expected);
    expect(allocate(sourceIds)).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('reserves a later exact numeric identity before allocating an earlier opaque ID', () => {
    expect(allocate(['opaque', '2', 'another'])).toEqual([1, 2, 3]);
  });
});
