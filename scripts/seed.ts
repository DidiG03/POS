import 'dotenv/config';
import { prisma } from '../src/db/client.js';
import bcrypt from 'bcryptjs';

/**
 * Idempotent development seed.
 *
 * Safe to run repeatedly (`pnpm db:seed`): every record is upserted on a
 * stable key (user/category/table id, menu-item sku, area name) so a second
 * run converges to the same state instead of creating duplicates.
 *
 * Produces a minimal but fully usable POS: an admin, an order-taking waiter
 * and cashier (all PIN 1234 for local dev), a couple of menu categories with
 * items, and a floor area with a few tables — enough to exercise the
 * login → clock-in → table → order flow end to end.
 */
async function main() {
  const devPinHash = bcrypt.hashSync('1234', 10);

  await prisma.user.upsert({
    where: { id: 1 },
    update: { displayName: 'Admin', role: 'ADMIN', pinHash: devPinHash, active: true },
    create: { id: 1, displayName: 'Admin', role: 'ADMIN', pinHash: devPinHash, active: true },
  });
  await prisma.user.upsert({
    where: { id: 2 },
    update: { displayName: 'Sara (Waiter)', role: 'WAITER', pinHash: devPinHash, active: true },
    create: { id: 2, displayName: 'Sara (Waiter)', role: 'WAITER', pinHash: devPinHash, active: true },
  });
  await prisma.user.upsert({
    where: { id: 3 },
    update: { displayName: 'Alex (Cashier)', role: 'CASHIER', pinHash: devPinHash, active: true },
    create: { id: 3, displayName: 'Alex (Cashier)', role: 'CASHIER', pinHash: devPinHash, active: true },
  });

  const drinks = await prisma.category.upsert({
    where: { id: 1 },
    update: { name: 'Drinks', sortOrder: 1, active: true },
    create: { id: 1, name: 'Drinks', sortOrder: 1, active: true },
  });
  const food = await prisma.category.upsert({
    where: { id: 2 },
    update: { name: 'Food', sortOrder: 2, active: true },
    create: { id: 2, name: 'Food', sortOrder: 2, active: true },
  });

  const items = [
    { sku: 'ESP', name: 'Espresso', categoryId: drinks.id, price: 2.0, vatRate: 0.2 },
    { sku: 'CAP', name: 'Cappuccino', categoryId: drinks.id, price: 2.5, vatRate: 0.2 },
    { sku: 'GSAL', name: 'Greek Salad', categoryId: food.id, price: 5.9, vatRate: 0.2 },
    { sku: 'BURG', name: 'Cheeseburger', categoryId: food.id, price: 8.5, vatRate: 0.2 },
  ];
  for (const it of items) {
    await prisma.menuItem.upsert({
      where: { sku: it.sku },
      update: { name: it.name, categoryId: it.categoryId, price: it.price, vatRate: it.vatRate, active: true },
      create: { ...it, active: true },
    });
  }

  await prisma.area.upsert({
    where: { name: 'Main' },
    update: { sortOrder: 1, active: true, defaultCount: 4 },
    create: { name: 'Main', sortOrder: 1, active: true, defaultCount: 4 },
  });

  for (let i = 1; i <= 4; i++) {
    await prisma.table.upsert({
      where: { id: i },
      update: { label: `T${i}`, area: 'Main', seats: 4, active: true },
      create: { id: i, label: `T${i}`, area: 'Main', seats: 4, active: true },
    });
  }

  // Shared floor layout so the waiter Tables view renders tappable tables
  // out of the box (key format mirrors the LAN API: `layout:global:<area>`).
  const floorNodes = [
    { kind: 'TABLE', label: 'T1', x: 200, y: 180, shape: 'circle', seats: 4 },
    { kind: 'TABLE', label: 'T2', x: 380, y: 180, shape: 'square', seats: 4 },
    { kind: 'TABLE', label: 'T3', x: 200, y: 340, shape: 'square', seats: 4 },
    { kind: 'TABLE', label: 'T4', x: 380, y: 340, shape: 'circle', seats: 4 },
  ];
  await prisma.syncState.upsert({
    where: { key: 'layout:global:Main' },
    update: { valueJson: { nodes: floorNodes } },
    create: { key: 'layout:global:Main', valueJson: { nodes: floorNodes } },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log('Seed completed');
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
