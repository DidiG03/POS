import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { isPackaged: false, isReady: () => false, getPath: () => '/tmp' },
  net: { fetch: vi.fn() },
}));

import { sendViaLpr } from './print';

let server: net.Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** An LPR daemon that ACKs every step, or drops the line at step `dropAt`. */
function lprd(dropAt?: number): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  return new Promise((resolve) => {
    server = net.createServer((sock) => {
      let step = 0;
      sock.on('data', (b) => {
        received.push(b);
        step += 1;
        if (dropAt && step >= dropAt) {
          sock.destroy();
          return;
        }
        // ACK whenever a command or a file's trailing NUL arrives.
        if (b[0] === 0x02 || b[0] === 0x03 || b[b.length - 1] === 0x00) {
          sock.write(Buffer.from([0]));
        }
      });
      sock.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server!.address() as net.AddressInfo).port, received }),
    );
  });
}

describe('sendViaLpr', () => {
  it('sends a job through all three steps', async () => {
    const { port, received } = await lprd();
    await sendViaLpr('127.0.0.1', port, 'lp', Buffer.from('hello'));
    expect(Buffer.concat(received).toString()).toContain('hello');
  });

  it('fails fast when the printer drops the connection', async () => {
    const { port } = await lprd(1);
    const started = Date.now();
    await expect(
      sendViaLpr('127.0.0.1', port, 'lp', Buffer.from('hello')),
    ).rejects.toThrow();
    // Not the 5 s ack timeout: the socket's own error/close is noticed.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('reports a refused connection', async () => {
    const probe = net.createServer();
    const port = await new Promise<number>((r) =>
      probe.listen(0, '127.0.0.1', () =>
        r((probe.address() as net.AddressInfo).port),
      ),
    );
    await new Promise((r) => probe.close(r));
    await expect(
      sendViaLpr('127.0.0.1', port, 'lp', Buffer.from('x')),
    ).rejects.toThrow(/ECONNREFUSED|refused/i);
  });
});
