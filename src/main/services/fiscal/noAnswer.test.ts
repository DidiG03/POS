/**
 * QA F3: easyPos accepting the connection and never answering held the
 * waiter's payment for minutes.
 *
 * Against a real local socket that accepts and never replies, through the
 * real transport: the request gives up on its own timeout. No request goes
 * to easyPos (the URL is a local middleware address on 127.0.0.1).
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import { FISCAL_ROUTES, FiscalTransportError, postFiscal } from './client';
import { resetEasyPosTransport } from './transport';

let server: net.Server;
const sockets = new Set<net.Socket>();
let accepted = 0;
let base = '';

beforeEach(async () => {
  server = net.createServer((socket) => {
    // Accept, read whatever comes, never answer.
    accepted += 1;
    sockets.add(socket);
    socket.on('data', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  accepted = 0;
});

afterEach(async () => {
  await resetEasyPosTransport();
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const settings = () =>
  ({
    fiscal: {
      enabled: true,
      provider: 'easypos',
      baseUrl: base,
      authToken: 'local-token',
    },
  }) as unknown as SettingsDTO;

describe('easyPos connects but never answers', () => {
  it('the request gives up on its timeout instead of hanging', async () => {
    const started = Date.now();
    const attempt = postFiscal(
      settings(),
      FISCAL_ROUTES.status,
      { docId: 'doc-no-answer' },
      { timeoutMs: 1_000 },
    );
    await expect(attempt).rejects.toBeInstanceOf(FiscalTransportError);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(5_000);
    // The connection was made: it is the silence that timed out.
    expect(accepted).toBeGreaterThan(0);
  });
});
