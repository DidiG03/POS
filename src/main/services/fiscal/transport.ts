/**
 * The HTTP connection to easyPos Cloud.
 *
 * Node's built-in fetch closes an idle connection after 4 seconds, so a
 * payment taken a few minutes after the last one paid for DNS, TCP and a
 * TLS handshake before its invoice could even be sent — two or three extra
 * round trips, a second or more on a slow venue line. This keeps one pool
 * open between payments, and lets the till open the connection while the
 * waiter is still on the payment screen.
 *
 * undici's own `fetch` is used with its own `Agent`: handing an Agent from
 * this package to Node's bundled fetch works only while both are the same
 * major version, and would silently break every fiscal request on an
 * Electron upgrade.
 *
 * Errors keep undici's shape (`fetch failed` with the socket code on the
 * cause), which `classify.ts` reads to tell "never reached easyPos" from
 * "may have been filed".
 */

import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Idle time before we close a connection ourselves. Comfortably under the
 * usual 60–75s server idle timeout, so we close first and do not send an
 * invoice down a connection the server has already dropped.
 */
export const EASYPOS_KEEP_ALIVE_MS = 30_000;

/** Skip a warm-up when the pool was used this recently. */
const WARM_SKIP_WITHIN_MS = 20_000;
const WARM_TIMEOUT_MS = 8_000;

let agent: Agent | null = null;
let lastActivityAt = 0;
let warming: Promise<void> | null = null;

function easyPosAgent(): Agent {
  if (!agent) {
    agent = new Agent({
      keepAliveTimeout: EASYPOS_KEEP_ALIVE_MS,
      keepAliveMaxTimeout: EASYPOS_KEEP_ALIVE_MS,
      connections: 4,
    });
  }
  return agent;
}

export interface EasyPosResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export async function easyPosFetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<EasyPosResponse> {
  try {
    return await undiciFetch(url, { ...init, dispatcher: easyPosAgent() });
  } finally {
    lastActivityAt = Date.now();
  }
}

/**
 * Open (or keep open) a connection to easyPos ahead of a payment.
 * Best-effort: never throws, never waits on more than one attempt.
 */
export function warmEasyPosConnection(
  baseUrl: string,
  now = Date.now(),
): Promise<void> {
  if (warming) return warming;
  if (now - lastActivityAt < WARM_SKIP_WITHIN_MS) return Promise.resolve();
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return Promise.resolve();
  }
  warming = (async () => {
    try {
      // A GET of the host root (a small 404): no invoice route, nothing for
      // easyPos to process — it only leaves a warm connection in the pool.
      // Not HEAD: undici never reuses a connection after a HEAD.
      const res = await undiciFetch(`${origin}/`, {
        method: 'GET',
        dispatcher: easyPosAgent(),
        signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined);
      lastActivityAt = Date.now();
    } catch {
      // A failed warm-up changes nothing; the payment connects as before.
    } finally {
      warming = null;
    }
  })();
  return warming;
}

/** @internal vitest */
export async function resetEasyPosTransport(): Promise<void> {
  const current = agent;
  agent = null;
  lastActivityAt = 0;
  warming = null;
  await current?.close().catch(() => undefined);
}
