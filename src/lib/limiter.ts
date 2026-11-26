export function createLimiter(maxConcurrent: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer');
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
