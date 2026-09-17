import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_TX_TIMEOUT_MS,
  isSqliteBusy,
  withSqliteRetry,
  withSqliteTransactionOptions,
} from './sqliteBusy';
import { sqliteConnectionUrl, sqliteFileUrl } from './sqliteUrl';

describe('sqliteFileUrl', () => {
  it('encodes spaces in packaged userData folders', () => {
    const url = sqliteFileUrl(
      path.join(os.tmpdir(), 'OneTap POS', 'db.sqlite'),
    );
    expect(url.startsWith('file:')).toBe(true);
    expect(url).toContain('OneTap%20POS');
    expect(url).not.toMatch(/OneTap POS/);
  });
});

describe('sqliteConnectionUrl', () => {
  it('pins SQLite to a small WAL read pool', () => {
    expect(sqliteConnectionUrl('file:./dev.db')).toBe(
      'file:./dev.db?connection_limit=4',
    );
    expect(sqliteConnectionUrl('file:./dev.db?socket_timeout=10')).toBe(
      'file:./dev.db?socket_timeout=10&connection_limit=4',
    );
  });

  it('does not duplicate connection_limit', () => {
    expect(sqliteConnectionUrl('file:./dev.db?connection_limit=1')).toBe(
      'file:./dev.db?connection_limit=1',
    );
  });
});

describe('isSqliteBusy', () => {
  it('recognizes Prisma and SQLite lock errors', () => {
    expect(isSqliteBusy({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isSqliteBusy({ code: 'P2024' })).toBe(true);
    expect(isSqliteBusy({ message: 'database is locked' })).toBe(true);
    expect(isSqliteBusy({ code: 'P2002' })).toBe(false);
  });
});

describe('withSqliteRetry', () => {
  it('retries a busy write then succeeds', async () => {
    let n = 0;
    const out = await withSqliteRetry(async () => {
      n += 1;
      if (n < 3) {
        const err = new Error('database is locked');
        (err as { code?: string }).code = 'SQLITE_BUSY';
        throw err;
      }
      return 'ok';
    }, [1, 1, 1]);
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('does not retry unique conflicts', async () => {
    let n = 0;
    await expect(
      withSqliteRetry(async () => {
        n += 1;
        const err = new Error('unique');
        (err as { code?: string }).code = 'P2002';
        throw err;
      }, [1, 1]),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(n).toBe(1);
  });
});

describe('withSqliteTransactionOptions', () => {
  it('adds timeout and maxWait when omitted', () => {
    const fn = async () => 1;
    const [first, opts] = withSqliteTransactionOptions([fn]);
    expect(first).toBe(fn);
    expect(opts).toEqual({
      timeout: SQLITE_TX_TIMEOUT_MS,
      maxWait: SQLITE_BUSY_TIMEOUT_MS,
    });
  });

  it('keeps caller timeout and maxWait', () => {
    const ops = [{}, {}];
    const [, opts] = withSqliteTransactionOptions([
      ops,
      { timeout: 9_000, maxWait: 1_000, isolationLevel: 'Serializable' },
    ]);
    expect(opts).toEqual({
      timeout: 9_000,
      maxWait: 1_000,
      isolationLevel: 'Serializable',
    });
  });

  it('leaves non-transaction calls unchanged', () => {
    const args = ['PRAGMA journal_mode=WAL;'];
    expect(withSqliteTransactionOptions(args)).toBe(args);
  });
});
