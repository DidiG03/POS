import { describe, expect, it } from 'vitest';
import {
  applyLocalPaidOntoHydrated,
  bindTicketTable,
  emptyTicketDraft,
  isTicketDraftFresh,
  mergeLocalStagedOntoHydrated,
  pruneStaleTicketDrafts,
  restoreMissingServerLines,
  revivePersistedTicketDraft,
  shouldKeepLocalDraftOnEmptyLog,
  shouldMergeLocalStagedOntoHydrated,
  TICKET_DRAFT_TTL_MS,
  type TicketDraft,
  type TicketDraftLine,
} from './ticketDraft';

describe('ticketDraft', () => {
  it('saves the current table and restores the next table draft', () => {
    const t1 = {
      ...emptyTicketDraft('course'),
      boundKey: 'A:1',
      drafts: {} as Record<string, TicketDraft>,
      lines: [{ name: 'Soup', qty: 1, unitPrice: 5, staged: true }],
      orderNote: 'no onion',
    };
    const switched = bindTicketTable(t1, 'A:2');
    expect(switched.boundKey).toBe('A:2');
    expect(switched.lines).toEqual([]);
    expect(switched.addMode).toBe('default');
    expect(switched.drafts['A:1']?.lines[0]?.name).toBe('Soup');
    expect(switched.drafts['A:1']?.addMode).toBe('course');

    const back = bindTicketTable(switched, 'A:1');
    expect(back.addMode).toBe('course');
    expect(back.lines[0]?.name).toBe('Soup');
    expect(back.orderNote).toBe('no onion');
  });

  it('restores a parked draft only within 10 seconds', () => {
    const t0 = 1_000_000;
    const parked = bindTicketTable(
      {
        ...emptyTicketDraft(),
        boundKey: 'A:1',
        drafts: {},
        lines: [{ name: 'Soup', qty: 1, unitPrice: 5, staged: true }],
        orderNote: '',
      },
      'A:2',
      t0,
    );
    const soon = bindTicketTable(parked, 'A:1', t0 + TICKET_DRAFT_TTL_MS - 1);
    expect(soon.lines[0]?.name).toBe('Soup');
    const later = bindTicketTable(parked, 'A:1', t0 + TICKET_DRAFT_TTL_MS);
    expect(later.lines).toEqual([]);
  });

  it('treats drafts without savedAt as stale', () => {
    expect(isTicketDraftFresh(undefined, 50_000)).toBe(false);
    expect(isTicketDraftFresh(0, 50_000)).toBe(false);
    expect(isTicketDraftFresh(40_001, 50_000)).toBe(true);
    expect(
      pruneStaleTicketDrafts(
        {
          fresh: { ...emptyTicketDraft(), savedAt: 45_000, lines: [] },
          old: { ...emptyTicketDraft(), savedAt: 1, lines: [] },
        },
        50_000,
      ),
    ).toEqual({
      fresh: { ...emptyTicketDraft(), savedAt: 45_000, lines: [] },
    });
  });

  it('clears a persisted cart after the grace window', () => {
    const stale = revivePersistedTicketDraft(
      {
        ...emptyTicketDraft(),
        lines: [{ name: 'Soup', qty: 1, unitPrice: 5, staged: true }],
        savedAt: 1,
        drafts: {
          'A:1': {
            ...emptyTicketDraft(),
            lines: [{ name: 'Cola', qty: 1, unitPrice: 2 }],
            savedAt: 1,
          },
        },
      },
      50_000,
    );
    expect(stale.lines).toEqual([]);
    expect(stale.drafts).toEqual({});

    const fresh = revivePersistedTicketDraft(
      {
        ...emptyTicketDraft(),
        lines: [{ name: 'Soup', qty: 1, unitPrice: 5, staged: true }],
        savedAt: 45_000,
        drafts: {},
      },
      50_000,
    );
    expect(fresh.lines[0]?.name).toBe('Soup');
  });

  it('keeps a local draft when the server log is empty', () => {
    expect(
      shouldKeepLocalDraftOnEmptyLog([
        { name: 'Cola', qty: 1, unitPrice: 2, staged: true },
      ]),
    ).toBe(true);
    expect(shouldKeepLocalDraftOnEmptyLog([])).toBe(false);
  });

  it('appends unsent local lines and keeps a higher local qty', () => {
    const hydrated = [
      {
        name: 'Soup',
        sku: 'soup',
        qty: 1,
        unitPrice: 5,
        staged: false,
        courseId: 'c1',
      },
    ];
    const local = [
      {
        name: 'Soup',
        sku: 'soup',
        qty: 2,
        unitPrice: 5,
        staged: true,
        courseId: 'c1',
      },
      {
        name: 'Steak',
        sku: 'steak',
        qty: 1,
        unitPrice: 20,
        staged: true,
        courseId: 'c2',
      },
    ];
    const merged = mergeLocalStagedOntoHydrated(hydrated, local);
    expect(merged.map((l) => [l.name, l.qty, l.staged])).toEqual([
      ['Soup', 2, true],
      ['Steak', 1, true],
    ]);
  });

  it('does not keep local staged lines on a fully voided ticket', () => {
    expect(
      shouldMergeLocalStagedOntoHydrated([
        { name: 'Soup', qty: 1, unitPrice: 5, voided: true },
      ]),
    ).toBe(false);
  });

  it('keeps a locally paid seat line paid after hydrate', () => {
    const next = applyLocalPaidOntoHydrated(
      [
        {
          name: 'Steak',
          sku: 'steak',
          qty: 1,
          unitPrice: 20,
          seatId: 's1',
        },
      ],
      [
        {
          name: 'Steak',
          sku: 'steak',
          qty: 1,
          unitPrice: 20,
          seatId: 's1',
          paid: true,
        },
      ],
    );
    expect(next[0]?.paid).toBe(true);
  });
});

