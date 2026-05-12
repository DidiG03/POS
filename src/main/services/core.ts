import { prisma } from '@db/client';

/**
 * Per-table in-process serialization for `tables:open` map mutations.
 *
 * The `tables:open` map is a single JSON column read-modify-written by
 * `setTableOpen`. Without serialization, two concurrent waiters can both
 * read `{}`, both add their own key, and both write — the loser's entry
 * survives but the winner's prior state is overwritten. The same applies
 * to the parallel `tables:openAt` and `tables:owner` maps.
 *
 * Both the Electron IPC handlers AND the embedded HTTP API run inside the
 * same Node process, so a single in-memory mutex map closes the gap for
 * every code path that mutates open-table state. We key the lock by
 * `area:label` so different tables still proceed in parallel.
 */
const tableLocks: Map<string, Promise<unknown>> = new Map();

export async function withTableLock<T>(
  area: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${area}:${label}`;
  const previous = tableLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chain *after* the previous holder finishes (success or failure) so
  // we never deadlock on a thrown body.
  const chained = previous.catch(() => undefined).then(() => next);
  tableLocks.set(key, chained);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // Only clear the slot if no one queued behind us, otherwise we'd
    // strand the next waiter without a head pointer.
    if (tableLocks.get(key) === chained) tableLocks.delete(key);
  }
}

/**
 * In-memory cache for the merged settings document.
 *
 * Why: `coreServices.readSettings()` is called from every print, every
 * KDS poll, every printer-station tick, and on every API request that
 * needs to know the restaurant name / VAT rate / cloud config. Each
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
    security: {
      allowLan: process.env.POS_ALLOW_LAN === 'true',
      requirePairingCode: process.env.POS_REQUIRE_PAIRING_CODE !== 'false',
    },
    cloud: {
      backendUrl: process.env.POS_CLOUD_URL || undefined,
      businessCode: process.env.POS_BUSINESS_CODE || undefined,
    },
    kds: {
      enabledStations: ['KITCHEN'],
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
  // backendUrl is locked to env and cannot be overridden by UI/settings
  // — prevents a compromised UI from re-pointing the POS to an attacker
  // backend.
  if (envDefaults?.cloud?.backendUrl) {
    merged.cloud = {
      ...(merged.cloud || {}),
      backendUrl: envDefaults.cloud.backendUrl,
    };
  } else {
    merged.cloud = { ...(merged.cloud || {}), backendUrl: undefined };
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
    if (input?.kds) merged.kds = { ...(current.kds || {}), ...input.kds };
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
    if (input?.cloud) {
      // Only businessCode is user-editable; backendUrl remains locked to env.
      merged.cloud = { ...(current.cloud || {}), ...(input.cloud || {}) };
      if (merged.cloud) delete (merged.cloud as any).backendUrl;
      merged.cloud = {
        ...(merged.cloud || {}),
        backendUrl: (current as any)?.cloud?.backendUrl,
      };
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
   * Plain read-modify-write of the `tables:open` map. Callers are
   * responsible for taking `withTableLock(area, label, …)` around any
   * critical section that needs to serialize against other writers —
   * see `tables:setOpen`, `tickets:log`, and the void handlers for
   * examples.
   *
   * The lock USED to live inside this function but that produced a
   * self-deadlock: the IPC handler wraps the whole "set open + write
   * openAt + close KDS" block in `withTableLock`, and then awaited
   * this call which tried to acquire the same lock from inside the
   * holder. The Pay button (and any flow that closes a table) hung
   * forever. Keeping the lock only at the outer call sites avoids the
   * re-entrancy problem without needing `AsyncLocalStorage`.
   */
  async setTableOpen(area: string, label: string, open: boolean) {
    const key = 'tables:open';
    const row = await prisma.syncState.findUnique({ where: { key } });
    const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
    const k = `${area}:${label}`;
    if (open) map[k] = true;
    else delete map[k];
    await prisma.syncState.upsert({
      where: { key },
      create: { key, valueJson: map },
      update: { valueJson: map },
    });
  },

  async isTableOpen(area: string, label: string): Promise<boolean> {
    const row = await prisma.syncState
      .findUnique({ where: { key: 'tables:open' } })
      .catch(() => null);
    const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
    return Boolean(map[`${area}:${label}`]);
  },

  async listOpenTables() {
    const key = 'tables:open';
    const row = await prisma.syncState.findUnique({ where: { key } });
    const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
    return Object.entries(map)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => {
        const [area, label] = k.split(':');
        return { area, label };
      });
  },
};
