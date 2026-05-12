/**
 * Pure-logic tests for the print dispatcher. Heavy imports (electron,
 * prisma, the actual TCP/CUPS senders) are mocked so the suite runs in
 * < 200ms with no hardware and no DB.
 *
 * Run with:  pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mocks --------------------------------------------------------------
// `prisma` is imported by the dispatcher both inside `buildOrderBuckets`
// (SKU → category lookup) AND by the PR 3 retry queue helpers
// (PrintJob create/findMany/findFirst). Default to no menu rows + a
// stub that records every PrintJob.create so tests can inspect what
// would have been persisted.
const findMenuItems = vi.fn(async () => [] as any[]);
const printJobCreate = vi.fn(async () => ({ id: 1 }) as any);
const printJobFindMany = vi.fn(async () => [] as any[]);
const printJobFindFirst = vi.fn(async () => null as any);
vi.mock('@db/client', () => ({
  prisma: {
    menuItem: { findMany: (...args: any[]) => findMenuItems(...args) },
    printJob: {
      create: (...args: any[]) => printJobCreate(...args),
      findMany: (...args: any[]) => printJobFindMany(...args),
      findFirst: (...args: any[]) => printJobFindFirst(...args),
    },
  },
}));

// `print.ts` pulls in electron's BrowserWindow — not available outside
// the runtime. Replace the whole module with stubs we can spy on.
const sendNetwork = vi.fn(async () => ({ ok: true }));
const sendCups = vi.fn(async () => ({ ok: true }));
const sendHtml = vi.fn(async () => ({ ok: true }));
const buildEscpos = vi.fn(() => Buffer.from('ESCPOS'));
const buildHtml = vi.fn(() => '<html/>');
vi.mock('../print', () => ({
  buildEscposTicket: (...a: any[]) => buildEscpos(...a),
  buildHtmlReceipt: (...a: any[]) => buildHtml(...a),
  printHtmlToSystemPrinter: (...a: any[]) => sendHtml(...a),
  sendToCupsRawPrinter: (...a: any[]) => sendCups(...a),
  sendToPrinterVerbose: (...a: any[]) => sendNetwork(...a),
}));

// Serial transport is dynamic-imported by the dispatcher; stub the path
// vitest resolves to.
const sendSerial = vi.fn(async () => ({ ok: true }));
vi.mock('../serial', () => ({
  sendToSerialPrinter: (...a: any[]) => sendSerial(...a),
}));

import {
  buildTestPrintBuffer,
  dispatchTicket,
  enqueuePrintRetry,
  isTransientPrintError,
  normalizePrinterProfiles,
  pickActiveReceiptProfile,
  pickPrinterProfile,
  printWithProfile,
  profileMode,
  RETRY_MAX_ATTEMPTS,
  setRetryWakeup,
  testPrintWithProfile,
} from './printDispatcher';

beforeEach(() => {
  findMenuItems.mockReset().mockResolvedValue([]);
  printJobCreate.mockReset().mockResolvedValue({ id: 1 } as any);
  printJobFindMany.mockReset().mockResolvedValue([] as any);
  printJobFindFirst.mockReset().mockResolvedValue(null as any);
  sendNetwork.mockReset().mockResolvedValue({ ok: true });
  sendCups.mockReset().mockResolvedValue({ ok: true });
  sendHtml.mockReset().mockResolvedValue({ ok: true });
  sendSerial.mockReset().mockResolvedValue({ ok: true });
  buildEscpos.mockClear();
  buildHtml.mockClear();
});

// ---- profileMode --------------------------------------------------------

describe('profileMode', () => {
  it('honours an explicit mode', () => {
    expect(profileMode({ mode: 'NETWORK' })).toBe('NETWORK');
    expect(profileMode({ mode: 'SYSTEM' })).toBe('SYSTEM');
    expect(profileMode({ mode: 'SERIAL' })).toBe('SERIAL');
  });
  it('infers SERIAL from serialPath when mode is missing', () => {
    expect(profileMode({ serialPath: '/dev/ttyUSB0' })).toBe('SERIAL');
  });
  it('infers SYSTEM from deviceName when mode is missing', () => {
    expect(profileMode({ deviceName: 'EPSON_TM_T20' })).toBe('SYSTEM');
  });
  it('falls back to NETWORK', () => {
    expect(profileMode({})).toBe('NETWORK');
    expect(profileMode(null)).toBe('NETWORK');
  });
});

// ---- profile selection --------------------------------------------------

describe('normalizePrinterProfiles', () => {
  it('returns the new printers[] array when present', () => {
    const out = normalizePrinterProfiles({
      printers: [
        { id: 'a', name: 'A', enabled: true },
        { id: 'b', name: 'B', enabled: true },
      ],
    });
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('filters out disabled profiles', () => {
    const out = normalizePrinterProfiles({
      printers: [
        { id: 'a', name: 'A', enabled: true },
        { id: 'b', name: 'B', enabled: false },
      ],
    });
    expect(out.map((p) => p.id)).toEqual(['a']);
  });
  it('falls back to legacy singular printer', () => {
    const out = normalizePrinterProfiles({
      printer: { ip: '10.0.0.5', port: 9100 },
    });
    expect(out).toEqual([
      {
        id: 'default',
        name: 'Default printer',
        enabled: true,
        ip: '10.0.0.5',
        port: 9100,
      },
    ]);
  });
  it('returns [] when nothing is configured', () => {
    expect(normalizePrinterProfiles({})).toEqual([]);
    expect(normalizePrinterProfiles({ printer: {} })).toEqual([]);
  });
});

describe('pickPrinterProfile', () => {
  const settings = {
    printers: [
      { id: 'kitchen', name: 'Kitchen', enabled: true },
      { id: 'bar', name: 'Bar', enabled: true },
    ],
  };
  it('returns the matching id', () => {
    expect(pickPrinterProfile(settings, 'bar')?.id).toBe('bar');
  });
  it('falls back to first enabled when id is unknown', () => {
    expect(pickPrinterProfile(settings, 'nope')?.id).toBe('kitchen');
  });
  it('returns null when no profiles', () => {
    expect(pickPrinterProfile({}, 'bar')).toBeNull();
  });
});

describe('pickActiveReceiptProfile', () => {
  it('uses printerRouting.receiptPrinterId when set', () => {
    expect(
      pickActiveReceiptProfile({
        printers: [
          { id: 'a', enabled: true },
          { id: 'b', enabled: true },
        ],
        printerRouting: { receiptPrinterId: 'b' },
      })?.id,
    ).toBe('b');
  });
  it('falls back to a profile literally named "default"', () => {
    expect(
      pickActiveReceiptProfile({
        printers: [
          { id: 'a', enabled: true },
          { id: 'default', enabled: true },
        ],
      })?.id,
    ).toBe('default');
  });
  it('falls back to the first enabled profile', () => {
    expect(
      pickActiveReceiptProfile({
        printers: [{ id: 'a', enabled: true }],
      })?.id,
    ).toBe('a');
  });
  it('returns null with nothing configured', () => {
    expect(pickActiveReceiptProfile({})).toBeNull();
  });
});

// ---- buildTestPrintBuffer ----------------------------------------------

describe('buildTestPrintBuffer', () => {
  it('emits an ESC/POS init + cut envelope', () => {
    const buf = buildTestPrintBuffer({ printerName: 'KitchenA' });
    const s = buf.toString('binary');
    // ESC @  initialise
    expect(s.startsWith('\x1b@')).toBe(true);
    // Includes the printer name in the body
    expect(s).toContain('KitchenA');
    // GS V A 0x10  partial cut (ends the slip)
    expect(s.includes('\x1dV\x41\x10')).toBe(true);
  });
});

// ---- printWithProfile (mode dispatch) -----------------------------------

describe('printWithProfile', () => {
  const payload = {
    area: 'A',
    tableLabel: 'T1',
    items: [{ name: 'Test', qty: 1, unitPrice: 1 }],
  } as any;

  it('NETWORK with port 9100 picks RAW and forwards to sendToPrinterVerbose', async () => {
    await printWithProfile(
      payload,
      {} as any,
      {
        id: 'p',
        name: 'P',
        mode: 'NETWORK',
        ip: '10.0.0.1',
        port: 9100,
      } as any,
    );
    expect(sendNetwork).toHaveBeenCalledTimes(1);
    expect(sendNetwork).toHaveBeenCalledWith(
      '10.0.0.1',
      9100,
      expect.any(Buffer),
      { forceProtocol: 'RAW' },
    );
  });

  it('NETWORK with port 515 forces LPR', async () => {
    await printWithProfile(
      payload,
      {} as any,
      { id: 'p', name: 'P', mode: 'NETWORK', ip: '10.0.0.1', port: 515 } as any,
    );
    expect(sendNetwork).toHaveBeenCalledWith(
      '10.0.0.1',
      515,
      expect.any(Buffer),
      { forceProtocol: 'LPR' },
    );
  });

  it('SYSTEM raw routes through sendToCupsRawPrinter', async () => {
    await printWithProfile(
      payload,
      {} as any,
      {
        id: 'p',
        name: 'P',
        mode: 'SYSTEM',
        deviceName: 'EPSON',
        systemRawEscpos: true,
      } as any,
    );
    expect(sendCups).toHaveBeenCalledWith({
      deviceName: 'EPSON',
      data: expect.any(Buffer),
    });
    expect(sendHtml).not.toHaveBeenCalled();
  });

  it('SYSTEM non-raw routes through printHtmlToSystemPrinter', async () => {
    await printWithProfile(
      payload,
      {} as any,
      {
        id: 'p',
        name: 'P',
        mode: 'SYSTEM',
        deviceName: 'EPSON',
        systemRawEscpos: false,
      } as any,
    );
    expect(sendHtml).toHaveBeenCalledTimes(1);
    expect(sendCups).not.toHaveBeenCalled();
  });

  it('SERIAL routes through sendToSerialPrinter', async () => {
    await printWithProfile(
      payload,
      {} as any,
      {
        id: 'p',
        name: 'P',
        mode: 'SERIAL',
        serialPath: '/dev/ttyUSB0',
        baudRate: 19200,
      } as any,
    );
    expect(sendSerial).toHaveBeenCalledTimes(1);
  });

  it('NETWORK with no IP fails fast', async () => {
    const r = await printWithProfile(
      payload,
      {} as any,
      { id: 'p', name: 'P', mode: 'NETWORK' } as any,
    );
    expect(r.ok).toBe(false);
    expect(sendNetwork).not.toHaveBeenCalled();
  });

  it('retries transient ECONNREFUSED when retries=1', async () => {
    sendNetwork
      .mockResolvedValueOnce({
        ok: false,
        error: 'fail',
        code: 'ECONNREFUSED',
      } as any)
      .mockResolvedValueOnce({ ok: true });
    const r = await printWithProfile(
      payload,
      {} as any,
      {
        id: 'p',
        name: 'P',
        mode: 'NETWORK',
        ip: '10.0.0.1',
        port: 9100,
      } as any,
      { retries: 1 },
    );
    expect(r.ok).toBe(true);
    expect(sendNetwork).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry non-transient errors (e.g. paper out)', async () => {
    sendNetwork.mockResolvedValue({ ok: false, error: 'paper out' } as any);
    await printWithProfile(
      payload,
      {} as any,
      {
        id: 'p',
        name: 'P',
        mode: 'NETWORK',
        ip: '10.0.0.1',
        port: 9100,
      } as any,
      { retries: 3 },
    );
    expect(sendNetwork).toHaveBeenCalledTimes(1);
  });
});

// ---- dispatchTicket (high-level routing) --------------------------------

describe('dispatchTicket', () => {
  it('returns ok=false when no printer is configured', async () => {
    const r = await dispatchTicket({} as any, {} as any);
    expect(r.ok).toBe(false);
    expect(r.firstError).toMatch(/no printer/i);
  });

  it('routes a non-ORDER ticket to the receipt profile only', async () => {
    const r = await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [{ name: 'x', qty: 1, unitPrice: 1 }],
        meta: { kind: 'PAYMENT' },
      } as any,
      {
        printers: [
          {
            id: 'kitchen',
            name: 'Kitchen',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.2',
            port: 9100,
          },
          {
            id: 'receipt',
            name: 'Receipt',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
        printerRouting: { enabled: true, receiptPrinterId: 'receipt' },
      } as any,
      { retries: 0 },
    );
    expect(r.ok).toBe(true);
    expect(r.perPrinter).toEqual([
      { profileId: 'receipt', ok: true, error: undefined },
    ]);
    expect(sendNetwork).toHaveBeenCalledTimes(1);
    expect(sendNetwork).toHaveBeenCalledWith(
      '10.0.0.1',
      9100,
      expect.any(Buffer),
      {
        forceProtocol: 'RAW',
      },
    );
  });

  it('default retries=1: one silent retry on transient TCP errors', async () => {
    sendNetwork
      .mockResolvedValueOnce({
        ok: false,
        error: 'blip',
        code: 'ECONNREFUSED',
      } as any)
      .mockResolvedValueOnce({ ok: true });
    const r = await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [{ name: 'x', qty: 1, unitPrice: 1 }],
        meta: { kind: 'PAYMENT' },
      } as any,
      {
        printers: [
          {
            id: 'r',
            name: 'R',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
      } as any,
      // No `retries` opt → falls through to default of 1.
    );
    expect(r.ok).toBe(true);
    expect(sendNetwork).toHaveBeenCalledTimes(2);
  });

  it('routing OFF: an ORDER also lands on a single (receipt) printer', async () => {
    const r = await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [
          { name: 'pizza', qty: 1, unitPrice: 1, categoryName: 'food' },
          { name: 'beer', qty: 1, unitPrice: 1, categoryName: 'drinks' },
        ],
        meta: { kind: 'ORDER' },
      } as any,
      {
        printers: [
          {
            id: 'r',
            name: 'R',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
        printerRouting: { enabled: false },
      } as any,
      { retries: 0 },
    );
    expect(r.ok).toBe(true);
    expect(r.perPrinter.length).toBe(1);
  });

  it('routing ON + ORDER: splits items by category to separate printers', async () => {
    // This is the iOS routing fix — used to never trigger from the
    // HTTP path. Now both Electron and HTTP routes go through this.
    const r = await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [
          { name: 'pizza', qty: 1, unitPrice: 1, categoryName: 'food' },
          { name: 'beer', qty: 1, unitPrice: 1, categoryName: 'drinks' },
        ],
        meta: { kind: 'ORDER' },
      } as any,
      {
        printers: [
          {
            id: 'kitchen',
            name: 'Kitchen',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.2',
            port: 9100,
          },
          {
            id: 'bar',
            name: 'Bar',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.3',
            port: 9100,
          },
          {
            id: 'receipt',
            name: 'Receipt',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
        printerRouting: {
          enabled: true,
          receiptPrinterId: 'receipt',
          categories: { food: 'kitchen', drinks: 'bar' },
        },
      } as any,
      { retries: 0 },
    );
    expect(r.ok).toBe(true);
    // Two slips: one for the kitchen, one for the bar.
    const ips = sendNetwork.mock.calls.map((c) => c[0]).sort();
    expect(ips).toEqual(['10.0.0.2', '10.0.0.3']);
    expect(r.perPrinter.map((p) => p.profileId).sort()).toEqual([
      'bar',
      'kitchen',
    ]);
  });

  it('reports per-printer failures and a first error', async () => {
    sendNetwork.mockImplementation(async (ip: string) =>
      ip === '10.0.0.2'
        ? { ok: false, error: 'kitchen offline', code: 'ECONNREFUSED' }
        : { ok: true },
    );
    const r = await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [
          { name: 'pizza', qty: 1, unitPrice: 1, categoryName: 'food' },
          { name: 'beer', qty: 1, unitPrice: 1, categoryName: 'drinks' },
        ],
        meta: { kind: 'ORDER' },
      } as any,
      {
        printers: [
          {
            id: 'kitchen',
            name: 'Kitchen',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.2',
            port: 9100,
          },
          {
            id: 'bar',
            name: 'Bar',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.3',
            port: 9100,
          },
          {
            id: 'receipt',
            name: 'Receipt',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
        printerRouting: {
          enabled: true,
          receiptPrinterId: 'receipt',
          categories: { food: 'kitchen', drinks: 'bar' },
        },
      } as any,
      { retries: 0 },
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toBe(1);
    expect(r.firstError).toMatch(/kitchen offline/);
  });
});

// ---- testPrintWithProfile ----------------------------------------------

describe('testPrintWithProfile', () => {
  it('NETWORK forces RAW for port 9100', async () => {
    await testPrintWithProfile(
      {
        id: 'p',
        name: 'P',
        mode: 'NETWORK',
        ip: '10.0.0.1',
        port: 9100,
      } as any,
      {} as any,
    );
    expect(sendNetwork).toHaveBeenCalledWith(
      '10.0.0.1',
      9100,
      expect.any(Buffer),
      { forceProtocol: 'RAW' },
    );
  });
  it('NETWORK forces LPR for port 515', async () => {
    await testPrintWithProfile(
      { id: 'p', name: 'P', mode: 'NETWORK', ip: '10.0.0.1', port: 515 } as any,
      {} as any,
    );
    expect(sendNetwork).toHaveBeenCalledWith(
      '10.0.0.1',
      515,
      expect.any(Buffer),
      { forceProtocol: 'LPR' },
    );
  });
  it('SERIAL with no path returns a friendly error (no transport call)', async () => {
    const r = await testPrintWithProfile(
      { id: 'p', name: 'P', mode: 'SERIAL' } as any,
      {} as any,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/serial/i);
    expect(sendSerial).not.toHaveBeenCalled();
  });
});

// ---- isTransientPrintError ---------------------------------------------

describe('isTransientPrintError', () => {
  it('matches the codes thrown by sendToPrinterVerbose', () => {
    expect(isTransientPrintError('Send failed: connect ECONNREFUSED')).toBe(
      true,
    );
    expect(isTransientPrintError('Send failed: ETIMEDOUT')).toBe(true);
    expect(isTransientPrintError('Address: 10.0.0.5:9100 — EHOSTUNREACH')).toBe(
      true,
    );
    expect(isTransientPrintError('socket hang up')).toBe(true);
    expect(isTransientPrintError('LPR connect timeout')).toBe(true);
    expect(isTransientPrintError('fetch failed')).toBe(true);
    // Regression: kernel alternates between EHOSTUNREACH (was OK) and
    // EHOSTDOWN (was wrongly dropped) when the printer is unplugged
    // mid-burst, so half the receipts vanished. Both should retry.
    expect(
      isTransientPrintError(
        'connect EHOSTDOWN 192.168.1.87:9100 - Local (192.168.1.78:49949)',
      ),
    ).toBe(true);
    expect(isTransientPrintError('Host is down')).toBe(true);
    expect(isTransientPrintError('connect ENETDOWN')).toBe(true);
  });
  it('does NOT match permanent errors', () => {
    expect(isTransientPrintError('out of paper')).toBe(false);
    expect(isTransientPrintError('Printer IP not configured')).toBe(false);
    expect(isTransientPrintError('LPR NACK')).toBe(false);
    expect(isTransientPrintError('')).toBe(false);
    expect(isTransientPrintError(null)).toBe(false);
    expect(isTransientPrintError(undefined)).toBe(false);
  });
});

// ---- enqueuePrintRetry --------------------------------------------------

describe('enqueuePrintRetry', () => {
  it('persists a RETRY row with the next backoff slot on first failure', async () => {
    const wakeup = vi.fn();
    setRetryWakeup(wakeup);
    try {
      const r = await enqueuePrintRetry({
        payload: { area: 'A', tableLabel: 'T1', items: [] } as any,
        printerProfileId: 'kitchen',
        error: 'ECONNREFUSED',
        priorAttempts: 1,
      });
      expect(r.status).toBe('RETRY');
      expect(printJobCreate).toHaveBeenCalledTimes(1);
      const passed = printJobCreate.mock.calls[0][0] as any;
      expect(passed.data.status).toBe('RETRY');
      expect(passed.data.attempts).toBe(1);
      expect(passed.data.printerProfileId).toBe('kitchen');
      expect(passed.data.lastError).toBe('ECONNREFUSED');
      expect(passed.data.nextAttemptAt).toBeInstanceOf(Date);
      // First retry slot is 5 s — give a wide window for jitter / clock skew.
      const ms = (passed.data.nextAttemptAt as Date).getTime() - Date.now();
      expect(ms).toBeGreaterThan(2_000);
      expect(ms).toBeLessThan(10_000);
      // The wake-up callback should be invoked so the loop sleeps no
      // longer than the new row's nextAttemptAt.
      expect(wakeup).toHaveBeenCalledTimes(1);
    } finally {
      setRetryWakeup(null);
    }
  });

  it('writes a FAILED row (not a RETRY) once attempts hit RETRY_MAX_ATTEMPTS', async () => {
    const r = await enqueuePrintRetry({
      payload: { area: 'A', tableLabel: 'T1', items: [] } as any,
      printerProfileId: 'kitchen',
      error: 'ECONNREFUSED',
      priorAttempts: RETRY_MAX_ATTEMPTS,
    });
    expect(r.status).toBe('FAILED');
    const passed = printJobCreate.mock.calls[0][0] as any;
    expect(passed.data.status).toBe('FAILED');
    // No nextAttemptAt for permanent failures.
    expect(passed.data.nextAttemptAt).toBeUndefined();
  });
});

// ---- dispatchTicket + persistRetryOnTransientFailure -------------------

describe('dispatchTicket retry-queue integration', () => {
  it('does NOT enqueue a retry when persist flag is omitted (default off)', async () => {
    sendNetwork.mockResolvedValue({ ok: false, error: 'ECONNREFUSED' } as any);
    await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [],
        meta: { kind: 'PAYMENT' },
      } as any,
      {
        printers: [
          {
            id: 'r',
            name: 'R',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
      } as any,
      { retries: 0 },
    );
    expect(printJobCreate).not.toHaveBeenCalled();
  });

  it('enqueues exactly one retry per failed transient destination', async () => {
    sendNetwork.mockResolvedValue({ ok: false, error: 'ECONNREFUSED' } as any);
    await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [],
        meta: { kind: 'PAYMENT' },
      } as any,
      {
        printers: [
          {
            id: 'r',
            name: 'R',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
      } as any,
      { retries: 0, persistRetryOnTransientFailure: true },
    );
    expect(printJobCreate).toHaveBeenCalledTimes(1);
    expect((printJobCreate.mock.calls[0][0] as any).data.status).toBe('RETRY');
    expect((printJobCreate.mock.calls[0][0] as any).data.printerProfileId).toBe(
      'r',
    );
  });

  it('does NOT enqueue a retry for permanent (non-transient) errors', async () => {
    sendNetwork.mockResolvedValue({ ok: false, error: 'out of paper' } as any);
    await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [],
        meta: { kind: 'PAYMENT' },
      } as any,
      {
        printers: [
          {
            id: 'r',
            name: 'R',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
      } as any,
      { retries: 0, persistRetryOnTransientFailure: true },
    );
    expect(printJobCreate).not.toHaveBeenCalled();
  });

  it('routed ORDER: only re-enqueues the bucket whose printer failed', async () => {
    // Bar OK, kitchen offline → exactly one RETRY row, for the kitchen.
    sendNetwork.mockImplementation(async (ip: string) =>
      ip === '10.0.0.2' ? { ok: false, error: 'ECONNREFUSED' } : { ok: true },
    );
    await dispatchTicket(
      {
        area: 'A',
        tableLabel: 'T1',
        items: [
          { name: 'pizza', qty: 1, unitPrice: 1, categoryName: 'food' },
          { name: 'beer', qty: 1, unitPrice: 1, categoryName: 'drinks' },
        ],
        meta: { kind: 'ORDER' },
      } as any,
      {
        printers: [
          {
            id: 'kitchen',
            name: 'Kitchen',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.2',
            port: 9100,
          },
          {
            id: 'bar',
            name: 'Bar',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.3',
            port: 9100,
          },
          {
            id: 'receipt',
            name: 'Receipt',
            enabled: true,
            mode: 'NETWORK',
            ip: '10.0.0.1',
            port: 9100,
          },
        ],
        printerRouting: {
          enabled: true,
          receiptPrinterId: 'receipt',
          categories: { food: 'kitchen', drinks: 'bar' },
        },
      } as any,
      { retries: 0, persistRetryOnTransientFailure: true },
    );
    expect(printJobCreate).toHaveBeenCalledTimes(1);
    const data = (printJobCreate.mock.calls[0][0] as any).data;
    expect(data.status).toBe('RETRY');
    expect(data.printerProfileId).toBe('kitchen');
    // The persisted payload should be the kitchen-only bucket — its
    // items list should have 1 entry (pizza), not the original 2.
    expect((data.payloadJson as any).items).toHaveLength(1);
    expect((data.payloadJson as any).items[0].name).toBe('pizza');
  });
});
