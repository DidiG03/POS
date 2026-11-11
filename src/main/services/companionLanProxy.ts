/**
 * Admin/KDS renderer `fetch` from localhost onto a private LAN IP is a
 * Chromium Private Network Access request. Scan already talks to the till
 * from the Electron main process (no CORS). Login and the rest of the
 * polyfill must use the same path or the UI shows "Failed to fetch"
 * after a successful scan.
 */
import type { IpcMain, WebContents } from 'electron';
import os from 'node:os';
import {
  httpHostForLocalPos,
  isThisMachineAddress,
} from '@shared/localPosHost';
import {
  TILL_IDENTITY_CHANGED,
  createPinnedTillClient,
  fileTillPinStore,
  memoryTillPinStore,
  type PinnedTillClient,
  type TillRequest,
} from './pinnedTillClient';

// Requests to the till go over HTTPS whenever the till offers it
// (`pinnedTillClient.ts`). Until the app names its data folder the
// remembered tills live in memory only.
let tillClient: PinnedTillClient = createPinnedTillClient({
  store: memoryTillPinStore(),
});

/** Remember tills in `file` (the app's own data folder). */
export function rememberCompanionTillsIn(file: string): void {
  tillClient = createPinnedTillClient({ store: fileTillPinStore(file) });
}

/** "Reset connection": the next till is trusted afresh. */
export function forgetCompanionTills(): void {
  tillClient.forgetAll();
}

function tillRequestFor(input: {
  host: string;
  httpPort: number;
  path: string;
}): Pick<
  TillRequest,
  'host' | 'connectHost' | 'httpPort' | 'path' | 'thisMachine'
> {
  const path = assertCompanionLanPath(input.path);
  const host = String(input.host || '').trim();
  if (!host) throw new Error('Host is required');
  const locals = companionLocalAddresses();
  return {
    host,
    connectHost: httpHostForLocalPos(host, locals),
    httpPort: Number(input.httpPort) || 3333,
    path,
    thisMachine: isThisMachineAddress(host, locals),
  };
}

const FORWARD_HEADERS = new Set([
  'content-type',
  'authorization',
  'idempotency-key',
  'x-pos-client',
]);

export function companionLocalAddresses(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni?.address) out.push(ni.address);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

export function assertCompanionLanPath(path: string): string {
  const raw = String(path || '');
  if (!raw.startsWith('/')) throw new Error('invalid path');
  if (raw.includes('://')) throw new Error('invalid path');
  const pathname = raw.split('?')[0] || '/';
  if (pathname.includes('..') || pathname.includes('\\')) {
    throw new Error('invalid path');
  }
  return raw;
}

export function pickForwardHeaders(
  headers: Record<string, string> | undefined,
  client?: 'admin' | 'kds',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!FORWARD_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value !== 'string' || !value) continue;
    out[key] = value;
  }
  const hasClient = Object.keys(out).some(
    (key) => key.toLowerCase() === 'x-pos-client',
  );
  if (client && !hasClient) out['X-POS-Client'] = client;
  return out;
}

export function consumeSseBuffer(buffer: string): {
  rest: string;
  events: Array<{ event: string; data: string }>;
} {
  const events: Array<{ event: string; data: string }> = [];
  const parts = String(buffer || '').split('\n\n');
  const rest = parts.pop() || '';
  for (const block of parts) {
    const parsed = parseSseBlock(block);
    if (parsed) events.push(parsed);
  }
  return { rest, events };
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of String(block || '').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:'))
      dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length && event === 'message') return null;
  return { event, data: dataLines.join('\n') };
}

export type CompanionLanFetchInput = {
  host: string;
  httpPort: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  client?: 'admin' | 'kds';
};

export type CompanionLanFetchResult = {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
};

/** Network failures must not throw out of IPC (Electron dumps a stack per poll). */
export function companionLanFailure(err: unknown): CompanionLanFetchResult {
  const e = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  const name = String(e?.name || '');
  const code = String(e?.cause?.code || e?.code || '');
  if (code === TILL_IDENTITY_CHANGED) {
    // Not "unreachable": something else answered at the till's address.
    return {
      status: 503,
      ok: false,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: String(e?.message || 'till identity changed'),
        code: TILL_IDENTITY_CHANGED,
        permanent: true,
      }),
    };
  }
  const aborted =
    name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED';
  return {
    status: aborted ? 504 : 503,
    ok: false,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: aborted ? 'till_timeout' : 'till_unreachable',
      code: code || undefined,
      message: String(e?.message || e || 'fetch failed'),
    }),
  };
}

