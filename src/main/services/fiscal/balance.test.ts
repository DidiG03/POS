/**
 * Cash balance declarations.
 *
 * The rule with teeth is "exactly one `/balance/initiate` per business day
 * per device". Declaring twice is a reporting error; declaring under a new
 * docId after an ambiguous first attempt is the same error wearing a
 * disguise, so the retry path has to reuse the stored docId.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';

const { store } = vi.hoisted(() => ({
  store: new Map<string, { valueJson: any; updatedAt: Date }>(),
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = store.get(where.key);
        return row ? { key: where.key, ...row } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = store.get(where.key);
        store.set(where.key, {
          valueJson: existing ? update.valueJson : create.valueJson,
          updatedAt: new Date(),
        });
        return { key: where.key, ...store.get(where.key) };
      }),
      create: vi.fn(async ({ data }: any) => {
        store.set(data.key, {
          valueJson: data.valueJson,
          updatedAt: new Date(),
        });
        return data;
      }),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

import {
  AUTO_DECLARE_RETRY_COOLDOWN_MS,
  depositCash,
  ensureDailyBalanceForCash,
  initiateDailyBalance,
  initiateKey,
  isDailyBalanceDeclared,
  deviceKeyOf,
  withdrawCash,
} from './balance';
import { __resetDocIdLocks, FISCAL_ROUTES } from './client';

const settings = {
  fiscal: {
    enabled: true,
    provider: 'easypos',
    baseUrl: 'https://api.dev.easypos.al/fiscalisation-service/v1',
    authToken: 'jwt',
    integrationApp: 'generic',
    defaultOperatorId: 'gh537ez280',
  },
} as unknown as SettingsDTO;

const fast = { sleep: async () => undefined, random: () => 0.5 };

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

const routesCalled = () =>
  fetchMock.mock.calls.map((c) => {
    const url = String(c[0]);
    return url.slice(url.lastIndexOf('/v1') + 3);
  });

beforeEach(() => {
  store.clear();
  __resetDocIdLocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('initiateDailyBalance', () => {
  it('completes on an FCDC, not on HTTP 200', async () => {
    fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
    const out = await initiateDailyBalance(settings, { amount: 20000 }, fast);

    expect(out.kind).toBe('complete');
    if (out.kind !== 'complete') throw new Error('unreachable');
    expect(out.fcdc).toBe('C9');
    expect(routesCalled()).toEqual([FISCAL_ROUTES.balanceInitiate]);
  });

  it('refuses to treat an empty 200 as declared', async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    const out = await initiateDailyBalance(
      settings,
      { amount: 20000 },
      { ...fast, maxAttempts: 1 },
    );
    expect(out.kind).toBe('unresolved');
    expect(await isDailyBalanceDeclared(settings)).toBe(false);
  });

  it('sends exactly one declaration per business day', async () => {
    fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
    await initiateDailyBalance(settings, { amount: 20000 }, fast);
    const second = await initiateDailyBalance(
      settings,
      { amount: 20000 },
      fast,
    );

    expect(second.kind).toBe('already-declared');
    // The second call must not reach the API at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The automatic path runs on every cash sale, so a declaration that keeps
   * being refused must not add a doomed POST to each one — but it does have
   * to start working the moment someone fixes the cause.
   */
  describe('the automatic cash path', () => {
    it('holds off after a refusal, then tries again once the cooldown lapses', async () => {
      fetchMock.mockResolvedValue(json(400, { message: 'operator not found' }));
      let clock = 1_000_000;
      const opts = { ...fast, now: () => clock };

      const first = await ensureDailyBalanceForCash(
        settings,
        { openingFloat: 20000 },
        opts,
      );
      expect(first.kind).toBe('rejected');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Straight after, and again just inside the window: no new request.
      await ensureDailyBalanceForCash(settings, { openingFloat: 20000 }, opts);
      clock += AUTO_DECLARE_RETRY_COOLDOWN_MS - 1;
      await ensureDailyBalanceForCash(settings, { openingFloat: 20000 }, opts);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Past the window the configuration may have been fixed, so ask again.
      clock += 2;
      fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
      const later = await ensureDailyBalanceForCash(
        settings,
        { openingFloat: 20000 },
        opts,
      );
      expect(later.kind).toBe('complete');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await isDailyBalanceDeclared(settings)).toBe(true);
    });

    /**
     * This runs inline on a cash sale. Three attempts against an
     * unresponsive easyPos is three request timeouts plus backoff — about a
     * minute of a waiter standing at the till before the invoice is even
     * tried. The cooldown is what retries, not this call.
     */
    it('makes one attempt only, so it cannot stall the till', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('fetch failed'), { name: 'AbortError' }),
      );

      const out = await ensureDailyBalanceForCash(
        settings,
        { openingFloat: 20000 },
        fast,
      );

      expect(out.kind).toBe('unresolved');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not tell staff to check easyPos when the network was down', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('fetch failed'), {
          cause: { code: 'ENETUNREACH' },
        }),
      );

      const out = await ensureDailyBalanceForCash(
        settings,
        { openingFloat: 20000 },
        fast,
      );

      expect(out.kind).toBe('unresolved');
      if (out.kind !== 'unresolved') throw new Error('unreachable');
      expect(out.message).toMatch(/never reached easyPos/i);
      expect(out.message).not.toMatch(/must be checked in easyPos/);
    });

    it('still lets an explicit declaration use the full retry budget', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('fetch failed'), { name: 'AbortError' }),
      );

      await initiateDailyBalance(settings, { amount: 20000 }, fast);

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('never re-declares once the day is settled', async () => {
      fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
      await ensureDailyBalanceForCash(settings, { openingFloat: 20000 }, fast);
      const again = await ensureDailyBalanceForCash(
        settings,
        { openingFloat: 20000 },
        fast,
      );

      expect(again.kind).toBe('already-declared');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('declares again on a different business day', async () => {
    fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
    await initiateDailyBalance(
      settings,
      { amount: 20000, dayKey: '2026-09-09' },
      fast,
    );
    const next = await initiateDailyBalance(
      settings,
      { amount: 20000, dayKey: '2026-09-10' },
      fast,
    );
    expect(next.kind).toBe('complete');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('persists the docId before the request is sent', async () => {
    fetchMock.mockImplementation(async () => {
      // At the moment the POST happens, the record must already exist.
      const record = store.get(
        initiateKey(deviceKeyOf(settings), '2026-09-09'),
      );
      expect(record?.valueJson?.state).toBe('PENDING');
      expect(record?.valueJson?.docId).toMatch(/^bal-/);
      return json(200, { fcdc: 'C9' });
    });
    await initiateDailyBalance(
      settings,
      { amount: 20000, dayKey: '2026-09-09' },
      fast,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resumes an ambiguous declaration under its original docId', async () => {
    // A fresh docId here would be a second declaration of the same float.
    fetchMock.mockResolvedValue(json(503, {}));
    await initiateDailyBalance(
      settings,
      { amount: 20000, dayKey: '2026-09-09' },
      { ...fast, maxAttempts: 1 },
    );
    const firstDocId = store.get(
      initiateKey(deviceKeyOf(settings), '2026-09-09'),
    )?.valueJson?.docId;
    expect(firstDocId).toBeTruthy();

    fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
    const resumed = await initiateDailyBalance(
      settings,
      { amount: 20000, dayKey: '2026-09-09' },
      fast,
    );

    expect(resumed.kind).toBe('complete');
    if (resumed.kind !== 'complete') throw new Error('unreachable');
    expect(resumed.docId).toBe(firstDocId);
  });

  it('stops on a validation failure rather than retrying', async () => {
    fetchMock.mockResolvedValue(json(400, { message: 'amount is required' }));
    const out = await initiateDailyBalance(settings, { amount: 20000 }, fast);
    expect(out.kind).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is scoped per device, so two tills each declare their own', async () => {
    fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
    await initiateDailyBalance(
      settings,
      { amount: 20000, dayKey: '2026-09-09' },
      fast,
    );

    const otherTill = {
      fiscal: { ...(settings as any).fiscal, defaultOperatorId: 'ab123cd456' },
    } as unknown as SettingsDTO;
    const out = await initiateDailyBalance(
      otherTill,
      { amount: 15000, dayKey: '2026-09-09' },
      fast,
    );

    expect(out.kind).toBe('complete');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('deposit and withdraw', () => {
  it('use their own routes and complete on FCDC', async () => {
    fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
    await depositCash(settings, { amount: 5000 }, fast);
    await withdrawCash(settings, { amount: 2500 }, fast);
    expect(routesCalled()).toEqual([
      FISCAL_ROUTES.balanceDeposit,
      FISCAL_ROUTES.balanceWithdraw,
    ]);
  });

  it('reuse a caller-supplied docId so a retry recovers', async () => {
    fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
    const first = await depositCash(
      settings,
      { amount: 5000, docId: 'drawer-evt-1' },
      fast,
    );
    const replay = await depositCash(
      settings,
      { amount: 5000, docId: 'drawer-evt-1' },
      fast,
    );

    expect(first.kind).toBe('complete');
    expect(replay.kind).toBe('already-declared');
    // The cash must not be moved twice.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('send the amount as given, in ALL', async () => {
    fetchMock.mockResolvedValue(json(200, { fcdc: 'C9' }));
    await depositCash(settings, { amount: 5000.456 }, fast);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as any).body));
    expect(body.amount).toBe(5000.46);
    expect(body.operatorCode).toBe('gh537ez280');
  });

  it('refuse a non-positive or non-numeric amount', async () => {
    await expect(depositCash(settings, { amount: 0 }, fast)).rejects.toThrow(
      /greater than zero/,
    );
    await expect(withdrawCash(settings, { amount: -5 }, fast)).rejects.toThrow(
      /must not be negative/,
    );
    await expect(depositCash(settings, { amount: NaN }, fast)).rejects.toThrow(
      /numeric amount in ALL/,
    );
  });
});
