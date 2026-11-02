/**
 * QA v0.2.103 H1 and H2, over the real claim store, payment path and
 * transmit loop.
 *
 * H1: a fiscal outage (503s from the local middleware) refused 1,215
 *     payments and left 160 tables blocked even after recovery and a
 *     restart. Now the payment is taken, the invoice queued, and the queue
 *     drains on its own, including after a restart.
 * H2: "retry" in the review list filed a timed-out sale twice. Now it is
 *     checked (cloud: easyPos is asked; local: the reviewer must confirm),
 *     and it is atomic per sale.
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
  return {
    ...actual,
    assertFiscalConfigured: vi.fn(),
    createEasyPosSale: createSale,
  };
});

vi.mock('./balance', () => ({ ensureDailyBalanceForCash: ensureFloat }));

import { transmitDueDeferredInvoices } from './deferred';
import { fiscalizePaymentOnce } from './index';
import {
  fiscalClaimKey,
  listFiscalClaimsDeferred,
  listFiscalClaimsNeedingReview,
  readFiscalClaim,
  resetFiscalDeferredHint,
} from './claims';
import { fiscalHttpOutcome } from './easypos';
import { retryFiscalReview } from './reviewRetry';

const LOCAL = {
  currency: 'ALL',
  defaultVatRate: 0.2,
  fiscal: {
    enabled: true,
    provider: 'easypos',
    baseUrl: 'http://127.0.0.1:8080',
    authToken: 'token',
  },
} as unknown as SettingsDTO;
const CLOUD = {
  ...LOCAL,
  fiscal: { ...(LOCAL as any).fiscal, baseUrl: 'https://api.dev.easypos.al' },
} as unknown as SettingsDTO;

function fiscalErr(
  message: string,
  outcome: 'not-registered' | 'unknown',
  retryable = true,
) {
  const err: any = new Error(message);
  err.fiscalOutcome = outcome;
  err.fiscalRetryable = retryable;
  return err;
}
/** What easyPosRequest throws for a 503 from the local middleware. */
const outage503 = () =>
  fiscalErr('POST /v1/invoices/new → HTTP 503', fiscalHttpOutcome(503), true);

function sale(table: string, total = 300) {
  return {
    area: 'Salla',
    tableLabel: table,
    items: [{ sku: 'ESP', name: 'Espresso', qty: 2, unitPrice: total / 2 }],
    meta: { kind: 'PAYMENT', method: 'CASH', totalAfter: total, userId: 7 },
  } as any;
}

const filed = (n: number) => ({
  nslf: `NSLF-${n}`,
  nivf: `NIVF-${n}`,
  link: '',
  status: 'accepted' as const,
});

/** Make every queued claim due now, as if its backoff had elapsed. */
function makeAllDue() {
  for (const [key, row] of store.entries()) {
    if (row.valueJson?.state === 'DEFERRED') {
      store.set(key, {
        ...row,
        valueJson: {
          ...row.valueJson,
          nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
        },
      });
    }
  }
}

beforeEach(() => {
  resetFiscalDeferredHint();
  store.clear();
  payments.clear();
  createSale.mockReset();
});

describe('fiscal HTTP errors (H1)', () => {
  it('treats a 503 as transient and nothing filed, other 5xx as unconfirmed', () => {
    expect(fiscalHttpOutcome(503)).toBe('not-registered');
    expect(fiscalHttpOutcome(500)).toBe('unknown');
    expect(fiscalHttpOutcome(502)).toBe('unknown');
    expect(fiscalHttpOutcome(504)).toBe('unknown');
    expect(fiscalHttpOutcome(400)).toBe('not-registered');
    expect(fiscalHttpOutcome(422)).toBe('not-registered');
  });
});

