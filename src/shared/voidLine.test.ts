import { describe, expect, it } from 'vitest';
import { findVoidableLineIndex } from './voidLine';

describe('findVoidableLineIndex', () => {
  it('picks the line with the matching price when a name repeats', () => {
    const items = [
      { name: 'Beer', qty: 1, unitPrice: 2.5 },
      { name: 'Beer', qty: 1, unitPrice: 4 },
    ];
    expect(
      findVoidableLineIndex(items, { name: 'Beer', qty: 1, unitPrice: 4 }),
    ).toBe(1);
  });

  it('distinguishes two of the same dish by their notes', () => {
    const items = [
      { name: 'Steak', qty: 1, unitPrice: 20, note: 'rare' },
      { name: 'Steak', qty: 1, unitPrice: 20, note: 'well done' },
    ];
    expect(
      findVoidableLineIndex(items, {
        name: 'Steak',
        qty: 1,
        unitPrice: 20,
        note: 'well done',
      }),
    ).toBe(1);
  });

  it('prefers the sku when the client sends one', () => {
    const items = [
      { sku: 'A1', name: 'House Red', qty: 1, unitPrice: 6 },
      { sku: 'B2', name: 'House Red', qty: 1, unitPrice: 6 },
    ];
    expect(
      findVoidableLineIndex(items, {
        sku: 'B2',
        name: 'House Red',
        qty: 1,
        unitPrice: 6,
      }),
    ).toBe(1);
  });

  it('never returns an already voided line', () => {
    const items = [
      { name: 'Coke', qty: 1, unitPrice: 3, voided: true },
      { name: 'Coke', qty: 1, unitPrice: 3 },
    ];
    expect(
      findVoidableLineIndex(items, { name: 'Coke', qty: 1, unitPrice: 3 }),
    ).toBe(1);
  });

  it('returns -1 when every matching line is already voided', () => {
    const items = [{ name: 'Coke', qty: 1, unitPrice: 3, voided: true }];
    expect(
      findVoidableLineIndex(items, { name: 'Coke', qty: 1, unitPrice: 3 }),
    ).toBe(-1);
  });

  it('falls back to the name when the client sends no price', () => {
    const items = [{ name: 'Coke', qty: 1, unitPrice: 3 }];
    expect(findVoidableLineIndex(items, { name: 'Coke' })).toBe(0);
  });

  it('still matches when the quantity has since changed on the line', () => {
    const items = [{ name: 'Coke', qty: 3, unitPrice: 3 }];
    expect(
      findVoidableLineIndex(items, { name: 'Coke', qty: 1, unitPrice: 3 }),
    ).toBe(0);
  });

  it('tolerates float noise in the price', () => {
    const items = [{ name: 'Coke', qty: 1, unitPrice: 3.0000000000000004 }];
    expect(
      findVoidableLineIndex(items, { name: 'Coke', qty: 1, unitPrice: 3 }),
    ).toBe(0);
  });

  it('returns -1 for an unknown item or empty snapshot', () => {
    expect(findVoidableLineIndex([], { name: 'Coke' })).toBe(-1);
    expect(findVoidableLineIndex(null, { name: 'Coke' })).toBe(-1);
    expect(findVoidableLineIndex([{ name: 'Coke' }], null)).toBe(-1);
  });
});
