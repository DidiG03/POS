import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sitting: null as any,
  stale: false,
  applied: [] as Array<{ open: boolean }>,
  events: [] as any[],
  security: [] as any[],
}));

vi.mock('./core', () => ({
  withTableLock: (_a: string, _l: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./tableOpen', () => ({
  applyTableOpenState: async (_a: string, _l: string, open: boolean) => {
    h.applied.push({ open });
    return true;
  },
}));
vi.mock('./tableOccupancy', () => ({
  occupancyIntentIsStale: async () => h.stale,
}));
vi.mock('./tableSession', () => ({
  findLatestTicketLogForCurrentSession: async () => h.sitting,
}));
vi.mock('./billEvents', async () => {
  const actual = await vi.importActual<any>('./billEvents');
  return {
    ...actual,
    recordBillEvent: async (e: any) => {
      h.events.push(e);
      return true;
    },
  };
});
vi.mock('./security', () => ({
  logSecurityEvent: (event: string, details: any) =>
    h.security.push({ event, details }),
}));

import {
  TABLE_HAS_UNPAID,
  setTableOpenGuarded,
  unpaidBillLines,
} from './tableClose';

const waiter = { userId: 2, role: 'WAITER' };
const admin = { userId: 1, role: 'ADMIN' };

function close(actor: { userId: number; role: string } | null) {
  return setTableOpenGuarded({
    area: 'Main',
    label: 'T1',
    open: false,
    actor,
    source: 'phone',
  });
}

beforeEach(() => {
  h.sitting = null;
  h.stale = false;
  h.applied = [];
  h.events = [];
  h.security = [];
});

describe('unpaidBillLines', () => {
  it('keeps only lines still owed', () => {
    expect(
      unpaidBillLines([
        { name: 'A', qty: 1, unitPrice: 2 },
        { name: 'B', qty: 1, unitPrice: 2, paid: true },
        { name: 'C', qty: 1, unitPrice: 2, voided: true },
        { name: 'D', qty: 0, unitPrice: 2 },
      ]).map((l) => l.name),
    ).toEqual(['A']);
  });
});

describe('setTableOpenGuarded', () => {
  it('refuses a waiter closing a table with unpaid items', async () => {
    h.sitting = {
      userId: 2,
      itemsJson: [{ name: 'Beer', qty: 2, unitPrice: 3 }],
    };
    const r = await close(waiter);
    expect(r).toMatchObject({
      ok: false,
      code: TABLE_HAS_UNPAID,
      permanent: true,
    });
    expect(h.applied).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.security[0].event).toBe('table_close_refused_unpaid');
  });

  it('refuses a close with no session at all', async () => {
    h.sitting = {
      userId: 2,
      itemsJson: [{ name: 'Beer', qty: 1, unitPrice: 3 }],
    };
    expect(await close(null)).toMatchObject({ code: TABLE_HAS_UNPAID });
  });

  it('lets an admin close it and records what was left unpaid', async () => {
    h.sitting = {
      userId: 2,
      itemsJson: [
        { name: 'Beer', qty: 2, unitPrice: 3 },
        { name: 'Water', qty: 1, unitPrice: 1, paid: true },
      ],
    };
    expect(await close(admin)).toBe(true);
    expect(h.applied).toEqual([{ open: false }]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: 'TABLE_CLOSED_UNPAID',
      actorUserId: 1,
      amount: 6,
      details: { tableOwnerId: 2 },
    });
    expect(h.events[0].details.lines).toHaveLength(1);
  });

  it('closes a table whose bill is settled, with no record', async () => {
    h.sitting = {
      userId: 2,
      itemsJson: [
        { name: 'Beer', qty: 1, unitPrice: 3, paid: true },
        { name: 'Soup', qty: 1, unitPrice: 5, voided: true },
      ],
    };
    expect(await close(waiter)).toBe(true);
    expect(h.applied).toEqual([{ open: false }]);
    expect(h.events).toEqual([]);
  });

  it('closes a table that is already free (after a payment)', async () => {
    h.sitting = null;
    expect(await close(waiter)).toBe(true);
    expect(h.applied).toEqual([{ open: false }]);
  });

  it('does not check a stale close, which changes nothing', async () => {
    h.stale = true;
    h.sitting = {
      userId: 2,
      itemsJson: [{ name: 'Beer', qty: 1, unitPrice: 3 }],
    };
    expect(await close(waiter)).toBe(true);
    expect(h.security).toEqual([]);
  });

  it('never checks an open', async () => {
    h.sitting = {
      userId: 2,
      itemsJson: [{ name: 'Beer', qty: 1, unitPrice: 3 }],
    };
    const r = await setTableOpenGuarded({
      area: 'Main',
      label: 'T1',
      open: true,
      actor: waiter,
      source: 'till',
    });
    expect(r).toBe(true);
    expect(h.applied).toEqual([{ open: true }]);
  });
});
