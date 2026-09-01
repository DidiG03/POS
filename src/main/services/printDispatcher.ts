/**
 * Single source of truth for everything that ends up putting ink on
 * paper. Three places used to re-implement the same NETWORK / SYSTEM /
 * SERIAL dispatch (the Electron `tickets:print` IPC, the HTTP
 * `/print/ticket` route used by iOS / web waiters, and the cloud-mode
 * `printerStation` polling loop). Each copy drifted slightly:
 *   - only one passed `forceProtocol` (so `.env` could still hijack
 *     real receipts via PRINTER_PROTOCOL=LPR);
 *   - the HTTP path didn't honour station/category routing at all, so
 *     iOS waiters couldn't split tickets to a kitchen printer;
 *   - the test-print buttons each constructed their own ESC/POS
 *     "Hello world" buffer four different ways.
 *
 * This module replaces all of that. Every print path now calls
 * `dispatchTicket()` (for real receipts/orders) or
 * `testPrintWithProfile()` (for the various test buttons), and protocol
 * resolution is uniform: the saved profile wins, port determines RAW vs
 * LPR, env vars are last-resort fallbacks.
 */

import { prisma } from '@db/client';
import type { PrinterProfileDTO, SettingsDTO } from '@shared/ipc';
import {
  ESC_POS_FONT_A,
  ESC_POS_PC850,
  encodeEscposText,
  layoutFromSettings,
} from '../escposEncode';

import {
  buildEscposTicket,
  buildHtmlReceipt,
  printHtmlToSystemPrinter,
  sendToCupsRawPrinter,
  sendToPrinterVerbose,
  type TicketPrintPayload,
} from '../print';

export type PrinterMode = 'NETWORK' | 'SYSTEM' | 'SERIAL';

export type PrintAttemptResult = { ok: boolean; error?: string };

export type DispatchResult = {
  ok: boolean;
  failures: number;
  firstError?: string;
  // One entry per physical print attempt. Useful for fine-grained
  // notifications ("kitchen printer offline, bar printer ok").
  perPrinter: Array<{ profileId: string; ok: boolean; error?: string }>;
};

// -------- profile selection ------------------------------------------------

export function profileMode(p: any): PrinterMode {
  return (p?.mode ||
    (p?.serialPath
      ? 'SERIAL'
      : p?.deviceName
        ? 'SYSTEM'
        : 'NETWORK')) as PrinterMode;
}

/**
 * Read every printer profile out of settings, normalising the legacy
 * singular `settings.printer` shape into the same array shape the new
 * UI uses. Disabled profiles are filtered out so callers never have to
 * remember.
 */
export function normalizePrinterProfiles(settings: any): PrinterProfileDTO[] {
  const arr = Array.isArray(settings?.printers) ? settings.printers : [];
  if (arr.length) {
    return arr.filter((p: any) => p && p.enabled !== false);
  }
  const legacy = settings?.printer;
  if (legacy && Object.keys(legacy).length) {
    return [
      {
        id: 'default',
        name: 'Default printer',
        enabled: true,
        ...legacy,
      } as PrinterProfileDTO,
    ];
  }
  return [];
}

export function pickPrinterProfile(
  settings: any,
  printerId?: string | null,
): PrinterProfileDTO | null {
  const profiles = normalizePrinterProfiles(settings);
  if (!profiles.length) return null;
  if (printerId) {
    const hit = profiles.find((p) => String(p.id) === String(printerId));
    if (hit) return hit;
  }
  return profiles[0] || null;
}

/**
 * The profile that should print customer receipts and any non-routed
 * ticket. Falls back through:
 *   1. routing.receiptPrinterId
 *   2. profile with id "default"
 *   3. first enabled profile
 */
export function pickActiveReceiptProfile(
  settings: any,
): PrinterProfileDTO | null {
  const receiptId =
    (settings as any)?.printerRouting?.receiptPrinterId || 'default';
  return (
    pickPrinterProfile(settings, receiptId) ||
    pickPrinterProfile(settings, 'default')
  );
}

// -------- core printing ----------------------------------------------------

const TRANSIENT_NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // EHOSTDOWN means the host responded to ARP recently but isn't
  // accepting connections now — exactly the case the queue is for.
  // Without this, unplugging the printer for ~30 s makes the kernel
  // alternate between EHOSTUNREACH (queued, good) and EHOSTDOWN
  // (dropped, bad), so half the receipts disappear.
  'EHOSTDOWN',
]);

