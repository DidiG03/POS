import { describe, expect, it } from 'vitest';
import {
  categoryMapFromRoutes,
  findPrintRouteForCategory,
  newPrintRouteId,
  nextPrintRouteName,
  normalizePrintRoute,
  normalizePrintRoutes,
} from './printRoutes';

describe('normalizePrintRoutes', () => {
  it('uses named routes when present, even if empty', () => {
    expect(
      normalizePrintRoutes({
        routes: [],
        categories: { '1': 'kitchen' },
      }),
    ).toEqual([]);
  });

  it('keeps two routings that share a printer', () => {
    const routes = normalizePrintRoutes({
      routes: [
        {
          id: 'grill',
          name: 'Grill',
          printerId: 'kitchen',
          categoryIds: ['10', '11'],
        },
        {
          id: 'cold',
          name: 'Cold Starters',
          printerId: 'kitchen',
          categoryIds: ['20'],
        },
      ],
    });
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.id)).toEqual(['grill', 'cold']);
    expect(routes.every((r) => r.printerId === 'kitchen')).toBe(true);
  });

  it('migrates a legacy category→printer map into one routing per printer', () => {
    const routes = normalizePrintRoutes(
      {
        categories: {
          '10': 'kitchen',
          steaks: 'kitchen',
          '20': 'bar',
        },
      },
      { printerNames: { kitchen: 'Kitchen', bar: 'Bar' } },
    );
    expect(routes).toEqual([
      {
        id: 'legacy:kitchen',
        name: 'Kitchen',
        printerId: 'kitchen',
        categoryIds: ['10', 'steaks'],
      },
      {
        id: 'legacy:bar',
        name: 'Bar',
        printerId: 'bar',
        categoryIds: ['20'],
      },
    ]);
  });
});

describe('findPrintRouteForCategory', () => {
  const routes = normalizePrintRoutes({
    routes: [
      {
        id: 'grill',
        name: 'Grill',
        printerId: 'kitchen',
        categoryIds: ['10', 'steaks'],
      },
      {
        id: 'cold',
        name: 'Cold Starters',
        printerId: 'kitchen',
        categoryIds: ['20'],
      },
    ],
  });

  it('matches by category id', () => {
    expect(findPrintRouteForCategory(routes, { categoryId: 10 })?.id).toBe(
      'grill',
    );
  });

  it('matches by legacy category name key', () => {
    expect(
      findPrintRouteForCategory(routes, { categoryName: 'Steaks' })?.id,
    ).toBe('grill');
  });

  it('returns undefined when the category is unassigned', () => {
    expect(
      findPrintRouteForCategory(routes, { categoryId: 99 }),
    ).toBeUndefined();
  });
});

describe('categoryMapFromRoutes', () => {
  it('derives the legacy printer map without collapsing routings', () => {
    expect(
      categoryMapFromRoutes([
        {
          id: 'grill',
          name: 'Grill',
          printerId: 'kitchen',
          categoryIds: ['10'],
        },
        {
          id: 'cold',
          name: 'Cold Starters',
          printerId: 'kitchen',
          categoryIds: ['20'],
        },
      ]),
    ).toEqual({ '10': 'kitchen', '20': 'kitchen' });
  });
});

describe('helpers', () => {
  it('skips blank category ids', () => {
    expect(
      normalizePrintRoute({
        id: 'x',
        name: 'X',
        printerId: 'p',
        categoryIds: ['1', '', '1', '2'],
      }),
    ).toEqual({
      id: 'x',
      name: 'X',
      printerId: 'p',
      categoryIds: ['1', '2'],
    });
  });

  it('picks the next unused default name', () => {
    expect(
      nextPrintRouteName([{ name: 'Routing 1' }], (n) => `Routing ${n}`),
    ).toBe('Routing 2');
  });

  it('allocates distinct ids', () => {
    expect(newPrintRouteId()).not.toBe(newPrintRouteId());
  });
});
