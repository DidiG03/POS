import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, alerts, securityLog, sales } = vi.hoisted(() => ({
  store: new Map<string, any>(),
  alerts: [] as any[],
  securityLog: [] as any[],
  sales: { count: 0, total: 0, since: null as Date | null },
}));

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
    user: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === 3 ? { displayName: 'Owner' } : null,
      ),
    },
    payment: {
      aggregate: vi.fn(async ({ where }: any) => {
        sales.since = where.paidAt.gte;
        return {
          _count: { _all: sales.count },
          _sum: { amount: sales.total },
        };
      }),
    },
  },
}));

vi.mock('./adminAlerts', () => ({
  notifyAdminsAndActor: vi.fn(async (input: any) => {
    alerts.push(input);
  }),
}));

vi.mock('./security', () => ({
  logSecurityEvent: vi.fn((event: string, details: any) => {
    securityLog.push({ event, details });
  }),
}));

import {
  FISCAL_TOGGLE_LOG_KEY,
  auditFiscalToggle,
  fiscalEnabledOf,
} from './fiscalToggleAudit';

const on = { fiscal: { enabled: true } };
const off = { fiscal: { enabled: false } };

beforeEach(() => {
  store.clear();
  alerts.length = 0;
  securityLog.length = 0;
  sales.count = 0;
  sales.total = 0;
  sales.since = null;
});

describe('auditFiscalToggle', () => {
  it('does nothing when the switch did not move', async () => {
    expect(
      await auditFiscalToggle({
        wasEnabled: true,
        settings: on,
        source: 'till',
      }),
    ).toBe('none');
    expect(alerts).toHaveLength(0);
    expect(store.has(FISCAL_TOGGLE_LOG_KEY)).toBe(false);
  });

  it('logs and alerts when fiscalization is switched off', async () => {
    const at = new Date('2026-09-28T09:00:00Z');
    expect(
      await auditFiscalToggle({
        wasEnabled: true,
        settings: off,
        actorUserId: 3,
        source: 'lan',
        now: at,
      }),
    ).toBe('off');
    expect(alerts[0].message).toMatch(
      /switched OFF by Owner from a phone\/tablet/,
    );
    expect(alerts[0].message).toMatch(/NOT reported to the tax office/);
    expect(alerts[0]).toMatchObject({ actorUserId: 3, type: 'SECURITY' });
    expect(securityLog[0]).toMatchObject({
      event: 'fiscal_toggled',
      details: { enabled: false, actorUserId: 3, source: 'lan' },
    });
    expect(store.get(FISCAL_TOGGLE_LOG_KEY).entries).toEqual([
      {
        at: at.toISOString(),
        enabled: false,
        actorUserId: 3,
        actorName: 'Owner',
        source: 'lan',
      },
    ]);
  });

  it('reports the sales taken while it was off when switched back on', async () => {
    const offAt = new Date('2026-09-28T09:00:00Z');
    await auditFiscalToggle({
      wasEnabled: true,
      settings: off,
      actorUserId: 3,
      source: 'till',
      now: offAt,
    });
    sales.count = 4;
    sales.total = 5200;
    expect(
      await auditFiscalToggle({
        wasEnabled: false,
        settings: on,
        actorUserId: 3,
        source: 'till',
        now: new Date('2026-09-28T13:00:00Z'),
      }),
    ).toBe('on');
    expect(sales.since?.toISOString()).toBe(offAt.toISOString());
    expect(alerts[1].message).toMatch(
      /switched back ON by Owner from the till/,
    );
    expect(alerts[1].message).toMatch(
      /4 sale\(s\) worth 5200\.00 were taken and not reported/,
    );
    expect(store.get(FISCAL_TOGGLE_LOG_KEY).entries).toHaveLength(2);
  });

  it('reads the flag the way the payment path does', () => {
    expect(fiscalEnabledOf(on)).toBe(true);
    expect(fiscalEnabledOf(off)).toBe(false);
    expect(fiscalEnabledOf({ fiscal: { enabled: 'true' } })).toBe(false);
    expect(fiscalEnabledOf(null)).toBe(false);
  });
});
