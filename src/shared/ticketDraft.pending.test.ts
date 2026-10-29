/**
 * QA round 4, #2: a Send queued offline lost its item (Fries) off the ticket.
 */
import { describe, expect, it } from 'vitest';
import {
  bindTicketTable,
  carryPendingOntoHydrated,
  emptyTicketDraft,
  mergeLocalStagedOntoHydrated,
  pruneLiveBillsForClosedTables,
  shouldKeepTicketDraft,
  type TicketDraftLine,
} from './ticketDraft';

const fries: TicketDraftLine = {
  sku: 'FRIES',
  name: 'Fries',
  qty: 1,
  unitPrice: 3.5,
  sendKey: 'k-fries',
  pending: true,
};
const beer: TicketDraftLine = {
  sku: 'BEER',
  name: 'Beer',
  qty: 1,
  unitPrice: 4,
  sendKey: 'k-beer',
};

describe('queued Sends stay on the ticket', () => {
  it('a bill reload keeps the pending line until the till has its Send', () => {
    expect(carryPendingOntoHydrated([beer], [beer, fries])).toEqual([
      beer,
      fries,
    ]);
    expect(mergeLocalStagedOntoHydrated([beer], [beer, fries])).toEqual([
      beer,
      fries,
    ]);
    // An all-voided or empty bill from the till does not take it either.
    expect(carryPendingOntoHydrated([], [fries])).toEqual([fries]);
  });

  it('the till copy replaces the pending one once the Send lands', () => {
    const landed = { ...fries, pending: undefined, lineId: 'L9.1' };
    expect(carryPendingOntoHydrated([beer, landed], [beer, fries])).toEqual([
      beer,
      landed,
    ]);
  });

  it('is never pruned with a stale bill', () => {
    const now = 1_000_000;
    const draft = { ...emptyTicketDraft(), lines: [fries], savedAt: 0 };
    expect(shouldKeepTicketDraft(draft, now, { keepLiveBill: false })).toBe(
      true,
    );
    // The till does not list the table as open yet (its open is queued too).
    expect(
      Object.keys(
        pruneLiveBillsForClosedTables({ 'Salla\u0001T3': draft }, []),
      ),
    ).toEqual(['Salla\u0001T3']);
  });

  it('a "table is free" answer keeps only the pending lines', () => {
    const state = {
      ...emptyTicketDraft(),
      lines: [{ ...beer }, fries],
      boundKey: 'Salla\u0001T3',
      drafts: {},
    };
    const next = bindTicketTable(state, 'Salla\u0001T3', 1, {
      keepLiveBill: false,
    });
    expect(next.lines).toEqual([fries]);
  });
});