describe('a fiscal outage never blocks tables (H1)', () => {
  it('takes every payment during the outage and drains the queue after recovery and a restart', async () => {
    const TABLES = 160;
    // Outage: the local middleware answers 503 to everything.
    createSale.mockRejectedValue(outage503());
    for (let i = 1; i <= TABLES; i++) {
      const out = await fiscalizePaymentOnce(sale(`T${i}`), LOCAL, {
        idempotencyKey: `pay-${i}`,
      });
      // Taken, with a "not yet fiscalised" receipt. Never refused.
      expect(out.kind).toBe('deferred');
      if (out.kind !== 'deferred') throw new Error('unreachable');
      expect(out.payload.meta?.fiscalStatus).toBe('pending');
    }
    // None of them needs a person: a 503 filed nothing.
    expect(await listFiscalClaimsNeedingReview()).toHaveLength(0);
    expect(await listFiscalClaimsDeferred()).toHaveLength(TABLES);

    // Still down when the loop runs: re-queued with backoff, nothing lost.
    makeAllDue();
    await transmitDueDeferredInvoices(LOCAL);
    const stillQueued = await readFiscalClaim('pay-1');
    expect(stillQueued?.state).toBe('DEFERRED');
    expect(Date.parse(stillQueued!.nextAttemptAt!)).toBeGreaterThan(Date.now());

    // The till restarts: a fresh copy of the modules over the same stored
    // claims. Fiscal is back.
    vi.resetModules();
    const { transmitDueDeferredInvoices: afterRestart } = await import(
      './deferred'
    );
    let n = 0;
    createSale.mockReset();
    createSale.mockImplementation(async () => filed(++n));
    makeAllDue();
    await afterRestart(LOCAL);

    // Drained on its own: every invoice filed exactly once.
    expect(createSale).toHaveBeenCalledTimes(TABLES);
    for (const i of [1, 80, TABLES]) {
      expect((await readFiscalClaim(`pay-${i}`))?.state).toBe('REGISTERED');
    }
    expect(await listFiscalClaimsDeferred()).toHaveLength(0);
    expect(await listFiscalClaimsNeedingReview()).toHaveLength(0);
  });

  it('a later payment on a table whose earlier send is unconfirmed is taken, never filed twice', async () => {
    // A timeout (unconfirmed) leaves the invoice held for a person.
    createSale.mockRejectedValue(
      fiscalErr('Fiscal middleware timed out.', 'unknown'),
    );
    const first = await fiscalizePaymentOnce(sale('T5'), LOCAL, {
      idempotencyKey: 'pay-a',
    });
    expect(first.kind).toBe('deferred');
    // The same payment replayed (the phone retrying): taken, not sent.
    const replay = await fiscalizePaymentOnce(sale('T5'), LOCAL, {
      idempotencyKey: 'pay-a',
    });
    expect(replay.kind).toBe('needs-review');
    expect(createSale).toHaveBeenCalledTimes(1);
    // The loop does not send it either while it is held.
    makeAllDue();
    await transmitDueDeferredInvoices(LOCAL);
    expect(createSale).toHaveBeenCalledTimes(1);
  });

  it('re-queues an unconfirmed resend on the cloud API to be status-checked', async () => {
    createSale.mockRejectedValue(outage503());
    await fiscalizePaymentOnce(sale('T6'), CLOUD, { idempotencyKey: 'pay-c' });
    createSale.mockReset();
    createSale.mockRejectedValue(
      fiscalErr('easyPos did not answer in time.', 'unknown'),
    );
    makeAllDue();
    await transmitDueDeferredInvoices(CLOUD);
    const claim = await readFiscalClaim('pay-c');
    // Not parked as UNKNOWN: back on the queue, asked about first next time.
    expect(claim?.state).toBe('DEFERRED');
    expect(claim?.checkStatusFirst).toBe(true);
    expect(claim?.holdReason).toBeUndefined();
  });

  it('holds a queued invoice easyPos now refuses, instead of dropping it', async () => {
    createSale.mockRejectedValue(outage503());
    await fiscalizePaymentOnce(sale('T7'), LOCAL, { idempotencyKey: 'pay-r' });
    createSale.mockReset();
    createSale.mockRejectedValue(
      fiscalErr('HTTP 400 · unknown articleId', 'not-registered', false),
    );
    makeAllDue();
    await transmitDueDeferredInvoices(LOCAL);
    const claim = await readFiscalClaim('pay-r');
    expect(claim?.state).toBe('DEFERRED');
    expect(claim?.holdReason).toContain('refused');
    expect(
      (await listFiscalClaimsNeedingReview()).map((r) => r.idempotencyKey),
    ).toContain('pay-r');
  });
});

