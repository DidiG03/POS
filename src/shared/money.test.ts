import { describe, expect, it } from 'vitest';
import { roundMoney } from './money';

/** Half-up on the decimal digits, the way it is written down. */
function reference(v: number): number {
  const s = Math.abs(v).toPrecision(15);
  const [i, f = ''] = s.split('.');
  const d = (f + '000').slice(0, 3);
  let cents = Number(i) * 100 + Number(d.slice(0, 2));
  if (Number(d[2]) >= 5) cents += 1;
  return (v < 0 ? -cents : cents) / 100;
}

describe('roundMoney', () => {
  it('rounds every half cent up, as written', () => {
    // One assertion at the end: 300k expect() calls outran the CI timeout.
    const wrong: number[] = [];
    for (let k = 0; k < 300_000; k++) {
      const v = k / 1000;
      if (roundMoney(v) !== reference(v)) wrong.push(v);
    }
    expect(wrong.slice(0, 10)).toEqual([]);
  });

  it('fixes the cases binary floats used to take down a cent', () => {
    expect(roundMoney(2.135)).toBe(2.14);
    expect(roundMoney(10.075)).toBe(10.08);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(1234.565)).toBe(1234.57);
  });

  it('rounds negative amounts away from zero, like positive ones', () => {
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(-220.015)).toBe(-220.02);
    expect(Object.is(roundMoney(-0.001), 0)).toBe(true);
  });

  it('keeps float noise out', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(1150.5 * 0.1)).toBe(115.05);
    expect(roundMoney('12.345')).toBe(12.35);
    expect(roundMoney(NaN)).toBe(0);
    expect(roundMoney(1e21)).toBe(1e21);
  });
});
