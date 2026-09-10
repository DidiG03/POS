/**
 * Where a line's `vatCode` comes from.
 *
 * The API does not expose a rate→code lookup, so this is ours to get right
 * and ours to get wrong. The previous implementation inferred the code from
 * the numeric rate with threshold comparisons, which cannot work:
 *
 *   - 0% is `A` (seller outside the VAT scheme), `C` (exempt supply) or
 *     `J` (export) depending on facts a percentage does not carry, and it
 *     always answered `A`;
 *   - the thresholds were ranges, so a misconfigured 15% rate was filed as
 *     `D` (10%) rather than refused — under-declaring VAT silently, which
 *     is the kind of error that is only ever found by an inspection.
 *
 * So the mapping is configuration. Rates must match a configured band, and
 * a rate that matches none is an error rather than a nearest guess.
 */

import type { SettingsDTO } from '@shared/ipc';
import {
  VAT_CODES,
  VAT_CODE_RATES,
  type DocumentType,
  type VatCode,
} from './apiTypes';

export interface VatBand {
  code: VatCode;
  /** Fraction, e.g. 0.2 for 20%. */
  rate: number;
}

/**
 * The bands the Albanian scheme defines. Used when a business has not
 * overridden them, which is the normal case — they are set by law, not by
 * preference. `A`, `C` and `J` are all 0% and are therefore never selected
 * by rate; they are chosen by the flags below.
 */
export const STANDARD_VAT_BANDS: readonly VatBand[] = [
  { code: 'B', rate: 0.2 },
  { code: 'D', rate: 0.1 },
  { code: 'E', rate: 0.06 },
];

export interface ResolvedVatConfig {
  /** Seller is not VAT registered: every line is filed as `A`. */
  nonVatBusiness: boolean;
  /** Which zero code a 0% line means for this seller. */
  zeroRateCode: Extract<VatCode, 'A' | 'C'>;
  bands: VatBand[];
}

function normalizeRate(raw: unknown): number | null {
  // `Number(null)` and `Number('')` are both 0, so coercing first would
  // turn a missing rate into a zero-rated line — a silent tax error rather
  // than the configuration complaint it should be.
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  let n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // Rates are fractions across this codebase, but settings imported from
  // elsewhere have arrived as percentages. Anything above 1 cannot be a
  // fraction (100% VAT does not exist), so read it as a percentage.
  if (n > 1) n = n / 100;
  return n;
}

export function readVatConfig(settings: SettingsDTO): ResolvedVatConfig {
  const vat = (settings as any)?.fiscal?.vat || {};
  const configured = Array.isArray(vat.bands) ? vat.bands : [];
  const bands: VatBand[] = [];
  for (const entry of configured) {
    const code = String(entry?.code || '').toUpperCase() as VatCode;
    const rate = normalizeRate(entry?.rate);
    if (!VAT_CODES.includes(code) || rate == null) continue;
    bands.push({ code, rate });
  }
  const zero = String(vat.zeroRateCode || '').toUpperCase();
  return {
    nonVatBusiness: vat.nonVatBusiness === true,
    zeroRateCode: zero === 'A' ? 'A' : 'C',
    bands: bands.length ? bands : [...STANDARD_VAT_BANDS],
  };
}

export interface VatCodeRequest {
  /** Per-line rate as a fraction. */
  vatRate?: number | null;
  /**
   * A code stored against the menu item. Wins over the rate, because a
   * seller who has classified a product as exempt knows something the
   * percentage does not say.
   */
  vatCode?: string | null;
  documentType?: DocumentType;
  /** True when this specific supply is exempt rather than zero-rated. */
  exempt?: boolean;
}

export type VatCodeResolution =
  | { ok: true; code: VatCode; reason: string }
  | { ok: false; error: string };

/**
 * Resolve the VAT code for one line.
 *
 * Order is deliberate: document-level facts (export) beat seller-level
 * facts (not VAT registered), which beat line-level classification, which
 * beats the rate.
 */
export function resolveVatCode(
  settings: SettingsDTO,
  request: VatCodeRequest,
): VatCodeResolution {
  const config = readVatConfig(settings);

  if (request.documentType === 'EXPORT') {
    return {
      ok: true,
      code: 'J',
      reason: 'EXPORT invoices are filed at the export rate J.',
    };
  }

  const explicit = String(request.vatCode || '').toUpperCase();
  if (explicit) {
    if (!VAT_CODES.includes(explicit as VatCode)) {
      return {
        ok: false,
        error: `"${explicit}" is not a VAT code. Expected one of ${VAT_CODES.join(', ')}.`,
      };
    }
    return {
      ok: true,
      code: explicit as VatCode,
      reason: 'Taken from the code stored against this article.',
    };
  }

  if (config.nonVatBusiness) {
    return {
      ok: true,
      code: 'A',
      reason:
        'The seller is configured as not VAT registered, so every line is band A.',
    };
  }

  if (request.exempt) {
    return {
      ok: true,
      code: config.zeroRateCode,
      reason: 'Line is marked exempt.',
    };
  }

  const rate = normalizeRate(request.vatRate);
  if (rate == null) {
    return {
      ok: false,
      error:
        'No VAT rate and no VAT code for this line. Set a rate on the menu item or a default in Admin → Fiskalizimi.',
    };
  }

  if (rate === 0) {
    return {
      ok: true,
      code: config.zeroRateCode,
      reason: `Zero-rated line filed as ${config.zeroRateCode} per the stored VAT configuration.`,
    };
  }

  // Exact match against a configured band, with a hair of tolerance for
  // 0.06 vs 6/100 style rounding. No nearest-band fallback: a rate that is
  // not a real band is a configuration error, and filing it as the closest
  // one misdeclares tax.
  const match = config.bands.find(
    (band) => Math.abs(band.rate - rate) < 0.0005,
  );
  if (match) {
    return {
      ok: true,
      code: match.code,
      reason: `Rate ${(rate * 100).toFixed(2)}% matches configured band ${match.code}.`,
    };
  }

  return {
    ok: false,
    error: `VAT rate ${(rate * 100).toFixed(2)}% does not match any configured band (${config.bands
      .map((b) => `${b.code}=${(b.rate * 100).toFixed(0)}%`)
      .join(
        ', ',
      )}). Fix the rate on the article or add the band in Admin → Fiskalizimi.`,
  };
}

export function assertVatCode(
  settings: SettingsDTO,
  request: VatCodeRequest & { articleName?: string },
): VatCode {
  const resolved = resolveVatCode(settings, request);
  if (!resolved.ok) {
    const where = request.articleName
      ? ` (article "${request.articleName}")`
      : '';
    throw new Error(`${resolved.error}${where}`);
  }
  return resolved.code;
}

/** The nominal rate a code stands for. Used to restate a filed invoice. */
export function rateForVatCode(code: VatCode): number {
  return VAT_CODE_RATES[code] ?? 0;
}
