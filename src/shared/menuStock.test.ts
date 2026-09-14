import { describe, expect, it } from 'vitest';
import {
  consumeUnits,
  inventoryLevelFromOnHand,
  stockLinesFromTicketItems,
  storeOnHandWrite,
} from './menuStock';

describe('inventoryLevelFromOnHand', () => {
  it('treats 0 and negatives as out', () => {
    expect(inventoryLevelFromOnHand(0)).toBe('OUT');
    expect(inventoryLevelFromOnHand(-2)).toBe('OUT');
  });

  it('flags 1–5 as low and 6+ as in stock', () => {
    expect(inventoryLevelFromOnHand(1)).toBe('LOW');
    expect(inventoryLevelFromOnHand(5)).toBe('LOW');
    expect(inventoryLevelFromOnHand(6)).toBe('OK');
  });
});

describe('storeOnHandWrite', () => {
  it('persists a floor of 0 and does not stamp a stock day', () => {
    expect(storeOnHandWrite(12)).toEqual({
      stockLevel: 'OK',
      stockRemaining: 12,
      stockDay: null,
    });
    expect(storeOnHandWrite(0).stockRemaining).toBe(0);
    expect(storeOnHandWrite(0).stockLevel).toBe('OUT');
  });
});

describe('stockLinesFromTicketItems', () => {
  it('skips voided lines and missing SKUs', () => {
    expect(
      stockLinesFromTicketItems([
        { sku: 'A', qty: 2 },
        { sku: 'B', qty: 1, voided: true },
        { name: 'no code', qty: 3 },
      ]),
    ).toEqual([{ sku: 'A', qty: 2 }]);
  });
});

describe('consumeUnits', () => {
  it('ceils fractional qty', () => {
    expect(consumeUnits(1.2)).toBe(2);
    expect(consumeUnits(0)).toBe(1);
  });
});
