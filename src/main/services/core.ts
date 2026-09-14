import { prisma } from '@db/client';
import { KeyedAsyncMutex } from '@shared/asyncMutex';
import {
  countOccupiedTables,
  isTableOccupied,
  listOccupiedTables,
  setTableOccupied,
} from './tableOccupancy';

/**
 * Per-table in-process serialization for open / pay / log / void.
 *
 * Occupancy itself is one SQLite row per table (`TableOccupancy`), so two
 * waiters opening different tables no longer clobber a shared JSON map.
 * This mutex still serializes the larger critical section on one table
 * (open + ticket log + KDS + pay) so those steps cannot interleave.
 *
 * Both the Electron IPC handlers AND the embedded HTTP API run inside the
 * same Node process, so a single in-memory mutex map covers every code
 * path. We key the lock by `area:label` so different tables still proceed
 * in parallel. A waiter who cannot acquire T7 within 8s gets TABLE_BUSY
 * instead of hanging behind a stuck payment.
 */
const tableLocks = new KeyedAsyncMutex();

/** How long a second waiter will wait for the same table before failing. */
export const TABLE_LOCK_WAIT_MS = 8_000;

export async function withTableLock<T>(
  area: string,
  label: string,
  fn: () => Promise<T>,
  waitMs: number = TABLE_LOCK_WAIT_MS,
): Promise<T> {
  const key = `${area}:${label}`;
  try {
    return await tableLocks.runExclusive(key, fn, waitMs);
  } catch (err) {
    if ((err as { code?: string })?.code === 'LOCK_TIMEOUT') {
      const busy = new Error(`Table ${key} is busy`);
      (busy as { code?: string }).code = 'TABLE_BUSY';
      throw busy;
    }
    throw err;
  }
}

/**
 * In-memory cache for the merged settings document.
 *
 * Why: `coreServices.readSettings()` is called from every print, every
 * KDS poll, every printer-station tick, and on every API request that
 * needs to know the restaurant name / VAT rate / host config. Each
 * call hits SQLite + JSON.parse + merge. During a busy service that
 * adds up to thousands of redundant queries an hour.
 *
 * Single Electron process owns the DB writes for `key = 'settings'`
 * (the renderer goes through IPC → main → here), so a process-local
 * cache is safe. We invalidate on every write through `updateSettings`
 * (single writer) and expose `invalidateSettingsCache()` for any code
 * paths that may bypass it (manual SQL, migrations, tests).
 *
 * `inflight` deduplicates concurrent first reads so a burst on cold
 * start doesn't spawn N parallel queries.
 */
let cached: any | null = null;
let inflight: Promise<any> | null = null;

function buildEnvDefaults() {
  return {
    restaurantName: process.env.RESTAURANT_NAME || ' Code Orbit Agroturizem',
    businessInfo: {
      address: process.env.BUSINESS_ADDRESS || '',
      phone: process.env.BUSINESS_PHONE || '',
      email: process.env.BUSINESS_EMAIL || '',
      website: process.env.BUSINESS_WEBSITE || '',
    },
    currency: process.env.CURRENCY || 'EUR',
    defaultVatRate: Number(process.env.VAT_RATE_DEFAULT || 0.2),
    // NOTE: `printer.ip` / `printer.port` / `PRINTER_PROTOCOL` env vars
    // are no longer seeded into defaults. The Admin → Settings UI is
    // the authoritative source for printer configuration; mixing env
    // overrides made it impossible to change the IP from the UI without
    // also editing `.env`. Env vars still work as a true last-resort
    // fallback inside `printDispatcher` when no profile is saved.
    enableAdmin: process.env.ENABLE_ADMIN === 'true',
    host: {
      openAtLogin: true,
    },
    security: {
      allowLan: process.env.POS_ALLOW_LAN === 'true',
      requirePairingCode: process.env.POS_REQUIRE_PAIRING_CODE !== 'false',
    },
    kds: {
      enabledStations: ['KITCHEN'],
    },
    fiscal: {
      enabled: false,
      provider: 'easypos',
      baseUrl: 'http://127.0.0.1:8080',
    },
  } as any;
}

async function loadSettingsFromDb(): Promise<any> {
  const envDefaults = buildEnvDefaults();
  const row = await prisma.syncState
    .findUnique({ where: { key: 'settings' } })
    .catch(() => null);
  const stored = (row?.valueJson as any) || {};
  const merged = { ...envDefaults, ...stored };
  // ENABLE_ADMIN env wins so a misconfigured stored setting can't lock
  // the admin user out of their own UI.
  if (envDefaults.enableAdmin) {
    merged.enableAdmin = true;
  }
  // Backward compat: if only legacy `printer` exists, expose it as a
  // single-entry `printers[]` so the new dispatcher path always sees
  // an array. Real upgrades happen the next time the user saves in the
  // Admin UI (which writes the full `printers[]`).
  if (
    !Array.isArray((merged as any).printers) ||
    (merged as any).printers.length === 0
  ) {
    const legacy = (merged as any).printer;
    if (legacy && Object.keys(legacy).length) {
      (merged as any).printers = [
        {
          id: 'default',
          name: 'Default printer',
          enabled: true,
          ...(legacy || {}),
        },
      ];
      (merged as any).printerRouting = {
        enabled: false,
        receiptPrinterId: 'default',
        station: { ALL: 'default' },
        ...(merged as any).printerRouting,
      };
    }
  }
  return merged;
}

