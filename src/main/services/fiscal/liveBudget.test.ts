/**
 * QA F3 / F5: how long a waiter waits on easyPos, and which easyPos the
 * retries talk to.
 *
 *   - easyPos accepting the connection and never answering held the payment
 *     ~111 s before the pending receipt printed;
 *   - easyPos unreachable held it 13.8 s before the sale was queued;
 *   - after the easyPos URL was changed, retries kept the old one.
 *
 * No request leaves the machine: the transport is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./transport', () => ({
  easyPosFetch: (url: string, init: unknown) =>
    (globalThis as any).fetch(url, init),
  warmEasyPosConnection: async () => undefined,
}));
import type { SettingsDTO } from '@shared/ipc';
import { __resetDeviceQueues, __resetDocIdLocks } from './client';
import {
  LIVE_REQUEST_TIMEOUT_MS,
  registerInvoiceWithRecovery,
} from './recover';
import { setFiscalSettingsSource } from './config';
import type { RegisterInvoiceRequest } from './apiTypes';

const settingsAt = (baseUrl: string) =>
  ({
    fiscal: {
      enabled: true,
      provider: 'easypos',
      baseUrl,
      authToken: 'jwt',
      integrationApp: 'generic',
      defaultOperatorId: 'gh537ez280',
    },
  }) as unknown as SettingsDTO;
const OLD = 'https://api.dev.easypos.al/fiscalisation-service/v1';
const NEW = 'https://api.easypos.al/fiscalisation-service/v1';

const request: RegisterInvoiceRequest = {
  docId: 'inv-live-1',
  articles: [
    {
      articleId: 'ESP',
      vatCode: 'B',
      name: 'Espresso',
      soldIn: 'XPP',
      price: 150,
      units: 2,
    },
  ],
  payment: [{ type: 'CASH', amount: 300 }],
};

const json = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;
const sleeps: number[] = [];
const fast = {
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
  random: () => 0.5,
};

beforeEach(() => {
  __resetDocIdLocks();
  __resetDeviceQueues();
  sleeps.length = 0;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setFiscalSettingsSource(null);
});

/** easyPos takes the connection and never answers; honours the abort. */
function hangs() {
  fetchMock.mockImplementation(
    (_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(
            Object.assign(new Error('This operation was aborted'), {
              name: 'AbortError',
            }),
          ),
        );
      }),
  );
}

describe('a live payment (QA F3, F5)', () => {
  it('uses a short request timeout', () => {
    expect(LIVE_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(LIVE_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(8_000);
  });

  it('queues a sale easyPos never answers after one timeout, marked to check first', async () => {
    hangs();
    const started = Date.now();
    const out = await registerInvoiceWithRecovery(settingsAt(OLD), request, {
      ...fast,
      live: true,
      requestTimeoutMs: 1_000,
    });
    const took = Date.now() - started;
    expect(out.kind).toBe('not-registered');
    // It may have reached easyPos: the next send asks /invoice/status first.
    expect(out).toMatchObject({ checkStatusFirst: true, sendAttempts: 1 });
    // One request, no status polls, no backoff: about one timeout.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(took).toBeLessThan(2_500);
    // The request carried the timeout's abort signal.
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('gives a dead connection back at once, safe to send later as it is', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );
    const out = await registerInvoiceWithRecovery(settingsAt(OLD), request, {
      ...fast,
      live: true,
    });
    expect(out.kind).toBe('not-registered');
    expect((out as any).checkStatusFirst).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No backoff and resend while the waiter waits.
    expect(sleeps).toEqual([]);
  });

  it('a connect timeout is a dead connection too', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('fetch failed'), {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      }),
    );
    const out = await registerInvoiceWithRecovery(settingsAt(OLD), request, {
      ...fast,
      live: true,
    });
    expect(out.kind).toBe('not-registered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the retry queue keeps its full budget', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );
    await registerInvoiceWithRecovery(settingsAt(OLD), request, fast);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('settings re-read on every attempt (QA F3)', () => {
  it('sends the next attempt to the URL set in the meantime', async () => {
    let current = settingsAt(OLD);
    setFiscalSettingsSource(async () => current);
    fetchMock
      .mockImplementationOnce(async () => {
        // The admin fixes the URL while the first send is failing.
        current = settingsAt(NEW);
        throw Object.assign(new Error('fetch failed'), {
          cause: { code: 'ECONNREFUSED' },
        });
      })
      .mockResolvedValueOnce(
        json(200, {
          response: { iic: 'IIC-1', fic: 'FIC-1', link: 'https://x' },
        }),
      );
    const out = await registerInvoiceWithRecovery(
      settingsAt(OLD),
      request,
      fast,
    );
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0].startsWith(OLD)).toBe(true);
    expect(urls[1].startsWith(NEW)).toBe(true);
    expect(out.kind).not.toBe('unresolved');
  });

  it('without a source, uses the settings it was given', async () => {
    fetchMock.mockResolvedValue(
      json(200, { response: { iic: 'I', fic: 'F', link: 'https://x' } }),
    );
    await registerInvoiceWithRecovery(settingsAt(OLD), request, fast);
    expect(String(fetchMock.mock.calls[0][0]).startsWith(OLD)).toBe(true);
  });
});
