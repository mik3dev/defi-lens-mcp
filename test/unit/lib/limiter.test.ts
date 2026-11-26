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
  it('never exceeds the cap when a caller lands between release and wake-up', async () => {
    // Sweep the microtask depth at which a late caller arrives so one lands in the handoff gap.
    for (let depth = 0; depth < 8; depth++) {
      const limit = createLimiter(1);
      let active = 0;
      let max = 0;
      const track = async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
      };
      const late: Promise<void>[] = [];
      const first = limit(async () => {
        await track();
        let chain: Promise<void> = Promise.resolve();
        for (let i = 0; i < depth; i++) chain = chain.then(() => undefined);
        late.push(chain.then(() => limit(track)));
      });
      const second = limit(track);
      await Promise.all([first, second]);
      await Promise.all(late);
      expect(max).toBe(1);
    }
  });
  it('rejects invalid concurrency', () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
  });
});
