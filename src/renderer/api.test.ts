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
    Object.defineProperty(globalThis.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
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

  it('stamps a key on the offline enqueue path too', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    const r = await logTicket({
      ...baseTicket,
      idempotencyKey: 'intent-offline-1',
    });
    expect(r).toEqual({ ok: true, queued: true });
    expect(tryOrQueue).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const queued = enqueue.mock.calls[0] as unknown as [string, any];
    expect(queued[0]).toBe('tickets.log');
    expect(queued[1].idempotencyKey).toBe('intent-offline-1');
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
