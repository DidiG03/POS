import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureTlsMaterial,
  issueTillCertificate,
  type TlsMaterial,
} from './lanTls';
import {
  TILL_IDENTITY_CHANGED,
  createPinnedTillClient,
  fileTillPinStore,
  memoryTillPinStore,
  type TillResponse,
} from './pinnedTillClient';

const HOST = '127.0.0.1';
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-pin-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function newTls(): Promise<TlsMaterial> {
  return ensureTlsMaterial(path.join(tempDir(), 'certs'), {});
}

type Seen = { plain: string[]; secure: string[]; bodies: string[] };

function handler(seen: Seen, kind: 'plain' | 'secure', health: () => object) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    seen[kind].push(`${req.method} ${req.url}`);
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(health()));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (body) seen.bodies.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ via: kind, auth: req.headers.authorization }));
    });
  };
}

function listen(server: http.Server | https.Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, HOST, () => {
      cleanup.push(() => {
        (server as any).closeAllConnections?.();
        server.close();
      });
      resolve((server.address() as { port: number }).port);
    });
  });
}

/** A till: plain HTTP always, HTTPS when `tls` is given. */
async function startTill(opts: { tls?: TlsMaterial; advertisePin?: string }) {
  const seen: Seen = { plain: [], secure: [], bodies: [] };
  let httpsPort = 0;
  let secureServer: https.Server | null = null;
  if (opts.tls) {
    secureServer = https.createServer(
      { key: opts.tls.key, cert: opts.tls.cert },
      handler(seen, 'secure', () => ({ ok: true })),
    );
    httpsPort = await listen(secureServer);
  }
  const plain = http.createServer(
    handler(seen, 'plain', () =>
      opts.tls
        ? {
            ok: true,
            httpsPort,
            tlsPin: opts.advertisePin ?? opts.tls.pin,
          }
        : { ok: true },
    ),
  );
  const httpPort = await listen(plain);
  return { seen, httpPort, httpsPort, secureServer };
}

