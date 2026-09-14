import { describe, expect, it } from 'vitest';
import { isSqliteWriteOperation } from './sqliteWrite';

describe('isSqliteWriteOperation', () => {
  it('gates mutations and transactions, not reads', () => {
    expect(isSqliteWriteOperation('create')).toBe(true);
    expect(isSqliteWriteOperation('$transaction')).toBe(true);
    expect(isSqliteWriteOperation('$executeRaw')).toBe(true);
    expect(isSqliteWriteOperation('findMany')).toBe(false);
    expect(isSqliteWriteOperation('$queryRaw')).toBe(false);
    expect(isSqliteWriteOperation('count')).toBe(false);
  });
});
