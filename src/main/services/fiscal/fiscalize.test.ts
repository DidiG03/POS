/**
 * End-to-end behaviour of `fiscalizePaymentOnce` over a real claim store.
 *
 * The property under test throughout: for one idempotency key, easyPos is
 * asked to register the invoice AT MOST ONCE, no matter how the caller
 * retries. Everything else is secondary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';

const { store, notifications, createSale } = vi.hoisted(() => ({
  store: new Map<string, { valueJson: any; updatedAt: Date }>(),
  notifications: [] as Array<{ userId: number; message: string }>,
  createSale: vi.fn(),
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
      findMany: vi.fn(async () => []),
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

vi.mock('./easypos', async (importActual) => {
  const actual = await importActual<typeof import('./easypos')>();
  return {
    ...actual,
    assertFiscalConfigured: vi.fn(),
    createEasyPosSale: createSale,
  };
});

import { fiscalizePaymentOnce } from './index';
import { readFiscalClaim } from './claims';

const KEY = 'pay-42';

const settings = {
  currency: 'ALL',
  defaultVatRate: 0.2,
  fiscal: {
    enabled: true,
    provider: 'easypos',
    baseUrl: 'http://127.0.0.1:8080',
    authToken: 'token',
  },
} as unknown as SettingsDTO;

function payment(overrides: Record<string, any> = {}) {
  return {
    area: 'Bar',
    tableLabel: '4',
    items: [{ sku: 'ESP', name: 'Espresso', qty: 2, unitPrice: 150 }],
    meta: { kind: 'PAYMENT', method: 'CARD', totalAfter: 300, userId: 7 },
    ...overrides,
  } as any;
}

function taggedError(message: string, outcome: 'not-registered' | 'unknown') {
  const err: any = new Error(message);
  err.fiscalOutcome = outcome;
  return err;
}

beforeEach(() => {
  store.clear();
  notifications.length = 0;
  createSale.mockReset();
});

describe('fiscalizePaymentOnce', () => {
  it('leaves non-payment tickets alone', async () => {
    const out = await fiscalizePaymentOnce(
      payment({ meta: { kind: 'ORDER' } }),
      settings,
      { idempotencyKey: KEY },
    );
    expect(out.kind).toBe('ok');
    expect(createSale).not.toHaveBeenCalled();
  });

  it('does nothing when fiskalizimi is switched off', async () => {
    const off = { ...settings, fiscal: { enabled: false } } as any;
    const out = await fiscalizePaymentOnce(payment(), off, {
      idempotencyKey: KEY,
    });
    expect(out.kind).toBe('ok');
    expect(createSale).not.toHaveBeenCalled();
  });

  it('stamps the identifiers onto the payload and records the claim', async () => {
    createSale.mockResolvedValue({
      nslf: 'NSLF-1',
      nivf: 'NIVF-1',
      link: 'https://verify',
      status: 'accepted',
    });

    const out = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') throw new Error('unreachable');
    expect(out.payload.meta?.fiscalNslf).toBe('NSLF-1');
    expect(out.payload.meta?.fiscalNivf).toBe('NIVF-1');
    expect((await readFiscalClaim(KEY))?.state).toBe('REGISTERED');
  });

  it('never registers the same sale twice, however often it is replayed', async () => {
    createSale.mockResolvedValue({
      nslf: 'NSLF-1',
      nivf: 'NIVF-1',
      status: 'accepted',
    });

    await fiscalizePaymentOnce(payment(), settings, { idempotencyKey: KEY });
    // The response was lost, the audit row never landed, the client retried.
    const replay = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });

    expect(createSale).toHaveBeenCalledTimes(1);
    expect(replay.kind).toBe('ok');
    if (replay.kind !== 'ok') throw new Error('unreachable');
    expect(replay.replayed).toBe(true);
    // The receipt still carries the real identifiers on the replay.
    expect(replay.payload.meta?.fiscalNslf).toBe('NSLF-1');
  });

  it('allows a retry when easyPos definitively rejected the invoice', async () => {
    createSale.mockRejectedValueOnce(
      taggedError('HTTP 400 · article not found', 'not-registered'),
    );

    const first = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });
    expect(first.kind).toBe('retryable');
    expect((await readFiscalClaim(KEY))?.state).toBe('FAILED');

    createSale.mockResolvedValueOnce({ nslf: 'NSLF-2', status: 'accepted' });
    const second = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });
    expect(second.kind).toBe('ok');
    expect(createSale).toHaveBeenCalledTimes(2);
  });

  it('sends an indeterminate outcome to review instead of retrying it', async () => {
    // A timeout: we stopped listening, but easyPos may have filed it.
    createSale.mockRejectedValue(
      taggedError('Fiscal middleware timed out.', 'unknown'),
    );

    const out = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });

    expect(out.kind).toBe('needs-review');
    expect((await readFiscalClaim(KEY))?.state).toBe('UNKNOWN');
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0].message).toContain(KEY);
  });

  it('does not call easyPos again once an outcome is unknown', async () => {
    createSale.mockRejectedValue(
      taggedError('Fiscal middleware timed out.', 'unknown'),
    );
    await fiscalizePaymentOnce(payment(), settings, { idempotencyKey: KEY });
    const attemptsAfterFirst = createSale.mock.calls.length;
    notifications.length = 0;

    const replay = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });

    expect(replay.kind).toBe('needs-review');
    // The whole point: a replay must not risk a second real invoice.
    expect(createSale).toHaveBeenCalledTimes(attemptsAfterFirst);
    // ...and it must not re-alert every admin each time.
    expect(notifications).toHaveLength(0);
  });

  it('treats an untagged provider error as indeterminate', async () => {
    createSale.mockRejectedValue(new Error('socket hang up'));
    const out = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });
    expect(out.kind).toBe('needs-review');
  });

  it('fails pre-flight without consuming a claim', async () => {
    const out = await fiscalizePaymentOnce(payment({ items: [] }), settings, {
      idempotencyKey: KEY,
    });
    // Nothing reached easyPos, so the key must stay usable — but an empty
    // ticket will still be empty on the next attempt.
    expect(out.kind).toBe('rejected');
    expect(createSale).not.toHaveBeenCalled();
    expect(await readFiscalClaim(KEY)).toBeNull();
  });

  it('does not retry a rejection that can never succeed', async () => {
    const err = taggedError('HTTP 400 · unknown articleId', 'not-registered');
    err.fiscalRetryable = false;
    createSale.mockRejectedValue(err);

    const out = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });

    expect(out.kind).toBe('rejected');
    // Still FAILED, not UNKNOWN: nothing was filed, so once someone fixes
    // the article mapping this exact payment can be released and retried.
    expect((await readFiscalClaim(KEY))?.state).toBe('FAILED');
    // And somebody has to be told, or the payment just sits there.
    expect(notifications.length).toBeGreaterThan(0);
  });

  it('warns admins when the invoice had to be balanced to match the charge', async () => {
    createSale.mockResolvedValue({ nslf: 'NSLF-1', status: 'accepted' });

    // Lines add up to 300; the amount actually charged was 250.
    const out = await fiscalizePaymentOnce(
      payment({ meta: { kind: 'PAYMENT', method: 'CARD', totalAfter: 250 } }),
      settings,
      { idempotencyKey: KEY },
    );

    expect(out.kind).toBe('ok');
    expect(notifications.some((n) => /balancing line/i.test(n.message))).toBe(
      true,
    );
  });

  it('stays quiet about a rounding-sized adjustment', async () => {
    createSale.mockResolvedValue({ nslf: 'NSLF-1', status: 'accepted' });

    await fiscalizePaymentOnce(
      payment({
        meta: { kind: 'PAYMENT', method: 'CARD', totalAfter: 299.99 },
      }),
      settings,
      { idempotencyKey: KEY },
    );

    expect(notifications.some((n) => /balancing line/i.test(n.message))).toBe(
      false,
    );
  });

  it('refuses to register when the claim cannot be stored', async () => {
    const { prisma } = (await import('@db/client')) as any;
    prisma.syncState.create.mockRejectedValueOnce(new Error('disk is full'));

    const out = await fiscalizePaymentOnce(payment(), settings, {
      idempotencyKey: KEY,
    });

    expect(out.kind).toBe('retryable');
    // Unprotected registration is exactly how duplicates happen.
    expect(createSale).not.toHaveBeenCalled();
  });
});
