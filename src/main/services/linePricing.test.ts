/**
 * Line prices on a payment come from the host's menu, not the phone.
 *
 * What reaches the fiscal invoice is `unitPrice × qty` per line, so a line
 * the client under-priced must be charged — and reported — at the menu
 * price, while a table that ordered before an admin changed a price keeps
 * the price it was quoted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { menu, store, seatedAt } = vi.hoisted(() => ({
  menu: [] as Array<{
    sku: string;
    name: string;
    price: number;
    vatRate: number;
  }>,
  store: new Map<string, any>(),
  seatedAt: { value: null as Date | null },
}));

vi.mock('@db/client', () => ({
  prisma: {
    menuItem: {
      findMany: vi.fn(async ({ where }: any) => {
        const keys = new Set<string>([
          ...(where.OR[0].sku.in as string[]),
          ...(where.OR[1].name.in as string[]),
        ]);
        return menu.filter((m) => keys.has(m.sku) || keys.has(m.name));
      }),
    },
    syncState: {
      findUnique: vi.fn(async ({ where }: any) =>
        store.has(where.key)
          ? { key: where.key, valueJson: store.get(where.key) }
          : null,
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        store.set(
          where.key,
          store.has(where.key) ? update.valueJson : create.valueJson,
        );
        return {};
      }),
    },
  },
}));

vi.mock('./tableSession', () => ({
  getTableSessionStartedAt: vi.fn(async () => seatedAt.value),
}));

import {
  describeLineIssues,
  repriceLines,
  repriceLinesFromMenu,
} from './linePricing';
import {
  MENU_PRICE_HISTORY_KEY,
  recordMenuPriceChange,
} from './menuPriceHistory';

const ESPRESSO = { sku: 'ESP', name: 'Espresso', price: 100, vatRate: 0.2 };
const STEAK = { sku: 'STK', name: 'Steak', price: 1500, vatRate: 0.2 };

const NOW = new Date('2026-09-28T20:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeEach(() => {
  menu.length = 0;
  menu.push({ ...ESPRESSO }, { ...STEAK });
  store.clear();
  seatedAt.value = minutesAgo(60);
});

describe('repriceLines', () => {
  it('leaves an honest ticket exactly as sent', () => {
    const items = [
      { sku: 'ESP', name: 'Espresso', qty: 2, unitPrice: 100, vatRate: 0.2 },
      { sku: 'STK', name: 'Steak', qty: 1, unitPrice: 1500, vatRate: 0.2 },
    ];
    const r = repriceLines(items, menu, []);
    expect(r.issues).toEqual([]);
    expect(r.items).toEqual(items);
  });

  it('charges the menu price for an under-priced line', () => {
    const r = repriceLines(
      [{ sku: 'STK', name: 'Steak', qty: 1, unitPrice: 150, vatRate: 0.2 }],
      menu,
      [],
    );
    expect(r.items[0].unitPrice).toBe(1500);
    expect(r.issues).toEqual([
      expect.objectContaining({
        kind: 'repriced',
        sku: 'STK',
        claimedPrice: 150,
        menuPrice: 1500,
      }),
    ]);
  });

  it('corrects a VAT rate that is not the menu item’s', () => {
    const r = repriceLines(
      [{ sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 100, vatRate: 0 }],
      menu,
      [],
    );
    expect(r.items[0]).toMatchObject({ unitPrice: 100, vatRate: 0.2 });
    expect(describeLineIssues(r.issues)).toContain('VAT 0% → 20%');
  });

  it('never lets a line pick its own tax band', () => {
    const r = repriceLines(
      [
        {
          sku: 'ESP',
          name: 'Espresso',
          qty: 1,
          unitPrice: 100,
          vatRate: 0.2,
          vatCode: 'A',
          vatExempt: true,
        },
      ],
      menu,
      [],
    );
    expect(r.items[0]).not.toHaveProperty('vatCode');
    expect(r.items[0]).not.toHaveProperty('vatExempt');
  });

  it('keeps the price a table was quoted before the menu changed', () => {
    const r = repriceLines(
      [{ sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 80, vatRate: 0.2 }],
      menu,
      [
        {
          sku: 'ESP',
          price: 80,
          vatRate: 0.2,
          until: minutesAgo(10).toISOString(),
        },
      ],
    );
    expect(r.issues).toEqual([]);
    expect(r.items[0].unitPrice).toBe(80);
  });

  it('drops a zero or negative quantity instead of subtracting it', () => {
    const r = repriceLines(
      [
        { sku: 'STK', name: 'Steak', qty: 1, unitPrice: 1500, vatRate: 0.2 },
        { sku: 'STK', name: 'Steak', qty: -1, unitPrice: 1500, vatRate: 0.2 },
      ],
      menu,
      [],
    );
    expect(r.items).toHaveLength(1);
    expect(r.issues).toEqual([
      expect.objectContaining({ kind: 'dropped', qty: -1 }),
    ]);
  });

  it('keeps an item that is not on the menu but reports it', () => {
    const line = {
      sku: 'GHOST',
      name: 'Ghost',
      qty: 1,
      unitPrice: 1,
      vatRate: 0.2,
    };
    const r = repriceLines([line], menu, []);
    expect(r.items).toEqual([line]);
    expect(describeLineIssues(r.issues)).toContain('Ghost is not on the menu');
  });

  it('finds an older ticket line by name when it carries no code', () => {
    const r = repriceLines(
      [{ sku: 'Steak', name: 'Steak', qty: 1, unitPrice: 15, vatRate: 0.2 }],
      menu,
      [],
    );
    expect(r.items[0].unitPrice).toBe(1500);
  });

  it('does not guess between two items with the same name', () => {
    menu.push({ sku: 'STK2', name: 'Steak', price: 2500, vatRate: 0.2 });
    const r = repriceLines(
      [{ sku: '', name: 'Steak', qty: 1, unitPrice: 15, vatRate: 0.2 }],
      menu,
      [],
    );
    expect(r.items[0].unitPrice).toBe(15);
    expect(r.issues[0].kind).toBe('unknown');
  });

  it('leaves voided lines alone — they are not charged', () => {
    const line = {
      sku: 'STK',
      name: 'Steak',
      qty: 1,
      unitPrice: 1,
      vatRate: 0.2,
      voided: true,
    };
    expect(repriceLines([line], menu, [])).toEqual({
      items: [line],
      issues: [],
    });
  });
});

describe('repriceLinesFromMenu', () => {
  it('honours a price change made after the table was seated', async () => {
    await recordMenuPriceChange(
      ESPRESSO,
      { ...ESPRESSO, price: 120 },
      minutesAgo(30),
    );
    menu[0].price = 120;
    const r = await repriceLinesFromMenu({
      items: [
        { sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 100, vatRate: 0.2 },
      ],
      area: 'Salla',
      tableLabel: '5',
      now: NOW,
    });
    expect(r?.issues).toEqual([]);
    expect(r?.items[0].unitPrice).toBe(100);
  });

  it('charges the new price to a table seated after the change', async () => {
    await recordMenuPriceChange(
      ESPRESSO,
      { ...ESPRESSO, price: 120 },
      minutesAgo(90),
    );
    menu[0].price = 120;
    const r = await repriceLinesFromMenu({
      items: [
        { sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 100, vatRate: 0.2 },
      ],
      area: 'Salla',
      tableLabel: '5',
      now: NOW,
    });
    expect(r?.items[0].unitPrice).toBe(120);
    expect(r?.issues[0].kind).toBe('repriced');
  });

  it('returns null rather than throwing when the menu cannot be read', async () => {
    const { prisma } = await import('@db/client');
    vi.mocked(prisma.menuItem.findMany).mockRejectedValueOnce(
      new Error('database is locked'),
    );
    await expect(
      repriceLinesFromMenu({
        items: [{ sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 1 }],
        area: 'Salla',
        tableLabel: '5',
        now: NOW,
      }),
    ).resolves.toBeNull();
  });
});

describe('recordMenuPriceChange', () => {
  it('records nothing when only the name or stock changed', async () => {
    await recordMenuPriceChange(ESPRESSO, {}, NOW);
    await recordMenuPriceChange(ESPRESSO, { ...ESPRESSO }, NOW);
    expect(store.has(MENU_PRICE_HISTORY_KEY)).toBe(false);
  });

  it('forgets prices older than any sitting can be', async () => {
    await recordMenuPriceChange(
      ESPRESSO,
      { price: 110 },
      new Date(NOW.getTime() - 3 * 24 * 60 * 60_000),
    );
    await recordMenuPriceChange(
      { ...ESPRESSO, price: 110 },
      { price: 120 },
      NOW,
    );
    expect(store.get(MENU_PRICE_HISTORY_KEY)).toEqual([
      expect.objectContaining({ sku: 'ESP', price: 110 }),
    ]);
  });
});

describe('wiring', () => {
  it('a menu price edit records the old price', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'menuAdmin.ts'), 'utf8');
    const fn = src.slice(
      src.indexOf('export async function updateMenuItemFromInput'),
    );
    expect(fn).toContain('await recordMenuPriceChange(');
  });
});