/**
 * Best-effort detection of "this might come back if we wait" errors,
 * working purely from the human-readable message string. Used by the
 * retry queue (PR 3) — `printWithProfile` already has a stricter
 * error-CODE check for in-flight retries; this looser one operates on
 * what the dispatcher actually exposes upward (a string).
 *
 * Examples we want to match:
 *   "Send failed (to 10.0.0.5:9100): connect ECONNREFUSED"
 *   "LPR connect timeout"
 *   "fetch failed"
 *   "socket hang up"
 *   "Address: 10.0.0.5:9100 — ETIMEDOUT"
 */
export function isTransientPrintError(err?: string | null): boolean {
  if (!err) return false;
  const e = String(err).toLowerCase();
  return /econnrefused|econnreset|etimedout|ehostunreach|ehostdown|enetunreach|enetdown|epipe|timeout|timed out|socket hang up|fetch failed|network|unreachable|unable to connect|host is down/.test(
    e,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Print a payload to a single, known profile. This is intentionally
 * "dumb" — no routing, no notifications, no DB writes. Caller decides
 * those.
 *
 * Protocol resolution for NETWORK printers:
 *   - `opts.forceProtocol` wins if provided (used by the per-profile
 *     Test print button so a stale env var can never hijack the test);
 *   - otherwise port 515 → LPR, anything else → RAW/JetDirect;
 *   - the legacy PRINTER_PROTOCOL env var is no longer honoured.
 */
export async function printWithProfile(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  profile: PrinterProfileDTO,
  opts: { forceProtocol?: 'RAW' | 'LPR'; retries?: number } = {},
): Promise<PrintAttemptResult> {
  const mode = profileMode(profile);
  const retries = Math.max(0, Number(opts.retries ?? 0));

  if (mode === 'SYSTEM') {
    const raw = (profile as any)?.systemRawEscpos !== false;
    if (raw) {
      const data = buildEscposTicket(payload, settings);
      return await sendToCupsRawPrinter({
        deviceName: profile?.deviceName,
        data,
      });
    }
    const html = buildHtmlReceipt(payload, settings);
    return await printHtmlToSystemPrinter({
      html,
      deviceName: profile?.deviceName,
      silent: profile?.silent !== false,
    });
  }

  if (mode === 'SERIAL') {
    const path = String(profile?.serialPath || '').trim();
    if (!path) return { ok: false, error: 'Serial port not configured' };
    const cfg = {
      path,
      baudRate: Number(profile?.baudRate || 19200),
      dataBits: (Number(profile?.dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
      stopBits: (Number(profile?.stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
      parity: String(profile?.parity || 'none') as 'none' | 'even' | 'odd',
    };
    const data = buildEscposTicket(payload, settings);
    const { sendToSerialPrinter } = await import('../serial');
    return await sendToSerialPrinter(cfg as any, data);
  }

  // NETWORK
  // Saved profile wins; env vars only kick in if the UI was never
  // touched (true headless installs).
  const ip = profile?.ip || process.env.PRINTER_IP;
  const port = Number(profile?.port || process.env.PRINTER_PORT || 9100);
  if (!ip) return { ok: false, error: 'Printer IP not configured' };
  const data = buildEscposTicket(payload, settings);
  const forceProtocol =
    opts.forceProtocol ?? (port === 515 ? ('LPR' as const) : ('RAW' as const));

  let lastErr: string | undefined;
  let lastCode: string | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(250 * Math.pow(2, attempt - 1));
    const r = await sendToPrinterVerbose(ip, port, data, { forceProtocol });
    if (r.ok) return { ok: true };
    lastErr = r.error;
    lastCode = (r as any).code;
    // Only retry on transient network blips; "out of paper" etc. won't
    // recover by waiting 250ms.
    if (!lastCode || !TRANSIENT_NET_CODES.has(lastCode)) break;
  }
  return { ok: false, error: lastErr || `Send failed (to ${ip}:${port})` };
}

// -------- order routing ----------------------------------------------------

function normKey(s: any): string {
  return String(s ?? '')
    .trim()
    .toLowerCase();
}

type OrderBucket = {
  printerId: string;
  payload: TicketPrintPayload;
};

/**
 * For routed ORDER tickets: split the items into per-category groups,
 * with each group destined for the printer mapped to that category in
 * `printerRouting.categories`. Items whose category has no explicit
 * mapping fall through to `printerRouting.fallbackPrinterId` (or
 * `station.ALL` for back-compat).
 *
 * SKUs without `categoryId`/`categoryName` on the line item itself get
 * filled in from a single batched menu lookup so the renderer doesn't
 * have to thread that info through.
 */
async function buildOrderBuckets(
  payload: TicketPrintPayload,
  settings: any,
): Promise<OrderBucket[]> {
  const routing = (settings as any)?.printerRouting || {};
  const stationRouting = (routing?.station || {}) as Record<string, string>;
  const categoryRouting = (routing?.categories || {}) as Record<string, string>;
  const fallbackPrinterId = String(
    routing?.fallbackPrinterId || stationRouting?.ALL || '',
  ).trim();

  const items: any[] = Array.isArray(payload?.items) ? payload.items : [];
  const skus = Array.from(
    new Set(items.map((it) => String(it?.sku || '')).filter(Boolean)),
  );
  const menuRows = skus.length
    ? await prisma.menuItem
        .findMany({
          where: { sku: { in: skus } },
          select: { sku: true, station: true, categoryId: true },
        } as any)
        .catch(() => [])
    : [];
  const bySku = new Map<string, { station?: string; categoryId?: number }>();
  for (const m of menuRows as any[]) {
    bySku.set(String(m.sku), {
      station: String(m.station || ''),
      categoryId: Number(m.categoryId),
    });
  }

  const groups = new Map<
    string,
    { printerId: string; items: any[]; routeLabel: string }
  >();
  for (const it of items) {
    const sku = String(it?.sku || '');
    const info = sku ? bySku.get(sku) : undefined;
    const categoryId = Number.isFinite(Number(it?.categoryId))
      ? Number(it.categoryId)
      : info?.categoryId;
    const categoryKey =
      categoryId != null && Number.isFinite(categoryId)
        ? String(categoryId)
        : '';
    const categoryNameKey = normKey(it?.categoryName);
    const printerByName =
      categoryNameKey && categoryRouting[categoryNameKey]
        ? categoryRouting[categoryNameKey]
        : '';
    const printerById =
      categoryKey && categoryRouting[categoryKey]
        ? categoryRouting[categoryKey]
        : '';
    const printerByCategory = printerByName || printerById;
    const printerId = String(
      printerByCategory || fallbackPrinterId || '',
    ).trim();
    const routeLabel = printerByCategory
      ? categoryNameKey || categoryKey || 'unknown'
      : 'all';
    const key = `${printerId}|${routeLabel}`;
    if (!groups.has(key)) {
      groups.set(key, { printerId, items: [], routeLabel });
    }
    groups.get(key)!.items.push({ ...it, station: 'ALL', categoryId });
  }

  return Array.from(groups.values()).map((g) => ({
    printerId: g.printerId,
    payload: {
      ...payload,
      items: g.items,
      meta: {
        ...((payload as any)?.meta || {}),
        kind: 'ORDER',
        station: 'ALL',
        hidePrices: true,
        routeLabel: g.routeLabel,
      },
    },
  }));
}

// -------- printer-offline retry queue (PR 3) -----------------------------

/**
 * Backoff schedule for the persisted retry queue. The first element is
 * the wait BEFORE the SECOND attempt (because attempt 1 is the
 * synchronous live one), and so on. Total ceiling: ~4 minutes —
 * intentionally chosen to be longer than a typical printer
 * power-cycle / paper-reload but short enough that a stale ticket
 * doesn't surprise the kitchen 10 minutes later. Anything past the
 * last entry is treated as "permanent fail".
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 180_000];
export const RETRY_MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 5 incl. the live one

export type RetryWakeup = (dueAtMs: number) => void;
let retryWakeup: RetryWakeup | null = null;

/**
 * Register a callback invoked every time a new RETRY row is persisted.
 * The printer-station loop uses this to wake up early instead of
 * waiting for its idle interval to elapse.
 */
export function setRetryWakeup(fn: RetryWakeup | null): void {
  retryWakeup = fn;
}

function ticketTypeFor(payload: TicketPrintPayload): string {
  // PrintJob.type is constrained to RECEIPT / X_REPORT / Z_REPORT / TEST.
  // Real customer/order prints all map to RECEIPT — the retry queue
  // never carries reports.
  void payload;
  return 'RECEIPT';
}

/**
 * Persist a failed print as a RETRY row (or FAILED if exhausted).
 *
 * `priorAttempts` is "how many physical attempts have already been made
 * including the one that just failed". So the very first retry row a
 * caller creates passes priorAttempts=1. The loop, when re-enqueueing
 * after a retry attempt, passes the row's existing `attempts + 1`.
 */
export async function enqueuePrintRetry(args: {
  payload: TicketPrintPayload;
  printerProfileId: string;
  error: string;
  priorAttempts: number;
}): Promise<{ status: 'RETRY' | 'FAILED'; nextAttemptAt?: Date }> {
  const attempts = Math.max(1, Number(args.priorAttempts || 0));
  if (attempts >= RETRY_MAX_ATTEMPTS) {
    try {
      await prisma.printJob.create({
        data: {
          type: ticketTypeFor(args.payload) as any,
          payloadJson: args.payload as any,
          status: 'FAILED' as any,
          attempts,
          lastError: args.error || null,
          printerProfileId: args.printerProfileId || null,
        } as any,
      });
      console.warn(
        `[PrinterRetry] Exhausted after ${attempts} attempts (printer=${args.printerProfileId}): ${args.error}`,
      );
    } catch (e: any) {
      // DB write failure is a real problem — surface it so we don't
      // silently lose the retry state. A common cause is the migration
      // not having been applied (missing `attempts` column).
      console.error(
        `[PrinterRetry] FAILED row write rejected: ${e?.message || e}`,
      );
    }
    return { status: 'FAILED' };
  }

  // RETRY_DELAYS_MS[0] is the gap between attempt 1 and attempt 2.
  const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;
  const nextAttemptAt = new Date(Date.now() + delay);
  try {
    await prisma.printJob.create({
      data: {
        type: ticketTypeFor(args.payload) as any,
        payloadJson: args.payload as any,
        status: 'RETRY' as any,
        attempts,
        lastError: args.error || null,
        nextAttemptAt,
        printerProfileId: args.printerProfileId || null,
      } as any,
    });
    console.log(
      `[PrinterRetry] Queued attempt #${attempts + 1} for printer=${args.printerProfileId} in ${Math.round(
        delay / 1000,
      )}s (error: ${args.error})`,
    );
  } catch (e: any) {
    console.error(
      `[PrinterRetry] RETRY row write rejected: ${e?.message || e}`,
    );
    return { status: 'FAILED' };
  }

  // Wake the loop early so it doesn't snooze through this retry.
  try {
    retryWakeup?.(nextAttemptAt.getTime());
  } catch (e: any) {
    console.warn(`[PrinterRetry] wakeup callback threw: ${e?.message || e}`);
  }
  return { status: 'RETRY', nextAttemptAt };
}

/**
 * Read every RETRY row whose `nextAttemptAt` has passed. Capped so a
 * massive backlog doesn't block the loop.
 */
export async function loadDuePrintRetries(limit = 10) {
  const now = new Date();
  return await prisma.printJob
    .findMany({
      where: {
        status: 'RETRY' as any,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
    })
    .catch(() => []);
}

/**
 * Find the timestamp of the next RETRY row that's NOT yet due. The
 * printer-station loop uses this to schedule its next wake-up exactly
 * on time instead of polling blindly.
 */
export async function nextPendingRetryAt(): Promise<Date | null> {
  const now = new Date();
  const row = await prisma.printJob
    .findFirst({
      where: { status: 'RETRY' as any, nextAttemptAt: { gt: now } },
      orderBy: { nextAttemptAt: 'asc' },
      select: { nextAttemptAt: true },
    })
    .catch(() => null);
  return row?.nextAttemptAt ?? null;
}

/**
 * The high-level entry point used by every receipt/order handler.
 *
 * Behaviour:
 *   - PAYMENT / RECEIPT / unspecified: print one slip to the receipt
 *     profile.
 *   - ORDER + routing enabled: split items by category, print per
 *     destination printer in parallel groups (sequential across
 *     printers, but one TCP connection per destination).
 *   - ORDER + routing disabled: print one slip to the receipt profile,
 *     same as a regular receipt.
 *
 * Returns a per-printer breakdown so callers can produce useful
 * notifications.
 *
 * `persistRetryOnTransientFailure` (PR 3) opts the caller into the
 * retry queue: any per-destination failure with a transient-looking
 * error gets enqueued for the printer-station loop to keep retrying
 * (~4 min total). The synchronous response still reports failure so
 * the user knows about the problem — the queue is the safety net for
 * "actually, the kitchen printer came back 12 seconds later".
 */
export async function dispatchTicket(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  opts: {
    retries?: number;
    persistRetryOnTransientFailure?: boolean;
    /**
     * For the printer-station loop: how many attempts the row already
     * has. Used to compute the next backoff if THIS attempt also
     * fails.
     */
    priorAttempts?: number;
  } = {},
): Promise<DispatchResult> {
  // Default to ONE silent retry for transient TCP errors. Empirically
  // this is the single highest-impact reliability tweak: most Wi-Fi
  // blips and printer half-second hiccups recover well within 250ms,
  // and a single retry hides them entirely from the waiter. If a print
  // is still failing on the second attempt it's almost certainly a
  // real outage (paper, power, network) — let the user see the error.
  const retries = opts.retries ?? 1;

  const fallback = pickActiveReceiptProfile(settings);
  if (!fallback) {
    return {
      ok: false,
      failures: 1,
      firstError: 'No printer configured',
      perPrinter: [],
    };
  }

  const meta: any = (payload as any)?.meta || {};
  const kind = String(meta?.kind || '').toUpperCase();
  const routingEnabled = Boolean((settings as any)?.printerRouting?.enabled);

  // priorAttempts defaults to 1 (this very call IS attempt #1). The
  // retry-loop path overrides it with the row's running attempt count
  // so the backoff schedule advances correctly across restarts.
  const priorAttempts = Math.max(1, Number(opts.priorAttempts ?? 1));

  // Helper: persist a retry row for a single destination, if asked
  // and the error looks transient. Swallows its own DB errors so a
  // retry-table problem can't break a real print.
  const maybePersistRetry = async (
    bucketPayload: TicketPrintPayload,
    profileId: string,
    error?: string,
  ) => {
    if (!opts.persistRetryOnTransientFailure) {
      console.log(
        `[PrinterRetry] Not persisting (caller didn't opt in): ${error}`,
      );
      return;
    }
    if (!isTransientPrintError(error)) {
      console.log(
        `[PrinterRetry] Not persisting (error is not transient — won't recover by waiting): "${error}"`,
      );
      return;
    }
    await enqueuePrintRetry({
      payload: bucketPayload,
      printerProfileId: profileId,
      error: error || 'transient print failure',
      priorAttempts,
    });
  };

  if (!routingEnabled || kind !== 'ORDER') {
    const r = await printWithProfile(payload, settings, fallback, {
      retries,
    });
    if (!r.ok) await maybePersistRetry(payload, fallback.id, r.error);
    return {
      ok: r.ok,
      failures: r.ok ? 0 : 1,
      firstError: r.error,
      perPrinter: [{ profileId: fallback.id, ok: r.ok, error: r.error }],
    };
  }

  const buckets = await buildOrderBuckets(payload, settings);
  let failures = 0;
  let firstError: string | undefined;
  const perPrinter: DispatchResult['perPrinter'] = [];
  for (const bucket of buckets) {
    const prof = pickPrinterProfile(settings, bucket.printerId) || fallback;
    const r = await printWithProfile(bucket.payload, settings, prof, {
      retries,
    });
    perPrinter.push({ profileId: prof.id, ok: r.ok, error: r.error });
    if (!r.ok) {
      failures++;
      if (!firstError) firstError = r.error;
      // Persist THIS bucket only — a routed order whose food slip went
      // through but whose drinks slip didn't should only retry the
      // drinks slip.
      await maybePersistRetry(bucket.payload, prof.id, r.error);
    }
  }
  return { ok: failures === 0, failures, firstError, perPrinter };
}

// -------- test prints ------------------------------------------------------

/**
 * "Hello world" ESC/POS slip used by every test-print path. Header is
 * double-size so it stands out from real tickets at a glance.
 */
export function buildTestPrintBuffer(
  opts: {
    title?: string;
    printerName?: string;
    mode?: PrinterMode;
    detail?: string;
    paperWidthMm?: 58 | 80;
  } = {},
): Buffer {
  const title = opts.title || 'OneTap POS Test Print';
  const layout = layoutFromSettings({
    printers: [{ id: 'default', paperWidthMm: opts.paperWidthMm }],
  });
  const body: string[] = [`${layout.sep}\n`];
  if (opts.printerName) body.push(`Printer: ${opts.printerName}\n`);
  if (opts.mode) body.push(`Mode:    ${opts.mode}\n`);
  if (opts.detail) body.push(`${opts.detail}\n`);
  body.push(`Time:    ${new Date().toISOString()}\n`);
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]), // ESC @
    ESC_POS_FONT_A,
    ESC_POS_PC850,
    Buffer.from([0x1b, 0x61, 0x01]), // center
    Buffer.from([0x1b, 0x21, 0x30]), // double size
    encodeEscposText(` ${title}\n`),
    Buffer.from([0x1b, 0x21, 0x00]),
    Buffer.from([0x1b, 0x61, 0x00]),
    encodeEscposText(body.join('')),
    Buffer.from([0x0a]),
    Buffer.from([0x1d, 0x56, 0x41, 0x10]), // GS V A partial cut
  ]);
}

/**
 * Send a hello-world test slip to a specific profile. Used by the per-
 * profile "Test print" button in Admin Settings AND by the older
 * settings:testPrint / testPrintVerbose IPC handlers (which now resolve
 * to the active receipt profile and call this).
 *
 * For NETWORK printers the protocol is forced from the typed port so a
 * stale `.env` can't hijack the test.
 */
export async function testPrintWithProfile(
  profile: PrinterProfileDTO,
  settings: SettingsDTO,
): Promise<PrintAttemptResult> {
  const mode = profileMode(profile);
  const detail =
    mode === 'NETWORK'
      ? `Address: ${profile?.ip || '?'}:${profile?.port || 9100}`
      : mode === 'SYSTEM'
        ? `Device:  ${profile?.deviceName || '(default)'}`
        : `Serial:  ${profile?.serialPath || '(none)'}`;
  const data = buildTestPrintBuffer({
    printerName: profile?.name,
    mode,
    detail,
    paperWidthMm: profile?.paperWidthMm === 58 ? 58 : 80,
  });

  if (mode === 'SYSTEM') {
    const raw = (profile as any)?.systemRawEscpos !== false;
    if (raw) {
      return await sendToCupsRawPrinter({
        deviceName: profile?.deviceName,
        data,
      });
    }
    // Non-raw drivers (PostScript / PCL) need real HTML, not ESC/POS
    // bytes — otherwise they print the control codes verbatim.
    const html = buildHtmlReceipt(
      {
        area: 'TEST',
        tableLabel: profile?.name || 'USB',
        covers: null,
        items: [{ name: 'Hello, world!', qty: 1, unitPrice: 0, vatRate: 0 }],
        note: null,
        userName: 'POS',
        meta: { vatEnabled: false },
      } as any,
      settings,
    );
    return await printHtmlToSystemPrinter({
      html,
      deviceName: profile?.deviceName,
      silent: profile?.silent !== false,
    });
  }

  if (mode === 'SERIAL') {
    const path = String(profile?.serialPath || '').trim();
    if (!path) return { ok: false, error: 'Serial port not selected.' };
    const cfg = {
      path,
      baudRate: Number(profile?.baudRate || 19200),
      dataBits: (Number(profile?.dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
      stopBits: (Number(profile?.stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
      parity: String(profile?.parity || 'none') as 'none' | 'even' | 'odd',
    };
    const { sendToSerialPrinter } = await import('../serial');
    return await sendToSerialPrinter(cfg as any, data);
  }

  // NETWORK
  const ip = String(profile?.ip || '').trim() || process.env.PRINTER_IP;
  const port = Number(profile?.port || process.env.PRINTER_PORT || 9100);
  if (!ip) return { ok: false, error: 'Printer IP is empty.' };
  const forceProtocol = port === 515 ? ('LPR' as const) : ('RAW' as const);
  const r = await sendToPrinterVerbose(ip, port, data, { forceProtocol });
  return r.ok
    ? { ok: true }
    : { ok: false, error: r.error || 'Network print failed' };
}
