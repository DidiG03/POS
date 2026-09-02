/**
 * Local SQLite migration runner.
 *
 * A fresh install ships a `seed.db` that `buildSeedDb.mjs` already put
 * through `prisma migrate deploy`. An UPGRADE, however, reuses the
 * customer's existing database — and the packaged app has no Prisma CLI
 * to migrate it with. The previous approach was a hand-maintained list
 * of `ALTER TABLE` statements, which drifted from `prisma/migrations/`
 * and left upgraded installs missing columns (and crashing on queries
 * that referenced them).
 *
 * This applies the real migration files instead, using the same
 * `_prisma_migrations` bookkeeping table as the CLI, so a database
 * migrated here is indistinguishable from one migrated by Prisma and
 * stays compatible with `prisma migrate status` / `deploy` later.
 *
 * Two deliberate accommodations for databases that were previously
 * patched by hand:
 *
 *   - Statements that fail because the change is already present
 *     ("duplicate column name", "already exists") are treated as
 *     satisfied rather than fatal, so a hand-patched database converges
 *     instead of deadlocking on its first pending migration.
 *   - A migration is only recorded once all of its statements have been
 *     accounted for; a genuine failure stops the run and leaves it
 *     unrecorded so the next boot retries it.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prisma } from '@db/client';

export interface MigrationResult {
  /** Migrations executed during this run. */
  applied: string[];
  /** Migrations whose changes were already present in the database. */
  converged: string[];
  /** Migration that stopped the run, if any. */
  failed: { name: string; error: string } | null;
  /** Total migrations already recorded before this run. */
  alreadyApplied: number;
}

const PRISMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

/**
 * Errors meaning "the schema already looks like this". Re-applying a
 * migration onto a hand-patched database is expected to hit these.
 */
function isAlreadySatisfied(error: unknown): boolean {
  const msg = String((error as any)?.message || error || '').toLowerCase();
  return (
    msg.includes('duplicate column name') ||
    msg.includes('already exists') ||
    msg.includes('duplicate index')
  );
}

/**
 * Split a migration file into executable statements.
 *
 * Prisma's SQLite migrations are DDL plus `PRAGMA` directives, but they
 * do contain string literals (default values) and quoted identifiers,
 * so a naive split on `;` is not safe.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === '-' && next === '-') {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
      if (ch === ';') {
        const trimmed = current.trim();
        if (trimmed) statements.push(trimmed);
        current = '';
        continue;
      }
    }

    if (ch === "'" && !inDouble) {
      // '' inside a string is an escaped quote, not a terminator.
      if (inSingle && next === "'") {
        current += "''";
        i++;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Prisma records the sha256 of the migration file as its checksum. */
function checksumOf(contents: string): string {
  return crypto.createHash('sha256').update(contents, 'utf8').digest('hex');
}

/** Migration directory names are timestamp-prefixed, so name order is apply order. */
function listMigrationDirs(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) =>
      fs.existsSync(path.join(migrationsDir, name, 'migration.sql')),
    )
    .sort();
}

async function readAppliedMigrations(): Promise<Set<string>> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "migration_name" FROM "_prisma_migrations"
     WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
  )) as Array<{ migration_name: string }>;
  return new Set(rows.map((r) => String(r.migration_name)));
}

async function recordMigration(
  name: string,
  checksum: string,
  steps: number,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "_prisma_migrations"
       ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
     VALUES (?, ?, current_timestamp, ?, current_timestamp, ?)`,
    crypto.randomUUID(),
    checksum,
    name,
    steps,
  );
}

/**
 * Apply every migration in `migrationsDir` that this database has not
 * recorded yet.
 *
 * `onBeforeApply` runs only when there is at least one pending
 * migration — the caller uses it to take a backup, which should not
 * happen on the overwhelmingly common no-op boot.
 */
export async function runPendingMigrations(
  migrationsDir: string,
  options?: { onBeforeApply?: () => Promise<void> },
): Promise<MigrationResult> {
  const result: MigrationResult = {
    applied: [],
    converged: [],
    failed: null,
    alreadyApplied: 0,
  };

  if (!migrationsDir || !fs.existsSync(migrationsDir)) {
    console.warn(
      `[migrator] Migrations directory not found at ${migrationsDir}; skipping.`,
    );
    return result;
  }

  await prisma.$executeRawUnsafe(PRISMA_MIGRATIONS_DDL);

  const applied = await readAppliedMigrations();
  result.alreadyApplied = applied.size;

  const pending = listMigrationDirs(migrationsDir).filter(
    (name) => !applied.has(name),
  );
  if (pending.length === 0) return result;

  console.log(
    `[migrator] ${pending.length} pending migration(s): ${pending.join(', ')}`,
  );

  if (options?.onBeforeApply) {
    try {
      await options.onBeforeApply();
    } catch (e: any) {
      console.warn(`[migrator] Pre-migration hook failed: ${e?.message || e}`);
    }
  }

  for (const name of pending) {
    const file = path.join(migrationsDir, name, 'migration.sql');
    let contents: string;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch (e: any) {
      result.failed = { name, error: `unreadable: ${e?.message || e}` };
      break;
    }

    const statements = splitSqlStatements(contents);
    let executed = 0;
    let convergedOnly = true;
    let failure: string | null = null;

    // One migration, one transaction. Applying the statements one at a time
    // in autocommit meant a file that failed halfway left the earlier DDL
    // committed but the migration unrecorded, so the next boot replayed it
    // against a half-changed schema and could converge it to "applied" with
    // the remaining statements never having run. That leaves a database whose
    // shape nobody can reason about, and it surfaces as a screen crashing on
    // a missing column days later. This mirrors `prisma migrate deploy`,
    // which is what the shipped seed database is built with.
    let inTransaction = false;
    try {
      await prisma.$executeRawUnsafe('BEGIN');
      inTransaction = true;
    } catch (e: any) {
      // An engine that will not start a transaction still gets the migration
      // applied — the old, non-atomic behaviour is better than not upgrading.
      console.warn(
        `[migrator] Could not open a transaction for ${name}: ${e?.message || e}`,
      );
    }

    for (const statement of statements) {
      try {
        await prisma.$executeRawUnsafe(statement);
        executed += 1;
        convergedOnly = false;
      } catch (e: any) {
        if (isAlreadySatisfied(e)) {
          executed += 1;
          continue;
        }
        failure = String(e?.message || e);
        break;
      }
    }

    // Bookkeeping joins the same transaction, so "schema changed" and
    // "migration recorded" can never disagree.
    if (!failure) {
      try {
        await recordMigration(name, checksumOf(contents), executed);
      } catch (e: any) {
        failure = `bookkeeping write failed: ${e?.message || e}`;
      }
    }

    if (inTransaction) {
      try {
        await prisma.$executeRawUnsafe(failure ? 'ROLLBACK' : 'COMMIT');
      } catch (e: any) {
        if (!failure) failure = `commit failed: ${e?.message || e}`;
      }
    }

    if (failure) {
      // Leave it unrecorded so the next boot retries from a clean schema.
      result.failed = { name, error: failure };
      console.error(`[migrator] Migration ${name} failed: ${failure}`);
      break;
    }

    if (convergedOnly && statements.length > 0) {
      result.converged.push(name);
      console.log(`[migrator] ${name} was already present; recorded.`);
    } else {
      result.applied.push(name);
      console.log(`[migrator] Applied ${name} (${executed} statement(s)).`);
    }
  }

  return result;
}
