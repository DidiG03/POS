/**
 * One sitting, one invoice.
 *
 * A second Pay tap for the same table gets a new docId, so the per-docId
 * claim cannot stop it filing a second invoice. These tests pin the check
 * that runs before every payment, and the sweep that surfaces interrupted
 * sends without waiting for a payment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, printJobs, payments, alerts, session } = vi.hoisted(() => ({
  store: new Map<string, { valueJson: any; updatedAt: Date }>(),
  printJobs: new Set<string>(),
  payments: new Set<string>(),
  alerts: [] as Array<{ message: string }>,
  session: { startedAt: null as Date | null },
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
        const gte = where?.updatedAt?.gte as Date | undefined;
        return [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .filter(([, row]) => !gte || row.updatedAt >= gte)
          .map(([key, row]) => ({ key, ...row }));
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    printJob: {
      findMany: vi.fn(async ({ where }: any) =>
        (where.idempotencyKey.in as string[])
          .filter((k) => printJobs.has(k))
          .map((idempotencyKey) => ({ idempotencyKey })),
      ),
    },
    payment: {
      findMany: vi.fn(async ({ where }: any) =>
        (where.idempotencyKey.in as string[])
          .filter((k) => payments.has(k))
          .map((idempotencyKey) => ({ idempotencyKey })),
      ),
    },
  },
}));

vi.mock('../tableSession', () => ({
  getTableSessionStartedAt: vi.fn(async () => session.startedAt),
}));

vi.mock('../adminAlerts', () => ({
  notifyAdminsAndActor: vi.fn(async (input: any) => {
    alerts.push(input);
  }),
}));

import {
  PROCESS_STARTED_AT,
  fiscalClaimKey,
  listFiscalClaimsNeedingReview,
  readFiscalClaim,
} from './claims';
import {
  ORPHAN_GRACE_MS,
  __resetFiscalSweepForTests,
  adoptFiscalInvoice,
  checkSittingBeforePayment,
  sweepFiscalClaims,
} from './sitting';

const NOW = Date.now();
const SESSION_START = new Date(NOW - 60 * 60_000);

function putClaim(
  key: string,
  record: Record<string, unknown>,
  opts: { createdAt?: number; updatedAt?: number } = {},
) {
  const createdAt = new Date(opts.createdAt ?? NOW - 5 * 60_000).toISOString();
  const updatedAt = new Date(
    opts.updatedAt ?? Date.parse(createdAt),
  ).toISOString();
  store.set(fiscalClaimKey(key), {
    valueJson: {
      attemptId: `att-${key}`,
      attempts: 1,
      createdAt,
      updatedAt,
      context: { area: 'Salla', tableLabel: 'T4', total: 25 },
      ...record,
    },
    updatedAt: new Date(),
  });
}

const check = (total = 25, idempotencyKey = 'pay-new') =>
  checkSittingBeforePayment({
    area: 'Salla',
    tableLabel: 'T4',
    total,
    idempotencyKey,
    now: NOW,
  });

beforeEach(() => {
  store.clear();
  printJobs.clear();
  payments.clear();
  alerts.length = 0;
  session.startedAt = SESSION_START;
  __resetFiscalSweepForTests();
});

describe('checkSittingBeforePayment', () => {
  it('lets a normal payment through', async () => {
    expect(await check()).toEqual({ kind: 'clear' });
  });

  it('reuses an invoice filed for this sitting whose sale was never saved', async () => {
    putClaim('pay-lost', {
      state: 'REGISTERED',
      result: { nslf: 'IIC1', nivf: 'FIC1' },
    });
    expect(await check(25)).toEqual({
      kind: 'adopt',
      docId: 'pay-lost',
      nivf: 'FIC1',
    });
  });

  it('holds the payment when the unsaved invoice is for a different amount', async () => {
    putClaim('pay-lost', {
      state: 'REGISTERED',
      result: { nslf: 'IIC1', nivf: 'FIC1' },
    });
    const r = await check(31.5);
    expect(r).toMatchObject({
      kind: 'blocked',
      code: 'FISCAL_SITTING_UNRESOLVED',
      retryable: false,
      docId: 'pay-lost',
    });
    // It is now on the admin review list, and admins were told once.
    expect((await readFiscalClaim('pay-lost'))?.orphanDetectedAt).toBeTruthy();
    expect(
      (await listFiscalClaimsNeedingReview()).map((r) => r.idempotencyKey),
    ).toContain('pay-lost');
    expect(alerts).toHaveLength(1);
    await check(31.5);
    expect(alerts).toHaveLength(1);
  });

  it('only reuses an invoice filed with the same payment method', async () => {
    putClaim('pay-lost', {
      state: 'REGISTERED',
      result: { nslf: 'IIC1', nivf: 'FIC1' },
      context: { area: 'Salla', tableLabel: 'T4', total: 25, method: 'CASH' },
    });
    const card = await checkSittingBeforePayment({
      area: 'Salla',
      tableLabel: 'T4',
      total: 25,
      method: 'CARD',
      idempotencyKey: 'pay-new',
      now: NOW,
    });
    expect(card).toMatchObject({
      kind: 'blocked',
      code: 'FISCAL_SITTING_UNRESOLVED',
    });
    expect((card as any).message).toContain('CASH');
    const cash = await checkSittingBeforePayment({
      area: 'Salla',
      tableLabel: 'T4',
      total: 25,
      method: 'CASH',
      idempotencyKey: 'pay-new',
      now: NOW,
    });
    expect(cash).toMatchObject({ kind: 'adopt', docId: 'pay-lost' });
  });

  it('ignores invoices whose sale was saved, under either key', async () => {
    putClaim('pay-a', { state: 'REGISTERED', result: { nivf: 'F' } });
    printJobs.add('pay-a');
    putClaim('pay-b', {
      state: 'REGISTERED',
      result: { nivf: 'F' },
      context: {
        area: 'Salla',
        tableLabel: 'T4',
        total: 25,
        saleKey: 'pay-b-sale',
      },
    });
    payments.add('pay-b-sale');
    expect(await check()).toEqual({ kind: 'clear' });
  });

  it('holds the payment while an earlier one is unconfirmed', async () => {
    putClaim('pay-unknown', { state: 'UNKNOWN', lastError: 'timeout' });
    expect(await check()).toMatchObject({
      kind: 'blocked',
      code: 'FISCAL_SITTING_UNRESOLVED',
      retryable: false,
    });
  });

  it('treats a send from before a restart as interrupted, however recent', async () => {
    const beforeStart = PROCESS_STARTED_AT - 1_000;
    putClaim(
      'pay-crash',
      { state: 'PENDING' },
      { createdAt: beforeStart, updatedAt: beforeStart },
    );
    session.startedAt = new Date(beforeStart - 60_000);
    expect(await check()).toMatchObject({
      kind: 'blocked',
      code: 'FISCAL_SITTING_UNRESOLVED',
    });
    expect((await readFiscalClaim('pay-crash'))?.state).toBe('UNKNOWN');
    expect(alerts.some((a) => a.message.includes('pay-crash'))).toBe(true);
  });

  it('asks to wait, not to escalate, while an earlier send is live', async () => {
    // Started by this process, moments ago.
    const justNow = Math.max(NOW, PROCESS_STARTED_AT);
    putClaim(
      'pay-live',
      { state: 'PENDING' },
      { createdAt: justNow, updatedAt: justNow },
    );
    expect(await check()).toMatchObject({
      kind: 'blocked',
      code: 'FISCAL_SITTING_BUSY',
      retryable: true,
    });
    expect((await readFiscalClaim('pay-live'))?.state).toBe('PENDING');
  });

  it('only looks at this sitting, this table, and not this payment', async () => {
    putClaim(
      'pay-old-sitting',
      { state: 'UNKNOWN' },
      { createdAt: SESSION_START.getTime() - 60_000 },
    );
    putClaim('pay-other-table', {
      state: 'UNKNOWN',
      context: { area: 'Salla', tableLabel: 'T9', total: 25 },
    });
    putClaim('pay-new', { state: 'UNKNOWN' });
    expect(await check(25, 'pay-new')).toEqual({ kind: 'clear' });
  });

  it('never adopts when the sitting start is unknown', async () => {
    session.startedAt = null;
    putClaim('pay-lost', { state: 'REGISTERED', result: { nivf: 'F' } });
    expect((await check(25)).kind).toBe('blocked');
  });

  it('links an adopted invoice to the new payment', async () => {
    putClaim('pay-lost', {
      state: 'REGISTERED',
      result: { nivf: 'F' },
      orphanDetectedAt: new Date(NOW).toISOString(),
    });
    await adoptFiscalInvoice({
      docId: 'pay-lost',
      saleKey: 'pay-new',
      area: 'Salla',
      tableLabel: 'T4',
      nivf: 'F',
    });
    const claim = await readFiscalClaim('pay-lost');
    expect(claim?.context?.saleKey).toBe('pay-new');
    expect(claim?.orphanDetectedAt).toBeUndefined();
    expect(claim?.state).toBe('REGISTERED');
  });
});

describe('sweepFiscalClaims', () => {
  it('moves interrupted sends to review and flags lost sales', async () => {
    const beforeStart = PROCESS_STARTED_AT - 1_000;
    putClaim(
      'pay-crash',
      { state: 'PENDING' },
      { createdAt: beforeStart, updatedAt: beforeStart },
    );
    putClaim(
      'pay-lost',
      { state: 'REGISTERED', result: { nivf: 'F' } },
      { createdAt: NOW - ORPHAN_GRACE_MS - 1_000 },
    );
    putClaim(
      'pay-printing',
      { state: 'REGISTERED', result: { nivf: 'F' } },
      { createdAt: NOW - 30_000 },
    );
    putClaim(
      'pay-ok',
      { state: 'REGISTERED', result: { nivf: 'F' } },
      { createdAt: NOW - ORPHAN_GRACE_MS - 1_000 },
    );
    printJobs.add('pay-ok');

    expect(await sweepFiscalClaims({ force: true, now: NOW })).toEqual({
      interrupted: 1,
      orphans: 1,
    });
    expect((await readFiscalClaim('pay-crash'))?.state).toBe('UNKNOWN');
    expect((await readFiscalClaim('pay-lost'))?.orphanDetectedAt).toBeTruthy();
    // Still within the time a payment takes to print and save.
    expect(
      (await readFiscalClaim('pay-printing'))?.orphanDetectedAt,
    ).toBeUndefined();
    expect((await readFiscalClaim('pay-ok'))?.orphanDetectedAt).toBeUndefined();
    const review = (await listFiscalClaimsNeedingReview()).map(
      (r) => r.idempotencyKey,
    );
    expect(review.sort()).toEqual(['pay-crash', 'pay-lost']);
  });

  it('clears the flag once the sale is saved', async () => {
    putClaim(
      'pay-lost',
      {
        state: 'REGISTERED',
        result: { nivf: 'F' },
        orphanDetectedAt: new Date(NOW - 1_000).toISOString(),
      },
      { createdAt: NOW - ORPHAN_GRACE_MS - 1_000 },
    );
    payments.add('pay-lost');
    await sweepFiscalClaims({ force: true, now: NOW });
    expect(
      (await readFiscalClaim('pay-lost'))?.orphanDetectedAt,
    ).toBeUndefined();
  });

  it('skips invoices whose sales were erased on purpose', async () => {
    putClaim(
      'pay-erased',
      { state: 'REGISTERED', result: { nivf: 'F' } },
      { createdAt: NOW - ORPHAN_GRACE_MS - 60_000 },
    );
    store.set('salesLedger:erasedThroughPrintJobId', {
      valueJson: {
        printJobId: 10,
        erasedAt: new Date(NOW - ORPHAN_GRACE_MS).toISOString(),
      },
      updatedAt: new Date(),
    });
    await sweepFiscalClaims({ force: true, now: NOW });
    expect(
      (await readFiscalClaim('pay-erased'))?.orphanDetectedAt,
    ).toBeUndefined();
  });

  it('is throttled between runs', async () => {
    await sweepFiscalClaims({ force: true, now: NOW });
    const beforeStart = PROCESS_STARTED_AT - 1_000;
    putClaim(
      'pay-crash',
      { state: 'PENDING' },
      { createdAt: beforeStart, updatedAt: beforeStart },
    );
    expect(await sweepFiscalClaims({ now: NOW + 1_000 })).toEqual({
      interrupted: 0,
      orphans: 0,
    });
    expect((await readFiscalClaim('pay-crash'))?.state).toBe('PENDING');
  });
});
