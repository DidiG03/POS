import { prisma } from '../src/db/client';

async function main() {
  // Works for the local SQLite DB (Electron host).
  // Leaves schema + _prisma_migrations intact, but deletes all business data.
  console.log('[db:wipe] Starting local DB wipe…');

  // Determine DB file path (best-effort).
  try {
    const rows = (await (prisma as any).$queryRawUnsafe('PRAGMA database_list;')) as any[];
    const mainDb = Array.isArray(rows) ? rows.find((r) => String(r?.name || r?.[1] || '') === 'main') : null;
    const file = String(mainDb?.file ?? mainDb?.[2] ?? '');
    if (file) console.log(`[db:wipe] SQLite file: ${file}`);
  } catch {
    // ignore
  }

  // List all tables in SQLite, excluding internal tables.
  const tables: Array<{ name: string }> = await (prisma as any).$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';`,
  );

  const names = (tables || [])
    .map((t) => String((t as any).name || ''))
    .filter(Boolean)
    // Keep Prisma migrations history so future migrations don't get confused.
    .filter((n) => n !== '_prisma_migrations');

  console.log(`[db:wipe] Tables to clear: ${names.length}`);

  // Disable FK checks temporarily to avoid delete ordering issues.
  await (prisma as any).$executeRawUnsafe('PRAGMA foreign_keys=OFF;');
  try {
    for (const n of names) {
      await (prisma as any).$executeRawUnsafe(`DELETE FROM "${n}";`);
    }
    // Reset autoincrement counters (nice clean start)
    await (prisma as any).$executeRawUnsafe(`DELETE FROM sqlite_sequence;`).catch(() => null);
  } finally {
    await (prisma as any).$executeRawUnsafe('PRAGMA foreign_keys=ON;').catch(() => null);
  }

  console.log('[db:wipe] Done. Local DB is now empty.');
}

main()
  .catch((e) => {
    console.error('[db:wipe] Failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });

