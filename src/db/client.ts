import { AsyncLocalStorage } from 'node:async_hooks';
import pkg from '@prisma/client';
import { AsyncMutex } from '@shared/asyncMutex';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  withSqliteRetry,
  withSqliteTransactionOptions,
} from './sqliteBusy';
import { sqliteConnectionUrl } from './sqliteUrl';
import { isSqliteWriteOperation } from './sqliteWrite';

const { PrismaClient } = pkg as unknown as {
  PrismaClient: new (args?: object) => any;
};

const PRAGMAS = [
  'PRAGMA journal_mode=WAL;',
  `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`,
  'PRAGMA synchronous=NORMAL;',
  'PRAGMA foreign_keys=ON;',
  'PRAGMA temp_store=MEMORY;',
  'PRAGMA cache_size=-8000;',
  'PRAGMA wal_autocheckpoint=1000;',
];

const writeMutex = new AsyncMutex();
const writeDepth = new AsyncLocalStorage<number>();

const base = new PrismaClient({
  datasources: { db: { url: sqliteConnectionUrl(process.env.DATABASE_URL) } },
});

let sqliteConfigured = false;

async function applyPragmas(): Promise<void> {
  // PRAGMA assignments return a row. Prisma `$executeRawUnsafe` rejects that
  // on SQLite ("Execute returned results, which is not allowed").
  await withSqliteRetry(async () => {
    for (const sql of PRAGMAS) {
      await base.$queryRawUnsafe(sql);
    }
  });
}

async function runPrismaOp(
  operation: unknown,
  args: unknown,
  query: (a: unknown) => Promise<unknown>,
): Promise<unknown> {
  if (!sqliteConfigured) {
    try {
      await applyPragmas();
      sqliteConfigured = true;
    } catch {
      // First query still runs; configureSqlite retries at boot.
    }
  }
  const run = () => query(args);
  if (!isSqliteWriteOperation(operation)) {
    return withSqliteRetry(run);
  }
  const depth = writeDepth.getStore() ?? 0;
  if (depth > 0) return run();
  return writeMutex.runExclusive(() =>
    writeDepth.run(1, () => withSqliteRetry(run)),
  );
}

function gateTransactions<T extends { $transaction: (...args: any[]) => any }>(
  client: T,
): T {
  const inner = client.$transaction.bind(client);
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (...args: unknown[]) => {
          const gated = withSqliteTransactionOptions(args);
          return runPrismaOp('$transaction', gated, (a) =>
            inner(...((Array.isArray(a) ? a : [a]) as any[])),
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

const extended =
  typeof base.$extends === 'function'
    ? base.$extends({
        query: {
          async $allOperations({
            operation,
            args,
            query,
          }: {
            operation?: unknown;
            args: unknown;
            query: (a: unknown) => Promise<unknown>;
          }) {
            return runPrismaOp(operation, args, query);
          },
        },
      })
    : base;

export const prisma = gateTransactions(extended);

/** WAL + busy_timeout on every pooled connection. Call once at host boot. */
export async function configureSqlite(): Promise<void> {
  if (sqliteConfigured) return;
  await base.$connect();
  await applyPragmas();
  sqliteConfigured = true;
}
