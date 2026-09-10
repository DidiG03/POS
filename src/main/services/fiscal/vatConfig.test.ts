/**
 * VAT code resolution.
 *
 * The bug being fixed here is that 0% maps to three different codes — A
 * (seller outside the VAT scheme), C (exempt supply) and J (export) — and
 * the old threshold-based mapper always answered A. It also snapped any
 * unrecognised rate into the nearest band, so a misconfigured 15% was
 * filed as 10%.
 */

import { describe, expect, it } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import {
  assertVatCode,
  rateForVatCode,
  readVatConfig,
  resolveVatCode,
} from './vatConfig';

const settings = (fiscalVat?: unknown): SettingsDTO =>
  ({ fiscal: { vat: fiscalVat } }) as unknown as SettingsDTO;

describe('the statutory bands', () => {
  it('maps the standard rates', () => {
    expect(resolveVatCode(settings(), { vatRate: 0.2 })).toMatchObject({
      ok: true,
      code: 'B',
    });
    expect(resolveVatCode(settings(), { vatRate: 0.1 })).toMatchObject({
      ok: true,
      code: 'D',
    });
    expect(resolveVatCode(settings(), { vatRate: 0.06 })).toMatchObject({
      ok: true,
      code: 'E',
    });
  });

  it('reads a whole number as a percentage', () => {
    expect(resolveVatCode(settings(), { vatRate: 20 })).toMatchObject({
      code: 'B',
    });
    expect(resolveVatCode(settings(), { vatRate: 6 })).toMatchObject({
      code: 'E',
    });
  });

  it('refuses a rate that is not a real band instead of snapping to one', () => {
    // The old mapper filed 15% as D (10%), under-declaring the tax with
    // nothing downstream able to notice.
    const resolved = resolveVatCode(settings(), { vatRate: 0.15 });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.error).toMatch(/does not match any configured band/);
    expect(resolved.error).toMatch(/B=20%/);
  });

  it('refuses a missing rate rather than defaulting to exempt', () => {
    // Silently filing an unpriced VAT line as 0% is a tax error.
    expect(resolveVatCode(settings(), {}).ok).toBe(false);
    expect(resolveVatCode(settings(), { vatRate: null }).ok).toBe(false);
    expect(resolveVatCode(settings(), { vatRate: NaN }).ok).toBe(false);
  });
});

describe('the three zero-rated codes', () => {
  it('defaults a 0% line to C — exempt — for a VAT-registered seller', () => {
    expect(resolveVatCode(settings(), { vatRate: 0 })).toMatchObject({
      ok: true,
      code: 'C',
    });
  });

  it('uses A for a seller outside the VAT scheme', () => {
    expect(
      resolveVatCode(settings({ nonVatBusiness: true }), { vatRate: 0.2 }),
    ).toMatchObject({ ok: true, code: 'A' });
    // Every line, whatever its rate.
    expect(
      resolveVatCode(settings({ nonVatBusiness: true }), { vatRate: 0.1 }),
    ).toMatchObject({ code: 'A' });
  });

  it('honours an explicit zeroRateCode of A', () => {
    expect(
      resolveVatCode(settings({ zeroRateCode: 'A' }), { vatRate: 0 }),
    ).toMatchObject({ code: 'A' });
  });

  it('uses J for an export document, whatever the line says', () => {
    expect(
      resolveVatCode(settings(), { vatRate: 0.2, documentType: 'EXPORT' }),
    ).toMatchObject({ ok: true, code: 'J' });
  });

  it('lets an export beat a non-VAT seller', () => {
    expect(
      resolveVatCode(settings({ nonVatBusiness: true }), {
        vatRate: 0.2,
        documentType: 'EXPORT',
      }),
    ).toMatchObject({ code: 'J' });
  });

  it('marks a line exempt when it is flagged as such', () => {
    expect(
      resolveVatCode(settings(), { vatRate: 0.2, exempt: true }),
    ).toMatchObject({ ok: true, code: 'C' });
  });
});

describe('an explicit code on the article', () => {
  it('wins over the rate', () => {
    // The seller has classified this product, which is knowledge the
    // percentage does not carry.
    expect(
      resolveVatCode(settings(), { vatCode: 'C', vatRate: 0.2 }),
    ).toMatchObject({ ok: true, code: 'C' });
  });

  it('is normalised to upper case', () => {
    expect(resolveVatCode(settings(), { vatCode: 'b' })).toMatchObject({
      code: 'B',
    });
  });

  it('is rejected when it is not a real code', () => {
    const resolved = resolveVatCode(settings(), { vatCode: 'X' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.error).toMatch(/is not a VAT code/);
  });
});

describe('configured band overrides', () => {
  it('replaces the statutory bands when supplied', () => {
    const custom = settings({ bands: [{ code: 'D', rate: 0.15 }] });
    expect(resolveVatCode(custom, { vatRate: 0.15 })).toMatchObject({
      code: 'D',
    });
    // And the statutory ones are then no longer implied.
    expect(resolveVatCode(custom, { vatRate: 0.2 }).ok).toBe(false);
  });

  it('ignores malformed entries and falls back to the statutory bands', () => {
    const broken = settings({ bands: [{ code: 'Z', rate: 'nonsense' }] });
    expect(readVatConfig(broken).bands.map((b) => b.code)).toEqual([
      'B',
      'D',
      'E',
    ]);
  });

  it('accepts percentages in the band config', () => {
    const pct = settings({ bands: [{ code: 'B', rate: 20 }] });
    expect(resolveVatCode(pct, { vatRate: 0.2 })).toMatchObject({ code: 'B' });
  });
});

describe('assertVatCode', () => {
  it('returns the code when it resolves', () => {
    expect(assertVatCode(settings(), { vatRate: 0.2 })).toBe('B');
  });

  it('throws naming the article, so the message is actionable at the till', () => {
    expect(() =>
      assertVatCode(settings(), { vatRate: 0.15, articleName: 'Birra Korça' }),
    ).toThrow(/Birra Korça/);
  });
});

describe('rateForVatCode', () => {
  it('restates the nominal rate for a code', () => {
    expect(rateForVatCode('B')).toBe(0.2);
    expect(rateForVatCode('D')).toBe(0.1);
    expect(rateForVatCode('E')).toBe(0.06);
    for (const zero of ['A', 'C', 'J'] as const) {
      expect(rateForVatCode(zero)).toBe(0);
    }
  });
});
