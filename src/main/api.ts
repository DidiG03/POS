import http from 'http';
import { prisma } from '@db/client';

export function startApiServer(port = 3333) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/tickets') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const { userId, area, tableLabel, covers, items, note } = payload || {};
          if (!userId || !area || !tableLabel) {
            res.writeHead(400).end('invalid payload');
            return;
          }
          await prisma.ticketLog.create({
            data: {
              userId: Number(userId),
              area: String(area),
              tableLabel: String(tableLabel),
              covers: covers ? Number(covers) : null,
              itemsJson: items ?? [],
              note: note ? String(note) : null,
            },
          });
          res.writeHead(201).end('ok');
        } catch (err) {
          console.error('API error', err);
          res.writeHead(500).end('error');
        }
      });
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(port, () => {
    console.log(`HTTP API listening on port ${port}`);
  });
  return server;
}
