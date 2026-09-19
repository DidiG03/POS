import { describe, expect, it } from 'vitest';
import {
  menuCategoriesMissingKgFlag,
  menuItemSoldByKg,
  withSoldByKgFlags,
} from './menuItemKg';

describe('menuItemSoldByKg', () => {
  it('treats boolean, 1, and string true as sold-by-kg', () => {
    expect(menuItemSoldByKg({ isKg: true })).toBe(true);
    expect(menuItemSoldByKg({ isKg: 1 })).toBe(true);
    expect(menuItemSoldByKg({ isKg: '1' })).toBe(true);
    expect(menuItemSoldByKg({ isKg: 'true' })).toBe(true);
    expect(menuItemSoldByKg({ isKg: 'TRUE' })).toBe(true);
    expect(menuItemSoldByKg({ tags: { isKg: true } })).toBe(true);
  });

  it('does not treat falsey or unrelated flags as kg', () => {
    expect(menuItemSoldByKg({ isKg: false })).toBe(false);
    expect(menuItemSoldByKg({ isKg: 0 })).toBe(false);
    expect(menuItemSoldByKg({ isKg: 'false' })).toBe(false);
    expect(menuItemSoldByKg({ name: 'Pizza' })).toBe(false);
    expect(menuItemSoldByKg(null)).toBe(false);
  });
});

describe('menuCategoriesMissingKgFlag', () => {
  it('detects a cached menu from before isKg existed', () => {
    expect(
      menuCategoriesMissingKgFlag([{ items: [{ name: 'Pizza', sku: 'P' }] }]),
    ).toBe(true);
    expect(
      menuCategoriesMissingKgFlag([
        { items: [{ name: 'Pizza', sku: 'P', isKg: false }] },
      ]),
    ).toBe(false);
  });
});

describe('withSoldByKgFlags', () => {
  it('normalizes 1/0 onto a boolean isKg', () => {
    const out = withSoldByKgFlags([
      {
        items: [
          { name: 'Cheese', isKg: 1 },
          { name: 'Pizza', isKg: 0 },
        ],
      },
    ]);
    expect(out[0].items?.[0]).toMatchObject({ isKg: true });
    expect(out[0].items?.[1]).toMatchObject({ isKg: false });
  });
});
