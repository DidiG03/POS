/**
 * The claim is the only thing standing between a retried payment and a
 * second real invoice at the tax service, so these tests care most about
 * the states that must NOT lead to another registration.
 *
 * Prisma is a small in-memory stand-in: `syncState` keyed by string, with
 * `create` raising P2002 on a duplicate exactly as SQLite's primary key
 * would.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, notifications } = vi.hoisted(() => ({
  store: new Map<string, { valueJson: any; updatedAt: Date }>(),
  notifications: [] as Array<{ userId: number; message: string }>,
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
        const lt = where?.updatedAt?.lt as Date | undefined;
        return [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .filter(([, row]) => !gte || row.updatedAt >= gte)
          .filter(([, row]) => !lt || row.updatedAt < lt)
          .map(([key, row]) => ({ key, ...row }));
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const keys: string[] = where?.key?.in ?? [];
        let count = 0;
        for (const key of keys) if (store.delete(key)) count += 1;
        return { count };
      }),
    },
    user: {
      findMany: vi.fn(async () => [{ id: 99 }]),
    },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        notifications.push({ userId: data.userId, message: data.message });
        return data;
      }),
    },
  },
}));

import {
  claimFiscalRegistration,
  findRegisteredClaimForTable,
  fiscalClaimKey,
  flagFiscalCorrectionRequired,
  listFiscalClaimsNeedingReview,
  notifyFiscalReviewNeeded,
  pruneFiscalClaims,
  readFiscalClaim,
  resolveFiscalClaim,
  settleFiscalClaimFailed,
  settleFiscalClaimRegistered,
  settleFiscalClaimUnknown,
  STALE_PENDING_MS,
} from './claims';

const KEY = 'pay-0001';

/** Rewind a claim's clock so the staleness branch can be exercised. */
function ageClaim(idempotencyKey: string, byMs: number) {
  const row = store.get(fiscalClaimKey(idempotencyKey))!;
  const record = row.valueJson;
  const shifted = new Date(Date.now() - byMs).toISOString();
  store.set(fiscalClaimKey(idempotencyKey), {
    ...row,
    valueJson: { ...record, createdAt: shifted, updatedAt: shifted },
  });
}

beforeEach(() => {
  store.clear();
  notifications.length = 0;
});

