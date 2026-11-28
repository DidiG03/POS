/**
 * The facts behind the status lights (`@shared/statusLights`), read on the
 * till. Printers and easyPos get a quick network check (connect only,
 * nothing is sent) at most every 10 s, and only while someone is looking:
 * a light turns within ~10 s of a printer or the internet going away.
 */
import net from 'node:net';
import { app } from 'electron';
import { prisma } from '@db/client';
import { APP_VERSION } from '@shared/appVersion';
import {
  aggregateStatusLights,
  type PrinterFact,
  type StatusFacts,
  type StatusLight,
} from '@shared/statusLights';
import { coreServices } from './core';
import { olderClients, onlineClients } from './clientVersions';
import { lastDatabaseBusyAt } from './dbBusy';
import { freeBytesAt } from './tillHealth';
import { readBackupSavedElsewhere } from './dbBackups';
import { logIgnored } from './logIgnored';

const PROBE_EVERY_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_500;
const probes = new Map<string, { at: number; ok: boolean }>();

/** Connect and close: does anything answer at host:port? */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.removeAllListeners();
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function cachedProbe(
  host: string,
  port: number,
  now: number,
): Promise<boolean> {
  const key = `${host}:${port}`;
  const hit = probes.get(key);
  if (hit && now - hit.at < PROBE_EVERY_MS) return hit.ok;
  const ok = await probeTcp(host, port);
  probes.set(key, { at: Date.now(), ok });
  return ok;
}

function rolesOf(id: string, routing: any): string[] {
  const roles: string[] = [];
  if (routing?.receiptPrinterId === id) roles.push('Receipts');
  for (const [st, pid] of Object.entries(routing?.station || {})) {
    if (pid === id)
      roles.push(
        st === 'KITCHEN'
          ? 'Kitchen'
          : st === 'BAR'
            ? 'Bar'
            : st === 'DESSERT'
              ? 'Desserts'
              : 'All',
      );
  }
  return roles;
}

async function printerFacts(
  settings: any,
  now: number,
): Promise<PrinterFact[]> {
  const list: any[] = Array.isArray(settings?.printers)
    ? settings.printers
    : [];
  const hourAgo = new Date(now - 3_600_000);
  return Promise.all(
    list
      .filter((p) => p && p.enabled !== false)
      .map(async (p) => {
        const id = String(p.id || '');
        const network =
          String(p.mode || 'NETWORK').toUpperCase() === 'NETWORK' && p.ip;
        const [reachable, retrying, failedRecently, last] = await Promise.all([
          network
            ? cachedProbe(String(p.ip), Number(p.port) || 9100, now)
            : Promise.resolve(null),
          prisma.printJob
            .count({ where: { printerProfileId: id, status: 'RETRY' } as any })
            .catch(() => 0),
          prisma.printJob
            .count({
              where: {
                printerProfileId: id,
                status: 'FAILED',
                createdAt: { gte: hourAgo },
              } as any,
            })
            .catch(() => 0),
          prisma.printJob
            .findFirst({
              where: {
                printerProfileId: id,
                status: { in: ['SENT', 'FAILED'] },
              } as any,
              orderBy: { id: 'desc' },
              select: { status: true, createdAt: true },
            })
            .catch(() => null),
        ]);
        return {
          name: String(p.name || id),
          roles: rolesOf(id, settings?.printerRouting),
          reachable,
          retrying,
          failedRecently,
          lastResult: last
            ? {
                ok: String(last.status) === 'SENT',
                at: new Date(last.createdAt as any).toISOString(),
              }
            : null,
        };
      }),
  );
}

async function fiscalFacts(
  settings: any,
  now: number,
): Promise<StatusFacts['fiscal']> {
  if (settings?.fiscal?.enabled !== true) {
    return {
      enabled: false,
      reachable: null,
      breakerOpen: false,
      reviews: 0,
      queued: 0,
    };
  }
  const [{ fiscalBreakerOpen }, claims] = await Promise.all([
    import('./fiscal/circuit'),
    import('./fiscal/claims'),
  ]);
  const [reviews, deferred] = await Promise.all([
    claims.listFiscalClaimsNeedingReview().catch(() => []),
    claims.listFiscalClaimsDeferred().catch(() => []),
  ]);
  const queued = deferred.filter((d) => !d.record.holdReason);
  let reachable: boolean | null = null;
  try {
    const u = new URL(String(settings.fiscal.baseUrl || ''));
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    reachable = await cachedProbe(u.hostname, port, now);
  } catch {
    reachable = null;
  }
  const oldest = queued.map((d) => d.record.createdAt).sort()[0] ?? null;
  return {
    enabled: true,
    reachable,
    breakerOpen: fiscalBreakerOpen(),
    reviews: reviews.length,
    queued: queued.length,
    oldestQueuedAt: oldest,
  };
}

let cache: { at: number; lights: StatusLight[]; reviews: number } | null = null;

/** The lights, read again at most every few seconds however many ask. */
export async function readStatusLights(now = Date.now()): Promise<{
  lights: StatusLight[];
  reviews: number;
  at: string;
}> {
  if (cache && now - cache.at < 3_000) {
    return {
      lights: cache.lights,
      reviews: cache.reviews,
      at: new Date(cache.at).toISOString(),
    };
  }
  const settings: any = await coreServices.readSettings();
  const { autoBackupConfig, readAutoBackupStatus } = await import(
    './autoBackup'
  );
  const [fiscal, printers, autoStatus, saved] = await Promise.all([
    fiscalFacts(settings, now),
    printerFacts(settings, now),
    readAutoBackupStatus().catch(() => null),
    readBackupSavedElsewhere().catch(logIgnored('statusLights:saved', null)),
  ]);
  const facts: StatusFacts = {
    now,
    fiscal,
    printers,
    backup: {
      auto: autoBackupConfig(settings).enabled,
      lastOkAt: autoStatus?.lastOkAt ?? null,
      lastFailed: autoStatus ? !autoStatus.ok : false,
      lastError: autoStatus?.error ?? null,
      savedElsewhereAt: saved?.at ?? null,
    },
    devices: {
      online: onlineClients(now),
      older: olderClients(now),
      tillVersion: APP_VERSION,
    },
    database: {
      lastBusyAt: lastDatabaseBusyAt(),
      freeBytes: (() => {
        try {
          return freeBytesAt(app.getPath('userData'));
        } catch {
          return null;
        }
      })(),
    },
  };
  const lights = aggregateStatusLights(facts);
  cache = { at: now, lights, reviews: fiscal.reviews };
  return { lights, reviews: fiscal.reviews, at: new Date(now).toISOString() };
}
