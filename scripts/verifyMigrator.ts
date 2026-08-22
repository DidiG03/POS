/**
 * End-to-end check for the packaged-app migration runner.
 *
 * Simulates the upgrade path that was broken: a customer database
 * created by an older release (missing the most recent migrations) that
 * is then opened by a newer build. Verifies the runner converges it to
 * the current schema without losing data.
 *
 * Each scenario runs in its own child process. The Prisma client is a
 * module singleton that resolves DATABASE_URL when it is first
 * constructed, so several databases cannot be exercised from one
 * process — the second would silently reuse the first one's connection.
 *
 * Run with:  pnpm tsx scripts/verifyMigrator.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations');
const HOLD_BACK = 3;

// ---- child mode ----------------------------------------------------
// `verifyMigrator.ts --run <dbFile>` migrates one database and prints
// the result as JSON for the parent to assert on.
if (process.argv[2] === '--run') {
  const dbFile = String(process.argv[3] || '');
  process.env.DATABASE_URL = `file:${dbFile.split(path.sep).join('/')}`;
  const { runPendingMigrations } = await import(
    '../src/main/services/migrator'
  );
  const result = await runPendingMigrations(MIGRATIONS);
  console.log(`__RESULT__${JSON.stringify(result)}`);
  process.exit(0);
}

function sqlite(dbFile: string, sql: string): string {
  // SQL goes in on stdin: multi-statement scripts are unreliable as a
  // command-line argument.
  const r = spawnSync('sqlite3', [dbFile], { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr || 'sqlite3 failed');
  if (String(r.stderr || '').trim()) throw new Error(String(r.stderr).trim());
  return String(r.stdout || '').trim();
}

interface RunResult {
  applied: string[];
  converged: string[];
  failed: { name: string; error: string } | null;
  alreadyApplied: number;
}

function migrate(dbFile: string): RunResult {
  const r = spawnSync(
    'pnpm',
    ['tsx', 'scripts/verifyMigrator.ts', '--run', dbFile],
    { encoding: 'utf8', cwd: ROOT },
  );
  const line = String(r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    throw new Error(`child produced no result:\n${r.stdout}\n${r.stderr}`);
  }
  return JSON.parse(line.slice('__RESULT__'.length)) as RunResult;
}

function listMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(MIGRATIONS, n, 'migration.sql')))
    .sort();
}

/** Build a database frozen at an older migration state. */
function buildOldDb(dbFile: string, upTo: string[]): void {
  sqlite(
    dbFile,
    `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    );`,
  );
  for (const name of upTo) {
    sqlite(
      dbFile,
      fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'),
    );
    sqlite(
      dbFile,
      `INSERT INTO "_prisma_migrations"
         ("id","checksum","finished_at","migration_name","started_at","applied_steps_count")
       VALUES ('${name}','x',current_timestamp,'${name}',current_timestamp,1);`,
    );
  }
}

function columnsOf(dbFile: string, table: string): string[] {
  const out = sqlite(dbFile, `PRAGMA table_info("${table}");`);
  return out ? out.split('\n').map((l) => l.split('|')[1]) : [];
}

function recordedIn(dbFile: string): string[] {
  const out = sqlite(
    dbFile,
    'SELECT "migration_name" FROM "_prisma_migrations" ORDER BY "migration_name";',
  );
  return out ? out.split('\n').filter(Boolean) : [];
}

let ok = true;
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) ok = false;
  console.log(
    `${condition ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`,
  );
}

async function main() {
  const all = listMigrations();
  const older = all.slice(0, all.length - HOLD_BACK);
  const withheld = all.slice(all.length - HOLD_BACK);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-migrate-verify-'));

  console.log(`Migrations in repo: ${all.length}`);
  console.log(`Simulating an install that stopped at: ${older.at(-1)}`);
  console.log(`Withheld: ${withheld.join(', ')}\n`);

  // ---- Scenario 1: a plain outdated database ------------------------
  console.log('Scenario 1 — outdated install upgrades');
  const db1 = path.join(tmp, 'outdated.db');
  buildOldDb(db1, older);
  check(
    'starts without MenuItem.stockDay',
    !columnsOf(db1, 'MenuItem').includes('stockDay'),
  );

  const r1 = migrate(db1);
  check('no migration failed', r1.failed === null, r1.failed?.error);
  check(
    `applied the ${HOLD_BACK} withheld migrations`,
    r1.applied.length === HOLD_BACK,
    `applied=${r1.applied.length} converged=${r1.converged.length}`,
  );
  check(
    'MenuItem.stockDay now exists',
    columnsOf(db1, 'MenuItem').includes('stockDay'),
  );
  check(
    'Category.kdsStation now exists',
    columnsOf(db1, 'Category').includes('kdsStation'),
  );
  check('all migrations recorded', recordedIn(db1).length === all.length);

  // ---- Scenario 2: re-running is a no-op ----------------------------
  console.log('\nScenario 2 — second boot is a no-op');
  const r2 = migrate(db1);
  check('nothing applied', r2.applied.length === 0);
  check('nothing failed', r2.failed === null);
  check('all still recorded', r2.alreadyApplied === all.length);

  // ---- Scenario 3: hand-patched DB (ensureLocalDbColumns legacy) ----
  console.log('\nScenario 3 — database previously patched by hand');
  const db3 = path.join(tmp, 'handpatched.db');
  buildOldDb(db3, older);
  // Mimic the old self-heal: columns exist, no migration recorded.
  sqlite(db3, `ALTER TABLE "MenuItem" ADD COLUMN "stockDay" TEXT;`);
  sqlite(db3, `ALTER TABLE "Category" ADD COLUMN "kdsStation" TEXT;`);

  const r3 = migrate(db3);
  check(
    'converges instead of failing on duplicate columns',
    r3.failed === null,
    r3.failed?.error,
  );
  const missing3 = all.filter((m) => !recordedIn(db3).includes(m));
  check(
    'all migrations recorded',
    missing3.length === 0,
    missing3.length ? `missing=${missing3.join(',')}` : '',
  );
  check(
    'Reservation.externalId still applied',
    columnsOf(db3, 'Reservation').includes('externalId'),
  );

  // ---- Scenario 4: data survives ------------------------------------
  console.log('\nScenario 4 — existing rows survive');
  const db4 = path.join(tmp, 'withdata.db');
  buildOldDb(db4, older);
  sqlite(
    db4,
    `INSERT INTO "User" ("displayName","role","pinHash","active")
     VALUES ('Ana','WAITER','hash',1);`,
  );
  sqlite(
    db4,
    `INSERT INTO "Category" ("name","sortOrder") VALUES ('Drinks', 1);`,
  );
  const r4 = migrate(db4);
  check('no migration failed', r4.failed === null, r4.failed?.error);
  const name = sqlite(db4, `SELECT "displayName" FROM "User" LIMIT 1;`);
  check('user row preserved', name === 'Ana', `got "${name}"`);
  // The kds_station migration backfills existing categories.
  const station = sqlite(
    db4,
    `SELECT "kdsStation" FROM "Category" WHERE "name"='Drinks';`,
  );
  check('data migration backfilled Drinks → BAR', station === 'BAR', station);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok ? 'All scenarios passed.' : 'FAILURES DETECTED.'}`);
  process.exit(ok ? 0 : 1);
}

void main();