export async function fetchCompanionLan(
  input: CompanionLanFetchInput,
): Promise<CompanionLanFetchResult> {
  const target = tillRequestFor(input);
  const method = String(input.method || 'GET').toUpperCase();
  const headers = pickForwardHeaders(input.headers, input.client);
  const timeoutMs = Math.max(1_000, Number(input.timeoutMs) || 8_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await tillClient.request({
      ...target,
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : input.body,
      signal: controller.signal,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.stream) chunks.push(Buffer.from(chunk));
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
  } catch (err) {
    return companionLanFailure(err);
  } finally {
    clearTimeout(timer);
  }
}

let sseAbort: AbortController | null = null;

export function stopCompanionLanSse(): void {
  try {
    sseAbort?.abort();
  } catch {
    // ignore
  }
  sseAbort = null;
}

export function startCompanionLanSse(opts: {
  host: string;
  httpPort: number;
  path: string;
  client?: 'admin' | 'kds';
  headers?: Record<string, string>;
  onOpen: () => void;
  onEvent: (event: string, data: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}): void {
  stopCompanionLanSse();
  const ac = new AbortController();
  sseAbort = ac;
  void (async () => {
    try {
      const response = await tillClient.request({
        ...tillRequestFor(opts),
        method: 'GET',
        headers: {
          ...pickForwardHeaders(opts.headers, opts.client),
          Accept: 'text/event-stream',
        },
        signal: ac.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        response.stream.resume();
        opts.onError(`HTTP ${response.status}`);
        opts.onClose();
        return;
      }
      opts.onOpen();
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of response.stream) {
        if (ac.signal.aborted) break;
        buf += decoder.decode(chunk, { stream: true });
        const consumed = consumeSseBuffer(buf);
        buf = consumed.rest;
        for (const event of consumed.events) {
          opts.onEvent(event.event, event.data);
        }
      }
      opts.onClose();
    } catch (err: any) {
      if (ac.signal.aborted) {
        opts.onClose();
        return;
      }
      opts.onError(String(err?.message || err || 'sse failed'));
      opts.onClose();
    }
  })();
}

function sendIfAlive(sender: WebContents, channel: string, payload: unknown) {
  try {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  } catch {
    // ignore
  }
}

export function registerCompanionLanIpc(opts: {
  ipcMain: IpcMain;
  fetchChannel: string;
  sseStartChannel: string;
  sseStopChannel: string;
  sseEventChannel: string;
  sseStatusChannel: string;
  client: 'admin' | 'kds';
  /** Where remembered tills are kept (`pinnedTillClient.ts`). */
  pinFile?: string;
}): void {
  if (opts.pinFile) rememberCompanionTillsIn(opts.pinFile);
  opts.ipcMain.handle(opts.fetchChannel, async (_event, payload) => {
    try {
      return await fetchCompanionLan({
        host: String(payload?.host || ''),
        httpPort: Number(payload?.httpPort) || 3333,
        path: String(payload?.path || ''),
        method: payload?.method,
        headers: payload?.headers,
        body: payload?.body,
        timeoutMs: payload?.timeoutMs,
        client: opts.client,
      });
    } catch (err) {
      return companionLanFailure(err);
    }
  });
  opts.ipcMain.handle(opts.sseStartChannel, (event, payload) => {
    const sender = event.sender;
    startCompanionLanSse({
      host: String(payload?.host || ''),
      httpPort: Number(payload?.httpPort) || 3333,
      path: String(payload?.path || ''),
      client: opts.client,
      headers: payload?.headers,
      onOpen: () =>
        sendIfAlive(sender, opts.sseStatusChannel, { status: 'open' }),
      onEvent: (name, data) =>
        sendIfAlive(sender, opts.sseEventChannel, { event: name, data }),
      onError: (message) =>
        sendIfAlive(sender, opts.sseStatusChannel, {
          status: 'error',
          error: message,
        }),
      onClose: () =>
        sendIfAlive(sender, opts.sseStatusChannel, { status: 'close' }),
    });
    return true;
  });
  opts.ipcMain.handle(opts.sseStopChannel, () => {
    stopCompanionLanSse();
    return true;
  });
}
