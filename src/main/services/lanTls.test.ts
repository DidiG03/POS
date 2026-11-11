import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TILL_CERT_COMMON_NAME,
  ensureTlsMaterial,
  generateTillKeyPem,
  issueTillCertificate,
  tlsPinOfCertificate,
} from './lanTls';

const DAY = 86_400_000;
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-tls-'));
  dirs.push(dir);
  return path.join(dir, 'certs');
}

afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const hosts = { dns: ['till-mac', 'till-mac.local'], ips: ['192.168.1.20'] };

/** GET over TLS, trusting only `pin`; resolves with the status code. */
function getWithPin(port: number, pin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      },
    );
    req.on('socket', (socket: any) => {
      socket.on('secureConnect', () => {
        const peer = socket.getPeerX509Certificate?.();
        if (!peer || tlsPinOfCertificate(peer.toString()) !== pin) {
          req.destroy(new Error('pin mismatch'));
        }
      });
    });
    req.on('error', reject);
  });
}

describe('ensureTlsMaterial', () => {
  it('makes a key and a ten-year certificate on first start', async () => {
    const dir = tempDir();
    const tls = await ensureTlsMaterial(dir, hosts);
    expect(tls.source).toBe('created');
    expect(tls.ownedByTill).toBe(true);
    const cert = new crypto.X509Certificate(tls.cert);
    expect(cert.subject).toContain(TILL_CERT_COMMON_NAME);
    expect(cert.subjectAltName).toContain('IP Address:192.168.1.20');
    expect(cert.subjectAltName).toContain('DNS:till-mac.local');
    expect(cert.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(cert.ca).toBe(false);
    const years = (tls.notAfter.getTime() - Date.now()) / DAY / 365;
    expect(years).toBeGreaterThan(9.9);
    expect(tls.pin).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'key.pem')).mode & 0o077).toBe(0);
    }
  });

  it('uses the same key and certificate on the next start', async () => {
    const dir = tempDir();
    const first = await ensureTlsMaterial(dir, hosts);
    const second = await ensureTlsMaterial(dir, hosts);
    expect(second.source).toBe('existing');
    expect(second.pin).toBe(first.pin);
    expect(second.cert.equals(first.cert)).toBe(true);
  });

  it('re-issues a certificate near its end date without changing the pin', async () => {
    const dir = tempDir();
    const first = await ensureTlsMaterial(dir, hosts);
    const later = first.notAfter.getTime() - 30 * DAY;
    const renewed = await ensureTlsMaterial(dir, hosts, later);
    expect(renewed.source).toBe('renewed');
    expect(renewed.pin).toBe(first.pin);
    expect(renewed.notAfter.getTime()).toBeGreaterThan(
      first.notAfter.getTime() + 3000 * DAY,
    );
    expect(renewed.cert.equals(first.cert)).toBe(false);
  });

  it('keeps the key when only the certificate is missing', async () => {
    const dir = tempDir();
    const first = await ensureTlsMaterial(dir, hosts);
    fs.rmSync(path.join(dir, 'cert.pem'));
    const again = await ensureTlsMaterial(dir, hosts);
    expect(again.pin).toBe(first.pin);
  });

  it('never replaces a key pair an operator installed, even an expired one', async () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    const keyPem = generateTillKeyPem();
    // Issued eleven years ago under the venue's own name: expired by now.
    const certPem = await issueTillCertificate(
      keyPem,
      hosts,
      Date.now() - 4000 * DAY,
      'pos.venue.example',
    );
    fs.writeFileSync(path.join(dir, 'key.pem'), keyPem);
    fs.writeFileSync(path.join(dir, 'cert.pem'), certPem);
    const tls = await ensureTlsMaterial(dir, hosts);
    expect(tls.source).toBe('existing');
    expect(tls.ownedByTill).toBe(false);
    expect(tls.cert.toString()).toBe(certPem);
    expect(tls.notAfter.getTime()).toBeLessThan(Date.now());
  });

  it('re-issues its own certificate after it has expired', async () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    const keyPem = generateTillKeyPem();
    const certPem = await issueTillCertificate(
      keyPem,
      hosts,
      Date.now() - 4000 * DAY,
    );
    fs.writeFileSync(path.join(dir, 'key.pem'), keyPem);
    fs.writeFileSync(path.join(dir, 'cert.pem'), certPem);
    const tls = await ensureTlsMaterial(dir, hosts);
    expect(tls.source).toBe('renewed');
    expect(tls.pin).toBe(tlsPinOfCertificate(certPem));
    expect(tls.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a certificate that does not belong to the key', async () => {
    const dir = tempDir();
    const first = await ensureTlsMaterial(dir, hosts);
    expect(first.source).toBe('created');
    fs.writeFileSync(path.join(dir, 'key.pem'), generateTillKeyPem());
    await expect(ensureTlsMaterial(dir, hosts)).rejects.toThrow(
      /do not belong together/,
    );
  });
});

describe('the certificate in use', () => {
  it('serves TLS 1.2+ to a client that pins it, and not to one that pins another', async () => {
    const tls = await ensureTlsMaterial(tempDir(), hosts);
    const server = https.createServer(
      { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' },
      (_req, res) => res.end('ok'),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await getWithPin(port, tls.pin)).toBe(200);
      const other = await ensureTlsMaterial(tempDir(), hosts);
      await expect(getWithPin(port, other.pin)).rejects.toThrow(/pin mismatch/);
    } finally {
      server.close();
    }
  });

  it('gives every till a different key', async () => {
    const a = await ensureTlsMaterial(tempDir(), hosts);
    const b = await ensureTlsMaterial(tempDir(), hosts);
    expect(a.pin).not.toBe(b.pin);
  });
});
