/**
 * Payment method mapping for the fiscal payload.
 *
 * Lives here rather than in `vat.ts` / `vatConfig.ts`: a payment type is
 * not a VAT band, and a file named for VAT is where a rate-to-code helper
 * kept being rediscovered after it had been retired.
 *
 * Everything but CASH, CARD and CHECK used to be filed as OTHER (QA round
 * 6, fiscal). Methods that name a tax payment type, or a synonym of one,
 * are now filed as that type. What a gift card or a room charge is for the
 * tax service (a single- or multi-purpose voucher, a company invoice) is
 * the venue's accountant's call: it is set per venue in
 * `fiscal.paymentTypeMap` (e.g. `{ "ROOM_CHARGE": "COMPANY" }`) and stays
 * OTHER until set.
 *
 * Voucher types (VOUCHER, SVOUCHER) are not offered: the tax service wants
 * the voucher numbers with them, and the till does not collect any, so
 * every gift-card sale mapped to a voucher was refused by easyPos (QA
 * v0.2.103, #4). Saving such a mapping is refused with that reason; one
 * saved before this is ignored, and the sale is filed as OTHER.
 */
import type { PaymentType } from './apiTypes';

/** Types a payment can be filed as from the till (ACCOUNT needs bank details; ORDER is for order documents). */
export const MAPPABLE_PAYMENT_TYPES: readonly PaymentType[] = [
  'CASH',
  'CARD',
  'CHECK',
  'COMPANY',
  'FACTORING',
  'KIND',
  'TRANSFER',
  'WAIVER',
  'OTHER',
];

const SYNONYMS: Readonly<Record<string, PaymentType>> = {
  CASH: 'CASH',
  BANKNOTE: 'CASH',
  CARD: 'CARD',
  CREDIT_CARD: 'CARD',
  DEBIT_CARD: 'CARD',
  CHECK: 'CHECK',
  CHEQUE: 'CHECK',
  TRANSFER: 'TRANSFER',
  BANK_TRANSFER: 'TRANSFER',
  COMPANY: 'COMPANY',
  FACTORING: 'FACTORING',
  KIND: 'KIND',
  WAIVER: 'WAIVER',
};

function venueMap(settings: unknown): Record<string, string> {
  const map = (settings as any)?.fiscal?.paymentTypeMap;
  return map && typeof map === 'object' ? map : {};
}

/** Need voucher numbers the till does not collect (see above). */
export const VOUCHER_PAYMENT_TYPES: readonly PaymentType[] = [
  'VOUCHER',
  'SVOUCHER',
];

/** Why a venue mapping cannot be saved, or null. */
export function paymentTypeMapProblem(map: unknown): string | null {
  if (map === null || map === undefined) return null;
  if (typeof map !== 'object' || Array.isArray(map)) {
    return 'The payment type map must list a tax payment type per method.';
  }
  for (const [method, type] of Object.entries(map as object)) {
    const t = String(type ?? '').toUpperCase();
    if ((VOUCHER_PAYMENT_TYPES as readonly string[]).includes(t)) {
      return `${method} cannot be filed as ${t}: the tax service requires the voucher numbers with a voucher payment, and the till does not collect them, so easyPos would refuse every such sale. Map ${method} to OTHER (or COMPANY) instead.`;
    }
    if (!(MAPPABLE_PAYMENT_TYPES as readonly string[]).includes(t)) {
      return `"${String(type)}" (for ${method}) is not a payment type the tax service accepts from the till (${MAPPABLE_PAYMENT_TYPES.join(', ')}).`;
    }
  }
  return null;
}

export function mapPaymentMethod(method: string, settings?: unknown): string {
  const m = String(method || '')
    .trim()
    .toUpperCase();
  const fromVenue = String(venueMap(settings)[m] ?? '')
    .trim()
    .toUpperCase();
  if ((MAPPABLE_PAYMENT_TYPES as readonly string[]).includes(fromVenue)) {
    return fromVenue;
  }
  return SYNONYMS[m] ?? 'OTHER';
}
