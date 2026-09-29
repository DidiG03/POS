/**
 * One connection to easyPos, kept between payments and opened early.
 *
 * Against a real local server: count TCP connections, because the whole
 * point is that the second request does not open another one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  easyPosFetch,
  resetEasyPosTransport,
  warmEasyPosConnection,
} from './transport';

let server: http.Server;
let base = '';
let connections = 0;
const requests: string[] = [];

beforeEach(async () => {
  connections = 0;
  requests.length = 0;
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      // Like easyPos: a sized reply and the connection kept open.
      const body = '{"ok":true}';
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
    });
  });
  server.keepAliveTimeout = 75_000;
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await resetEasyPosTransport();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A port nothing listens on, so a connect is actively refused. */
async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const post = () =>
  easyPosFetch(`${base}/fiscalisation-service/v1/invoice/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

describe('easyPos transport', () => {
  it('reuses the connection after an idle gap Node’s fetch would close', async () => {
    const first = await post();
    expect(await first.json()).toEqual({ ok: true });
    // Node's built-in fetch drops idle sockets after 4s.
    await new Promise((r) => setTimeout(r, 5_000));
    await (await post()).json();
    expect(connections).toBe(1);
  }, 15_000);

  it('opens the connection ahead of the payment, which then reuses it', async () => {
    await warmEasyPosConnection(`${base}/fiscalisation-service/v1`);
    expect(requests).toEqual(['GET /']);
    // The waiter is still entering the tender; the connection is back in
    // the pool well before the invoice is sent.
    await new Promise((r) => setTimeout(r, 50));
    await (await post()).json();
    expect(connections).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it('does not warm a connection that was just used', async () => {
    await (await post()).json();
    await warmEasyPosConnection(`${base}/fiscalisation-service/v1`);
    expect(requests).toHaveLength(1);
  });

  it('shares one warm-up between screens opening at once', async () => {
    await Promise.all([
      warmEasyPosConnection(base),
      warmEasyPosConnection(base),
      warmEasyPosConnection(base),
    ]);
    expect(requests).toEqual(['GET /']);
  });

  it('never throws when easyPos cannot be reached', async () => {
    const closed = await closedPort();
    await expect(
      warmEasyPosConnection(
        `http://127.0.0.1:${closed}/fiscalisation-service/v1`,
      ),
    ).resolves.toBeUndefined();
    await expect(warmEasyPosConnection('not a url')).resolves.toBeUndefined();
  });

  it('keeps undici’s error shape for a refused connection', async () => {
    const closed = await closedPort();
    const err = await easyPosFetch(
      `http://127.0.0.1:${closed}/invoice/register`,
      {
        method: 'POST',
        headers: {},
        body: '{}',
      },
    ).catch((e) => e);
    // classify.ts relies on this to call the sale safely retryable.
    const { neverReachedProvider } = await import('./classify');
    expect(neverReachedProvider(err)).toBe(true);
  });
});
