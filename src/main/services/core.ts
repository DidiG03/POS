import { prisma } from '@db/client';

export const coreServices = {
  async readSettings() {
    const envDefaults = {
      restaurantName: process.env.RESTAURANT_NAME || 'Ullishtja Agroturizem',
      currency: process.env.CURRENCY || 'EUR',
      defaultVatRate: Number(process.env.VAT_RATE_DEFAULT || 0.2),
      printer: {
        ip: process.env.PRINTER_IP,
        port: process.env.PRINTER_PORT ? Number(process.env.PRINTER_PORT) : undefined,
      },
      enableAdmin: process.env.ENABLE_ADMIN === 'true',
    } as any;
    const row = await prisma.syncState.findUnique({ where: { key: 'settings' } }).catch(() => null);
    const stored = (row?.valueJson as any) || {};
    return { ...envDefaults, ...stored };
  },

  async updateSettings(input: any) {
    const current = await this.readSettings();
    const merged = { ...current, ...input };
    if (input?.printer) merged.printer = { ...(current.printer || {}), ...input.printer };
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


