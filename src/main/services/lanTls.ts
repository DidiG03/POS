/**
 * The till's own HTTPS certificate for the LAN API.
 *
 * Phones, kitchen displays and the Admin app used to reach the till over
 * plain HTTP unless an operator installed `key.pem` / `cert.pem` by hand,
 * which nobody did: PINs and session tokens crossed the Wi-Fi in the
 * clear. The till now makes its own key and certificate the first time it
 * starts and serves HTTPS with them.
 *
 * No public authority vouches for a till on a private network, so the
 * certificate is self-signed. A client does not trust it by name; it
 * remembers the till's *pin* (a hash of the certificate's public key) when
 * it is paired and afterwards refuses any other key. The key is made once
 * and kept: when the certificate nears its end date it is re-issued for
 * the same key, so the pin a device stored stays valid.
 *
 * A key pair an operator installed is used as it is and never replaced.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TILL_CERT_COMMON_NAME = 'OneTap POS till';
const CERT_DAYS = 3650;
/** Re-issue our own certificate when it has fewer days than this left. */
const RENEW_WITHIN_DAYS = 60;
const DAY_MS = 86_400_000;

export type TlsHosts = { dns?: string[]; ips?: string[] };

export type TlsMaterial = {
  key: Buffer;
  cert: Buffer;
  /** base64 SHA-256 of the certificate's public key (SPKI). */
  pin: string;
  /**
   * `created`: new key and certificate. `renewed`: our certificate was
   * re-issued for the existing key. `existing`: used as found.
   */
  source: 'created' | 'renewed' | 'existing';
  /** False for a key pair an operator installed. */
  ownedByTill: boolean;
  notAfter: Date;
};

/** The pin of a certificate: base64 SHA-256 of its SubjectPublicKeyInfo. */
export function tlsPinOfCertificate(certPem: string | Buffer): string {
  const spki = new crypto.X509Certificate(certPem).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  return crypto.createHash('sha256').update(spki).digest('base64');
}

function pem(label: string, der: ArrayBuffer | Buffer): string {
  const b64 = Buffer.from(der as ArrayBuffer).toString('base64');
  return `-----BEGIN ${label}-----\n${(b64.match(/.{1,64}/g) || []).join('\n')}\n-----END ${label}-----\n`;
}

function uniqueClean(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values || []).map((v) => String(v || '').trim()).filter(Boolean),
    ),
  ];
}

const EC = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

/** A fresh P-256 private key, PKCS#8 PEM. */
export function generateTillKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** A self-signed server certificate for `keyPem`, valid ten years. */
export async function issueTillCertificate(
  keyPem: string,
  hosts: TlsHosts,
  nowMs = Date.now(),
  commonName = TILL_CERT_COMMON_NAME,
): Promise<string> {
  // Loaded only here: once per install, and again years later to renew.
  await import('reflect-metadata');
  const x509 = await import('@peculiar/x509');
  const subtle = crypto.webcrypto.subtle;
  x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);

  const privateKeyObject = crypto.createPrivateKey(keyPem);
  const privateKey = await subtle.importKey(
    'pkcs8',
    privateKeyObject.export({ type: 'pkcs8', format: 'der' }),
    EC,
    false,
    ['sign'],
  );
  const publicKey = await subtle.importKey(
    'spki',
    crypto
      .createPublicKey(privateKeyObject)
      .export({ type: 'spki', format: 'der' }),
    EC,
    true,
    ['verify'],
  );

  const names = [
    ...uniqueClean(['localhost', ...(hosts.dns || [])]).map((value) => ({
      type: 'dns' as const,
      value,
    })),
    ...uniqueClean(['127.0.0.1', '::1', ...(hosts.ips || [])]).map((value) => ({
      type: 'ip' as const,
      value,
    })),
  ];

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto
      .randomBytes(16)
      .toString('hex')
      .replace(/^[89a-f]/, '7'),
    name: `CN=${commonName}`,
    // A day back, so a phone whose clock runs slightly behind accepts it.
    notBefore: new Date(nowMs - DAY_MS),
    notAfter: new Date(nowMs + CERT_DAYS * DAY_MS),
    signingAlgorithm: EC,
    keys: { privateKey, publicKey },
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      // serverAuth
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], false),
      new x509.SubjectAlternativeNameExtension(names, false),
    ],
  });
  return pem('CERTIFICATE', cert.rawData);
}

function writePrivate(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows: the user profile's own permissions apply
  }
}

function isOurCertificate(cert: crypto.X509Certificate): boolean {
  return cert.subject.split('\n').includes(`CN=${TILL_CERT_COMMON_NAME}`);
}

function keyMatchesCertificate(
  keyPem: Buffer,
  cert: crypto.X509Certificate,
): boolean {
  try {
    return cert.checkPrivateKey(crypto.createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

/**
 * The key pair in `dir`, made or renewed when needed.
 *
 * Throws when the files there cannot be used and are not ours to replace
 * (an operator's certificate that does not match its key); the caller then
 * runs without HTTPS and says why.
 */
export async function ensureTlsMaterial(
  dir: string,
  hosts: TlsHosts,
  nowMs = Date.now(),
): Promise<TlsMaterial> {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const haveKey = fs.existsSync(keyPath);
  const haveCert = fs.existsSync(certPath);

  if (haveKey && haveCert) {
    const key = fs.readFileSync(keyPath);
    const certPem = fs.readFileSync(certPath);
    const cert = new crypto.X509Certificate(certPem);
    if (!keyMatchesCertificate(key, cert)) {
      throw new Error(`key.pem and cert.pem in ${dir} do not belong together`);
    }
    const notAfter = new Date(cert.validTo);
    const ours = isOurCertificate(cert);
    const daysLeft = (notAfter.getTime() - nowMs) / DAY_MS;
    if (!ours || daysLeft > RENEW_WITHIN_DAYS) {
      return {
        key,
        cert: certPem,
        pin: tlsPinOfCertificate(certPem),
        source: 'existing',
        ownedByTill: ours,
        notAfter,
      };
    }
    // Ours and close to its end date: same key, new certificate.
    const renewed = await issueTillCertificate(key.toString(), hosts, nowMs);
    writePrivate(certPath, renewed);
    return {
      key,
      cert: Buffer.from(renewed),
      pin: tlsPinOfCertificate(renewed),
      source: 'renewed',
      ownedByTill: true,
      notAfter: new Date(new crypto.X509Certificate(renewed).validTo),
    };
  }

  // A key without its certificate keeps the key (and every stored pin).
  const keyPem = haveKey
    ? fs.readFileSync(keyPath).toString()
    : generateTillKeyPem();
  const certPem = await issueTillCertificate(keyPem, hosts, nowMs);
  if (!haveKey) writePrivate(keyPath, keyPem);
  writePrivate(certPath, certPem);
  return {
    key: Buffer.from(keyPem),
    cert: Buffer.from(certPem),
    pin: tlsPinOfCertificate(certPem),
    source: haveKey ? 'renewed' : 'created',
    ownedByTill: true,
    notAfter: new Date(new crypto.X509Certificate(certPem).validTo),
  };
}

/** What a client needs to reach the till over HTTPS, once it is serving. */
export type ActiveLanTls = { port: number; pin: string };

let active: ActiveLanTls | null = null;

export function setActiveLanTls(info: ActiveLanTls | null): void {
  active = info;
}

export function activeLanTls(): ActiveLanTls | null {
  return active;
}
