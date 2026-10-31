/**
 * QA round 6, #3 and #5: the till refuses a bad menu price itself, whatever
 * the Admin form let through, before anything is written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const update = vi.fn();
vi.mock('@db/client', () => ({
  prisma: {
    category: { findUnique: vi.fn(async () => ({ kdsStation: 'KITCHEN' })) },
    menuItem: {
      create: (...a: any[]) => create(...a),
      update: (...a: any[]) => update(...a),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
  },
}));
vi.mock('./license', () => ({ storePlanBlocksTables: () => false }));
vi.mock('./menuStock', () => ({
  applyDailyStockPatch: vi.fn(),
  applyOnHandStockPatch: vi.fn(),
  expireStaleMenuStock: vi.fn(),
  localCalendarDateKey: () => '2026-10-31',
}));

import { createMenuItemFromInput, updateMenuItemFromInput } from './menuAdmin';

describe('menu prices the till refuses', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [3.333, /2 decimals/],
    [0, /more than 0/],
    [1_000_000_000_000, /at most/],
  ])('create at %s', async (price, message) => {
    await expect(
      createMenuItemFromInput({ categoryId: 1, name: 'Kafe', price }),
    ).rejects.toThrow(message);
    expect(create).not.toHaveBeenCalled();
  });

  it('update to a bad price is refused; an update without a price is not', async () => {
    await expect(
      updateMenuItemFromInput({ id: 5, price: 3.333 }),
    ).rejects.toMatchObject({ code: 'INVALID_MENU_PRICE' });
    expect(update).not.toHaveBeenCalled();
    // Renaming an item keeps its saved price: no price check (it then
    // fails on the missing item in this mock, not on the price).
    await expect(updateMenuItemFromInput({ id: 5, name: 'X' })).rejects.toThrow(
      'Menu item not found',
    );
  });
});
