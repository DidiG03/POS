/**
 * Provision a new tenant (business + first admin).
 *
 * Credentials are supplied through the environment and are never
 * written to source or echoed back. An earlier version of this script
 * hardcoded a live business's access password and admin PIN, which put
 * working production credentials into git history.
 *
 * Usage (from server/):
 *   BUSINESS_CODE=ACMECAFE \
 *   BUSINESS_NAME="Acme Cafe" \
 *   ACCESS_PASSWORD='…' \
 *   ADMIN_PIN='…' \
 *   pnpm tsx scripts/registerBusiness.ts
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.js';

function required(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    console.error(`[register] Missing required environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

const BUSINESS_CODE = required('BUSINESS_CODE').toUpperCase();
const BUSINESS_NAME = required('BUSINESS_NAME');
const ACCESS_PASSWORD = required('ACCESS_PASSWORD');
const ADMIN_PIN = required('ADMIN_PIN');
const ADMIN_NAME = String(process.env.ADMIN_NAME || 'Admin').trim();

function validate(): void {
  const problems: string[] = [];
  if (!/^[A-Z0-9]{2,24}$/.test(BUSINESS_CODE)) {
    problems.push('BUSINESS_CODE must be 2-24 characters, A-Z and 0-9 only.');
  }
  if (!/^\d{4,6}$/.test(ADMIN_PIN)) {
    problems.push('ADMIN_PIN must be 4-6 digits.');
  }
  if (ADMIN_PIN === '1234' || ADMIN_PIN === '0000') {
    problems.push('ADMIN_PIN is a well-known default; choose another.');
  }
  if (ACCESS_PASSWORD.length < 12) {
    problems.push('ACCESS_PASSWORD must be at least 12 characters.');
  }
  if (problems.length) {
    for (const p of problems) console.error(`[register] ${p}`);
    process.exit(1);
  }
}

async function main() {
  validate();
  console.log('[register] Creating business', BUSINESS_CODE, '…');

  const existing = await prisma.business.findUnique({
    where: { code: BUSINESS_CODE },
  });
  if (existing) {
    console.log('[register] Business already exists. Skipping.');
    return;
  }

  const [pinHash, accessPasswordHash] = await Promise.all([
    bcrypt.hash(ADMIN_PIN, 10),
    bcrypt.hash(ACCESS_PASSWORD, 10),
  ]);

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

  // Deliberately does not print the PIN or password: this output ends up
  // in shell history and CI logs.
  console.log('[register] Done.');
  console.log('  Business:', created.name, '| Code:', created.code);
  console.log('  Admin:', created.users[0]!.displayName);
  console.log('  Credentials were taken from the environment; not echoed.');
}

main()
  .catch((e) => {
    console.error('[register] Failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
