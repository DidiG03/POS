import type { PrismaClient } from '@prisma/client';

let timer: NodeJS.Timeout | null = null;
let activeDayKey: string | null = null;

export function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Local calendar start (00:00:00.000) using the PC clock. */
export function localDayStart(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function kdsStationListWhere(station: string, status: string) {
  const st = String(station || 'KITCHEN').toUpperCase();
  const stat = String(status || 'NEW').toUpperCase();
  const where: Record<string, unknown> = { station: st, status: stat };
  if (stat === 'DONE') {
    where.bumpedAt = { gte: localDayStart() };
  }
  return where;
}

async function cleanupOrphanKdsRows(tx: any) {
  await tx.$executeRawUnsafe(
    `DELETE FROM "KdsTicket" WHERE "id" NOT IN (SELECT DISTINCT "ticketId" FROM "KdsTicketStation");`,
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM "KdsOrder" WHERE "id" NOT IN (SELECT DISTINCT "orderId" FROM "KdsTicket");`,
  );
}

/** Deletes every bumped (DONE) KDS ticket. NEW tickets are kept. */
export async function purgeAllKdsDoneTickets(prisma: PrismaClient) {
  let purgedDoneRows = 0;
  await (prisma as any).$transaction(async (tx: any) => {
    const res = await tx.kdsTicketStation.deleteMany({
      where: { status: 'DONE' },
    });
    purgedDoneRows = res.count;
    await cleanupOrphanKdsRows(tx);
  });
  if (purgedDoneRows > 0) {
    console.log(
      `[KDS] Midnight purge: removed ${purgedDoneRows} Done ticket row(s)`,
    );
  }
  return { purgedDoneRows, dayKey: dayKeyLocal() };
}

/** Removes Done tickets from before today (PC was off at midnight). */
export async function purgeStaleKdsDoneTickets(prisma: PrismaClient) {
  const start = localDayStart();
  let purgedDoneRows = 0;
  await (prisma as any).$transaction(async (tx: any) => {
    const res = await tx.kdsTicketStation.deleteMany({
      where: {
        status: 'DONE',
        bumpedAt: { lt: start },
      },
    });
    purgedDoneRows = res.count;
    if (purgedDoneRows > 0) {
      await cleanupOrphanKdsRows(tx);
    }
  });
  if (purgedDoneRows > 0) {
    console.log(
      `[KDS] Removed ${purgedDoneRows} stale Done ticket row(s) from before ${dayKeyLocal()}`,
    );
  }
  return { purgedDoneRows, dayKey: dayKeyLocal() };
}

/** Removes all Done tickets for one station (clears the Done tab). */
export async function purgeKdsDoneTicketsForStation(
  prisma: PrismaClient,
  station: string,
) {
  const st = String(station || 'KITCHEN').toUpperCase();
  let purgedDoneRows = 0;
  await (prisma as any).$transaction(async (tx: any) => {
    const res = await tx.kdsTicketStation.deleteMany({
      where: {
        station: st,
        status: 'DONE',
      },
    });
    purgedDoneRows = res.count;
    if (purgedDoneRows > 0) {
      await cleanupOrphanKdsRows(tx);
    }
  });
  return { ok: true as const, purgedDoneRows };
}

/**
 * Watches the PC clock; when the local date rolls past 00:00, clears all Done KDS tickets.
 * NEW/active tickets are never removed by this job.
 */
export function startKdsRetentionLoop(
  prisma: PrismaClient,
  opts: { intervalMs?: number } = {},
) {
  if (timer) return;
  const intervalMs = Number.isFinite(Number(opts.intervalMs))
    ? Number(opts.intervalMs)
    : 60 * 1000;

  activeDayKey = dayKeyLocal();

  const run = async () => {
    const today = dayKeyLocal();
    if (activeDayKey && today !== activeDayKey) {
      activeDayKey = today;
      await purgeAllKdsDoneTickets(prisma);
      return;
    }
    activeDayKey = today;
  };

  purgeStaleKdsDoneTickets(prisma).catch((e) => {
    console.error('[KDS] Stale Done purge failed', e);
  });
  run().catch((e) => {
    console.error('[KDS] Day rollover check failed', e);
  });
  timer = setInterval(
    () => {
      run().catch((e) => {
        console.error('[KDS] Day rollover check failed', e);
      });
    },
    Math.max(15_000, intervalMs),
  );
}

export function stopKdsRetentionLoop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  activeDayKey = null;
}
