import { describe, expect, it } from 'vitest';
import { createLimiter } from '../../../src/lib/limiter.js';

describe('createLimiter', () => {
  it('caps concurrency and resolves all tasks', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let max = 0;
    const task = (i: number) => async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    };
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) => limit(task(i))));
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(max).toBe(2);
  });
  it('keeps running after a rejection', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limit(async () => 1)).resolves.toBe(1);
  });
  it('rejects invalid concurrency', () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
  });
});
