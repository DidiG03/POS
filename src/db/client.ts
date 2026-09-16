import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import pkg from '@prisma/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { AsyncMutex } from '@shared/asyncMutex';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  withSqliteRetry,
  withSqliteTransactionOptions,
} from './sqliteBusy';
import { sqliteConnectionUrl, sqliteFileUrl } from './sqliteUrl';
import { isSqliteWriteOperation } from './sqliteWrite';

const { PrismaClient } = pkg as unknown as {
  PrismaClient: new (args?: object) => any;
};

/** Negative cache_size is KiB. 32 MB so floor/KDS reads stay in the pager. */
const SQLITE_CACHE_SIZE_KIB = 32_768;
/** 64 MB mmap for sequential TicketLog / Order scans. */
const SQLITE_MMAP_SIZE_BYTES = 67_108_864;

const PRAGMAS = [
  'PRAGMA journal_mode=WAL;',
  `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`,
  'PRAGMA synchronous=NORMAL;',
  'PRAGMA foreign_keys=ON;',
  'PRAGMA temp_store=MEMORY;',
  `PRAGMA cache_size=-${SQLITE_CACHE_SIZE_KIB};`,
  `PRAGMA mmap_size=${SQLITE_MMAP_SIZE_BYTES};`,
  'PRAGMA wal_autocheckpoint=1000;',
];

const writeMutex = new AsyncMutex();
const writeDepth = new AsyncLocalStorage<number>();

/** Unextended Prisma client. Pragmas must run here, not through `$extends`. */
let raw: any = null;
let inner: any = null;
let sqliteConfigured = false;
let openMode: 'plain' | 'encrypted' | 'none' = 'none';

function isVaultLockEnabled(): boolean {
  return String(process.env.POS_VAULT_LOCK || '').trim() === '1';
}

function createPlainClient(url: string) {
  return new PrismaClient({
    datasources: { db: { url: sqliteConnectionUrl(url) } },
  });
}

function createEncryptedClient(file: string, encryptionKey: string) {
  const adapter = new PrismaLibSQL({
    url: sqliteFileUrl(file),
    encryptionKey,
  });
  return new PrismaClient({ adapter });
}

function attachClient(client: any, mode: 'plain' | 'encrypted'): void {
  raw = client;
  inner = wrapClient(client);
  openMode = mode;
  sqliteConfigured = false;
}

function wrapClient(client: any): any {
  const extended =
    typeof client.$extends === 'function'
      ? client.$extends({
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
      : client;
  return gateTransactions(extended);
}

async function applyPragmas(): Promise<void> {
  if (!raw) requireClient();
  const client = raw;
  if (!client) return;
  await withSqliteRetry(async () => {
    for (const sql of PRAGMAS) {
      await client.$queryRawUnsafe(sql);
    }
    // Refresh query-planner stats if sqlite_stat1 is stale. SQLite no-ops
    // when nothing useful can be done, so this is cheap on a quiet boot.
    await client.$queryRawUnsafe('PRAGMA optimize;');
  });
}

async function runPrismaOp(
  operation: unknown,
  args: unknown,
  query: (a: unknown) => Promise<unknown>,
): Promise<unknown> {
  if (!sqliteConfigured) {
    // Mark configured before awaiting. `$queryRawUnsafe` on the extended
    // client re-enters this function; without the flag Electron grows the
    // heap until V8 OOMs (~4GB) and the till never opens.
    sqliteConfigured = true;
    try {
      await applyPragmas();
    } catch {
      sqliteConfigured = false;
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
  const txn = client.$transaction.bind(client);
  return new Proxy(client, {
    get(target, prop, _receiver) {
      if (prop === '$transaction') {
        return (...args: unknown[]) => {
          const gated = withSqliteTransactionOptions(args);
          return runPrismaOp('$transaction', gated, (a) =>
            txn(...((Array.isArray(a) ? a : [a]) as any[])),
          );
        };
      }
      return Reflect.get(target, prop);
    },
  }) as T;
}

function requireClient(): any {
  if (inner) return inner;
  if (isVaultLockEnabled()) {
    throw new Error('POS_DB_LOCKED');
  }
  attachClient(createPlainClient(process.env.DATABASE_URL || ''), 'plain');
  return inner;
}

export function isPrismaOpen(): boolean {
  return inner != null;
}

/** True while the till vault has not opened Prisma yet. */
export function isSqliteLocked(): boolean {
  return !inner && isVaultLockEnabled();
}

export function getOpenSqliteMode(): 'plain' | 'encrypted' | 'none' {
  return inner ? openMode : 'none';
}

export function resolveSqliteFilePath(): string {
  const url = String(process.env.DATABASE_URL || '')
    .trim()
    .replace(/^file:/, '')
    .split('?')[0];
  if (url) return path.resolve(url);
  return path.resolve('./dev.db');
}

export async function disconnectPrisma(): Promise<void> {
  if (!inner) return;
  try {
    if (raw) await raw.$queryRawUnsafe('PRAGMA optimize;');
  } catch {
    // ignore
  }
  try {
    await inner.$disconnect();
  } catch {
    // ignore
  }
  inner = null;
  raw = null;
  sqliteConfigured = false;
  openMode = 'none';
}

export async function openPlainSqlite(url?: string): Promise<void> {
  await disconnectPrisma();
  attachClient(
    createPlainClient(url || process.env.DATABASE_URL || ''),
    'plain',
  );
  await configureSqlite();
}

export async function openEncryptedSqlite(
  file: string,
  encryptionKey: string,
): Promise<void> {
  await disconnectPrisma();
  process.env.POS_VAULT_LOCK = '';
  attachClient(createEncryptedClient(file, encryptionKey), 'encrypted');
  await configureSqlite();
}

export const prisma = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (prop === '$disconnect' && !inner) {
        return async () => disconnectPrisma();
      }
      const client = requireClient();
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    },
  },
) as any;

/** WAL, cache, mmap, and PRAGMA optimize. Call once at host boot. */
export async function configureSqlite(): Promise<void> {
  if (sqliteConfigured) return;
  requireClient();
  if (raw && typeof raw.$connect === 'function') {
    await raw.$connect();
  }
  await applyPragmas();
  sqliteConfigured = true;
}
