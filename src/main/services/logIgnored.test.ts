import { describe, expect, it, vi } from 'vitest';
import { logIgnored } from './logIgnored';

describe('logIgnored', () => {
  it('answers the fallback and writes one line saying where and why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = Promise.reject(
      Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
    );
    expect(await failing.catch(logIgnored('salesLedger:120', null))).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[ignored] salesLedger:120 [SQLITE_BUSY]: database is locked',
    );
    expect(
      await Promise.reject('x').catch(logIgnored('a', [] as number[])),
    ).toEqual([]);
    warn.mockRestore();
  });
});
