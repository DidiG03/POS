import 'dotenv/config';
import { prisma } from '../src/db/client.js';
import bcrypt from 'bcryptjs';

async function main() {
  const adminPin = '1234';
  const pinHash = bcrypt.hashSync(adminPin, 10);

  await prisma.user.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, displayName: 'Admin', role: 'ADMIN', pinHash, active: true },
  });

  const drinks = await prisma.category.create({ data: { name: 'Drinks', sortOrder: 1 } });
  const food = await prisma.category.create({ data: { name: 'Food', sortOrder: 2 } });

  await prisma.menuItem.createMany({
    data: [
      { name: 'Espresso', sku: 'ESP', categoryId: drinks.id, price: 2.0, vatRate: 0.2, active: true },
      { name: 'Cappuccino', sku: 'CAP', categoryId: drinks.id, price: 2.5, vatRate: 0.2, active: true },
      { name: 'Greek Salad', sku: 'GSAL', categoryId: food.id, price: 5.9, vatRate: 0.2, active: true },
    ],
  });

  await prisma.table.createMany({
    data: [
      { label: 'T1', area: 'Main Hall', seats: 4 },
      { label: 'T2', area: 'Main Hall', seats: 4 },
      { label: 'T3', area: 'Terrace', seats: 4 },
    ],
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


