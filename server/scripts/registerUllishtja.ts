/**
 * Registers business UllishtjaAgroturizem with admin PIN 1234 and access password Sefrid2003.
 * Run from server/: pnpm run register:ullishtja
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.js';

const BUSINESS_CODE = 'ULLISHTJAAGROTURIZEM';
const BUSINESS_NAME = 'Ullishtja Agroturizem';
const ACCESS_PASSWORD = 'Sefrid2003';
const ADMIN_NAME = 'Admin';
const ADMIN_PIN = '1234';

async function main() {
  console.log('[register] Creating business', BUSINESS_CODE, '…');

  const existing = await prisma.business.findUnique({ where: { code: BUSINESS_CODE } });
  if (existing) {
    console.log('[register] Business already exists. Skipping.');
    return;
  }

  const pinHash = await bcrypt.hash(ADMIN_PIN, 10);
  const accessPasswordHash = await bcrypt.hash(ACCESS_PASSWORD, 10);

  const created = await prisma.business.create({
    data: {
      name: BUSINESS_NAME,
      code: BUSINESS_CODE,
      active: true,
      accessPasswordHash,
      users: {
        create: {
          displayName: ADMIN_NAME,
          role: 'ADMIN',
          pinHash,
          active: true,
        },
      },
    },
    include: { users: true },
  });

  const admin = created.users[0]!;
  console.log('[register] Done.');
  console.log('  Business:', created.name, '| Code:', created.code);
  console.log('  Admin:', admin.displayName, '| PIN:', ADMIN_PIN);
  console.log('  Cloud access password:', ACCESS_PASSWORD);
  console.log('');
  console.log('You can now log in with:');
  console.log('  - Business code:', BUSINESS_CODE);
  console.log('  - Access password:', ACCESS_PASSWORD);
  console.log('  - Admin PIN:', ADMIN_PIN);
}

main()
  .catch((e) => {
    console.error('[register] Failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
