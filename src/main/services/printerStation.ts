import { buildEscposTicket, sendToPrinter } from '../print';
import { coreServices } from './core';
import { cloudJson, getCloudConfig, hasCloudSession } from './cloud';

type PrintJobDTO = { id: number; type: string; payload: any; createdAt: string };

let started = false;

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
      const ip = process.env.PRINTER_IP || settings?.printer?.ip;
      const port = Number(process.env.PRINTER_PORT || settings?.printer?.port || 9100);
      if (!ip) return;

      const jobs = await cloudJson<PrintJobDTO[]>('GET', '/print-jobs/pending?limit=10', undefined, { requireAuth: true }).catch(() => []);
      for (const job of jobs) {
        if (!job?.id || inFlight.has(job.id)) continue;
        inFlight.add(job.id);
        try {
          const payload = job.payload || {};
          const data = buildEscposTicket(payload, settings as any);
          const ok = await sendToPrinter(ip, port, data);
          await cloudJson('POST', `/print-jobs/${encodeURIComponent(String(job.id))}/ack`, { status: ok ? 'SENT' : 'FAILED' }, { requireAuth: true }).catch(() => {});
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

