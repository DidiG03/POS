import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  update: vi.fn(async (_args: unknown) => ({})),
  findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
  loadDue: vi.fn(async (_n: number) => [] as unknown[]),
  print: vi.fn(),
  enqueue: vi.fn(async (_args: unknown) => ({ status: 'RETRY' })),
  mark: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('@db/client', () => ({
  prisma: { printJob: { update: h.update, findMany: h.findMany } },
}));
vi.mock('./core', () => ({
  coreServices: { readSettings: async () => ({}) },
}));
vi.mock('./printDispatcher', () => ({
  RETRY_MAX_ATTEMPTS: 5,
  dispatchTicket: vi.fn(),
  enqueuePrintRetry: h.enqueue,
  isTransientPrintError: (e?: string) => /timeout|refused/i.test(String(e)),
  loadDuePrintRetries: h.loadDue,
  markPrinterResult: h.mark,
  nextPendingRetryAt: async () => null,
  pickPrinterProfile: (_s: unknown, id: string) => ({ id }),
  printWithProfile: h.print,
  setRetryWakeup: vi.fn(),
}));

import { runPrinterStationTickForTests as tick } from './printerStation';

const row = (id: number, printerProfileId: string) => ({
  id,
  printerProfileId,
  attempts: 1,
  payloadJson: { area: 'A', tableLabel: String(id), items: [] },
});

beforeEach(() => {
  for (const f of Object.values(h)) f.mockClear();
});

describe('printer station retry pass', () => {
  it('after one timeout, defers that printer’s other rows instead of timing out on each', async () => {
    h.loadDue.mockResolvedValueOnce([
      row(1, 'receipt'),
      row(2, 'receipt'),
      row(3, 'kitchen'),
      row(4, 'receipt'),
    ]);
    h.print.mockImplementation(async (payload: any, _s: unknown, p: any) =>
      p.id === 'receipt'
        ? { ok: false, error: 'Printer connection timeout' }
        : { ok: true },
    );

    await tick();

    // receipt probed once, kitchen printed; rows 2 and 4 never dialled.
    expect(h.print).toHaveBeenCalledTimes(2);
    const deferred = h.update.mock.calls
      .map((c: any) => c[0])
      .filter((a: any) => a.data.nextAttemptAt && !a.data.status);
    expect(deferred.map((a: any) => a.where.id)).toEqual([2, 4]);
    // The deferral does not use up an attempt.
    expect(deferred.every((a: any) => a.data.attempts === undefined)).toBe(
      true,
    );
  });

  it('feeds every result into the payments’ printer-down mark', async () => {
    h.loadDue.mockResolvedValueOnce([row(1, 'receipt')]);
    h.print.mockResolvedValueOnce({ ok: true });
    await tick();
    expect(h.mark).toHaveBeenCalledWith('receipt', true, undefined);
  });
});
