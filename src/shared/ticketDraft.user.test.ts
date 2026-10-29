/**
 * QA round 4, #3: on a shared phone the table owner signed in and saw a
 * colleague's requested items as their own unsent lines (Ticket (3), 11.55,
 * Send enabled; Q30 showed 37.00 against 31.50 on the till).
 */
import { describe, expect, it } from 'vitest';
import {
  emptyTicketDraft,
  switchTicketDraftUser,
  type TicketDraft,
} from './ticketDraft';

const now = 5_000_000;
const requested = {
  sku: 'COLA',
  name: 'Cola',
  qty: 2,
  unitPrice: 2.5,
  staged: true,
};

function phone(userId: number | null, lines = [requested]) {
  return {
    ...emptyTicketDraft(),
    lines,
    savedAt: now,
    boundKey: 'Salla\u0001Q30' as string | null,
    drafts: {} as Record<string, TicketDraft>,
    draftUserId: userId,
    userDrafts: {} as Record<string, Record<string, TicketDraft>>,
  };
}

describe('switchTicketDraftUser', () => {
  it("the owner never inherits the requester's lines", () => {
    // Ben (8) asked to add 2 Cola to Ana's (7) table, then signed out.
    const ana = switchTicketDraftUser(phone(8), 7, now);
    expect(ana.lines).toEqual([]);
    expect(ana.boundKey).toBeNull();
    expect(ana.drafts).toEqual({});
    expect(ana.draftUserId).toBe(7);
  });

  it("gives the requester's cart back when they sign in again", () => {
    const ana = switchTicketDraftUser(phone(8), 7, now);
    const ben = switchTicketDraftUser(ana, 8, now + 1000);
    expect(ben.drafts['Salla\u0001Q30']?.lines).toEqual([requested]);
    expect(ben.userDrafts['8']).toBeUndefined();
  });

  it('is a no-op for the same waiter, a sign-out, or a cart with no owner yet', () => {
    const state = phone(7);
    expect(switchTicketDraftUser(state, 7, now)).toBe(state);
    expect(switchTicketDraftUser(state, null, now)).toBe(state);
    const legacy = switchTicketDraftUser(phone(null), 7, now);
    expect(legacy.lines).toEqual([requested]);
    expect(legacy.draftUserId).toBe(7);
  });
});
