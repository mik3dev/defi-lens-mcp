interface Entry {
  value: unknown;
  expiresAt: number; // Infinity = never
}

export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries: number) {}

  /** Live entry for `key`; expired entries are dropped. */
  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** True when `key` holds an unexpired value, including a stored `undefined`. */
  has(key: string): boolean {
    return this.live(key) !== undefined;
  }

  /** Cached value, or undefined on a miss. A stored `undefined` also reads as undefined: use has(). */
  get<T>(key: string): T | undefined {
    return this.live(key)?.value as T | undefined;
  }

  set<T>(key: string, value: T, ttlMs: number | 'forever'): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const expiresAt = ttlMs === 'forever' ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
    this.entries.set(key, { value, expiresAt });
  }

  /** Cached fn result; concurrent callers share one in-flight call. Rejections are not cached. */
  wrap<T>(key: string, ttlMs: number | 'forever', fn: () => Promise<T>): Promise<T> {
    const hit = this.live(key);
    if (hit) return Promise.resolve(hit.value as T);
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = fn()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }
}
