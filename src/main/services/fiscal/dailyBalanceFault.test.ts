/**
 * CIS fault 123: a cash invoice sent before today's opening float was
 * declared. easyPos keeps the docId unfinished; once the float is declared,
 * the same docId sent again completes it (seen on the sandbox, 2026-10-25).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';

const { store } = vi.hoisted(() => ({ store: new Map<string, any>() }));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: vi.fn(async ({ where }: any) =>
        store.has(where.key)
          ? { key: where.key, valueJson: store.get(where.key) }
          : null,
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        store.set(
          where.key,
          store.has(where.key) ? update.valueJson : create.valueJson,
        );
        return {};
      }),
    },
  },
}));

vi.mock('./transport', () => ({
  easyPosFetch: (url: string, init: unknown) =>
    (globalThis as any).fetch(url, init),
  warmEasyPosConnection: async () => undefined,
}));

import { createEasyPosSale } from './easypos';
import { classifyFiscalAttempt } from './classify';
import { fiscalDayKey } from './clock';

const settings = {
  fiscal: {
    enabled: true,
    provider: 'easypos',
    baseUrl: 'https://api.dev.easypos.al/fiscalisation-service/v1',
    authToken: 'token',
    integrationApp: 'generic',
    defaultOperatorId: 'gh537ez280',
    openingFloat: 0,
  },
} as unknown as SettingsDTO;

const draft = {
  docId: 'inv-cash-00001',
  operatorCode: 'gh537ez280',
  articles: [
    {
      articleId: 'PROD001',
      vatCode: 'B',
      name: 'Kafe',
      soldIn: 'XPP',
      price: 100,
      units: 2,
    },
  ],
  payment: [{ type: 'CASH', amount: 200 }],
};

const fault123 = {
  orderId: 'inv-cash-00001',
  iic: 'IIC-1',
  error: {
    cisError: {
      faultString:
        'Nuk është bërë raportimi i balancës ditore dhe fatura ka metoda pagese CASH!',
      faultCode: '123',
      faultEnv: 'env:SERVER',
    },
  },
};

function reply(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => store.clear());

describe('fault 123 (opening float not declared)', () => {
  it('is not an easyPos outage to poll, but a missing float', () => {
    const c = classifyFiscalAttempt({ httpStatus: 200, data: fault123 });
    expect(c).toMatchObject({
      dailyBalanceMissing: true,
      outcome: 'not-registered',
      mustCheckStatus: false,
    });
  });

  it('declares the float and completes the same invoice', async () => {
    let registers = 0;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const route = url.split('/v1')[1];
        calls.push(route);
        if (route === '/balance/initiate') return reply({ fcdc: 'FCDC-1' });
        if (route === '/invoice/register') {
          registers += 1;
          return reply(
            registers === 1
              ? fault123
              : { orderId: draft.docId, iic: 'IIC-1', fic: 'FIC-1' },
          );
        }
        return reply(fault123);
      }),
    );

    const r = await createEasyPosSale(settings, draft as any);
    expect(r).toMatchObject({ nslf: 'IIC-1', nivf: 'FIC-1' });
    expect(calls).toEqual([
      '/invoice/register',
      '/balance/initiate',
      '/invoice/register',
    ]);
    vi.unstubAllGlobals();
  });

  it('declares again when a stale local record says it was declared', async () => {
    store.set(`fiscal:balance:initiate:dev:gh537ez280:${fiscalDayKey()}`, {
      operation: 'initiate',
      docId: 'bal-old-00001',
      state: 'COMPLETE',
      fcdc: 'OLD',
    });
    let registers = 0;
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any) => {
        const route = url.split('/v1')[1];
        if (route === '/balance/initiate') {
          bodies.push(JSON.parse(init.body));
          return reply({ fcdc: 'FCDC-2' });
        }
        registers += 1;
        return reply(
          registers === 1
            ? fault123
            : { orderId: draft.docId, iic: 'IIC-1', fic: 'FIC-2' },
        );
      }),
    );

    const r = await createEasyPosSale(settings, draft as any);
    expect(r.nivf).toBe('FIC-2');
    expect(bodies[0].docId).not.toBe('bal-old-00001');
    vi.unstubAllGlobals();
  });

  it('queues the invoice when the float cannot be declared', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/balance/initiate')
          ? { ok: false, status: 400, json: async () => ({ message: 'no' }) }
          : reply(fault123),
      ),
    );
    await expect(
      createEasyPosSale(settings, draft as any),
    ).rejects.toMatchObject({
      fiscalOutcome: 'not-registered',
      fiscalRetryable: true,
    });
    vi.unstubAllGlobals();
  });
});
