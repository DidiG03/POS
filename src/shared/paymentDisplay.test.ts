import { describe, it, expect } from 'vitest';
import {
  cashChangeDue,
  cashTenderSuggestions,
  convertPosAmount,
  parseEurExchangeRate,
  splitEvenly,
  toEurAtRate,
} from './paymentDisplay';

describe('parseEurExchangeRate', () => {
  it('accepts a positive fiscal rate', () => {
    expect(parseEurExchangeRate(100.5)).toBe(100.5);
    expect(parseEurExchangeRate('100.5')).toBe(100.5);
  });

  it('rejects missing or invalid rates', () => {
    expect(parseEurExchangeRate(null)).toBeNull();
    expect(parseEurExchangeRate(0)).toBeNull();
    expect(parseEurExchangeRate(-1)).toBeNull();
    expect(parseEurExchangeRate('abc')).toBeNull();
  });
});

describe('convertPosAmount', () => {
  it('converts ALL to EUR using Kursi EUR', () => {
    const r = convertPosAmount(4200, 'ALL', 100.5);
    expect(r.all).toBe(4200);
    expect(r.eur).toBe(41.79);
  });

  it('converts EUR to ALL using Kursi EUR', () => {
    const r = convertPosAmount(42, 'EUR', 100.5);
    expect(r.eur).toBe(42);
    expect(r.all).toBe(4221);
  });

  it('keeps EUR when the rate is missing', () => {
    expect(convertPosAmount(42, 'EUR', null)).toEqual({
      eur: 42,
      all: null,
    });
  });

  it('does not invent a rate for other currencies', () => {
    expect(convertPosAmount(100, 'USD', 100.5)).toEqual({
      eur: null,
      all: null,
    });
  });
});

describe('toEurAtRate', () => {
  it('quotes euros from a lek total', () => {
    expect(toEurAtRate(4200, 100.5)).toBe(41.79);
    expect(toEurAtRate(1400, 100.5)).toBe(13.93);
  });

  it('returns null without a rate', () => {
    expect(toEurAtRate(4200, null)).toBeNull();
  });
});

describe('splitEvenly', () => {
  it('splits a round total equally', () => {
    expect(splitEvenly(4200, 3)).toEqual({
      guests: 3,
      perPerson: 1400,
      lastPerson: 1400,
    });
  });

  it('puts leftover cents on the last guest', () => {
    expect(splitEvenly(100, 3)).toEqual({
      guests: 3,
      perPerson: 33.33,
      lastPerson: 33.34,
    });
  });

  it('rejects invalid guest counts', () => {
    expect(splitEvenly(100, 0)).toBeNull();
    expect(splitEvenly(100, 1.9)).toEqual({
      guests: 1,
      perPerson: 100,
      lastPerson: 100,
    });
  });
});

describe('cashChangeDue', () => {
  it('returns remaining change', () => {
    expect(cashChangeDue(5000, 4200)).toBe(800);
    expect(cashChangeDue(4200, 4200)).toBe(0);
    expect(cashChangeDue(1000, 4200)).toBe(0);
  });
});

describe('cashTenderSuggestions', () => {
  it('offers lek bill amounts at or above due', () => {
    expect(cashTenderSuggestions(4200, 'ALL')).toEqual([4200, 4500, 5000]);
  });

  it('offers euro notes at or above due', () => {
    expect(cashTenderSuggestions(42, 'EUR')).toEqual([42, 45, 50, 60]);
  });
});
