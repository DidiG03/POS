/** QA round 6, fiscal: cash in/out and the counted opening float are declared. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  initiate: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
  opening: vi.fn(async (): Promise<any> => null),
  enabled: true,
  store: new Map<string, any>(),
}));
vi.mock('./balance', () => ({
  initiateDailyBalance: h.initiate,
  depositCash: h.deposit,
  withdrawCash: h.withdraw,
  readDailyBalanceRecord: h.opening,
}));
vi.mock('./index', () => ({ isFiscalEnabled: () => h.enabled }));
vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: async ({ where }: any) =>
        h.store.has(where.key) ? { valueJson: h.store.get(where.key) } : null,
      upsert: async ({ where, update }: any) => {
        h.store.set(where.key, update.valueJson);
        return {};
      },
    },
  },
}));

import {
  cashDeclarationStatus,
  declareCash,
  listCashDeclarations,
} from './cashDrawer';

const settings = {} as any;

describe('declareCash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.enabled = true;
    h.store.clear();
    h.opening.mockResolvedValue(null);
    h.initiate.mockResolvedValue({ kind: 'complete', docId: 'd1', fcdc: 'F1' });
    h.deposit.mockResolvedValue({ kind: 'complete', docId: 'd2', fcdc: 'F2' });
    h.withdraw.mockResolvedValue({ kind: 'complete', docId: 'd3', fcdc: 'F3' });
  });

  it('declares the counted opening float', async () => {
    const r = await declareCash(settings, { kind: 'opening', amount: 12_500 });
    expect(h.initiate).toHaveBeenCalledWith(settings, { amount: 12_500 });
    expect(r).toEqual({ ok: true, kind: 'complete', docId: 'd1', fcdc: 'F1' });
  });

  it('declares cash in and out, one document per request key', async () => {
    await declareCash(settings, {
      kind: 'deposit',
      amount: 5000,
      requestKey: 'abc-123-key',
    });
    expect(h.deposit).toHaveBeenCalledWith(settings, {
      amount: 5000,
      docId: 'cash-abc-123-key',
    });
    await declareCash(settings, {
      kind: 'withdraw',
      amount: 2000,
      requestKey: 'def-456-key',
    });
    expect(h.withdraw).toHaveBeenCalledWith(settings, {
      amount: 2000,
      docId: 'cash-def-456-key',
    });
  });

  it('refuses bad amounts and a till that does not fiscalise', async () => {
    expect(
      await declareCash(settings, { kind: 'deposit', amount: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      await declareCash(settings, { kind: 'withdraw', amount: 'abc' }),
    ).toMatchObject({ ok: false });
    h.enabled = false;
    expect(
      await declareCash(settings, { kind: 'opening', amount: 100 }),
    ).toEqual({ ok: false, error: 'Fiscalization is off.' });
    expect(h.initiate).not.toHaveBeenCalled();
    expect(h.deposit).not.toHaveBeenCalled();
  });

  it('passes on a refusal from the tax service', async () => {
    h.deposit.mockResolvedValueOnce({
      kind: 'rejected',
      docId: 'd9',
      message: 'Balanca ditore nuk është deklaruar',
    });
    expect(
      await declareCash(settings, {
        kind: 'deposit',
        amount: 100,
        requestKey: 'ghi-789-key',
      }),
    ).toEqual({
      ok: false,
      error: 'Balanca ditore nuk është deklaruar',
      docId: 'd9',
    });
  });
});

describe('cash declarations (QA v0.2.103 #9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.enabled = true;
    h.store.clear();
    h.opening.mockResolvedValue(null);
    h.deposit.mockResolvedValue({ kind: 'complete', docId: 'd2', fcdc: 'F2' });
    h.initiate.mockResolvedValue({ kind: 'complete', docId: 'd1', fcdc: 'F1' });
  });

  it('refuses cash in/out without a request key, so a retry cannot declare it twice', async () => {
    for (const kind of ['deposit', 'withdraw'] as const) {
      const r = await declareCash(settings, { kind, amount: 500 });
      expect(r).toMatchObject({ ok: false });
      expect((r as any).error).toMatch(/request key/);
    }
    expect(h.deposit).not.toHaveBeenCalled();
    expect(h.withdraw).not.toHaveBeenCalled();
  });

  it('a retried declaration uses the same document', async () => {
    const ask = { kind: 'deposit', amount: 500, requestKey: 'same-key-1' };
    await declareCash(settings, ask);
    await declareCash(settings, ask);
    expect(h.deposit.mock.calls.map((c) => c[1].docId)).toEqual([
      'cash-same-key-1',
      'cash-same-key-1',
    ]);
  });

  it('says so when the opening float was already declared for another amount', async () => {
    h.opening.mockResolvedValue({
      state: 'COMPLETE',
      amount: 0,
      docId: 'auto-1',
      updatedAt: new Date().toISOString(),
    });
    const r = await declareCash(settings, { kind: 'opening', amount: 15_000 });
    expect(r).toMatchObject({ ok: false, docId: 'auto-1' });
    expect((r as any).error).toMatch(/already declared: 0\.00 lekë/);
    expect((r as any).error).toMatch(/cash in \(15000\.00 lekë\)/);
    // Nothing is sent: easyPos takes one opening float a day.
    expect(h.initiate).not.toHaveBeenCalled();
  });

  it('the same float entered again is fine', async () => {
    h.opening.mockResolvedValue({ state: 'COMPLETE', amount: 15_000 });
    h.initiate.mockResolvedValue({ kind: 'already-declared', docId: 'd1' });
    const r = await declareCash(settings, { kind: 'opening', amount: 15_000 });
    expect(r).toMatchObject({ ok: true, kind: 'already-declared' });
  });

  it('keeps a local record of every declaration, refused ones included', async () => {
    await declareCash(settings, {
      kind: 'deposit',
      amount: 500,
      requestKey: 'rec-key-1',
      actorUserId: 4,
    });
    await declareCash(settings, { kind: 'withdraw', amount: 200 });
    await declareCash(settings, { kind: 'opening', amount: 1000 });
    const log = await listCashDeclarations();
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({
      kind: 'deposit',
      amount: 500,
      requestKey: 'rec-key-1',
      actorUserId: 4,
      ok: true,
      outcome: 'complete',
      docId: 'd2',
      fcdc: 'F2',
    });
    expect(log[1]).toMatchObject({ kind: 'withdraw', ok: false });
    expect(log[1].error).toMatch(/request key/);
    expect(log[2]).toMatchObject({ kind: 'opening', ok: true });
  });
});

describe('cash declarations (QA v0.2.104 #10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.enabled = true;
    h.store.clear();
    h.deposit.mockResolvedValue({ kind: 'complete', docId: 'd2', fcdc: 'F2' });
  });

  it('a key reused with another amount is a 409 conflict, not "already declared"', async () => {
    h.deposit.mockResolvedValueOnce({
      kind: 'conflict',
      docId: 'cash-key-12345',
      message: 'This request key was already used for a cash in of 2.01 lekë',
    });
    const r = await declareCash(settings, {
      kind: 'deposit',
      amount: 4,
      requestKey: 'key-12345',
    });
    expect(r).toMatchObject({ ok: false, code: 'CASH_KEY_CONFLICT' });
    expect(cashDeclarationStatus(r)).toBe(409);
    expect((await listCashDeclarations())[0]).toMatchObject({
      ok: false,
      outcome: 'conflict',
    });
  });

  it('refuses more than 2 decimal places (400), before anything is sent', async () => {
    for (const amount of [2.005, 0.001, 10.123]) {
      const r = await declareCash(settings, {
        kind: 'deposit',
        amount,
        requestKey: 'key-dec-1',
      });
      expect(r).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
      expect(cashDeclarationStatus(r)).toBe(400);
    }
    expect(h.deposit).not.toHaveBeenCalled();
    // Whole cents are fine, float noise included.
    for (const amount of [2.01, 0.1 + 0.2, 1999.99]) {
      expect(
        await declareCash(settings, {
          kind: 'deposit',
          amount,
          requestKey: 'key-ok-1',
        }),
      ).toMatchObject({ ok: true });
    }
  });
});