describe('retrying from the review list (H2)', () => {
  async function heldAfterTimeout(settings: SettingsDTO, key = 'pay-66') {
    createSale.mockRejectedValue(
      fiscalErr('Fiscal middleware timed out.', 'unknown'),
    );
    await fiscalizePaymentOnce(sale('T66'), settings, { idempotencyKey: key });
    createSale.mockReset();
  }

  it('records the invoice easyPos already filed and sends nothing (cloud)', async () => {
    await heldAfterTimeout(LOCAL);
    const stamp = vi.fn(async () => undefined);
    const checkStatus = vi.fn(async () => ({
      kind: 'filed' as const,
      result: filed(66),
    }));
    const r = await retryFiscalReview({
      idempotencyKey: 'pay-66',
      settings: CLOUD,
      checkStatus,
      stampSale: stamp,
    });
    expect(r).toEqual({ ok: true, outcome: 'filed', nivf: 'NIVF-66' });
    expect((await readFiscalClaim('pay-66'))?.state).toBe('REGISTERED');
    expect(stamp).toHaveBeenCalledWith('pay-66', expect.anything());
    // Nothing goes out afterwards.
    makeAllDue();
    await transmitDueDeferredInvoices(CLOUD);
    expect(createSale).not.toHaveBeenCalled();
  });

  it('queues the same docId when easyPos has never seen it, still checked first (cloud)', async () => {
    await heldAfterTimeout(LOCAL);
    const r = await retryFiscalReview({
      idempotencyKey: 'pay-66',
      settings: CLOUD,
      checkStatus: async () => ({ kind: 'absent' as const }),
    });
    expect(r).toEqual({ ok: true, outcome: 'queued' });
    const claim = await readFiscalClaim('pay-66');
    expect(claim?.state).toBe('DEFERRED');
    expect(claim?.holdReason).toBeUndefined();
    expect(claim?.checkStatusFirst).toBe(true);
    expect((claim?.draft as any)?.docId).toBeTruthy();
  });

  it('sends nothing when easyPos cannot say (cloud)', async () => {
    await heldAfterTimeout(LOCAL);
    const r = await retryFiscalReview({
      idempotencyKey: 'pay-66',
      settings: CLOUD,
      checkStatus: async () => ({ kind: 'unknown' as const, message: 'x' }),
    });
    expect(r).toMatchObject({ ok: false, code: 'STATUS_UNKNOWN' });
    expect((await readFiscalClaim('pay-66'))?.holdReason).toBeTruthy();
  });

  it('requires the reviewer to confirm on the local middleware', async () => {
    await heldAfterTimeout(LOCAL);
    const refused = await retryFiscalReview({
      idempotencyKey: 'pay-66',
      settings: LOCAL,
    });
    expect(refused).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    expect((await readFiscalClaim('pay-66'))?.holdReason).toBeTruthy();

    const confirmed = await retryFiscalReview({
      idempotencyKey: 'pay-66',
      settings: LOCAL,
      confirmedNotFiled: true,
    });
    expect(confirmed).toEqual({ ok: true, outcome: 'queued' });
    // Sent once by the loop, under the same docId, and never again.
    createSale.mockResolvedValue(filed(67));
    makeAllDue();
    await transmitDueDeferredInvoices(LOCAL);
    await transmitDueDeferredInvoices(LOCAL);
    expect(createSale).toHaveBeenCalledTimes(1);
    expect((await readFiscalClaim('pay-66'))?.state).toBe('REGISTERED');
  });

  it('is atomic per sale: two retries at once ask easyPos once and queue once', async () => {
    await heldAfterTimeout(LOCAL);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const checkStatus = vi.fn(async () => {
      await gate;
      return { kind: 'absent' as const };
    });
    const a = retryFiscalReview({
      idempotencyKey: 'pay-66',
      settings: CLOUD,
      checkStatus,
    });
    const b = retryFiscalReview({
      idempotencyKey: 'pay-66',
      settings: CLOUD,
      checkStatus,
    });
    // The second click waits briefly, then is told one is already running.
    const second = await b;
    release();
    const first = await a;
    expect(first).toEqual({ ok: true, outcome: 'queued' });
    expect(second).toMatchObject({ ok: false, code: 'BUSY' });
    expect(checkStatus).toHaveBeenCalledTimes(1);
  });

  it('never re-sends an invoice that already has a NIVF', async () => {
    store.set(fiscalClaimKey('pay-n'), {
      valueJson: {
        state: 'UNKNOWN',
        attemptId: 'a',
        attempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        result: { nivf: 'NIVF-X' },
      },
      updatedAt: new Date(),
    });
    const r = await retryFiscalReview({
      idempotencyKey: 'pay-n',
      settings: LOCAL,
      confirmedNotFiled: true,
    });
    expect(r).toMatchObject({ ok: false, code: 'NOT_RETRYABLE' });
  });
});
