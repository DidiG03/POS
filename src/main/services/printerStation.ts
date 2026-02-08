import { buildEscposTicket, buildHtmlReceipt, printHtmlToSystemPrinter, sendToCupsRawPrinter, sendToPrinter } from '../print';
import { coreServices } from './core';
import { cloudJson, getCloudConfig, hasCloudSession } from './cloud';
import { prisma } from '@db/client';

type PrintJobDTO = { id: number; type: string; payload: any; createdAt: string };

let started = false;

type Station = 'KITCHEN' | 'BAR' | 'DESSERT' | 'ALL';

function normKey(s: any): string {
  return String(s ?? '')
    .trim()
    .toLowerCase();
}

function normalizeProfiles(settings: any): any[] {
  const arr = Array.isArray(settings?.printers) ? settings.printers : [];
  if (arr.length) return arr;
  const legacy = settings?.printer;
  if (legacy && Object.keys(legacy).length) return [{ id: 'default', name: 'Default printer', enabled: true, ...legacy }];
  return [];
}

function pickProfile(settings: any, printerId?: string | null): any | null {
  const profiles = normalizeProfiles(settings).filter((p) => p && p.enabled !== false);
  if (!profiles.length) return null;
  if (printerId) {
    const hit = profiles.find((p) => String(p.id) === String(printerId));
    if (hit) return hit;
  }
  // fallback: first enabled profile
  return profiles[0] || null;
}

