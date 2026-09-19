import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./license', () => ({ storePlanBlocksTables: () => false }));
vi.mock('./menuStock', () => ({
  applyDailyStockPatch: vi.fn(),
  applyOnHandStockPatch: vi.fn(),
  expireStaleMenuStock: vi.fn(),
  localCalendarDateKey: () => '2026-09-18',
}));
import { mapMenuCategoryForClient } from './menuAdmin';

const cat = {
  id: 1,
  name: 'Food',
  sortOrder: 0,
  active: true,
  color: '#111',
  kdsStation: 'KITCHEN',
  items: [
    {
      id: 10,
      name: 'Pizza',
      sku: 'PIZZA',
      price: 8,
      vatRate: 0.2,
      active: true,
      categoryId: 1,
      isKg: false,
      station: 'KITCHEN',
      stockLevel: 'OK',
      stockRemaining: null,
      costPrice: 3,
      costBreakdown: [{ id: 'a', label: 'dough', amount: 3 }],
    },
    {
      id: 11,
      name: 'Old soup',
      sku: 'SOUP',
      price: 4,
      vatRate: 0.2,
      active: false,
      categoryId: 1,
      station: 'KITCHEN',
      stockLevel: 'OK',
    },
  ],
};

describe('mapMenuCategoryForClient', () => {
  it('strips cost and inactive items for waiter phones', () => {
    const dto = mapMenuCategoryForClient(cat, {
      includeCost: false,
      includeInactiveItems: false,
    });
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].name).toBe('Pizza');
    expect(dto.items[0].costPrice).toBeUndefined();
    expect(dto.items[0].costBreakdown).toBeUndefined();
    expect(dto.color).toBe('#111');
  });

  it('keeps cost and inactive items for the admin till', () => {
    const dto = mapMenuCategoryForClient(cat);
    expect(dto.items).toHaveLength(2);
    expect(dto.items[0].costPrice).toBe(3);
    expect(dto.items[0].costBreakdown).toHaveLength(1);
  });
});
