import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../../src/lib/cache.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TtlCache', () => {
  it('returns value before ttl and undefined after', () => {
    const c = new TtlCache(10);
    c.set('a', 1, 1000);
    expect(c.get('a')).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(c.get('a')).toBeUndefined();
  });
  it('never expires forever entries', () => {
    const c = new TtlCache(10);
    c.set('a', 1, 'forever');
    vi.advanceTimersByTime(10 ** 10);
    expect(c.get('a')).toBe(1);
  });
  it('evicts the oldest entry past maxEntries', () => {
    const c = new TtlCache(2);
    c.set('a', 1, 'forever');
    c.set('b', 2, 'forever');
    c.set('c', 3, 'forever');
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });
  it('does not evict when overwriting an existing key', () => {
    const c = new TtlCache(2);
    c.set('a', 1, 'forever');
    c.set('b', 2, 'forever');
    c.set('b', 3, 'forever');
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(3);
  });
  it('dedups concurrent wrap calls and caches the result', async () => {
    const c = new TtlCache(10);
    const fn = vi.fn(async () => 'v');
    const [x, y] = await Promise.all([c.wrap('k', 1000, fn), c.wrap('k', 1000, fn)]);
    expect([x, y]).toEqual(['v', 'v']);
    expect(await c.wrap('k', 1000, fn)).toBe('v');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('does not cache rejections', async () => {
    const c = new TtlCache(10);
    const fn = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce('ok');
    await expect(c.wrap('k', 1000, fn)).rejects.toThrow('no');
    await expect(c.wrap('k', 1000, fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('distinguishes a stored undefined from a miss with has()', () => {
    const c = new TtlCache(10);
    c.set('u', undefined, 1000);
    expect(c.has('u')).toBe(true);
    expect(c.get('u')).toBeUndefined();
    expect(c.has('missing')).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(c.has('u')).toBe(false);
  });
  it('wrap treats a cached undefined as a hit', async () => {
    const c = new TtlCache(10);
    const fn = vi.fn(async () => undefined);
    await c.wrap('k', 1000, fn);
    await expect(c.wrap('k', 1000, fn)).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
