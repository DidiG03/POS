/**
 * logTicket / printTicket must stamp an idempotency key *before* the first
 * attempt. A key minted only on retry is a key the host has never seen, so
 * the kitchen gets the order twice after a lost response.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tryOrQueue, enqueue } = vi.hoisted(() => ({
  tryOrQueue: vi.fn(async () => ({ queued: false })),
  enqueue: vi.fn(async () => ({ pending: 1 })),
}));

vi.mock('./utils/offlineQueue', () => ({
  tryOrQueue,
  offlineQueue: { enqueue },
}));

import { logTicket, printTicket } from './api';

function lastCall(): { op: string; args: any } {
  const call = tryOrQueue.mock.calls.at(-1) as unknown as
    | [string, any]
    | undefined;
  expect(call).toBeTruthy();
  return { op: call![0], args: call![1] };
}

/**
 * Vitest runs these files in Node. Some Node builds expose `navigator`,
 * Linux CI does not — so never assume the object is already there.
 */
try {
  delete (globalThis as { navigator?: unknown }).navigator;
} catch {
  // ignore
}

function setOnline(value: boolean) {
  const current = (globalThis as { navigator?: object }).navigator;
  const nav = current && typeof current === 'object' ? current : {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: nav,
  });
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

const baseTicket = {
  userId: 1,
  area: 'Main Hall',
  tableLabel: '4',
  items: [{ name: 'Burger', qty: 1, unitPrice: 8 }],
};

describe('logTicket', () => {
  beforeEach(() => {
    tryOrQueue.mockClear();
    enqueue.mockClear();
    tryOrQueue.mockResolvedValue({ queued: false });
    setOnline(true);
  });

  it('stamps a key before the live call when the caller omits one', async () => {
    await logTicket(baseTicket);
    expect(tryOrQueue).toHaveBeenCalledTimes(1);
    const { op, args } = lastCall();
    expect(op).toBe('tickets.log');
    expect(String(args.idempotencyKey).length).toBeGreaterThanOrEqual(8);
  });

  it('reuses a caller-supplied key so a retry of the same tap stays one order', async () => {
    await logTicket({ ...baseTicket, idempotencyKey: 'intent-abc-12345' });
    expect(lastCall().args.idempotencyKey).toBe('intent-abc-12345');
  });

  it('keeps the same key if the live call is queued after a transport error', async () => {
    tryOrQueue.mockResolvedValueOnce({ queued: true });
    const r = await logTicket({
      ...baseTicket,
      idempotencyKey: 'intent-queued-1',
    });
    expect(r).toEqual({ ok: true, queued: true });
    expect(lastCall().args.idempotencyKey).toBe('intent-queued-1');
  });

  it('stamps a key even when the OS reports offline (LAN still tried live)', async () => {
    setOnline(false);
    const r = await logTicket({
      ...baseTicket,
      idempotencyKey: 'intent-offline-1',
    });
    expect(r).toEqual({ ok: true, queued: false });
    expect(tryOrQueue).toHaveBeenCalledTimes(1);
    expect(lastCall().args.idempotencyKey).toBe('intent-offline-1');
  });

  it('surfaces a permanent server rejection', async () => {
    tryOrQueue.mockRejectedValueOnce(
      Object.assign(new Error('Table is closed'), {
        permanent: true,
        code: 'TABLE_CLOSED',
      }),
    );
    await expect(logTicket(baseTicket)).resolves.toEqual({
      ok: false,
      error: 'Table is closed',
      code: 'TABLE_CLOSED',
    });
  });

  it('reports failure when the order could be neither sent nor queued', async () => {
    // Claiming success here loses the order silently: the caller marks the
    // lines sent and prints a chit for something the kitchen never received.
    tryOrQueue.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    const r = await logTicket(baseTicket);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 'LOG_FAILED' });
  });
});

describe('printTicket', () => {
  beforeEach(() => {
    tryOrQueue.mockClear();
    tryOrQueue.mockResolvedValue({ queued: false });
  });

  it('stamps a key before the live call', async () => {
    await printTicket({
      area: 'Main Hall',
      tableLabel: '4',
      items: [{ name: 'Burger', qty: 1, unitPrice: 8 }],
    });
    expect(tryOrQueue).toHaveBeenCalledTimes(1);
    const { op, args } = lastCall();
    expect(op).toBe('tickets.print');
    expect(String(args.idempotencyKey).length).toBeGreaterThanOrEqual(8);
  });

  it('reuses a caller-supplied key', async () => {
    await printTicket({
      area: 'Main Hall',
      tableLabel: '4',
      items: [{ name: 'Burger', qty: 1, unitPrice: 8 }],
      idempotencyKey: 'print-intent-99',
    });
    expect(lastCall().args.idempotencyKey).toBe('print-intent-99');
  });
});