describe('claimFiscalRegistration', () => {
  it('lets the first attempt through and records the intent before the call', async () => {
    const decision = await claimFiscalRegistration(KEY, { area: 'Bar' });
    expect(decision.outcome).toBe('proceed');

    // The record must exist BEFORE the provider is contacted, otherwise a
    // crash mid-request leaves nothing to stop a duplicate.
    const stored = await readFiscalClaim(KEY);
    expect(stored?.state).toBe('PENDING');
    expect(stored?.context?.area).toBe('Bar');
  });

  it('blocks a second attempt while the first is still in flight', async () => {
    await claimFiscalRegistration(KEY);
    // The tablet timed out and replayed while the host was still working.
    const second = await claimFiscalRegistration(KEY);
    expect(second.outcome).toBe('in-flight');
  });

  it('replays stored identifiers instead of registering a second invoice', async () => {
    const first = await claimFiscalRegistration(KEY);
    if (first.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimRegistered(KEY, first.attemptId, {
      nslf: 'NSLF-1',
      nivf: 'NIVF-1',
      status: 'accepted',
    });

    const replay = await claimFiscalRegistration(KEY);
    expect(replay.outcome).toBe('replay');
    if (replay.outcome !== 'replay') throw new Error('unreachable');
    expect(replay.result.nslf).toBe('NSLF-1');
    expect(replay.result.nivf).toBe('NIVF-1');
  });

  it('allows a retry after the provider definitively rejected the invoice', async () => {
    const first = await claimFiscalRegistration(KEY);
    if (first.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimFailed(KEY, first.attemptId, 'HTTP 400 bad article');

    const retry = await claimFiscalRegistration(KEY);
    expect(retry.outcome).toBe('proceed');
    if (retry.outcome !== 'proceed') throw new Error('unreachable');
    // A fresh owner id, so the abandoned attempt cannot settle this one.
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect((await readFiscalClaim(KEY))?.attempts).toBe(2);
  });

  it('sends an interrupted attempt to review rather than retrying it', async () => {
    await claimFiscalRegistration(KEY);
    // Nothing settled the claim within the provider's whole budget: the
    // process died mid-request and the invoice may or may not exist.
    ageClaim(KEY, STALE_PENDING_MS + 1000);

    const decision = await claimFiscalRegistration(KEY);
    expect(decision.outcome).toBe('needs-review');
    if (decision.outcome !== 'needs-review') throw new Error('unreachable');
    expect(decision.alreadyReported).toBe(false);
    expect((await readFiscalClaim(KEY))?.state).toBe('UNKNOWN');
  });

  it('keeps an unknown claim in review and only reports it once', async () => {
    const first = await claimFiscalRegistration(KEY);
    if (first.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimUnknown(KEY, first.attemptId, 'timed out');

    const second = await claimFiscalRegistration(KEY);
    expect(second.outcome).toBe('needs-review');
    if (second.outcome !== 'needs-review') throw new Error('unreachable');
    expect(second.alreadyReported).toBe(true);
  });

  it('refuses to proceed when the claim cannot be stored', async () => {
    const { prisma } = (await import('@db/client')) as any;
    prisma.syncState.create.mockRejectedValueOnce(new Error('disk is full'));
    // Registering without a durable claim is what allows duplicates, so
    // failing the payment is the safer outcome.
    await expect(claimFiscalRegistration(KEY)).rejects.toThrow('disk is full');
  });

  it('requires an idempotency key', async () => {
    await expect(claimFiscalRegistration('')).rejects.toThrow(
      /idempotency key/i,
    );
  });
});

describe('settling a claim', () => {
  it('ignores a settle from a superseded attempt', async () => {
    const first = await claimFiscalRegistration(KEY);
    if (first.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimFailed(KEY, first.attemptId, 'rejected');
    const retry = await claimFiscalRegistration(KEY);
    if (retry.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimRegistered(KEY, retry.attemptId, { nslf: 'NSLF-2' });

    // The abandoned first attempt finally returns. It must not downgrade
    // a registration the current owner already recorded.
    await settleFiscalClaimFailed(KEY, first.attemptId, 'late failure');

    const stored = await readFiscalClaim(KEY);
    expect(stored?.state).toBe('REGISTERED');
    expect(stored?.result?.nslf).toBe('NSLF-2');
  });

  it('is a no-op when no claim exists', async () => {
    await expect(
      settleFiscalClaimRegistered('missing', 'whatever', {}),
    ).resolves.toBeUndefined();
  });
});

describe('review surface', () => {
  it('lists only the claims a human still has to reconcile', async () => {
    const a = await claimFiscalRegistration('pay-a');
    if (a.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimRegistered('pay-a', a.attemptId, { nslf: 'X' });

    const b = await claimFiscalRegistration('pay-b');
    if (b.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimUnknown('pay-b', b.attemptId, 'timed out');

    const pending = await listFiscalClaimsNeedingReview();
    expect(pending.map((p) => p.idempotencyKey)).toEqual(['pay-b']);
  });

  it('clears a reconciled claim for retry', async () => {
    const c = await claimFiscalRegistration(KEY);
    if (c.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimUnknown(KEY, c.attemptId, 'timed out');

    expect(await resolveFiscalClaim(KEY, 'retry')).toBe(true);
    expect((await claimFiscalRegistration(KEY)).outcome).toBe('proceed');
  });

  it('marks a reconciled claim registered so it is never sent again', async () => {
    const c = await claimFiscalRegistration(KEY);
    if (c.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimUnknown(KEY, c.attemptId, 'timed out');

    await resolveFiscalClaim(KEY, 'registered', { nslf: 'FOUND-IN-EASYPOS' });

    const decision = await claimFiscalRegistration(KEY);
    expect(decision.outcome).toBe('replay');
  });

  it('notifies the actor and every admin', async () => {
    await notifyFiscalReviewNeeded({
      idempotencyKey: KEY,
      area: 'Bar',
      tableLabel: '4',
      actorUserId: 7,
      message: 'timed out',
    });
    expect(notifications.map((n) => n.userId).sort()).toEqual([7, 99]);
    expect(notifications[0].message).toContain('Bar Table 4');
    expect(notifications[0].message).toContain(KEY);
  });
});

describe('a void after the invoice was filed', () => {
  /** Register a sale for `Bar 4` the way a real payment would. */
  async function registerSale(key = KEY) {
    const c = await claimFiscalRegistration(key, {
      area: 'Bar',
      tableLabel: '4',
      total: 300,
    });
    if (c.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimRegistered(key, c.attemptId, {
      nslf: 'NSLF-1',
      nivf: 'NIVF-1',
      status: 'accepted',
    });
  }

  it('finds the invoice filed for that table in this session', async () => {
    await registerSale();
    const found = await findRegisteredClaimForTable({
      area: 'Bar',
      tableLabel: '4',
      since: new Date(Date.now() - 60_000),
    });
    expect(found?.idempotencyKey).toBe(KEY);
    expect(found?.record.result?.nivf).toBe('NIVF-1');
  });

  it('ignores another table and anything before this session', async () => {
    await registerSale();
    expect(
      await findRegisteredClaimForTable({
        area: 'Bar',
        tableLabel: '5',
        since: new Date(Date.now() - 60_000),
      }),
    ).toBeNull();
    expect(
      await findRegisteredClaimForTable({
        area: 'Bar',
        tableLabel: '4',
        since: new Date(Date.now() + 60_000),
      }),
    ).toBeNull();
  });

  it('flags the sale for correction and hands the admin the invoice numbers', async () => {
    await registerSale();
    notifications.length = 0;

    const flagged = await flagFiscalCorrectionRequired({
      idempotencyKey: KEY,
      reason: 'Ticket voided after the sale was fiscalized',
      actorUserId: 7,
      context: { area: 'Bar', tableLabel: '4' },
      result: { nslf: 'NSLF-1', nivf: 'NIVF-1' },
    });

    expect(flagged).toBe(true);
    expect((await readFiscalClaim(KEY))?.state).toBe('CORRECTION_REQUIRED');
    // Without the identifiers the admin cannot find the invoice to correct.
    expect(notifications[0].message).toContain('NIVF-1');
    expect(notifications.map((n) => n.userId).sort()).toEqual([7, 99]);
  });

  it('shows up in the review queue alongside unconfirmed outcomes', async () => {
    await registerSale();
    await flagFiscalCorrectionRequired({
      idempotencyKey: KEY,
      reason: 'voided',
    });

    const queue = await listFiscalClaimsNeedingReview();
    expect(queue).toHaveLength(1);
    expect(queue[0].record.state).toBe('CORRECTION_REQUIRED');
  });

  it('never re-registers a sale that is awaiting correction', async () => {
    await registerSale();
    await flagFiscalCorrectionRequired({
      idempotencyKey: KEY,
      reason: 'voided',
    });

    // The invoice still exists upstream; a replay must not file a second.
    expect((await claimFiscalRegistration(KEY)).outcome).toBe('replay');
  });

  it('does not nag on a second void of the same ticket', async () => {
    await registerSale();
    await flagFiscalCorrectionRequired({ idempotencyKey: KEY, reason: 'a' });
    notifications.length = 0;
    await flagFiscalCorrectionRequired({ idempotencyKey: KEY, reason: 'b' });
    expect(notifications).toHaveLength(0);
  });

  it('clears once an admin confirms the corrective invoice', async () => {
    await registerSale();
    await flagFiscalCorrectionRequired({
      idempotencyKey: KEY,
      reason: 'voided',
    });

    expect(await resolveFiscalClaim(KEY, 'corrected')).toBe(true);
    expect((await readFiscalClaim(KEY))?.state).toBe('CORRECTED');
    expect(await listFiscalClaimsNeedingReview()).toHaveLength(0);
  });
});

describe('pruneFiscalClaims', () => {
  /** Push a claim past the 90-day retention window. */
  function backdate(key: string) {
    const full = fiscalClaimKey(key);
    const row = store.get(full)!;
    store.set(full, {
      ...row,
      updatedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    });
  }

  it('keeps unreconciled sales however old they get', async () => {
    const c = await claimFiscalRegistration(KEY);
    if (c.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimUnknown(KEY, c.attemptId, 'timed out');
    backdate(KEY);

    await pruneFiscalClaims({ force: true });

    // Age is not resolution. Deleting this would erase the only record
    // that a real sale still needs someone to look at it.
    expect(await readFiscalClaim(KEY)).not.toBeNull();
  });

  it('drops settled claims past the retention window', async () => {
    const c = await claimFiscalRegistration(KEY);
    if (c.outcome !== 'proceed') throw new Error('expected proceed');
    await settleFiscalClaimRegistered(KEY, c.attemptId, { nslf: 'X' });
    backdate(KEY);

    await pruneFiscalClaims({ force: true });

    expect(await readFiscalClaim(KEY)).toBeNull();
  });
});