export const coreServices = {
  async readSettings() {
    if (cached) return cached;
    if (inflight) return await inflight;
    inflight = loadSettingsFromDb()
      .then((m) => {
        cached = m;
        return m;
      })
      .finally(() => {
        inflight = null;
      });
    return await inflight;
  },

  /**
   * Force the cache to refresh on the next read. Call this from any
   * code that bypasses `updateSettings` (raw SQL writes, migrations,
   * tests).
   */
  invalidateSettingsCache() {
    cached = null;
  },

  async updateSettings(input: any) {
    const current = await this.readSettings();
    const merged = { ...current, ...input };
    if (input?.businessInfo)
      merged.businessInfo = {
        ...(current.businessInfo || {}),
        ...input.businessInfo,
      };
    if (input?.printer)
      merged.printer = { ...(current.printer || {}), ...input.printer };
    if (input?.printers)
      merged.printers = Array.isArray(input.printers)
        ? input.printers
        : current.printers;
    if (input?.printerRouting)
      merged.printerRouting = {
        ...(current.printerRouting || {}),
        ...(input.printerRouting || {}),
      };
    if (input?.security)
      merged.security = { ...(current.security || {}), ...input.security };
    if (input?.host) merged.host = { ...(current.host || {}), ...input.host };
    if (input?.kds) merged.kds = { ...(current.kds || {}), ...input.kds };
    if (input?.googleCalendar) {
      merged.googleCalendar = {
        ...(current.googleCalendar || {}),
        ...input.googleCalendar,
      };
      const nextUrl = String(
        (input.googleCalendar as any)?.icalUrl || '',
      ).trim();
      const prevUrl = String(
        (current as any)?.googleCalendar?.icalUrl || '',
      ).trim();
      if (!nextUrl && prevUrl) {
        merged.googleCalendar.icalUrl = prevUrl;
      }
      if ((input.googleCalendar as any)?.oauth === null) {
        delete merged.googleCalendar.oauth;
      } else if ((input.googleCalendar as any)?.oauth) {
        merged.googleCalendar.oauth = {
          ...((current as any)?.googleCalendar?.oauth || {}),
          ...((input.googleCalendar as any).oauth || {}),
        };
        const nextRefresh = String(
          (input.googleCalendar as any)?.oauth?.refreshToken || '',
        ).trim();
        const prevRefresh = String(
          (current as any)?.googleCalendar?.oauth?.refreshToken || '',
        ).trim();
        if (!nextRefresh && prevRefresh) {
          merged.googleCalendar.oauth.refreshToken = prevRefresh;
        }
        const nextAccess = String(
          (input.googleCalendar as any)?.oauth?.accessToken || '',
        ).trim();
        const prevAccess = String(
          (current as any)?.googleCalendar?.oauth?.accessToken || '',
        ).trim();
        if (!nextAccess && prevAccess) {
          merged.googleCalendar.oauth.accessToken = prevAccess;
        }
        const nextExpires = String(
          (input.googleCalendar as any)?.oauth?.accessTokenExpiresAt || '',
        ).trim();
        const prevExpires = String(
          (current as any)?.googleCalendar?.oauth?.accessTokenExpiresAt || '',
        ).trim();
        if (!nextExpires && prevExpires) {
          merged.googleCalendar.oauth.accessTokenExpiresAt = prevExpires;
        }
      }
    }
    if (input?.preferences)
      merged.preferences = {
        ...(current.preferences || {}),
        ...input.preferences,
        // Nested objects should also be field-merged so callers can update one
        // sub-section (e.g. autoCloseShift) without wiping the others.
        serviceCharge: {
          ...((current.preferences as any)?.serviceCharge || {}),
          ...((input.preferences as any)?.serviceCharge || {}),
        },
        autoCloseShift: {
          ...((current.preferences as any)?.autoCloseShift || {}),
          ...((input.preferences as any)?.autoCloseShift || {}),
        },
        reservationAutoNoShow: {
          ...((current.preferences as any)?.reservationAutoNoShow || {}),
          ...((input.preferences as any)?.reservationAutoNoShow || {}),
        },
      };
    if (input?.fiscal) {
      merged.fiscal = { ...(current.fiscal || {}), ...input.fiscal };
      const nextToken = String((input.fiscal as any)?.authToken || '').trim();
      const prevToken = String(
        (current as any)?.fiscal?.authToken || '',
      ).trim();
      if (!nextToken && prevToken) {
        merged.fiscal.authToken = prevToken;
      }
    }
    await prisma.syncState.upsert({
      where: { key: 'settings' },
      create: { key: 'settings', valueJson: merged },
      update: { valueJson: merged },
    });
    // Refresh the cache atomically — every reader after this returns
    // the just-saved doc without an extra DB round-trip.
    cached = merged;
    return merged;
  },

  /**
   * Open or close one table row. Callers are responsible for taking
   * `withTableLock(area, label, …)` around any critical section that
   * needs to serialize against other writers on the same table —
   * see `tables:setOpen`, `tickets:log`, and the void handlers.
   *
   * The lock USED to live inside this function but that produced a
   * self-deadlock: the IPC handler wraps the whole "set open + write
   * openedAt + close KDS" block in `withTableLock`, and then awaited
   * this call which tried to acquire the same lock from inside the
   * holder. The Pay button (and any flow that closes a table) hung
   * forever. Keeping the lock only at the outer call sites avoids the
   * re-entrancy problem without needing `AsyncLocalStorage`.
   */
  async setTableOpen(area: string, label: string, open: boolean) {
    await setTableOccupied(area, label, open);
  },

  async isTableOpen(area: string, label: string): Promise<boolean> {
    return isTableOccupied(area, label);
  },

  async listOpenTables() {
    const tables = await listOccupiedTables();
    return tables.map((t) => ({ area: t.area, label: t.label }));
  },

  async countOpenTables() {
    return countOccupiedTables();
  },
};
