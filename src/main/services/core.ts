import { prisma } from '@db/client';

export const coreServices = {
  async readSettings() {
    const envDefaults = {
      restaurantName: process.env.RESTAURANT_NAME || ' Code Orbit Agroturizem',
      currency: process.env.CURRENCY || 'EUR',
      defaultVatRate: Number(process.env.VAT_RATE_DEFAULT || 0.2),
      printer: {
        ip: process.env.PRINTER_IP,
        port: process.env.PRINTER_PORT ? Number(process.env.PRINTER_PORT) : undefined,
      },
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
    const row = await prisma.syncState.findUnique({ where: { key: 'settings' } }).catch(() => null);
    const stored = (row?.valueJson as any) || {};
    const merged = { ...envDefaults, ...stored };
    // IMPORTANT: backendUrl is locked to env and cannot be overridden by UI/settings.
    // This prevents users from pointing the POS to arbitrary backends.
    if (envDefaults?.cloud?.backendUrl) {
      merged.cloud = { ...(merged.cloud || {}), backendUrl: envDefaults.cloud.backendUrl };
    } else {
      // If not set in env, disable cloud mode entirely.
      merged.cloud = { ...(merged.cloud || {}), backendUrl: undefined };
    }

    // Backward compat: if only legacy `printer` exists, create a default profile + routing.
    if (!Array.isArray((merged as any).printers) || (merged as any).printers.length === 0) {
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
  },

  async updateSettings(input: any) {
    const current = await this.readSettings();
    const merged = { ...current, ...input };
    if (input?.printer) merged.printer = { ...(current.printer || {}), ...input.printer };
    if (input?.printers) merged.printers = Array.isArray(input.printers) ? input.printers : current.printers;
    if (input?.printerRouting) merged.printerRouting = { ...(current.printerRouting || {}), ...(input.printerRouting || {}) };
    if (input?.security) merged.security = { ...(current.security || {}), ...input.security };
    if (input?.kds) merged.kds = { ...(current.kds || {}), ...input.kds };
    if (input?.cloud) {
      // Only businessCode is user-editable; backendUrl remains locked to env.
      merged.cloud = { ...(current.cloud || {}), ...(input.cloud || {}) };
      if (merged.cloud) delete (merged.cloud as any).backendUrl;
      merged.cloud = { ...(merged.cloud || {}), backendUrl: (current as any)?.cloud?.backendUrl };
    }
    await prisma.syncState.upsert({ where: { key: 'settings' }, create: { key: 'settings', valueJson: merged }, update: { valueJson: merged } });
    return merged;
  },

  async setTableOpen(area: string, label: string, open: boolean) {
    const key = 'tables:open';
    const row = await prisma.syncState.findUnique({ where: { key } });
    const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
    const k = `${area}:${label}`;
    if (open) map[k] = true; else delete map[k];
    await prisma.syncState.upsert({ where: { key }, create: { key, valueJson: map }, update: { valueJson: map } });
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


