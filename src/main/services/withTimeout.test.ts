import { describe, expect, it } from 'vitest';
import { OperationTimeoutError, withTimeout } from './withTimeout';

const never = () => new Promise<never>(() => {});

describe('withTimeout', () => {
  it('passes a value through when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('passes the original rejection through', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('printer offline')), 1000),
    ).rejects.toThrow('printer offline');
  });

  it('rejects with a labelled timeout when the work hangs', async () => {
    const err = await withTimeout(never(), 10, 'Serial write').catch((e) => e);
    expect(err).toBeInstanceOf(OperationTimeoutError);
    expect(err.message).toBe('Serial write timed out after 10ms');
    expect(err.timeoutMs).toBe(10);
  });

  it('treats a non-positive timeout as no deadline', async () => {
    await expect(withTimeout(Promise.resolve(1), 0)).resolves.toBe(1);
    await expect(withTimeout(Promise.resolve(1), -5)).resolves.toBe(1);
    await expect(withTimeout(Promise.resolve(1), NaN)).resolves.toBe(1);
  });

  it('does not fire the deadline after the work settled', async () => {
    const seen: unknown[] = [];
    process.once('unhandledRejection', (e) => seen.push(e));
    await withTimeout(Promise.resolve('done'), 5);
    await new Promise((r) => setTimeout(r, 25));
    expect(seen).toEqual([]);
  });
});
