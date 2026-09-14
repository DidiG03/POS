import { describe, expect, it } from 'vitest';
import { isChunkLoadError, retryLazyImport } from './lazyRetry';

describe('isChunkLoadError', () => {
  it('matches Capacitor / Safari module-script failures', () => {
    expect(
      isChunkLoadError(new Error('Importing a module script failed.')),
    ).toBe(true);
    expect(
      isChunkLoadError({
        name: 'ChunkLoadError',
        message: 'Loading chunk 7 failed',
      }),
    ).toBe(true);
    expect(isChunkLoadError(new Error('unique constraint'))).toBe(false);
  });
});

describe('retryLazyImport', () => {
  it('retries a failed chunk then succeeds', async () => {
    let n = 0;
    const out = await retryLazyImport(async () => {
      n += 1;
      if (n < 2) throw new Error('Importing a module script failed.');
      return { default: 'ok' };
    });
    expect(out).toEqual({ default: 'ok' });
    expect(n).toBe(2);
  });

  it('does not retry other errors', async () => {
    let n = 0;
    await expect(
      retryLazyImport(async () => {
        n += 1;
        throw new Error('syntax');
      }),
    ).rejects.toMatchObject({ message: 'syntax' });
    expect(n).toBe(1);
  });
});
