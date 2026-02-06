import type { PrismaClient } from '@prisma/client';

let timer: NodeJS.Timeout | null = null;

export type NotificationRetentionOptions = {
  /**
   * Delete notifications older than this many days.
   * Default: 7 (one week)
   */
  days?: number;
  /**
   * How often to run the cleanup.
   * Default: every 6 hours.
   */
  intervalMs?: number;
};

async function cleanupOnce(prisma: PrismaClient, days: number) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs);
  const res = await prisma.notification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (res.count > 0) {
    console.log(
      `[Notifications] Deleted ${res.count} notifications older than ${days}d`,
    );
  }
}

export function startNotificationRetentionLoop(
  prisma: PrismaClient,
  opts: NotificationRetentionOptions = {},
) {
  if (timer) return;
  const days = Number.isFinite(Number(opts.days)) ? Number(opts.days) : 7;
  const intervalMs = Number.isFinite(Number(opts.intervalMs))
    ? Number(opts.intervalMs)
    : 6 * 60 * 60 * 1000;

  // Run once on boot, then periodically.
  cleanupOnce(prisma, Math.max(1, days)).catch(() => {});
  timer = setInterval(
    () => {
      cleanupOnce(prisma, Math.max(1, days)).catch(() => {});
    },
    Math.max(60_000, intervalMs),
  );
}

export function stopNotificationRetentionLoop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
