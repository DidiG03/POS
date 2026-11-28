import { describe, expect, it } from 'vitest';
import { connectionBar, lineSendState } from './lineSendState';
import { waitingItemsView } from './offlineQueue';

const line = (over: Record<string, unknown> = {}) => ({ id: 'ln-1', ...over });

describe('line sending states', () => {
  it('walks a line from draft to done', () => {
    const idle = { sending: false, kitchen: null };
    expect(lineSendState(line({ staged: true }), idle)).toBe('NOT_SENT');
    expect(
      lineSendState(line({ staged: true }), { ...idle, sending: true }),
    ).toBe('SENDING');
    expect(lineSendState(line(), idle)).toBe('SENT');
    expect(
      lineSendState(line(), {
        sending: false,
        kitchen: { 'ln-1': 'IN_KITCHEN' },
      }),
    ).toBe('IN_KITCHEN');
    expect(
      lineSendState(line(), { sending: false, kitchen: { 'ln-1': 'DONE' } }),
    ).toBe('DONE');
  });

  it('a line sent during a drop is saved, then sending, then sent once', () => {
    // Send pressed offline: the line is flagged pending, still staged.
    const queued = line({ staged: true, pending: true });
    expect(lineSendState(queued, { sending: false })).toBe('QUEUED');
    // The till is back and the queue replays it.
    expect(lineSendState(queued, { sending: true })).toBe('SENDING');
    // The replayed bill replaces the line with the till's own: sent.
    expect(lineSendState(line(), { sending: false })).toBe('SENT');
  });

  it('paid and voided lines keep their own labels', () => {
    expect(lineSendState(line({ paid: true }), { sending: false })).toBeNull();
    expect(
      lineSendState(line({ voided: true, pending: true }), { sending: true }),
    ).toBeNull();
  });
});

describe('connection bar', () => {
  const now = 1_000_000;
  it('offline only when the till looks down, with the count saved here', () => {
    expect(
      connectionBar({
        tillDown: true,
        waiting: 3,
        syncing: false,
        emptiedAt: 0,
        now,
      }),
    ).toEqual({ kind: 'offline', waiting: 3 });
    // Requests succeeding: never offline, even with items still waiting.
    expect(
      connectionBar({
        tillDown: false,
        waiting: 2,
        syncing: true,
        emptiedAt: 0,
        now,
      }).kind,
    ).toBe('sending');
  });
  it('shows a brief "All sent" and then hides', () => {
    expect(
      connectionBar({
        tillDown: false,
        waiting: 0,
        syncing: false,
        emptiedAt: now - 1_000,
        now,
      }).kind,
    ).toBe('allSent');
    expect(
      connectionBar({
        tillDown: false,
        waiting: 0,
        syncing: false,
        emptiedAt: now - 5_000,
        now,
      }).kind,
    ).toBe('hidden');
    expect(
      connectionBar({
        tillDown: false,
        waiting: 0,
        syncing: false,
        emptiedAt: 0,
        now,
      }).kind,
    ).toBe('hidden');
  });
});

describe('the waiting list', () => {
  it('shows tables and lines, oldest first, read-only', () => {
    const v = waitingItemsView([
      {
        id: 'b',
        op: 'tickets.log',
        args: {
          area: 'Salla',
          tableLabel: '4',
          items: [
            { name: 'Tea', qty: 2 },
            { name: 'X', qty: 1, voided: true },
          ],
        },
        createdAt: 20,
        attempts: 2,
        lastError: 'timeout',
      },
      {
        id: 'a',
        op: 'payments.record',
        args: { area: 'Salla', tableLabel: '2' },
        createdAt: 10,
        attempts: 0,
      },
    ]);
    expect(v.map((x) => x.id)).toEqual(['a', 'b']);
    expect(v[1]).toMatchObject({ table: '4', lines: ['2× Tea'], attempts: 2 });
  });
});
