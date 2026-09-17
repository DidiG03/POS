/**
 * A replayed order must never re-occupy a table.
 *
 * The queue retries `tickets.log` until it lands, and the dispatcher used to
 * open the table before every attempt so `openAt` existed for the sitting.
 * That made a replay of an order the host had *already* recorded resurrect a
 * table which had since been paid and closed: the ticket itself no-ops on its
 * idempotency key, but the table went red again with an empty bill. Waiters
 * saw tables occupy themselves minutes after being cleared.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchTicketLog, ticketRejection } from './offlineQueue';

const log = vi.fn();
const setOpen = vi.fn();
const saveCovers = vi.fn();

const ORDER = {
  userId: 1,
  area: 'Salla',
  tableLabel: 'T1',
  items: [{ name: 'Birra', qty: 1, unitPrice: 300 }],
  idempotencyKey: 'intent-1',
};

/** How the LAN client surfaces the host's 409 (see `goLan`'s `HttpError`). */
function lanRejection(code: string) {
  return Object.assign(new Error(`Table Salla T1 is ${code}`), {
    status: 409,
    code,
  });
}

beforeEach(() => {
  log.mockReset();
  setOpen.mockReset();
  saveCovers.mockReset();
  log.mockResolvedValue({ ok: true });
  setOpen.mockResolvedValue(true);
  saveCovers.mockResolvedValue(true);
  (globalThis as any).window = {
    api: {
      tickets: { log },
      tables: { setOpen },
      covers: { save: saveCovers },
    },
  };
});

describe('ticketRejection', () => {
  it('marks an IPC rejection permanent', () => {
    const e = ticketRejection({
      result: { ok: false, error: 'closed', code: 'TABLE_CLOSED' },
    });
    expect(e.code).toBe('TABLE_CLOSED');
    expect(e.permanent).toBe(true);
  });

  it('marks a LAN 409 permanent so it stops being retried forever', () => {
    // Without this the mobile client treated "table is closed" as a transport
    // blip: a durable money op retried at the capped backoff indefinitely.
    const e = ticketRejection({ thrown: lanRejection('TABLE_OWNED_BY_OTHER') });
    expect(e.code).toBe('TABLE_OWNED_BY_OTHER');
    expect(e.permanent).toBe(true);
  });

  it('leaves a transport failure alone so the order is replayed', () => {
    expect(ticketRejection({ thrown: new TypeError('Failed to fetch') })).toBe(
      null,
    );
    expect(ticketRejection({ result: { ok: true } })).toBe(null);
    expect(ticketRejection({ result: true })).toBe(null);
  });
});

describe('dispatchTicketLog', () => {
  it('sends the order without touching table state when the host accepts', () => {
    return dispatchTicketLog(ORDER, { attempt: 0 }).then(() => {
      expect(log).toHaveBeenCalledTimes(1);
      expect(setOpen).not.toHaveBeenCalled();
    });
  });

  it('opens the table and retries once on the live attempt', async () => {
    // Open-and-send where the table-open write has not landed yet. The waiter
    // is standing at the table, so self-healing is the right call.
    log
      .mockResolvedValueOnce({ ok: false, code: 'TABLE_CLOSED' })
      .mockResolvedValueOnce({ ok: true });

    await dispatchTicketLog(ORDER, { attempt: 0 });

    expect(setOpen).toHaveBeenCalledWith('Salla', 'T1', true);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('never re-opens a closed table on a background replay', async () => {
    log.mockResolvedValue({ ok: false, code: 'TABLE_CLOSED' });

    await expect(
      dispatchTicketLog(ORDER, { attempt: 1 }),
    ).rejects.toMatchObject({ code: 'TABLE_CLOSED', permanent: true });

    // The whole point: the sitting was closed while this order sat on the
    // queue, and the replay must not bring it back.
    expect(setOpen).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('never re-opens a closed table on a LAN replay either', async () => {
    log.mockRejectedValue(lanRejection('TABLE_CLOSED'));

    await expect(
      dispatchTicketLog(ORDER, { attempt: 3 }),
    ).rejects.toMatchObject({ code: 'TABLE_CLOSED', permanent: true });
    expect(setOpen).not.toHaveBeenCalled();
  });

  it('does not open the table for a rejection opening cannot fix', async () => {
    log.mockResolvedValue({ ok: false, code: 'TABLE_OWNED_BY_OTHER' });

    await expect(
      dispatchTicketLog(ORDER, { attempt: 0 }),
    ).rejects.toMatchObject({ code: 'TABLE_OWNED_BY_OTHER' });
    expect(setOpen).not.toHaveBeenCalled();
  });

  it('lets a transport failure through so the queue replays the order', async () => {
    log.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(dispatchTicketLog(ORDER, { attempt: 0 })).rejects.toThrow(
      /Failed to fetch/,
    );
    expect(setOpen).not.toHaveBeenCalled();
  });

  it('keeps covers best-effort — a failure there does not lose the order', async () => {
    saveCovers.mockRejectedValue(new Error('nope'));
    await expect(
      dispatchTicketLog({ ...ORDER, covers: 4 }, { attempt: 0 }),
    ).resolves.toBeUndefined();
    expect(saveCovers).toHaveBeenCalledWith('Salla', 'T1', 4);
  });
});
