/**
 * Sending invoices that were taken while easyPos was unreachable.
 *
 * The loop shares the claim lock with voids and admin reversals, so it must
 * skip a claim someone else is deciding about, never send a withdrawn one,
 * and stamp the result on the sale it belongs to — which, after a
 * correction restated the invoice, is not the claim's own key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';

const { store, payments, createSale, ensureFloat } = vi.hoisted(() => ({
  store: new Map<string, { valueJson: any; updatedAt: Date }>(),
  payments: new Map<string, any>(),
  createSale: vi.fn(),
  ensureFloat: vi.fn(async (..._args: unknown[]) => ({
    kind: 'already-declared',
  })),
}));

vi.mock('@db/client', () => ({
  prisma: {
    // The claim listings' SQL, over the in-memory rows: key range, then the
    // states passed as parameters (plus orphaned REGISTERED when asked).
    $queryRawUnsafe: vi.fn(
      async (sql: string, from: string, to: string, ...states: string[]) =>
        [...store.entries()]
          .filter(([key, row]) => {
            if (!(key >= from && key < to)) return false;
            const v = row.valueJson || {};
            return (
              states.includes(v.state) ||
              (sql.includes('orphanDetectedAt') &&
                v.state === 'REGISTERED' &&
                v.orphanDetectedAt != null)
            );
          })
          .map(([key, row]) => ({
            key,
            valueJson: JSON.stringify(row.valueJson),
          })),
    ),
    syncState: {
      create: vi.fn(async ({ data }: any) => {
        if (store.has(data.key)) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        store.set(data.key, {
          valueJson: data.valueJson,
          updatedAt: new Date(),
        });
        return { key: data.key };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = store.get(where.key);
        store.set(where.key, {
          valueJson: existing ? update.valueJson : create.valueJson,
          updatedAt: new Date(),
        });
        return { key: where.key };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = store.get(where.key);
        return row ? { key: where.key, ...row } : null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const prefix = where?.key?.startsWith ?? '';
        return [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, row]) => ({ key, ...row }));
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    printJob: { findUnique: vi.fn(async () => null) },
    payment: {
      findUnique: vi.fn(
        async ({ where }: any) => payments.get(where.idempotencyKey) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        for (const p of payments.values()) {
          if (p.id === where.id) Object.assign(p, data);
        }
        return {};
      }),
    },
    user: { findMany: vi.fn(async () => []) },
    notification: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock('../core', () => ({
  coreServices: { readSettings: vi.fn(async () => ({})) },
}));

vi.mock('./easypos', async (importActual) => {
  const actual = await importActual<typeof import('./easypos')>();
  return { ...actual, createEasyPosSale: createSale };
});

vi.mock('./balance', () => ({ ensureDailyBalanceForCash: ensureFloat }));

import { transmitDueDeferredInvoices } from './deferred';
import {
  fiscalClaimKey,
  readFiscalClaim,
  resetFiscalDeferredHint,
  withFiscalClaimLock,
} from './claims';

const settings = { fiscal: { enabled: true } } as unknown as SettingsDTO;
const PAST = new Date(Date.now() - 60_000).toISOString();

function deferred(key: string, extra: Record<string, any> = {}) {
  store.set(fiscalClaimKey(key), {
    valueJson: {
      state: 'DEFERRED',
      attemptId: 'a',
      attempts: 1,
      createdAt: PAST,
      updatedAt: PAST,
      nextAttemptAt: PAST,
      context: { area: 'Bar', tableLabel: '4', total: 300 },
      draft: { docId: key, articles: [], payment: [] },
      ...extra,
    },
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  resetFiscalDeferredHint();
  store.clear();
  payments.clear();
  ensureFloat.mockClear();
  createSale.mockReset();
  createSale.mockResolvedValue({
    nslf: 'NSLF-D',
    nivf: 'NIVF-D',
    link: '',
    status: 'accepted',
  });
});

describe('transmitDueDeferredInvoices', () => {
  it('stamps a restated invoice on the sale it replaced', async () => {
    deferred('inv-restated', {
      context: { area: 'Bar', tableLabel: '4', total: 200, saleKey: 'pay-1' },
    });
    payments.set('pay-1', { id: 1, idempotencyKey: 'pay-1', metaJson: {} });

    const r = await transmitDueDeferredInvoices(settings);
    expect(r).toEqual({ attempted: 1, registered: 1 });
    expect((await readFiscalClaim('inv-restated'))?.state).toBe('REGISTERED');
    expect(payments.get('pay-1')).toMatchObject({
      fiscalNslf: 'NSLF-D',
      fiscalNivf: 'NIVF-D',
    });
  });

  it('keeps the NIVF when the registered claim will not save', async () => {
    deferred('pay-unstored');
    payments.set('pay-unstored', {
      id: 2,
      idempotencyKey: 'pay-unstored',
      metaJson: {},
    });
    const { prisma } = await import('@db/client');
    const upsert = vi.mocked(prisma.syncState.upsert);
    const original = upsert.getMockImplementation();
    upsert.mockImplementation(async (args: any) => {
      const value = args?.update?.valueJson ?? args?.create?.valueJson;
      if (value?.state === 'REGISTERED') throw new Error('disk full');
      return original!(args);
    });
    try {
      const r = await transmitDueDeferredInvoices(settings);
      expect(r.registered).toBe(0);
      expect(createSale).toHaveBeenCalledTimes(1);
      expect((await readFiscalClaim('pay-unstored'))?.state).toBe('UNKNOWN');
      expect((await readFiscalClaim('pay-unstored'))?.result?.nivf).toBe(
        'NIVF-D',
      );
      expect(payments.get('pay-unstored')).toMatchObject({
        fiscalNivf: 'NIVF-D',
        fiscalNslf: 'NSLF-D',
      });
      await transmitDueDeferredInvoices(settings);
      expect(createSale).toHaveBeenCalledTimes(1);
    } finally {
      if (original) upsert.mockImplementation(original);
    }
  });

  it('asks easyPos first when an earlier send was never confirmed', async () => {
    deferred('pay-check', { checkStatusFirst: true });
    await transmitDueDeferredInvoices(settings);
    expect(createSale).toHaveBeenCalledWith(
      settings,
      expect.objectContaining({ docId: 'pay-check' }),
      { statusFirst: true },
    );
  });

  it('keeps the status check when easyPos still cannot be asked', async () => {
    deferred('pay-still-off');
    createSale.mockRejectedValueOnce(
      Object.assign(new Error('offline'), {
        fiscalOutcome: 'not-registered',
        fiscalRetryable: true,
        fiscalCheckStatusFirst: true,
      }),
    );
    await transmitDueDeferredInvoices(settings);
    const claim = await readFiscalClaim('pay-still-off');
    expect(claim?.state).toBe('DEFERRED');
    expect(claim?.checkStatusFirst).toBe(true);
  });

  it('never sends a withdrawn invoice', async () => {
    store.set(fiscalClaimKey('pay-2'), {
      valueJson: {
        state: 'ABANDONED',
        attemptId: 'a',
        attempts: 1,
        createdAt: PAST,
        updatedAt: PAST,
      },
      updatedAt: new Date(),
    });
    await transmitDueDeferredInvoices(settings);
    expect(createSale).not.toHaveBeenCalled();
  });

  it('leaves a claim alone while a reversal is deciding about it', async () => {
    deferred('pay-3');
    let release!: () => void;
    const reversal = withFiscalClaimLock(
      'pay-3',
      () => new Promise<void>((r) => (release = r)),
    );
    const r = await transmitDueDeferredInvoices(settings);
    expect(r.registered).toBe(0);
    expect(createSale).not.toHaveBeenCalled();
    release();
    await reversal;
    expect((await readFiscalClaim('pay-3'))?.state).toBe('DEFERRED');
  });

  it('does not send a claim withdrawn after it was listed', async () => {
    deferred('pay-4');
    // A reversal that wins the lock first and withdraws the invoice.
    const { abandonUnsentFiscalClaimUnlocked } = await import('./claims');
    const reversal = withFiscalClaimLock('pay-4', async () => {
      await new Promise((r) => setTimeout(r, 20));
      await abandonUnsentFiscalClaimUnlocked('pay-4', 'cancelled');
    });
    await new Promise((r) => setTimeout(r, 1));
    const loop = transmitDueDeferredInvoices(settings);
    await Promise.all([reversal, loop]);
    expect(createSale).not.toHaveBeenCalled();
    expect((await readFiscalClaim('pay-4'))?.state).toBe('ABANDONED');
  });
});

describe('deferred loop when nothing is waiting', () => {
  it('stops querying until a sale is actually deferred', async () => {
    const { prisma } = await import('@db/client');
    const query = vi.mocked((prisma as any).$queryRawUnsafe);

    await transmitDueDeferredInvoices(settings);
    const afterFirst = query.mock.calls.length;
    await transmitDueDeferredInvoices(settings);
    await transmitDueDeferredInvoices(settings);
    expect(query.mock.calls.length).toBe(afterFirst);

    // Deferring a sale goes through the claim writers, which re-arm it.
    const { claimFiscalRegistration, settleFiscalClaimDeferred } = await import(
      './claims'
    );
    const c = await claimFiscalRegistration('pay-9', {
      area: 'Bar',
      tableLabel: '4',
      total: 300,
    });
    if (c.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimDeferred(
      'pay-9',
      c.attemptId,
      'offline',
      {
        docId: 'pay-9',
        articles: [],
        payment: [],
      },
      PAST,
    );

    const r = await transmitDueDeferredInvoices(settings);
    expect(r).toEqual({ attempted: 1, registered: 1 });
  });

  it('still looks again after a couple of minutes', async () => {
    const { fiscalDeferredWorkMayExist, listFiscalClaimsDeferred } =
      await import('./claims');
    await listFiscalClaimsDeferred();
    expect(fiscalDeferredWorkMayExist()).toBe(false);
    expect(fiscalDeferredWorkMayExist(Date.now() + 2 * 60_000)).toBe(true);
  });
});

describe('opening float for invoices sent late', () => {
  const cloud = {
    fiscal: {
      enabled: true,
      baseUrl: 'https://api.easypos.al/fiscalisation-service/v1',
      openingFloat: 5000,
    },
  } as unknown as SettingsDTO;

  it("declares today's float before resending a cash invoice", async () => {
    deferred('cash-1', {
      draft: {
        docId: 'cash-1',
        articles: [],
        payment: [{ type: 'CASH', amount: 300 }],
      },
    });
    const order: string[] = [];
    ensureFloat.mockImplementationOnce(async () => {
      order.push('float');
      return { kind: 'initiated' } as any;
    });
    createSale.mockImplementationOnce(async () => {
      order.push('invoice');
      return { nslf: 'N', nivf: 'F', link: '', status: 'accepted' };
    });
    await transmitDueDeferredInvoices(cloud);
    expect(order).toEqual(['float', 'invoice']);
    expect(ensureFloat.mock.calls[0][1]).toEqual({ openingFloat: 5000 });
  });

  it('leaves card invoices alone', async () => {
    deferred('card-1', {
      draft: {
        docId: 'card-1',
        articles: [],
        payment: [{ type: 'CARD', amount: 300 }],
      },
    });
    await transmitDueDeferredInvoices(cloud);
    expect(ensureFloat).not.toHaveBeenCalled();
    expect(createSale).toHaveBeenCalledTimes(1);
  });

  it('still sends the invoice when the float check fails', async () => {
    deferred('cash-2', {
      draft: {
        docId: 'cash-2',
        articles: [],
        payment: [{ type: 'CASH', amount: 300 }],
      },
    });
    ensureFloat.mockRejectedValueOnce(new Error('offline'));
    await transmitDueDeferredInvoices(cloud);
    expect(createSale).toHaveBeenCalledTimes(1);
  });
});

describe('an outage during a resend pass', () => {
  it('sends the oldest sale first and stops at the first unreachable send', async () => {
    const at = (min: number) =>
      new Date(Date.now() - min * 60_000).toISOString();
    deferred('inv-newer-000', { createdAt: at(5) });
    deferred('inv-oldest-00', { createdAt: at(30) });
    deferred('inv-middle-00', { createdAt: at(15) });
    const offline = Object.assign(new Error('fetch failed'), {
      fiscalOutcome: 'not-registered',
      fiscalRetryable: true,
    });
    createSale.mockReset();
    createSale.mockRejectedValue(offline);

    const r = await transmitDueDeferredInvoices(settings);

    // One send found easyPos down; the other two wait for the next pass
    // instead of each spending a full recovery budget on the same answer.
    expect(createSale).toHaveBeenCalledTimes(1);
    expect((createSale.mock.calls[0] as any)[1].docId).toBe('inv-oldest-00');
    expect(r).toEqual({ attempted: 1, registered: 0 });
    expect((await readFiscalClaim('inv-middle-00'))?.state).toBe('DEFERRED');
  });
});
