import { describe, expect, it } from 'vitest';
import {
  dropOptimisticOpenState,
  mergeOpenTables,
  OFFLINE_OPTIMISTIC_OPEN_TTL_MS,
  OPTIMISTIC_OPEN_TTL_MS,
  optimisticOpenTtlMs,
} from './openTableMerge';

const keyOf = (area: string, label: string) => `${area}:${label}`;
const NOW = 1_700_000_000_000;

describe('mergeOpenTables', () => {
  it('takes the host list when there is nothing optimistic', () => {
    expect(
      mergeOpenTables({
        incoming: [{ area: 'Salla', label: 'T6' }],
        openMap: {},
        lastSetAt: {},
        keyOf,
        now: NOW,
      }),
    ).toEqual({ 'Salla:T6': true });
  });

  it('keeps a just-tapped close that the host has not caught up with', () => {
    expect(
      mergeOpenTables({
        incoming: [{ area: 'Salla', label: 'T6' }],
        openMap: { 'Salla:T6': false },
        lastSetAt: { 'Salla:T6': NOW - 1_000 },
        keyOf,
        now: NOW,
      }),
    ).toEqual({});
  });

  it('lets the host win once the optimistic window passes', () => {
    expect(
      mergeOpenTables({
        incoming: [{ area: 'Salla', label: 'T6' }],
        openMap: { 'Salla:T6': false },
        lastSetAt: { 'Salla:T6': NOW - OPTIMISTIC_OPEN_TTL_MS - 1 },
        keyOf,
        now: NOW,
      }),
    ).toEqual({ 'Salla:T6': true });
  });

  it('holds an optimistic close longer while offline, but not forever', () => {
    const stale = {
      incoming: [{ area: 'Salla', label: 'T6' }],
      openMap: { 'Salla:T6': false },
      keyOf,
      now: NOW,
      offline: true,
    };
    expect(
      mergeOpenTables({
        ...stale,
        lastSetAt: { 'Salla:T6': NOW - OPTIMISTIC_OPEN_TTL_MS - 1 },
      }),
    ).toEqual({});
    // Regression: this used to be preserved indefinitely, which hid a live
    // bill on an occupied table for the rest of the shift.
    expect(
      mergeOpenTables({
        ...stale,
        lastSetAt: { 'Salla:T6': NOW - OFFLINE_OPTIMISTIC_OPEN_TTL_MS - 1 },
      }),
    ).toEqual({ 'Salla:T6': true });
  });

  it('ignores flags with no write timestamp', () => {
    expect(
      mergeOpenTables({
        incoming: [],
        openMap: { 'Salla:T6': true },
        lastSetAt: {},
        keyOf,
        now: NOW,
      }),
    ).toEqual({});
  });

  it('keeps a recent optimistic open the host has not seen yet', () => {
    expect(
      mergeOpenTables({
        incoming: [],
        openMap: { 'Salla:T9': true },
        lastSetAt: { 'Salla:T9': NOW - 500 },
        keyOf,
        now: NOW,
      }),
    ).toEqual({ 'Salla:T9': true });
  });
});

describe('optimisticOpenTtlMs', () => {
  it('is longer offline', () => {
    expect(optimisticOpenTtlMs(false)).toBe(OPTIMISTIC_OPEN_TTL_MS);
    expect(optimisticOpenTtlMs(true)).toBe(OFFLINE_OPTIMISTIC_OPEN_TTL_MS);
  });
});

describe('dropOptimisticOpenState', () => {
  it('clears write timestamps so a restart trusts the host', () => {
    const next = dropOptimisticOpenState({
      openMap: { 'Salla:T6': false },
      lastSetAt: { 'Salla:T6': NOW },
    });
    expect(next.lastSetAt).toEqual({});
    expect(next.openMap).toEqual({ 'Salla:T6': false });
  });
});