async function json(res: TillResponse): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of res.stream) chunks.push(Buffer.from(c));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe('pinned till client', () => {
  it('moves to HTTPS on first contact and remembers the till', async () => {
    const tls = await newTls();
    const till = await startTill({ tls });
    const store = memoryTillPinStore();
    const client = createPinnedTillClient({ store });
    const res = await client.request({
      host: HOST,
      httpPort: till.httpPort,
      path: '/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"userId":1,"pin":"482913"}',
    });
    expect(res.secure).toBe(true);
    expect((await json(res)).via).toBe('secure');
    // The PIN went over HTTPS only; plain HTTP saw just the health check.
    expect(till.seen.plain).toEqual(['GET /health']);
    expect(till.seen.bodies).toEqual(['{"userId":1,"pin":"482913"}']);
    expect(store.get(HOST)?.pin).toBe(tls.pin);
    expect(store.get(HOST)?.httpsPort).toBe(till.httpsPort);

    await json(
      await client.request({
        host: HOST,
        httpPort: till.httpPort,
        path: '/kds/tickets',
        headers: { Authorization: 'Bearer abc' },
      }),
    );
    expect(till.seen.plain).toEqual(['GET /health']);
    expect(till.seen.secure).toEqual(['POST /auth/login', 'GET /kds/tickets']);
  });

  it('keeps using HTTP with a till that does not offer HTTPS, asking once', async () => {
    const till = await startTill({});
    const client = createPinnedTillClient({ store: memoryTillPinStore() });
    for (let i = 0; i < 3; i++) {
      const res = await client.request({
        host: HOST,
        httpPort: till.httpPort,
        path: '/kds/tickets',
      });
      expect(res.secure).toBe(false);
      await json(res);
    }
    expect(till.seen.plain.filter((r) => r === 'GET /health')).toHaveLength(1);
  });

  it('does not fall back to HTTP once a till is remembered', async () => {
    const tls = await newTls();
    const till = await startTill({ tls });
    const client = createPinnedTillClient({ store: memoryTillPinStore() });
    await json(
      await client.request({ host: HOST, httpPort: till.httpPort, path: '/a' }),
    );
    (till.secureServer as any).closeAllConnections?.();
    await new Promise<void>((r) => till.secureServer!.close(() => r()));
    const before = till.seen.plain.length;
    await expect(
      client.request({
        host: HOST,
        httpPort: till.httpPort,
        path: '/auth/login',
        method: 'POST',
        body: '{"pin":"482913"}',
      }),
    ).rejects.toThrow();
    expect(till.seen.plain.length).toBe(before);
    expect(till.seen.bodies).toEqual([]);
  });

  it('refuses another machine answering at the remembered address', async () => {
    const tls = await newTls();
    const till = await startTill({ tls });
    const store = memoryTillPinStore();
    const client = createPinnedTillClient({ store });
    await json(
      await client.request({ host: HOST, httpPort: till.httpPort, path: '/a' }),
    );
    (till.secureServer as any).closeAllConnections?.();
    await new Promise<void>((r) => till.secureServer!.close(() => r()));

    const impostorTls = await newTls();
    const impostorSeen: Seen = { plain: [], secure: [], bodies: [] };
    const impostor = https.createServer(
      { key: impostorTls.key, cert: impostorTls.cert },
      handler(impostorSeen, 'secure', () => ({ ok: true })),
    );
    await listen(impostor, till.httpsPort);

    const attempt = client.request({
      host: HOST,
      httpPort: till.httpPort,
      path: '/auth/login',
      method: 'POST',
      body: '{"pin":"482913"}',
    });
    await expect(attempt).rejects.toMatchObject({
      code: TILL_IDENTITY_CHANGED,
    });
    // Nothing reached the impostor's handler, and the pin is unchanged.
    expect(impostorSeen.secure).toEqual([]);
    expect(impostorSeen.bodies).toEqual([]);
    expect(store.get(HOST)?.pin).toBe(tls.pin);
  });

  it('accepts a renewed certificate for the same key', async () => {
    const tls = await newTls();
    const till = await startTill({ tls });
    const store = memoryTillPinStore();
    const client = createPinnedTillClient({ store });
    await json(
      await client.request({ host: HOST, httpPort: till.httpPort, path: '/a' }),
    );
    const oldCert = store.get(HOST)!.cert;
    (till.secureServer as any).closeAllConnections?.();
    await new Promise<void>((r) => till.secureServer!.close(() => r()));

    const renewedCert = await issueTillCertificate(tls.key.toString(), {});
    const renewed = https.createServer(
      { key: tls.key, cert: renewedCert },
      handler(till.seen, 'secure', () => ({ ok: true })),
    );
    await listen(renewed, till.httpsPort);
    client.forgetAll();
    store.set(HOST, { pin: tls.pin, cert: oldCert, httpsPort: till.httpsPort });

    const res = await client.request({
      host: HOST,
      httpPort: till.httpPort,
      path: '/b',
    });
    expect(res.secure).toBe(true);
    await json(res);
    expect(store.get(HOST)!.cert).not.toBe(oldCert);
    expect(store.get(HOST)!.pin).toBe(tls.pin);
  });

  it('does not remember a till whose HTTPS key is not the one it named', async () => {
    const tls = await newTls();
    const other = await newTls();
    const till = await startTill({ tls, advertisePin: other.pin });
    const store = memoryTillPinStore();
    const client = createPinnedTillClient({ store });
    const res = await client.request({
      host: HOST,
      httpPort: till.httpPort,
      path: '/a',
    });
    expect(res.secure).toBe(false);
    await json(res);
    expect(store.get(HOST)).toBeNull();
  });

  it('talks plain HTTP to a till on this same computer', async () => {
    const tls = await newTls();
    const till = await startTill({ tls });
    const store = memoryTillPinStore();
    const client = createPinnedTillClient({ store });
    const res = await client.request({
      host: HOST,
      httpPort: till.httpPort,
      path: '/a',
      thisMachine: true,
    });
    expect(res.secure).toBe(false);
    await json(res);
    expect(till.seen.plain).toEqual(['GET /a']);
    expect(store.get(HOST)).toBeNull();
  });

  it('forgets a till on Reset connection, then trusts the new one', async () => {
    const tls = await newTls();
    const till = await startTill({ tls });
    const store = memoryTillPinStore();
    const client = createPinnedTillClient({ store });
    await json(
      await client.request({ host: HOST, httpPort: till.httpPort, path: '/a' }),
    );
    client.forgetAll();
    expect(store.get(HOST)).toBeNull();
    const res = await client.request({
      host: HOST,
      httpPort: till.httpPort,
      path: '/a',
    });
    expect(res.secure).toBe(true);
    await json(res);
  });
});

describe('fileTillPinStore', () => {
  it('keeps pins across restarts and survives a damaged file', () => {
    const file = path.join(tempDir(), 'nested', 'till-pins.json');
    const a = fileTillPinStore(file);
    a.set('192.168.1.20', { pin: 'p', cert: 'c', httpsPort: 3443 });
    expect(fileTillPinStore(file).get('192.168.1.20')?.pin).toBe('p');
    fs.writeFileSync(file, '{not json');
    expect(fileTillPinStore(file).get('192.168.1.20')).toBeNull();
    a.clear();
    expect(fileTillPinStore(file).get('192.168.1.20')).toBeNull();
  });
});