describe('restoreMissingServerLines', () => {
  const fired = (
    name: string,
    unitPrice: number,
    extra: Partial<TicketDraftLine> = {},
  ): TicketDraftLine => ({
    sku: name,
    name,
    qty: 1,
    unitPrice,
    station: 'KITCHEN',
    fired: true,
    ...extra,
  });

  it('puts back a whole bill that the local cart lost', () => {
    const server = [fired('Antipastë', 800), fired('Djathë', 300)];
    const outgoing = [fired('Sallatë cezar', 600)];
    const next = restoreMissingServerLines(outgoing, server);
    expect(next.map((l) => l.name)).toEqual([
      'Antipastë',
      'Djathë',
      'Sallatë cezar',
    ]);
  });

  it('leaves an in-sync send untouched', () => {
    const server = [fired('Antipastë', 800)];
    const outgoing = [fired('Antipastë', 800), fired('Sallatë cezar', 600)];
    expect(restoreMissingServerLines(outgoing, server)).toBe(outgoing);
  });

  it('never resurrects voided or paid lines', () => {
    const server = [
      fired('Voided', 800, { voided: true }),
      fired('Paid', 300, { paid: true }),
    ];
    expect(restoreMissingServerLines([], server)).toEqual([]);
  });

  it('ignores server lines that were never fired', () => {
    const server = [{ sku: 'Draft', name: 'Draft', qty: 1, unitPrice: 5 }];
    expect(restoreMissingServerLines([], server)).toEqual([]);
  });

  it('keeps the same item on two seats apart', () => {
    const server = [
      fired('Steak', 20, { seatId: 's1' }),
      fired('Steak', 20, { seatId: 's2' }),
    ];
    const outgoing = [fired('Steak', 20, { seatId: 's1' })];
    const next = restoreMissingServerLines(outgoing, server);
    expect(next.map((l) => l.seatId)).toEqual(['s2', 's1']);
  });
});
