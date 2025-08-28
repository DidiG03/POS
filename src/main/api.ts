import http from 'http';
import https from 'https';
import fs from 'fs';
import url from 'url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';

function send(res: http.ServerResponse, code: number, data: any) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

async function parseJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
      let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function startApiServer(httpPort = 3333, httpsPort = 3443) {
  const CURRENT_FILE = fileURLToPath(import.meta.url);
  const CURRENT_DIR = dirname(CURRENT_FILE);
  const RENDERER_DIR = join(CURRENT_DIR, '../renderer');
  const RENDERER_ORIGIN = process.env.RENDERER_ORIGIN || '';

  function getContentType(pathname: string) {
    if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
    if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
    if (pathname.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
    if (pathname.endsWith('.svg')) return 'image/svg+xml';
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    if (pathname.endsWith('.woff2')) return 'font/woff2';
    if (pathname.endsWith('.map')) return 'application/octet-stream';
    return 'text/plain; charset=utf-8';
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      if (req.method === 'OPTIONS') {
        send(res, 200, 'ok');
            return;
      }
      const parsed = url.parse(req.url || '', true);
      const pathname = parsed.pathname || '';

      // Static site (serve built renderer or proxy to remote origin)
      if (req.method === 'GET') {
        let filePath = '';
        if (pathname === '/' || pathname === '/renderer' || pathname === '/renderer/') {
          filePath = join(RENDERER_DIR, 'index.html');
        } else if (pathname.startsWith('/renderer/')) {
          filePath = join(RENDERER_DIR, pathname.replace('/renderer/', ''));
        } else if (pathname === '/index.html' || pathname.startsWith('/assets/') || pathname.startsWith('/favicon')) {
          filePath = join(RENDERER_DIR, pathname.replace(/^\//, ''));
        }
        if (filePath) {
          // If proxy origin configured, fetch from it and stream through
          if (RENDERER_ORIGIN) {
            try {
              const upstreamPath = pathname === '/' || pathname === '/renderer' || pathname === '/renderer/'
                ? '/'
                : pathname.replace('/renderer/', '/');
              const upstreamUrl = new URL(upstreamPath, RENDERER_ORIGIN).toString();
              const upstream = await fetch(upstreamUrl);
              const buf = new Uint8Array(await upstream.arrayBuffer());
              res.writeHead(upstream.status, { 'Content-Type': getContentType(upstreamPath) });
              res.end(Buffer.from(buf));
              return;
            } catch {
              // fall back to local files
            }
          }
          try {
            if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
              filePath = join(RENDERER_DIR, 'index.html');
            }
            const stream = fs.createReadStream(filePath);
            res.writeHead(200, { 'Content-Type': getContentType(filePath) });
            stream.pipe(res);
            return;
          } catch {
            // fall through
          }
        }
      }

      // Auth
      if (req.method === 'POST' && pathname === '/auth/login') {
        const { pin, userId } = await parseJson(req);
        const where: any = userId ? { id: Number(userId), active: true } : { active: true };
        const user = await prisma.user.findFirst({ where });
        if (!user) return send(res, 200, null);
        const ok = await bcrypt.compare(String(pin || ''), user.pinHash);
        if (!ok) {
          await prisma.notification.create({ data: { userId: user.id, type: 'SECURITY' as any, message: 'Wrong PIN attempt on your account' } }).catch(() => {});
          return send(res, 200, null);
        }
        return send(res, 200, { id: user.id, displayName: user.displayName, role: user.role, active: user.active, createdAt: user.createdAt.toISOString() });
      }
      if (req.method === 'GET' && pathname === '/auth/users') {
        const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
        return send(res, 200, users.map((u: any) => ({ id: u.id, displayName: u.displayName, role: u.role, active: u.active, createdAt: u.createdAt.toISOString() })));
      }

      // Menu
      if (req.method === 'GET' && pathname === '/menu/categories') {
        const cats = await prisma.category.findMany({
          where: { active: true },
          orderBy: { sortOrder: 'asc' },
          include: { items: { where: { active: true }, orderBy: { name: 'asc' } } },
        });
        return send(res, 200, cats.map((c: any) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder, active: c.active, items: c.items.map((i: any) => ({ id: i.id, name: i.name, sku: i.sku, price: Number(i.price), vatRate: Number(i.vatRate), active: i.active, categoryId: i.categoryId })) })));
      }

      // Tickets
      if (req.method === 'POST' && pathname === '/tickets') {
        const { userId, area, tableLabel, covers, items, note } = await parseJson(req);
        if (!userId || !area || !tableLabel) return send(res, 400, 'invalid payload');
        await prisma.ticketLog.create({ data: { userId: Number(userId), area: String(area), tableLabel: String(tableLabel), covers: covers ? Number(covers) : null, itemsJson: items ?? [], note: note ? String(note) : null } });
        return send(res, 201, 'ok');
      }
      if (req.method === 'GET' && pathname === '/tickets/latest') {
        const area = String(parsed.query.area || '');
        const tableLabel = String(parsed.query.table || '');
        if (!area || !tableLabel) return send(res, 400, 'invalid');
        const last = await prisma.ticketLog.findFirst({ where: { area, tableLabel }, orderBy: { createdAt: 'desc' } });
        if (!last) return send(res, 200, null);
        return send(res, 200, { items: last.itemsJson as any, note: last.note ?? null, covers: last.covers ?? null, createdAt: last.createdAt.toISOString(), userId: last.userId });
      }
      if (req.method === 'POST' && pathname === '/tickets/void-item') {
        const { userId, area, tableLabel, item } = await parseJson(req);
        if (!userId || !area || !tableLabel || !item?.name) return send(res, 400, 'invalid');
        const message = `Voided item on ${area} ${tableLabel}: ${item.name} x${Number(item.qty || 1)}`;
        await prisma.notification.create({ data: { userId: Number(userId), type: 'OTHER' as any, message } }).catch(() => {});
        const last = await prisma.ticketLog.findFirst({ where: { area, tableLabel }, orderBy: { createdAt: 'desc' } });
        if (last) {
          const items = (last.itemsJson as any[]) || [];
          const idx = items.findIndex((it: any) => it.name === item.name);
          if (idx !== -1) {
            items[idx] = { ...items[idx], voided: true };
            await prisma.ticketLog.update({ where: { id: last.id }, data: { itemsJson: items } });
          }
        }
        return send(res, 200, 'ok');
      }
      if (req.method === 'POST' && pathname === '/tickets/void-ticket') {
        const { userId, area, tableLabel, reason } = await parseJson(req);
        if (!userId || !area || !tableLabel) return send(res, 400, 'invalid');
        const message = `Voided ticket on ${area} ${tableLabel}${reason ? `: ${reason}` : ''}`;
        await prisma.notification.create({ data: { userId: Number(userId), type: 'OTHER' as any, message } }).catch(() => {});
        const last = await prisma.ticketLog.findFirst({ where: { area, tableLabel }, orderBy: { createdAt: 'desc' } });
        if (last) {
          const items = ((last.itemsJson as any[]) || []).map((it: any) => ({ ...it, voided: true }));
          await prisma.ticketLog.update({ where: { id: last.id }, data: { itemsJson: items, note: last.note ? `${last.note} | VOIDED${reason ? `: ${reason}` : ''}` : `VOIDED${reason ? `: ${reason}` : ''}` } });
        }
        return send(res, 200, 'ok');
      }

      // Tables open
      if (req.method === 'POST' && pathname === '/tables/open') {
        const { area, label, open } = await parseJson(req);
        if (!area || !label) return send(res, 400, 'invalid');
        const key = 'tables:open';
        const row = await prisma.syncState.findUnique({ where: { key } });
        const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
        const k = `${area}:${label}`;
        if (open) map[k] = true; else delete map[k];
        await prisma.syncState.upsert({ where: { key }, create: { key, valueJson: map }, update: { valueJson: map } });
        return send(res, 200, 'ok');
      }
      if (req.method === 'GET' && pathname === '/tables/open') {
        const key = 'tables:open';
        const row = await prisma.syncState.findUnique({ where: { key } });
        const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
        return send(res, 200, Object.entries(map).filter(([, v]) => Boolean(v)).map(([k]) => { const [area, label] = k.split(':'); return { area, label }; }));
      }

      // Shifts (open userIds)
      if (req.method === 'GET' && pathname === '/shifts/open') {
        const rows = await prisma.dayShift.findMany({ where: { closedAt: null } });
        return send(res, 200, rows.map((s: any) => s.openedById));
      }

      // Shift: get open shift for a user
      if (req.method === 'GET' && pathname === '/shifts/get-open') {
        const userId = Number(parsed.query.userId || 0);
        if (!userId) return send(res, 400, 'invalid');
        const open = await prisma.dayShift.findFirst({ where: { closedAt: null, openedById: userId } });
        return send(res, 200, open ? { id: open.id, openedAt: open.openedAt.toISOString(), closedAt: open.closedAt ? new Date(open.closedAt).toISOString() : null, openedById: open.openedById, closedById: open.closedById ?? null } : null);
      }
      // Shift: clock in
      if (req.method === 'POST' && pathname === '/shifts/clock-in') {
        const { userId } = await parseJson(req);
        if (!userId) return send(res, 400, 'invalid');
        const already = await prisma.dayShift.findFirst({ where: { closedAt: null, openedById: Number(userId) } });
        if (already) return send(res, 200, { id: already.id, openedAt: already.openedAt.toISOString(), closedAt: null, openedById: already.openedById, closedById: already.closedById ?? null });
        const created = await prisma.dayShift.create({ data: { openedById: Number(userId), totalsJson: {} as any } as any });
        return send(res, 200, { id: created.id, openedAt: created.openedAt.toISOString(), closedAt: null, openedById: created.openedById, closedById: created.closedById ?? null });
      }
      // Shift: clock out
      if (req.method === 'POST' && pathname === '/shifts/clock-out') {
        const { userId } = await parseJson(req);
        if (!userId) return send(res, 400, 'invalid');
        const open = await prisma.dayShift.findFirst({ where: { closedAt: null, openedById: Number(userId) } });
        if (!open) return send(res, 200, null);
        const updated = await prisma.dayShift.update({ where: { id: open.id }, data: { closedAt: new Date(), closedById: Number(userId) } });
        return send(res, 200, { id: updated.id, openedAt: updated.openedAt.toISOString(), closedAt: updated.closedAt ? new Date(updated.closedAt).toISOString() : null, openedById: updated.openedById, closedById: updated.closedById ?? null });
      }

      // Settings (minimal: only enableAdmin used by login)
      if (req.method === 'GET' && pathname === '/settings') {
        const row = await prisma.syncState.findUnique({ where: { key: 'settings' } }).catch(() => null);
        const stored = (row?.valueJson as any) || {};
        const enableAdmin = Boolean(stored.enableAdmin);
        return send(res, 200, { enableAdmin });
      }

      // Covers
      if (req.method === 'POST' && pathname === '/covers/save') {
        const { area, label, covers } = await parseJson(req);
        const num = Number(covers);
        if (!area || !label || !Number.isFinite(num) || num <= 0) return send(res, 400, 'invalid');
        await prisma.covers.create({ data: { area: String(area), label: String(label), covers: num } });
        return send(res, 200, 'ok');
      }
      if (req.method === 'GET' && pathname === '/covers/last') {
        const area = String(parsed.query.area || '');
        const label = String(parsed.query.label || '');
        if (!area || !label) return send(res, 400, 'invalid');
        const row = await prisma.covers.findFirst({ where: { area, label }, orderBy: { id: 'desc' } });
        return send(res, 200, row?.covers ?? null);
      }

      // Admin overview and trends
      if (req.method === 'GET' && pathname === '/admin/overview') {
        const [users, openShifts, openTables, revenueRows] = await Promise.all([
          prisma.user.count({ where: { active: true } }),
          prisma.dayShift.count({ where: { closedAt: null } }),
          (async () => {
            const key = 'tables:open';
            const row = await prisma.syncState.findUnique({ where: { key } }).catch(() => null);
            const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
            return Object.values(map).filter(Boolean).length;
          })(),
          prisma.ticketLog.findMany({
            where: { createdAt: { gte: new Date(new Date().setHours(0,0,0,0)), lte: new Date(new Date().setHours(23,59,59,999)) } },
            select: { itemsJson: true },
          }).catch(() => []),
        ]);
        const revenueTodayNet = (revenueRows as any[]).reduce((s, r) => s + (r.itemsJson as any[]).reduce((ss: number, it: any) => ss + (Number(it.unitPrice) * Number(it.qty || 1)), 0), 0);
        const revenueTodayVat = (revenueRows as any[]).reduce((s, r) => s + (r.itemsJson as any[]).reduce((ss: number, it: any) => ss + (Number(it.unitPrice) * Number(it.qty || 1) * Number(it.vatRate || 0)), 0), 0);
        return send(res, 200, { activeUsers: users, openShifts, openOrders: openTables, lowStockItems: 0, queuedPrintJobs: 0, lastMenuSync: null, lastStaffSync: null, printerIp: process.env.PRINTER_IP ?? null, appVersion: process.env.npm_package_version || '0.1.0', revenueTodayNet, revenueTodayVat });
      }
      if (req.method === 'GET' && pathname === '/admin/sales-trends') {
        const range = (parsed.query.range as string) || 'daily';
        const today = new Date(new Date().setHours(0, 0, 0, 0));
        let buckets: { label: string; from: Date; to: Date }[] = [];
        if (range === 'daily') {
          const start = new Date(today.getTime() - 13 * 86400000);
          for (let i = 0; i < 14; i++) {
            const d = new Date(start.getTime() + i * 86400000);
            const from = new Date(d.setHours(0, 0, 0, 0));
            const to = new Date(d.setHours(23, 59, 59, 999));
            const label = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        } else if (range === 'weekly') {
          const start = new Date(today.getTime() - 7 * 86400000 * 11);
          for (let i = 0; i < 12; i++) {
            const from = new Date(start.getTime() + i * 7 * 86400000);
            const to = new Date(from.getTime() + 6 * 86400000);
            from.setHours(0, 0, 0, 0); to.setHours(23, 59, 59, 999);
            const oneJan = new Date(from.getFullYear(), 0, 1);
            const week = Math.ceil((((from.getTime() - oneJan.getTime()) / 86400000) + oneJan.getDay() + 1) / 7);
            const label = `${from.getFullYear()}-W${String(week).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        } else {
          const startYear = today.getFullYear();
          let m = today.getMonth() - 11;
          for (let i = 0; i < 12; i++, m++) {
            const year = startYear + Math.floor(m / 12);
            const month = ((m % 12) + 12) % 12;
            const from = new Date(year, month, 1, 0, 0, 0, 0);
            const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
            const label = `${year}-${String(month + 1).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        }
        const rows = await prisma.ticketLog.findMany({ where: { createdAt: { gte: buckets[0].from, lte: buckets[buckets.length - 1].to } }, select: { createdAt: true, itemsJson: true }, orderBy: { createdAt: 'asc' } });
        const points = buckets.map((b) => ({ label: b.label, total: 0, orders: 0 }));
        for (const r of rows) {
          const when = new Date(r.createdAt);
          const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
          if (idx === -1) continue;
          const net = (r.itemsJson as any[]).reduce((s: number, it: any) => s + (Number(it.unitPrice) * Number(it.qty || 1)), 0);
          points[idx].total += net; points[idx].orders += 1;
        }
        return send(res, 200, { range, points });
      }

      // Fallback
      return send(res, 404, 'not found');
    } catch (e) {
      console.error('API error', e);
      return send(res, 500, 'error');
    }
  };

  const server = http.createServer(handler);
  server.listen(httpPort, () => {
    console.log(`HTTP API listening on http://localhost:${httpPort}`);
  });

  try {
    const key = fs.readFileSync('key.pem');
    const cert = fs.readFileSync('cert.pem');
    const httpsServer = https.createServer({ key, cert }, handler);
    httpsServer.listen(httpsPort, () => {
      console.log(`HTTPS API listening on https://localhost:${httpsPort}`);
    });
  } catch {
    // no TLS certs, skip HTTPS
  }

  return server;
}
