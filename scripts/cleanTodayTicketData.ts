/**
 * Deletes today's POS ticket flow data from the local SQLite DB so you can
 * retest transfers / payments without double-counts from old rows.
 *
 * Usage:
 *   pnpm db:clean-today              # dry-run (counts only)
 *   pnpm db:clean-today -- --yes     # perform delete
 *
 * Clears: TicketLog, PrintJob, Covers, TicketRequest, KDS rows for today,
 * resets KdsDayCounter for today, and clears tables:open / tables:openAt.
 * Does NOT delete users, menu, shifts, reservations, inventory, etc.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../src/db/client';

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function localDayRange(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
    999,
  );
  return { start, end };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--yes');
  const { start, end } = localDayRange();
  const dayKey = dayKeyLocal();

  const whereToday = { gte: start, lte: end } as const;

  const counts = {
    ticketLog: await prisma.ticketLog.count({
      where: { createdAt: whereToday },
    }),
    printJob: await prisma.printJob.count({
      where: { createdAt: whereToday },
    }),
    covers: await prisma.covers.count({
      where: { createdAt: whereToday },
    }),
    ticketRequest: await prisma.ticketRequest.count({
      where: { createdAt: whereToday },
    }),
    kdsOrderTodayKey: await prisma.kdsOrder.count({
      where: { dayKey },
    }),
  };

  console.log(`[db:clean-today] Local calendar day: ${dayKey}`);
  console.log(`[db:clean-today] Range: ${start.toISOString()} … ${end.toISOString()}`);
  console.log('[db:clean-today] Rows to remove:', counts);

  if (dryRun) {
    console.log(
      '\n[db:clean-today] Dry run. Re-run with --yes to delete and reset open tables.',
    );
    process.exitCode = 0;
    return;
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const orderIds = (
      await tx.kdsOrder.findMany({
        where: { dayKey },
        select: { id: true },
      })
    ).map((o) => o.id);

    if (orderIds.length) {
      const ticketIds = (
        await tx.kdsTicket.findMany({
          where: { orderId: { in: orderIds } },
          select: { id: true },
        })
      ).map((t) => t.id);

      if (ticketIds.length) {
        await tx.kdsTicketStation.deleteMany({
          where: { ticketId: { in: ticketIds } },
        });
      }
      await tx.kdsTicket.deleteMany({ where: { orderId: { in: orderIds } } });
      await tx.kdsOrder.deleteMany({ where: { id: { in: orderIds } } });
    }

    await tx.kdsDayCounter.deleteMany({ where: { dayKey } });

    await tx.ticketLog.deleteMany({ where: { createdAt: whereToday } });
    await tx.printJob.deleteMany({ where: { createdAt: whereToday } });
    await tx.covers.deleteMany({ where: { createdAt: whereToday } });
    await tx.ticketRequest.deleteMany({ where: { createdAt: whereToday } });

    for (const key of ['tables:open', 'tables:openAt'] as const) {
      await tx.syncState.upsert({
        where: { key },
        create: { key, valueJson: {} },
        update: { valueJson: {} },
      });
    }
  });

  console.log('[db:clean-today] Done. Open-table maps cleared; ticket data for today removed.');
}

main()
  .catch((e) => {
    console.error('[db:clean-today] Failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
