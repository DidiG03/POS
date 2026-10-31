/** QA round 6, fiscal: cash in/out and the counted opening float are declared. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  initiate: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
  enabled: true,
}));
vi.mock('./balance', () => ({
  initiateDailyBalance: h.initiate,
  depositCash: h.deposit,
  withdrawCash: h.withdraw,
}));
vi.mock('./index', () => ({ isFiscalEnabled: () => h.enabled }));

import { declareCash } from './cashDrawer';

const settings = {} as any;

describe('declareCash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.enabled = true;
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
    await declareCash(settings, { kind: 'withdraw', amount: 2000 });
    expect(h.withdraw).toHaveBeenCalledWith(settings, { amount: 2000 });
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
      await declareCash(settings, { kind: 'deposit', amount: 100 }),
    ).toEqual({
      ok: false,
      error: 'Balanca ditore nuk është deklaruar',
      docId: 'd9',
    });
  });
});
