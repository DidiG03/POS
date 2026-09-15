import { BrowserWindow } from 'electron';
import os from 'node:os';

export function listLanIpv4Addresses(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    const list = nets[name] || [];
    for (const ni of list) {
      if (!ni) continue;
      if (ni.family !== 'IPv4') continue;
      if (ni.internal) continue;
      ips.push(ni.address);
    }
  }
  return Array.from(new Set(ips)).sort((a, b) => a.localeCompare(b));
}

export async function listHostSystemPrinters(): Promise<
  Array<{
    name: string;
    isDefault?: boolean;
    status?: number;
    description?: string;
  }>
> {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      const list = await w.webContents.getPrintersAsync();
      return (list || []).map((p: any) => ({
        name: p.name,
        isDefault: Boolean(p.isDefault),
        status: typeof p.status === 'number' ? p.status : undefined,
        description: p.description ? String(p.description) : undefined,
      }));
    } catch {
      // try the next window
    }
  }
  return [];
}
