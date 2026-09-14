/**
 * Classify Prisma operations so WAL readers never take the write gate.
 * `$transaction` is a write: inner statements reenter via AsyncLocalStorage.
 */
const WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'executeRaw',
  'executeRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  'transaction',
  '$transaction',
]);

export function isSqliteWriteOperation(operation: unknown): boolean {
  const op = String(operation || '').trim();
  if (!op) return false;
  if (WRITE_OPS.has(op)) return true;
  const bare = op.startsWith('$') ? op.slice(1) : op;
  return WRITE_OPS.has(bare);
}
