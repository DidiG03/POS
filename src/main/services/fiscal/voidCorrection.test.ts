/**
 * Voiding a ticket the tax service has already been told about.
 *
 * The POS cannot issue the corrective invoice itself, so the whole value
 * here is detection: the divergence has to be noticed and attributed to
 * the right invoice, and it must not cry wolf over a previous party's
 * perfectly good sale.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, notifications, openAt } = vi.hoisted(() => ({
  store: new Map<string, { valueJson: any; updatedAt: Date }>(),
  notifications: [] as Array<{ userId: number; message: string }>,
  openAt: { value: null as string | null },
}));

vi.mock('@db/client', () => ({
  prisma: {
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
        return { key: data.key, ...store.get(data.key) };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = store.get(where.key);
        store.set(where.key, {
          valueJson: existing ? update.valueJson : create.valueJson,
          updatedAt: new Date(),
        });
        return { key: where.key, ...store.get(where.key) };
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
    user: { findMany: vi.fn(async () => [{ id: 99 }]) },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        notifications.push({ userId: data.userId, message: data.message });
        return data;
      }),
    },
  },
}));

vi.mock('../tableSession', () => ({
  getTableSessionStartedAt: vi.fn(async () =>
    openAt.value ? new Date(openAt.value) : null,
  ),
}));

import { flagVoidAfterFiscalization } from './index';
import {
  claimFiscalRegistration,
  fiscalClaimKey,
  readFiscalClaim,
  settleFiscalClaimRegistered,
} from './claims';

const KEY = 'pay-void-1';

async function fiscalizeSale(
  key = KEY,
  context = { area: 'Bar', tableLabel: '4', total: 300 },
) {
  const c = await claimFiscalRegistration(key, context);
  if (c.outcome !== 'proceed') throw new Error('expected proceed');
  await settleFiscalClaimRegistered(key, c.attemptId, {
    nslf: 'NSLF-1',
    nivf: 'NIVF-1',
    status: 'accepted',
  });
}

/** Rewind a stored claim so it looks like it was filed a while ago. */
function ageClaim(key: string, byMs: number) {
  const full = fiscalClaimKey(key);
  const row = store.get(full)!;
  store.set(full, { ...row, updatedAt: new Date(Date.now() - byMs) });
}

beforeEach(() => {
  store.clear();
  notifications.length = 0;
  openAt.value = null;
});

describe('flagVoidAfterFiscalization', () => {
  it('says nothing when the table was never fiscalized', async () => {
    openAt.value = new Date(Date.now() - 60_000).toISOString();
    const flagged = await flagVoidAfterFiscalization({
      area: 'Bar',
      tableLabel: '4',
      reason: 'voided',
    });
    expect(flagged).toBe(false);
    expect(notifications).toHaveLength(0);
  });

  it('flags a void while the fiscalized table is still open', async () => {
    openAt.value = new Date(Date.now() - 60_000).toISOString();
    await fiscalizeSale();

    const flagged = await flagVoidAfterFiscalization({
      area: 'Bar',
      tableLabel: '4',
      reason: 'Ticket voided after the sale was fiscalized',
      actorUserId: 7,
    });

    expect(flagged).toBe(true);
    expect((await readFiscalClaim(KEY))?.state).toBe('CORRECTION_REQUIRED');
  });

  it('still catches it after payment has closed the table', async () => {
    // The close wipes `tables:openAt`, so there is no session to bound by
    // — and this is the case the whole check exists for.
    await fiscalizeSale();
    openAt.value = null;

    const flagged = await flagVoidAfterFiscalization({
      area: 'Bar',
      tableLabel: '4',
      reason: 'voided',
    });

    expect(flagged).toBe(true);
    expect(notifications[0].message).toMatch(/Fiskalizimi/i);
  });

  it('leaves an earlier party out of it', async () => {
    // Paid and left at noon; a new party sat down since. Voiding the new
    // ticket has nothing to do with the invoice from lunch.
    await fiscalizeSale();
    ageClaim(KEY, 60 * 60 * 1000);
    openAt.value = new Date(Date.now() - 10 * 60_000).toISOString();

    const flagged = await flagVoidAfterFiscalization({
      area: 'Bar',
      tableLabel: '4',
      reason: 'voided',
    });

    expect(flagged).toBe(false);
    expect((await readFiscalClaim(KEY))?.state).toBe('REGISTERED');
  });

  it('will not reach back past the lookback window on a closed table', async () => {
    await fiscalizeSale();
    ageClaim(KEY, 20 * 60 * 60 * 1000);
    openAt.value = null;

    expect(
      await flagVoidAfterFiscalization({
        area: 'Bar',
        tableLabel: '4',
        reason: 'voided',
      }),
    ).toBe(false);
  });

  it('ignores an invoice filed for a different table', async () => {
    await fiscalizeSale(KEY, { area: 'Bar', tableLabel: '9', total: 300 });
    openAt.value = null;

    expect(
      await flagVoidAfterFiscalization({
        area: 'Bar',
        tableLabel: '4',
        reason: 'voided',
      }),
    ).toBe(false);
  });

  it('never lets a bookkeeping failure block the void', async () => {
    await fiscalizeSale();
    const { prisma } = await import('@db/client');
    // Both lookups fail — and only these two, so later tests get the
    // working store back.
    vi.mocked(prisma.syncState.findMany)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(
      flagVoidAfterFiscalization({
        area: 'Bar',
        tableLabel: '4',
        reason: 'voided',
      }),
    ).resolves.toBe(false);
  });
});

describe('flagVoidAfterFiscalization — invoices not yet sent', () => {
  it('withdraws a deferred invoice instead of letting it go out', async () => {
    openAt.value = new Date(Date.now() - 60_000).toISOString();
    const c = await claimFiscalRegistration(KEY, {
      area: 'Bar',
      tableLabel: '4',
      total: 300,
    });
    if (c.outcome !== 'proceed') throw new Error('expected proceed');
    const { settleFiscalClaimDeferred } = await import('./claims');
    await settleFiscalClaimDeferred(
      KEY,
      c.attemptId,
      'offline',
      { docId: KEY },
      new Date().toISOString(),
    );
    expect(
      await flagVoidAfterFiscalization({
        area: 'Bar',
        tableLabel: '4',
        reason: 'voided',
      }),
    ).toBe(true);
    expect((await readFiscalClaim(KEY))?.state).toBe('ABANDONED');
  });

  it('sends an invoice interrupted mid-send to review, never withdraws it', async () => {
    openAt.value = new Date(Date.now() - 60 * 60_000).toISOString();
    await claimFiscalRegistration(KEY, {
      area: 'Bar',
      tableLabel: '4',
      total: 300,
    });
    // Started by an earlier run of the till: it cannot still be sending.
    const { PROCESS_STARTED_AT } = await import('./claims');
    const full = fiscalClaimKey(KEY);
    const row = store.get(full)!;
    const before = new Date(PROCESS_STARTED_AT - 1_000).toISOString();
    store.set(full, {
      ...row,
      valueJson: { ...row.valueJson, createdAt: before, updatedAt: before },
    });

    expect(
      await flagVoidAfterFiscalization({
        area: 'Bar',
        tableLabel: '4',
        reason: 'voided',
      }),
    ).toBe(true);
    const claim = await readFiscalClaim(KEY);
    expect(claim?.state).toBe('UNKNOWN');
    expect(claim?.lastError).toMatch(/voided/);
    expect(notifications.some((n) => n.message.includes(KEY))).toBe(true);
  });
});
