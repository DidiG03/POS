import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, users, notify } = vi.hoisted(() => ({
  store: new Map<string, any>(),
  users: new Map<number, any>(),
  notify: vi.fn(async (_input?: unknown) => undefined),
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: vi.fn(async ({ where }: any) =>
        store.has(where.key)
          ? { key: where.key, valueJson: store.get(where.key) }
          : null,
      ),
      upsert: vi.fn(async ({ where, update }: any) => {
        store.set(where.key, update.valueJson);
        return { key: where.key, valueJson: update.valueJson };
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: any) => {
        const u = users.get(where.id);
        return u && u.active === where.active ? u : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...users.values()].filter(
          (u) => u.role === where.role && u.active === where.active,
        ),
      ),
    },
    notification: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock('./adminAlerts', () => ({ notifyAdminsAndActor: notify }));
vi.mock('./security', () => ({ logSecurityEvent: vi.fn() }));

import { __resetManagerPinForTests } from './managerPin';
import {
  isFiscalEnabledForUser,
  listWaiterFiscalLog,
  manageWaiterFiscal,
  waiterFiscalHold,
} from './waiterFiscal';

const settings = { fiscal: { enabled: true, provider: 'easypos' } };

beforeEach(() => {
  store.clear();
  users.clear();
  notify.mockClear();
  __resetManagerPinForTests();
  users.set(7, {
    id: 7,
    displayName: 'Ana',
    role: 'WAITER',
    active: true,
    pinHash: bcrypt.hashSync('2580', 4),
  });
  users.set(1, {
    id: 1,
    displayName: 'Boss',
    role: 'ADMIN',
    active: true,
    pinHash: bcrypt.hashSync('9147', 4),
  });
});

describe('waiter fiskalizimi switch (QA v0.2.104 #4)', () => {
  it('is on for everyone by default', async () => {
    expect(await isFiscalEnabledForUser(7)).toBe(true);
    expect(await waiterFiscalHold(settings, 7)).toBeUndefined();
  });

  it("refuses the waiter's own PIN: an admin's is needed", async () => {
    const r = await manageWaiterFiscal({
      userId: 7,
      managerPin: '2580',
      enabled: false,
      source: 'till',
    });
    expect(r).toMatchObject({ ok: false, code: 'WRONG_PIN' });
    expect(await isFiscalEnabledForUser(7)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(await listWaiterFiscalLog()).toEqual([]);
  });

  it('locks a phone out after repeated wrong PINs, without checking them', async () => {
    let last: any;
    for (let i = 0; i < 8; i++) {
      last = await manageWaiterFiscal({
        userId: 7,
        managerPin: '0000',
        enabled: false,
        source: 'lan',
        requester: '10.0.0.9',
      });
    }
    expect(last).toMatchObject({ ok: false, code: 'LOCKED' });
    // Even the right PIN now waits out the lock.
    expect(
      await manageWaiterFiscal({
        userId: 7,
        managerPin: '9147',
        enabled: false,
        source: 'lan',
        requester: '10.0.0.9',
      }),
    ).toMatchObject({ ok: false, code: 'LOCKED' });
    expect(await isFiscalEnabledForUser(7)).toBe(true);
  }, 20_000);

  it('turns it off for one waiter with an admin PIN: logged, and their sales held', async () => {
    const off = await manageWaiterFiscal({
      userId: 7,
      managerPin: '9147',
      enabled: false,
      source: 'till',
    });
    expect(off).toEqual({ ok: true, enabled: false, changed: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String((notify.mock.calls[0][0] as any).message)).toMatch(
      /approved by Boss/,
    );
    const [entry] = await listWaiterFiscalLog();
    expect(entry).toMatchObject({
      userId: 7,
      userName: 'Ana',
      enabled: false,
      approvedByAdminId: 1,
      approvedByName: 'Boss',
      source: 'till',
    });

    // Ana's sales are not sent, but they are not dropped either: held.
    const hold = await waiterFiscalHold(settings, 7);
    expect(hold).toMatch(/switched off for this staff member/);
    expect(await waiterFiscalHold(settings, 8)).toBeUndefined();
    // The venue still fiscalises (the settings are not changed).
    expect(settings.fiscal.enabled).toBe(true);

    const on = await manageWaiterFiscal({
      userId: 7,
      managerPin: '9147',
      enabled: true,
      source: 'till',
    });
    expect(on).toEqual({ ok: true, enabled: true, changed: true });
    expect(await waiterFiscalHold(settings, 7)).toBeUndefined();
    expect(await listWaiterFiscalLog()).toHaveLength(2);
  });

  it('holds nothing when the venue does not fiscalise at all', async () => {
    store.set('fiscal:waiterOff', { userIds: [7] });
    expect(
      await waiterFiscalHold({ fiscal: { enabled: false } }, 7),
    ).toBeUndefined();
  });

  it('rejects malformed input', async () => {
    expect(
      await manageWaiterFiscal({
        userId: 'x',
        managerPin: '9147',
        source: 'till',
      }),
    ).toEqual({ ok: false, code: 'INVALID' });
    expect(
      await manageWaiterFiscal({
        userId: 7,
        managerPin: '9147',
        enabled: 'no',
        source: 'till',
      }),
    ).toEqual({ ok: false, code: 'INVALID' });
    expect(
      await manageWaiterFiscal({
        userId: 99,
        managerPin: '9147',
        source: 'till',
      }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
