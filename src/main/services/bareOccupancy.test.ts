/**
 * Occupied tables with no ticket and no guest count are the "red table,
 * timer running, print and pay do nothing" report. They must be freed.
 * A covers-only sit, a real bill, and a sitting that was just opened
 * (the ticket has not been written yet) must stay.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listOccupiedTables,
  setTableOccupied,
  getOpenedAt,
  findLatest,
  findMany,
  broadcast,
  withTableLock,
} = vi.hoisted(() => ({
  listOccupiedTables: vi.fn(),
  setTableOccupied: vi.fn(async () => true),
  getOpenedAt: vi.fn(async (): Promise<Date | null> => null),
  findLatest: vi.fn(async (): Promise<unknown> => null),
  findMany: vi.fn(async (): Promise<unknown[]> => []),
  broadcast: vi.fn(),
  withTableLock: vi.fn(
    async (_area: string, _label: string, fn: () => Promise<unknown>) => fn(),
  ),
}));

vi.mock('@db/client', () => ({
  prisma: { covers: { findMany } },
}));
vi.mock('./tableOccupancy', () => ({
  listOccupiedTables,
  setTableOccupied,
  getOpenedAt,
}));
vi.mock('./core', () => ({
  withTableLock,
}));
vi.mock('./tableSession', () => ({
  findLatestTicketLogForCurrentSession: findLatest,
}));
vi.mock('./realtime', () => ({
  broadcastTableStatusChanged: broadcast,
}));

import {
  BARE_OCCUPANCY_GRACE_MS,
  isBareOccupancy,
  releaseBareOccupancy,
  resetBareOccupancyHealForTests,
} from './bareOccupancy';

const NOW = 1_790_000_000_000;

describe('isBareOccupancy', () => {
  it('is the timer-only sitting: open long enough, no ticket, no covers', () => {
    expect(
      isBareOccupancy({
        openedAtMs: NOW - BARE_OCCUPANCY_GRACE_MS,
        now: NOW,
        hasSessionTicket: false,
        hasSessionCovers: false,
      }),
    ).toBe(true);
  });

  it('keeps a sitting that was just opened so send can still land', () => {
    expect(
      isBareOccupancy({
        openedAtMs: NOW - 1_000,
        now: NOW,
        hasSessionTicket: false,
        hasSessionCovers: false,
      }),
    ).toBe(false);
  });

  it('keeps a covers-only sit', () => {
    expect(
      isBareOccupancy({
        openedAtMs: NOW - 60_000,
        now: NOW,
        hasSessionTicket: false,
        hasSessionCovers: true,
      }),
    ).toBe(false);
  });

  it('keeps a sitting that has a ticket', () => {
    expect(
      isBareOccupancy({
        openedAtMs: NOW - 60_000,
        now: NOW,
        hasSessionTicket: true,
        hasSessionCovers: false,
      }),
    ).toBe(false);
  });
});

describe('releaseBareOccupancy', () => {
  beforeEach(() => {
    listOccupiedTables.mockReset();
    setTableOccupied.mockReset();
    setTableOccupied.mockResolvedValue(true);
    getOpenedAt.mockReset();
    getOpenedAt.mockResolvedValue(new Date(NOW - 60_000));
    withTableLock.mockReset();
    withTableLock.mockImplementation(
      async (_area: string, _label: string, fn: () => Promise<unknown>) => fn(),
    );
    findLatest.mockReset();
    findLatest.mockResolvedValue(null);
    findMany.mockReset();
    findMany.mockResolvedValue([]);
    broadcast.mockReset();
    resetBareOccupancyHealForTests();
  });

  it('frees a ghost table and tells the other tills', async () => {
    listOccupiedTables.mockResolvedValue([
      {
        area: 'Veranda',
        label: 'T29',
        openedAt: new Date(NOW - 60_000),
      },
      {
        area: 'Salla',
        label: '1',
        openedAt: new Date(NOW - 120_000),
      },
    ]);

    const closed = await releaseBareOccupancy(NOW);

    expect(closed).toEqual([
      { area: 'Veranda', label: 'T29' },
      { area: 'Salla', label: '1' },
    ]);
    expect(setTableOccupied).toHaveBeenCalledWith('Veranda', 'T29', false);
    expect(setTableOccupied).toHaveBeenCalledWith('Salla', '1', false);
    expect(broadcast).toHaveBeenCalledWith({
      area: 'Veranda',
      label: 'T29',
      open: false,
    });
  });

  it('does not free a table that still has a bill', async () => {
    listOccupiedTables.mockResolvedValue([
      { area: 'Salla', label: 'T5', openedAt: new Date(NOW - 60_000) },
    ]);
    findLatest.mockResolvedValue({ id: 9, itemsJson: [{ name: 'Birra' }] });

    expect(await releaseBareOccupancy(NOW)).toEqual([]);
    expect(setTableOccupied).not.toHaveBeenCalled();
  });

  it('does not free a covers-only sit', async () => {
    listOccupiedTables.mockResolvedValue([
      { area: 'Salla', label: 'T11', openedAt: new Date(NOW - 60_000) },
    ]);
    findMany.mockResolvedValue([
      { createdAt: new Date(NOW - 50_000), covers: 4 },
    ]);

    expect(await releaseBareOccupancy(NOW)).toEqual([]);
    expect(setTableOccupied).not.toHaveBeenCalled();
  });

  it('does not free a table opened a moment ago', async () => {
    listOccupiedTables.mockResolvedValue([
      { area: 'Salla', label: 'T21', openedAt: new Date(NOW - 2_000) },
    ]);

    expect(await releaseBareOccupancy(NOW)).toEqual([]);
    expect(setTableOccupied).not.toHaveBeenCalled();
  });

  it('does not free a sitting that was reopened before the lock was granted', async () => {
    listOccupiedTables.mockResolvedValue([
      { area: 'Salla', label: 'T5', openedAt: new Date(NOW - 60_000) },
    ]);
    getOpenedAt.mockResolvedValue(new Date(NOW - 1_000));

    expect(await releaseBareOccupancy(NOW)).toEqual([]);
    expect(setTableOccupied).not.toHaveBeenCalled();
  });

  it('leaves the table alone when a Send already holds the lock', async () => {
    listOccupiedTables.mockResolvedValue([
      { area: 'Salla', label: 'T8', openedAt: new Date(NOW - 60_000) },
    ]);
    withTableLock.mockRejectedValue(new Error('Table Salla:T8 is busy'));

    expect(await releaseBareOccupancy(NOW)).toEqual([]);
    expect(setTableOccupied).not.toHaveBeenCalled();
  });

  it('leaves the table alone when the ticket lookup fails', async () => {
    listOccupiedTables.mockResolvedValue([
      { area: 'Salla', label: 'T22', openedAt: new Date(NOW - 60_000) },
    ]);
    findLatest.mockRejectedValue(new Error('db busy'));

    expect(await releaseBareOccupancy(NOW)).toEqual([]);
    expect(setTableOccupied).not.toHaveBeenCalled();
  });
});
