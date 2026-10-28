import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  update: vi.fn(async (_args: unknown) => ({})),
  findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
  loadDue: vi.fn(async (_n: number) => [] as unknown[]),
  print: vi.fn(),
  enqueue: vi.fn(async (_args: unknown) => ({ status: 'RETRY' })),
  mark: vi.fn(),
  failedNotice: vi.fn(async (_args: unknown) => undefined),
  event: vi.fn(),
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
vi.mock('./printJobNotify', () => ({
  notifyStationPrintFailed: h.failedNotice,
}));
vi.mock('./realtime', () => ({ broadcastPrinterEvent: h.event }));
vi.mock('./printDispatcher', async () => {
  const real = await vi.importActual<any>('./printDispatcher');
  return {
    RETRY_MAX_ATTEMPTS: 5,
    dispatchTicket: vi.fn(),
    enqueuePrintRetry: h.enqueue,
    isStationSlip: real.isStationSlip,
    printRetryPlan: real.printRetryPlan,
    isTransientPrintError: (e?: string) => /timeout|refused/i.test(String(e)),
    loadDuePrintRetries: h.loadDue,
    markPrinterResult: h.mark,
    nextPendingRetryAt: async () => null,
    pickPrinterProfile: (_s: unknown, id: string) => ({ id }),
    printWithProfile: h.print,
    setRetryWakeup: vi.fn(),
  };
});

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

  it('keeps one row per job: a failed retry updates it, never adds a row', async () => {
    h.loadDue.mockResolvedValueOnce([row(1, 'receipt')]);
    h.print.mockResolvedValueOnce({ ok: false, error: 'connection timeout' });
    await tick();
    expect(h.enqueue).not.toHaveBeenCalled();
    const write = h.update.mock.calls
      .map((c: any) => c[0])
      .find((a: any) => a.where.id === 1);
    expect(write.data).toMatchObject({ status: 'RETRY', attempts: 2 });
    expect(write.data.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('keeps retrying a kitchen slip long after a receipt would give up', async () => {
    h.loadDue.mockResolvedValueOnce([
      {
        ...row(1, 'kitchen'),
        attempts: 9,
        createdAt: new Date(Date.now() - 20 * 60_000),
        payloadJson: {
          area: 'A',
          tableLabel: 'T2',
          items: [],
          meta: { kind: 'ORDER' },
        },
      },
    ]);
    h.print.mockResolvedValueOnce({ ok: false, error: 'connection refused' });
    await tick();
    const write = h.update.mock.calls
      .map((c: any) => c[0])
      .find((a: any) => a.where.id === 1);
    expect(write.data.status).toBe('RETRY');
    expect(h.failedNotice).not.toHaveBeenCalled();
  });

  it('gives up on a kitchen slip after the window, and tells people', async () => {
    h.loadDue.mockResolvedValueOnce([
      {
        ...row(1, 'kitchen'),
        attempts: 200,
        createdAt: new Date(Date.now() - 3 * 60 * 60_000),
        payloadJson: {
          area: 'A',
          tableLabel: 'T2',
          items: [],
          meta: { kind: 'ORDER', userId: 7 },
        },
      },
    ]);
    h.print.mockResolvedValueOnce({ ok: false, error: 'connection refused' });
    await tick();
    const write = h.update.mock.calls
      .map((c: any) => c[0])
      .find((a: any) => a.where.id === 1);
    expect(write.data.status).toBe('FAILED');
    expect(h.failedNotice).toHaveBeenCalledTimes(1);
  });

  it('marks a kitchen slip printed late, and says the printer is back', async () => {
    const sentAtIso = new Date(Date.now() - 5 * 60_000).toISOString();
    h.loadDue.mockResolvedValueOnce([
      {
        ...row(1, 'kitchen'),
        payloadJson: {
          area: 'A',
          tableLabel: 'T2',
          items: [],
          meta: { kind: 'ORDER', sentAtIso },
        },
      },
    ]);
    h.print.mockResolvedValueOnce({ ok: true });
    await tick();
    expect(h.print.mock.calls[0][0].meta.lateSentAtIso).toBe(sentAtIso);
    expect(h.event).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', kind: 'recovered' }),
    );
  });
});
