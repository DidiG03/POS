/**
 * Wipes all business data from the cloud PostgreSQL database.
 * Run from server/: pnpm db:wipe
 * Requires DATABASE_URL in server/.env pointing to the cloud DB.
 */
import 'dotenv/config';
import { prisma } from '../src/db.js';

async function main() {
  console.log('[db:wipe] Starting cloud DB wipe…');

  // PostgreSQL: TRUNCATE Business CASCADE removes Business and all tables with FK to it
  await (prisma as any).$executeRawUnsafe(`TRUNCATE TABLE "Business" CASCADE;`);

  console.log('[db:wipe] Done. Cloud DB is now empty.');
}

main()
  .catch((e) => {
    console.error('[db:wipe] Failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
