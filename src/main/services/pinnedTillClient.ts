/**
 * How the Admin and KDS desktop apps reach a till on another computer.
 *
 * They used plain HTTP: a PIN typed in Admin, or a kitchen display's
 * token, crossed the Wi-Fi in the clear. A till now serves HTTPS with a
 * certificate it made itself (`lanTls.ts`) and says so on `/health`.
 *
 *  - First contact: the till's `/health` names its HTTPS port and pin. The
 *    app connects to that port, checks the key really is the one named,
 *    and remembers the certificate for this till.
 *  - From then on every request goes over HTTPS and is verified against
 *    the remembered certificate before any data is sent. There is no
 *    return to plain HTTP for that till: blocking the HTTPS port must not
 *    be a way to make the app talk in the clear again.
 *  - A re-issued certificate for the same key (the till renews it near its
 *    end date) is accepted and remembered. A different key is refused with
 *    `TILL_IDENTITY_CHANGED`; "Reset connection" in the app forgets the
 *    till so it can be trusted again after a reinstall.
 *
 * A till on this same computer, and a till too old to offer HTTPS, are
 * reached over HTTP as before.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { tlsPinOfCertificate } from './lanTls';

export const TILL_IDENTITY_CHANGED = 'TILL_IDENTITY_CHANGED';
export const TILL_IDENTITY_CHANGED_MESSAGE =
  'This till is not the one this app was connected to (its security key changed). If the till was reinstalled or replaced, choose Reset connection and connect again.';

/** How long "this till offers no HTTPS" is believed before asking again. */
const NO_TLS_RECHECK_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

export type TillPin = { pin: string; cert: string; httpsPort: number };

export type TillPinStore = {
  get: (host: string) => TillPin | null;
  set: (host: string, value: TillPin) => void;
  clear: () => void;
};

/** Pins kept in one JSON file (the app's own data folder). */
export function fileTillPinStore(file: string): TillPinStore {
  let cache: Record<string, TillPin> | null = null;
  const load = (): Record<string, TillPin> => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      cache = {};
    }
    return cache!;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache || {}, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn('[till-pin] could not save:', e);
    }
  };
  return {
    get(host) {
      const hit = load()[host];
      return hit && hit.pin && hit.cert && hit.httpsPort ? hit : null;
    },
    set(host, value) {
      load()[host] = value;
      save();
    },
    clear() {
      cache = {};
      save();
    },
  };
}

export function memoryTillPinStore(): TillPinStore {
  const map = new Map<string, TillPin>();
  return {
    get: (host) => map.get(host) ?? null,
    set: (host, value) => void map.set(host, value),
    clear: () => map.clear(),
  };
}

export class TillIdentityError extends Error {
  code = TILL_IDENTITY_CHANGED;
  constructor() {
    super(TILL_IDENTITY_CHANGED_MESSAGE);
    this.name = 'TillIdentityError';
  }
}

/**
 * The certificate a TLS server presents, without trusting it and without
 * sending it anything.
 */
export function fetchPeerCertificatePem(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('TLS probe timed out')));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const peer = socket.getPeerX509Certificate();
      socket.destroy();
      if (!peer) return reject(new Error('no certificate presented'));
      resolve(peer.toString());
    });
  });
}

export type TillRequest = {
  /** Host as the app knows the till (the key its pin is stored under). */
  host: string;
  /** Host to connect to; differs from `host` only for a till on this machine. */
  connectHost?: string;
  httpPort: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** True when the till is this computer: plain HTTP, as before. */
  thisMachine?: boolean;
};

export type TillResponse = {
  status: number;
  headers: Record<string, string>;
  stream: http.IncomingMessage;
  secure: boolean;
};

function flatHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function send(
  transport: typeof http | typeof https,
  options: https.RequestOptions,
  req: TillRequest,
  secure: boolean,
): Promise<TillResponse> {
  return new Promise((resolve, reject) => {
    const method = String(req.method || 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : req.body;
    const headers: Record<string, string> = { ...(req.headers || {}) };
    if (body !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const request = transport.request(
      { ...options, method, path: req.path, headers, signal: req.signal },
      (res) =>
        resolve({
          status: res.statusCode || 0,
          headers: flatHeaders(res.headers),
          stream: res,
          secure,
        }),
    );
    request.on('error', reject);
    request.end(body);
  });
}

function isCertificateError(err: unknown): boolean {
  const code = String((err as { code?: unknown })?.code || '');
  return (
    code.startsWith('ERR_TLS_CERT') ||
    code.startsWith('UNABLE_TO_') ||
    code.startsWith('CERT_') ||
    code.startsWith('DEPTH_ZERO') ||
    code.startsWith('SELF_SIGNED') ||
    code === 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'
  );
}

async function readJson(res: TillResponse): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of res.stream) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export function createPinnedTillClient(deps: {
  store: TillPinStore;
  now?: () => number;
}) {
  const now = deps.now ?? (() => Date.now());
  const noTlsUntil = new Map<string, number>();
  // One agent per remembered certificate, so connections are reused.
  const agents = new Map<string, https.Agent>();

  function agentFor(pin: TillPin): https.Agent {
    let agent = agents.get(pin.cert);
    if (!agent) {
      agent = new https.Agent({
        keepAlive: true,
        ca: pin.cert,
        minVersion: 'TLSv1.2',
        // Trust is the remembered certificate, not the name: a till's IP
        // address changes with the router's mood.
        checkServerIdentity: () => undefined,
      });
      agents.set(pin.cert, agent);
    }
    return agent;
  }

  function sendSecure(req: TillRequest, pin: TillPin): Promise<TillResponse> {
    return send(
      https,
      {
        host: req.connectHost || req.host,
        port: pin.httpsPort,
        agent: agentFor(pin),
      },
      req,
      true,
    );
  }

  function sendPlain(req: TillRequest): Promise<TillResponse> {
    return send(
      http,
      { host: req.connectHost || req.host, port: req.httpPort },
      req,
      false,
    );
  }

  /** Ask a till we hold no pin for whether it offers HTTPS, and pin it. */
  async function learnPin(req: TillRequest): Promise<TillPin | null> {
    const until = noTlsUntil.get(req.host) || 0;
    if (until > now()) return null;
    const remember = () =>
      void noTlsUntil.set(req.host, now() + NO_TLS_RECHECK_MS);
    let health: any;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        health = await readJson(
          await sendPlain({
            host: req.host,
            connectHost: req.connectHost,
            httpPort: req.httpPort,
            path: '/health',
            signal: controller.signal,
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Unreachable: the real request will report that.
      return null;
    }
    const advertised = String(health?.tlsPin || '');
    const httpsPort = Number(health?.httpsPort) || 0;
    if (!advertised || !httpsPort) {
      remember();
      return null;
    }
    try {
      const cert = await fetchPeerCertificatePem(
        req.connectHost || req.host,
        httpsPort,
      );
      if (tlsPinOfCertificate(cert) !== advertised) {
        console.warn(
          `[till-pin] ${req.host}: HTTPS key does not match the one the till named; staying on HTTP for now`,
        );
        remember();
        return null;
      }
      const pin = { pin: advertised, cert, httpsPort };
      deps.store.set(req.host, pin);
      return pin;
    } catch {
      remember();
      return null;
    }
  }

  return {
    /** One request to the till, over HTTPS whenever the till offers it. */
    async request(req: TillRequest): Promise<TillResponse> {
      if (req.thisMachine) return sendPlain(req);
      let pin = deps.store.get(req.host);
      if (!pin) pin = await learnPin(req);
      if (!pin) return sendPlain(req);
      try {
        return await sendSecure(req, pin);
      } catch (err) {
        if (!isCertificateError(err)) throw err;
        // Not the remembered certificate. The same key with a renewed
        // certificate is still this till; anything else is not.
        let presented: string;
        try {
          presented = await fetchPeerCertificatePem(
            req.connectHost || req.host,
            pin.httpsPort,
          );
        } catch {
          throw err;
        }
        if (tlsPinOfCertificate(presented) !== pin.pin) {
          throw new TillIdentityError();
        }
        const renewed = { ...pin, cert: presented };
        deps.store.set(req.host, renewed);
        return sendSecure(req, renewed);
      }
    },
    /** Forget every till ("Reset connection"). */
    forgetAll(): void {
      deps.store.clear();
      noTlsUntil.clear();
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
    },
  };
}

export type PinnedTillClient = ReturnType<typeof createPinnedTillClient>;
