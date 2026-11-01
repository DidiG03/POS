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
    },
  },
}));
vi.mock('./adminAlerts', () => ({ notifyAdminsAndActor: notify }));
vi.mock('./security', () => ({ logSecurityEvent: vi.fn() }));

import {
  fiscalSettingsForActor,
  isFiscalEnabledForUser,
  manageWaiterFiscal,
} from './waiterFiscal';

const settings = { fiscal: { enabled: true, provider: 'easypos' } };

beforeEach(() => {
  store.clear();
  users.clear();
  notify.mockClear();
  users.set(7, {
    id: 7,
    displayName: 'Ana',
    active: true,
    pinHash: bcrypt.hashSync('2580', 4),
  });
});

describe('waiter fiskalizimi switch', () => {
  it('is on for everyone by default', async () => {
    expect(await isFiscalEnabledForUser(7)).toBe(true);
    expect(await fiscalSettingsForActor(settings, 7)).toBe(settings);
  });

  it('refuses a wrong PIN and changes nothing', async () => {
    const r = await manageWaiterFiscal({
      userId: 7,
      pin: '1111',
      enabled: false,
      source: 'till',
    });
    expect(r).toEqual({ ok: false, code: 'WRONG_PIN' });
    expect(await isFiscalEnabledForUser(7)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('reads the state with the PIN alone', async () => {
    const r = await manageWaiterFiscal({
      userId: 7,
      pin: '2580',
      source: 'lan',
    });
    expect(r).toEqual({ ok: true, enabled: true, changed: false });
  });

  it('turns fiskalizimi off for one waiter only, and back on', async () => {
    const off = await manageWaiterFiscal({
      userId: 7,
      pin: '2580',
      enabled: false,
      source: 'till',
    });
    expect(off).toEqual({ ok: true, enabled: false, changed: true });
    expect(notify).toHaveBeenCalledTimes(1);

    const forAna = await fiscalSettingsForActor(settings, 7);
    expect((forAna as any).fiscal.enabled).toBe(false);
    expect((forAna as any).fiscal.provider).toBe('easypos');
    expect(settings.fiscal.enabled).toBe(true);
    expect(await fiscalSettingsForActor(settings, 8)).toBe(settings);

    const on = await manageWaiterFiscal({
      userId: 7,
      pin: '2580',
      enabled: true,
      source: 'lan',
    });
    expect(on).toEqual({ ok: true, enabled: true, changed: true });
    expect(await fiscalSettingsForActor(settings, 7)).toBe(settings);
  });

  it('leaves venue-wide fiskalizimi off alone', async () => {
    store.set('fiscal:waiterOff', { userIds: [7] });
    const off = { fiscal: { enabled: false } };
    expect(await fiscalSettingsForActor(off, 7)).toBe(off);
  });

  it('rejects malformed input', async () => {
    expect(
      await manageWaiterFiscal({ userId: 'x', pin: '2580', source: 'till' }),
    ).toEqual({ ok: false, code: 'INVALID' });
    expect(
      await manageWaiterFiscal({
        userId: 7,
        pin: '2580',
        enabled: 'no',
        source: 'till',
      }),
    ).toEqual({ ok: false, code: 'INVALID' });
    expect(
      await manageWaiterFiscal({ userId: 99, pin: '2580', source: 'till' }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