async function printWithProfile(payload: any, settings: any, profile: any): Promise<{ ok: boolean; error?: string }> {
  const mode = (profile?.mode || (profile?.serialPath ? 'SERIAL' : profile?.deviceName ? 'SYSTEM' : 'NETWORK')) as any;
  if (mode === 'SYSTEM') {
    const raw = profile?.systemRawEscpos !== false;
    if (raw) {
      const data = buildEscposTicket(payload, settings as any);
      return await sendToCupsRawPrinter({ deviceName: profile?.deviceName, data });
    } else {
      const html = buildHtmlReceipt(payload, settings as any);
      return await printHtmlToSystemPrinter({ html, deviceName: profile?.deviceName, silent: profile?.silent !== false });
    }
  }
  if (mode === 'SERIAL') {
    const cfg = {
      path: String(profile?.serialPath || ''),
      baudRate: Number(profile?.baudRate || 19200),
      dataBits: (Number(profile?.dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
      stopBits: (Number(profile?.stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
      parity: (String(profile?.parity || 'none') as any) as 'none' | 'even' | 'odd',
    };
    if (!cfg.path) return { ok: false, error: 'Serial port not configured' };
    const { sendToSerialPrinter } = await import('../serial');
    const data = buildEscposTicket(payload, settings as any);
    return await sendToSerialPrinter(cfg as any, data);
  }
  const ip = process.env.PRINTER_IP || profile?.ip;
  const port = Number(process.env.PRINTER_PORT || profile?.port || 9100);
  if (!ip) return { ok: false, error: 'Printer IP not configured' };
  const data = buildEscposTicket(payload, settings as any);
  const ok = await sendToPrinter(ip as string, port, data);
  return ok ? { ok: true } : { ok: false, error: `Send failed (to ${ip}:${port})` };
}

async function routeOrderPayloadByStation(payload: any, settings: any): Promise<Array<{ station: Station; printerId?: string; payload: any }>> {
  const routing = (settings as any)?.printerRouting || {};
  const stationRouting = (routing?.station || {}) as Partial<Record<Station, string>>;
  const categoryRouting = (routing?.categories || {}) as Record<string, string>;
  const fallbackPrinterId =
    String((routing as any)?.fallbackPrinterId || stationRouting?.ALL || '').trim();
  const items: any[] = Array.isArray(payload?.items) ? payload.items : [];
  const skus = Array.from(new Set(items.map((it) => String(it?.sku || '')).filter(Boolean)));
  const menu = skus.length
    ? await prisma.menuItem
        .findMany({ where: { sku: { in: skus } }, select: { sku: true, station: true, categoryId: true } } as any)
        .catch(() => [])
    : [];
  const bySku = new Map<string, { station?: string; categoryId?: number }>();
  for (const m of menu as any[]) bySku.set(String(m.sku), { station: String(m.station || ''), categoryId: Number(m.categoryId) });

  const buckets = new Map<string, any[]>();
  for (const it of items) {
    const sku = String(it?.sku || '');
    const info = sku ? bySku.get(sku) : undefined;
    const categoryId = Number.isFinite(Number(it?.categoryId)) ? Number(it?.categoryId) : info?.categoryId;
    const categoryKey = categoryId != null && Number.isFinite(categoryId) ? String(categoryId) : '';
    const categoryName = normKey(it?.categoryName);
    const printerIdByCategoryName = categoryName && categoryRouting[categoryName] ? String(categoryRouting[categoryName]) : '';
    const printerIdByCategoryId = categoryKey && categoryRouting[categoryKey] ? String(categoryRouting[categoryKey]) : '';
    const printerIdByCategory = printerIdByCategoryName || printerIdByCategoryId;
    const printerId = (printerIdByCategory || fallbackPrinterId || '').trim();
    // When category routing exists, split by CATEGORY. Otherwise, everything goes to fallback.
    const groupKey = printerIdByCategory
      ? `CAT:${categoryName || categoryKey || 'unknown'}`
      : `FB:ALL`;
    const key = `${printerId}|${groupKey}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push({ ...it, station: 'ALL', categoryId });
  }

  const out: Array<{ station: Station; printerId?: string; payload: any }> = [];
  for (const [key, groupItems] of buckets.entries()) {
    const [printerId, group] = key.split('|');
    const isCat = String(group || '').startsWith('CAT:');
    const routeLabel = isCat ? String(group || '').slice(4) : 'all';
    const st: Station = 'ALL';
    const meta = { ...(payload?.meta || {}), kind: 'ORDER', station: 'ALL', hidePrices: true, routeLabel: routeLabel || 'all' };
    out.push({ station: st, printerId: (printerId || '').trim() || undefined, payload: { ...payload, items: groupItems, meta } });
  }
  return out;
}

export function startPrinterStationLoop() {
  if (started) return;
  started = true;

  const inFlight = new Set<number>();

  const tick = async () => {
    try {
      const cfg = await getCloudConfig().catch(() => null);
      if (!cfg) return;
      if (!hasCloudSession(cfg.businessCode)) return;

      const settings = await coreServices.readSettings();
      const routingEnabled = Boolean((settings as any)?.printerRouting?.enabled);
      const receiptPrinterId = (settings as any)?.printerRouting?.receiptPrinterId || 'default';
      const fallbackProfile = pickProfile(settings, receiptPrinterId) || pickProfile(settings, 'default');
      // If we're in pure NETWORK mode and no IP is configured, skip. (Other modes can still print.)
      if (!fallbackProfile) return;

      const jobs = await cloudJson<PrintJobDTO[]>('GET', '/print-jobs/pending?limit=10', undefined, { requireAuth: true }).catch(() => []);
      for (const job of jobs) {
        if (!job?.id || inFlight.has(job.id)) continue;
        inFlight.add(job.id);
        try {
          const payload = job.payload || {};
          const meta = (payload as any)?.meta || {};
          const kind = String(meta?.kind || '').toUpperCase();

          let okAll = true;
          if (routingEnabled && kind === 'ORDER') {
            const routed = await routeOrderPayloadByStation(payload, settings);
            for (const r of routed) {
              const prof = pickProfile(settings, r.printerId) || fallbackProfile;
              const pr = await printWithProfile(r.payload, settings, prof);
              if (!pr.ok) okAll = false;
            }
          } else {
            const prof = fallbackProfile;
            const pr = await printWithProfile(payload, settings, prof);
            okAll = pr.ok;
          }

          await cloudJson('POST', `/print-jobs/${encodeURIComponent(String(job.id))}/ack`, { status: okAll ? 'SENT' : 'FAILED' }, { requireAuth: true }).catch(() => {});
        } finally {
          inFlight.delete(job.id);
        }
      }
    } catch {
      // swallow: printer station should never crash the app
    }
  };

  tick();
  setInterval(tick, 2500);
}

