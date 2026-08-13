import { describe, expect, it } from 'vitest';

import { BoundedResourceCache } from '../../src/common/bounded-resource-cache';

describe('bounded resource cache', () => {
  it('refreshes retained entries, evicts least-recently-used values, and disposes every retained resource', () => {
    const disposed: string[] = [];
    const cache = new BoundedResourceCache<{ id: string }>(2, 10, (value) => disposed.push(value.id));
    const first = cache.acquire('a', 3, () => ({ id: 'a' })); first.release();
    cache.acquire('b', 3, () => ({ id: 'b' })).release();
    expect(cache.acquire('a', 3, () => ({ id: 'replacement' })).value).toBe(first.value);
    cache.acquire('c', 5, () => ({ id: 'c' })).release();
    expect({ size: cache.size, bytes: cache.retainedBytes, disposed }).toEqual({ size: 2, bytes: 8, disposed: ['b'] });
    cache.clear();
    expect({ size: cache.size, bytes: cache.retainedBytes, disposed }).toEqual({ size: 0, bytes: 0, disposed: ['b', 'a', 'c'] });
  });

  it('returns an idempotently disposable transient lease when one resource exceeds the byte budget', () => {
    const disposed: string[] = [];
    const cache = new BoundedResourceCache<string>(2, 4, (value) => disposed.push(value));
    const transient = cache.acquire('large', 5, () => 'large');
    expect({ value: transient.value, size: cache.size, bytes: cache.retainedBytes }).toEqual({ value: 'large', size: 0, bytes: 0 });
    transient.release(); transient.release();
    expect(disposed).toEqual(['large']);
    expect(() => cache.acquire('bad', -1, () => 'bad')).toThrow(/nonnegative safe integer/);
  });
});
