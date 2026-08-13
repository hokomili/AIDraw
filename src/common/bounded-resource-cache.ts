export interface BoundedResourceLease<T> {
  value: T;
  /** Releases only transient values; retained entries are owned by the cache. */
  release(): void;
}

interface BoundedResourceEntry<T> {
  value: T;
  bytes: number;
}

/** A synchronous byte- and entry-bounded LRU for disposable render resources. */
export class BoundedResourceCache<T> {
  readonly #entries = new Map<string, BoundedResourceEntry<T>>();
  #bytes = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
    readonly dispose: (value: T) => void,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('Resource cache entry limit must be a positive safe integer.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Resource cache byte limit must be a positive safe integer.');
  }

  get size(): number { return this.#entries.size; }
  get retainedBytes(): number { return this.#bytes; }

  acquire(key: string, bytes: number, create: () => T): BoundedResourceLease<T> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Resource cache entry size must be a nonnegative safe integer.');
    const existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return { value: existing.value, release() {} };
    }

    const value = create();
    if (bytes > this.maxBytes) {
      let released = false;
      return { value, release: () => { if (!released) { released = true; this.dispose(value); } } };
    }
    while (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) {
      const oldest = this.#entries.entries().next().value as [string, BoundedResourceEntry<T>] | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
      this.dispose(oldest[1].value);
    }
    this.#entries.set(key, { value, bytes });
    this.#bytes += bytes;
    return { value, release() {} };
  }

  clear(): void {
    for (const entry of this.#entries.values()) this.dispose(entry.value);
    this.#entries.clear();
    this.#bytes = 0;
  }
}
