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
const ticketLogFindMany = vi.fn();
const ticketLogCreate = vi.fn();
const ticketLogUpdate = vi.fn();
const dayShiftFindFirst = vi.fn();
const userFindMany = vi.fn();
const notificationCreate = vi.fn();
const syncStateFindUnique = vi.fn();
const syncStateUpsert = vi.fn();
const ticketRequestUpdateMany = vi.fn();
const kdsOrderFindFirst = vi.fn();
const kdsOrderUpdate = vi.fn();
const coversCreate = vi.fn();
const broadcastTableStatusChanged = vi.fn();
const broadcastTicketsChanged = vi.fn();

vi.mock('./realtime', () => ({
  broadcastTableStatusChanged: (...a: any[]) =>
    broadcastTableStatusChanged(...a),
  broadcastTicketsChanged: (...a: any[]) => broadcastTicketsChanged(...a),
}));

vi.mock('@db/client', () => ({
  prisma: {
    user: {
      findUnique: (...a: any[]) => userFindUnique(...a),
      findMany: (...a: any[]) => userFindMany(...a),
    },
    ticketLog: {
      findFirst: (...a: any[]) => ticketLogFindFirst(...a),
      findMany: (...a: any[]) => ticketLogFindMany(...a),
      create: (...a: any[]) => ticketLogCreate(...a),
      update: (...a: any[]) => ticketLogUpdate(...a),
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
    covers: {
      create: (...a: any[]) => coversCreate(...a),
    },
  },
}));

import {
  isTransferredOutNote,
  parseTransferTag,
  transferTableLocal,
  TRANSFERRED_OUT_TAG_PREFIX,
} from './tableTransfer';

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

  it('parses short MOVED tags without quotes or ids', () => {
    const out = parseTransferTag('[TRANSFER from Main Hall T1]');
    expect(out).toEqual({
      kind: 'MOVED',
      fromUserName: null,
      fromUserId: null,
      fromArea: 'Main Hall',
      fromLabel: 'T1',
      toUserName: null,
      toUserId: null,
      byUserName: null,
      byUserId: null,
    });
  });

  it('parses short MOVED tag with new waiter hint', () => {
    const out = parseTransferTag('[TRANSFER from Main Hall T1 · now Carol]');
    expect(out?.kind).toBe('MOVED');
    expect(out?.fromArea).toBe('Main Hall');
    expect(out?.fromLabel).toBe('T1');
    expect(out?.toUserName).toBe('Carol');
  });

  it('parses short OWNER tag (same table)', () => {
    const out = parseTransferTag('[TRANSFER Bob → Carol]');
    expect(out).toEqual({
      kind: 'OWNER',
      fromUserName: 'Bob',
      fromUserId: null,
      toUserName: 'Carol',
      toUserId: null,
      byUserName: null,
      byUserId: null,
    });
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

describe('isTransferredOutNote', () => {
  it('returns false for empty / non-transfer notes', () => {
    expect(isTransferredOutNote(null)).toBe(false);
    expect(isTransferredOutNote('')).toBe(false);
    expect(isTransferredOutNote('regular waiter note')).toBe(false);
  });

  it('returns false for transfer-IN tags (these are destination rows)', () => {
    expect(
      isTransferredOutNote('[TRANSFER from "Bob"#3 (Sallon T1) by "Alice"#1]'),
    ).toBe(false);
    expect(
      isTransferredOutNote(
        '[TRANSFER owner "Bob"#3 -> "Carol"#7 by "Admin"#1]',
      ),
    ).toBe(false);
  });

  it('returns true when the moved-out prefix is present anywhere in the note', () => {
    expect(
      isTransferredOutNote(
        `${TRANSFERRED_OUT_TAG_PREFIX} -> "Alice"#1 (Bar T3) by "Alice"#1]`,
      ),
    ).toBe(true);
    expect(
      isTransferredOutNote(
        `${TRANSFERRED_OUT_TAG_PREFIX} -> X]\noriginal note text`,
      ),
    ).toBe(true);
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
    ticketLogFindMany.mockResolvedValue([]);
    ticketLogCreate.mockResolvedValue({ id: 100 });
    ticketLogUpdate.mockResolvedValue({});
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
    coversCreate.mockResolvedValue({});
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

  it('tags prior session rows when handing off to another waiter on the same table', async () => {
    dayShiftFindFirst.mockResolvedValue({ id: 42 });
    ticketLogFindMany.mockResolvedValue([{ id: 51, note: 'sent' }]);
    const result = await transferTableLocal({
      fromArea: 'Sallon',
      fromLabel: 'T1',
      toUserId: TARGET.id,
      actorUserId: ACTOR.id,
    });
    expect(result.ok).toBe(true);
    expect(ticketLogUpdate).toHaveBeenCalledTimes(1);
    expect(ticketLogUpdate.mock.calls[0][0].data.note).toMatch(
      /^\[TRANSFER moved-out → /,
    );
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
    expect(coversCreate).toHaveBeenCalledWith({
      data: {
        area: 'Sallon',
        label: 'T2',
        covers: 2,
      },
    });
  });

  it('tags every source-session row with the moved-out marker when only moving the table', async () => {
    // Simulate two ticketLog rows in the current session at the source
    // table. Both should be tagged so analytics skip them and only
    // count the destination row created by the transfer.
    const sessionRows = [
      { id: 51, note: '' },
      { id: 52, note: 'waiter note' },
    ];
    ticketLogFindMany.mockResolvedValue(sessionRows);
    syncStateFindUnique.mockImplementation(({ where }: any) => {
      if (where.key === 'tables:open') {
        return Promise.resolve({ valueJson: { 'Sallon:T1': true } });
      }
      if (where.key === 'tables:openAt') {
        return Promise.resolve({
          valueJson: { 'Sallon:T1': '2026-05-12T13:00:00.000Z' },
        });
      }
      return Promise.resolve(null);
    });

    const result = await transferTableLocal({
      fromArea: 'Sallon',
      fromLabel: 'T1',
      toArea: 'Sallon',
      toLabel: 'T2',
      actorUserId: ACTOR.id,
    });

    expect(result.ok).toBe(true);
    expect(ticketLogUpdate).toHaveBeenCalledTimes(sessionRows.length);
    for (const call of ticketLogUpdate.mock.calls) {
      const arg = call[0];
      expect(arg.data.note).toMatch(/^\[TRANSFER moved-out → /);
      expect(arg.data.note).toContain('Sallon T2');
    }
    // First row had no prior note; second row's note is preserved
    // after the marker (newline-separated).
    expect(ticketLogUpdate.mock.calls[1][0].data.note).toMatch(
      /\nwaiter note$/,
    );
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Sallon',
      label: 'T1',
      open: false,
    });
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Sallon',
      label: 'T2',
      open: true,
    });
    expect(broadcastTicketsChanged).toHaveBeenCalledWith({
      area: 'Sallon',
      tableLabel: 'T2',
      userId: ACTOR.id,
    });
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
