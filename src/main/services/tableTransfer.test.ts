/**
 * Pure-logic tests for the transfer-tag parser. The full transferTableLocal()
 * flow touches Prisma and is exercised end-to-end via integration smoke runs;
 * here we only lock in the regex contract that the admin UI depends on.
 *
 * Run with:  pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stubs for every Prisma surface that transferTableLocal touches. Each test
// resets the implementations to sensible defaults so a single test can
// override only what it cares about.
const userFindUnique = vi.fn();
const ticketLogFindFirst = vi.fn();
const ticketLogCreate = vi.fn();
const dayShiftFindFirst = vi.fn();
const userFindMany = vi.fn();
const notificationCreate = vi.fn();
const syncStateFindUnique = vi.fn();
const syncStateUpsert = vi.fn();
const ticketRequestUpdateMany = vi.fn();
const kdsOrderFindFirst = vi.fn();
const kdsOrderUpdate = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    user: {
      findUnique: (...a: any[]) => userFindUnique(...a),
      findMany: (...a: any[]) => userFindMany(...a),
    },
    ticketLog: {
      findFirst: (...a: any[]) => ticketLogFindFirst(...a),
      create: (...a: any[]) => ticketLogCreate(...a),
    },
    dayShift: { findFirst: (...a: any[]) => dayShiftFindFirst(...a) },
    notification: { create: (...a: any[]) => notificationCreate(...a) },
    syncState: {
      findUnique: (...a: any[]) => syncStateFindUnique(...a),
      upsert: (...a: any[]) => syncStateUpsert(...a),
    },
    ticketRequest: {
      updateMany: (...a: any[]) => ticketRequestUpdateMany(...a),
    },
    kdsOrder: {
      findFirst: (...a: any[]) => kdsOrderFindFirst(...a),
      update: (...a: any[]) => kdsOrderUpdate(...a),
    },
  },
}));

import { parseTransferTag, transferTableLocal } from './tableTransfer';

describe('parseTransferTag', () => {
  it('returns null for empty / non-transfer notes', () => {
    expect(parseTransferTag(null)).toBeNull();
    expect(parseTransferTag('')).toBeNull();
    expect(parseTransferTag('regular waiter note, no tag')).toBeNull();
  });

  it('parses a structured MOVED tag with from-table and actor', () => {
    const note =
      '[TRANSFER from "Bob"#3 (Sallon T1) by "Alice"#1]\noriginal note text';
    const out = parseTransferTag(note);
    expect(out).toEqual({
      kind: 'MOVED',
      fromUserName: 'Bob',
      fromUserId: 3,
      fromArea: 'Sallon',
      fromLabel: 'T1',
      byUserName: 'Alice',
      byUserId: 1,
    });
  });

  it('parses a structured MOVED tag with multi-word area', () => {
    const out = parseTransferTag(
      '[TRANSFER from "Bob"#3 (Main Hall T12) by "Alice"#1]',
    );
    expect(out?.fromArea).toBe('Main Hall');
    expect(out?.fromLabel).toBe('T12');
  });

  it('parses a structured OWNER tag', () => {
    const out = parseTransferTag(
      '[TRANSFER owner "Bob"#3 -> "Carol"#7 by "Admin"#1]',
    );
    expect(out).toEqual({
      kind: 'OWNER',
      fromUserName: 'Bob',
      fromUserId: 3,
      toUserName: 'Carol',
      toUserId: 7,
      byUserName: 'Admin',
      byUserId: 1,
    });
  });

  it('handles escaped quotes in display names', () => {
    const out = parseTransferTag(
      '[TRANSFER from "Bo\\"b"#3 (Bar T1) by "Al\\"ice"#1]',
    );
    expect(out?.fromUserName).toBe('Bo"b');
    expect(out?.byUserName).toBe('Al"ice');
  });

  it('falls back to the legacy MOVED format', () => {
    const out = parseTransferTag('[TRANSFER] Sallon T1 → Bar T2');
    expect(out).toMatchObject({
      kind: 'MOVED',
      fromArea: 'Sallon',
      fromLabel: 'T1',
      fromUserName: null,
      fromUserId: null,
    });
  });

  it('falls back to the legacy MOVED+owner format', () => {
    const out = parseTransferTag(
      '[TRANSFER] Sallon T1 → Bar T2 (owner → Carol)',
    );
    expect(out?.kind).toBe('MOVED');
    expect(out?.toUserName).toBe('Carol');
  });

  it('falls back to the legacy OWNER format', () => {
    const out = parseTransferTag('[TRANSFER] owner → Carol');
    expect(out?.kind).toBe('OWNER');
    expect(out?.toUserName).toBe('Carol');
  });

  it('parses legacy MOVED notes with multi-word area names', () => {
    const out = parseTransferTag('[TRANSFER] Main Hall T4 -> Main Hall T6');
    expect(out).toMatchObject({
      kind: 'MOVED',
      fromArea: 'Main Hall',
      fromLabel: 'T4',
      fromUserName: null,
    });
  });
});

describe('transferTableLocal — on-shift requirement', () => {
  const ACTOR = { id: 1, role: 'WAITER', active: true, displayName: 'Alice' };
  const FROM_OWNER = ACTOR; // current ticket belongs to the actor
  const TARGET = { id: 7, role: 'WAITER', active: true, displayName: 'Carol' };
  const LAST_TICKET = {
    id: 99,
    userId: ACTOR.id,
    area: 'Sallon',
    tableLabel: 'T1',
    note: '',
    itemsJson: [],
    covers: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: target exists, not on shift. Tests that need an open shift
    // override `dayShiftFindFirst` explicitly.
    userFindUnique.mockImplementation(({ where }: any) => {
      if (where.id === ACTOR.id) return Promise.resolve(ACTOR);
      if (where.id === TARGET.id) return Promise.resolve(TARGET);
      if (where.id === FROM_OWNER.id) return Promise.resolve(FROM_OWNER);
      return Promise.resolve(null);
    });
    ticketLogFindFirst.mockResolvedValue(LAST_TICKET);
    ticketLogCreate.mockResolvedValue({ id: 100 });
    dayShiftFindFirst.mockResolvedValue(null); // nobody on shift by default
    userFindMany.mockResolvedValue([]); // no admins
    notificationCreate.mockResolvedValue({});
    // Open-tables map: source is open, destination unused.
    syncStateFindUnique.mockResolvedValue({
      valueJson: { 'Sallon:T1': true },
    });
    syncStateUpsert.mockResolvedValue({});
    ticketRequestUpdateMany.mockResolvedValue({});
    kdsOrderFindFirst.mockResolvedValue(null);
  });

  it('rejects ownership transfer when the target waiter is not on shift', async () => {
    const result = await transferTableLocal({
      fromArea: 'Sallon',
      fromLabel: 'T1',
      toUserId: TARGET.id,
      actorUserId: ACTOR.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/not on shift/i);
    }
    expect(ticketLogCreate).not.toHaveBeenCalled();
    expect(dayShiftFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          openedById: TARGET.id,
          closedAt: null,
        }),
      }),
    );
  });

  it('allows ownership transfer when the target waiter has an open shift', async () => {
    dayShiftFindFirst.mockResolvedValue({ id: 42 });
    const result = await transferTableLocal({
      fromArea: 'Sallon',
      fromLabel: 'T1',
      toUserId: TARGET.id,
      actorUserId: ACTOR.id,
    });
    expect(result.ok).toBe(true);
    expect(ticketLogCreate).toHaveBeenCalledTimes(1);
    // The new ticket-log row should be assigned to the target user.
    const createCall = ticketLogCreate.mock.calls[0][0];
    expect(createCall.data.userId).toBe(TARGET.id);
  });

  it('does NOT require an open shift when only moving the table to a new label (no owner change)', async () => {
    const result = await transferTableLocal({
      fromArea: 'Sallon',
      fromLabel: 'T1',
      toArea: 'Sallon',
      toLabel: 'T2',
      actorUserId: ACTOR.id,
    });
    expect(result.ok).toBe(true);
    // Without `toUserId` the on-shift check shouldn't run at all.
    expect(dayShiftFindFirst).not.toHaveBeenCalled();
  });

  it('admins are also bound by the on-shift requirement', async () => {
    const ADMIN = { id: 2, role: 'ADMIN', active: true, displayName: 'Boss' };
    userFindUnique.mockImplementation(({ where }: any) => {
      if (where.id === ADMIN.id) return Promise.resolve(ADMIN);
      if (where.id === TARGET.id) return Promise.resolve(TARGET);
      if (where.id === FROM_OWNER.id) return Promise.resolve(FROM_OWNER);
      return Promise.resolve(null);
    });
    const result = await transferTableLocal({
      fromArea: 'Sallon',
      fromLabel: 'T1',
      toUserId: TARGET.id,
      actorUserId: ADMIN.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/not on shift/i);
    }
  });
});
