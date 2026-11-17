import { describe, expect, it } from 'vitest';
import {
  parsePaymentApprovalPurpose,
  paymentApprovalFingerprint,
  purposeAllowsPayment,
} from './approvalPurpose';

const settings = {
  preferences: { serviceCharge: { enabled: true, value: 10 } },
};
const purpose = parsePaymentApprovalPurpose({
  action: 'PAYMENT',
  area: 'Main Hall',
  tableLabel: 'T1',
  discountType: 'PERCENT',
  discountValue: 10,
  serviceChargeRemoved: false,
  totalBefore: 20,
})!;
const meta = (over: Record<string, unknown> = {}) => ({
  discountType: 'PERCENT',
  discountValue: 10,
  discountAmount: 2,
  baseTotal: 18.18,
  serviceChargeAmount: 1.82,
  totalBefore: 20,
  ...over,
});
const at = (m: Record<string, unknown>, table = 'T1') => ({
  settings,
  area: 'Main Hall',
  tableLabel: table,
  meta: m,
});

describe('payment approval purpose', () => {
  it('reads a purpose and rejects junk', () => {
    expect(purpose.discountValue).toBe(10);
    expect(parsePaymentApprovalPurpose({ action: 'VOID' })).toBeNull();
    expect(parsePaymentApprovalPurpose(null)).toBeNull();
    expect(
      parsePaymentApprovalPurpose({ action: 'PAYMENT', area: 'A' }),
    ).toBeNull();
  });

  it('allows the payment the manager saw', () => {
    expect(purposeAllowsPayment(purpose, at(meta()))).toBe(true);
  });

  it('refuses a bigger discount, another table or another bill', () => {
    expect(
      purposeAllowsPayment(purpose, at(meta({ discountValue: 100 }))),
    ).toBe(false);
    expect(
      purposeAllowsPayment(purpose, at(meta({ discountType: 'AMOUNT' }))),
    ).toBe(false);
    expect(purposeAllowsPayment(purpose, at(meta(), 'T2'))).toBe(false);
    expect(purposeAllowsPayment(purpose, at(meta({ totalBefore: 80 })))).toBe(
      false,
    );
  });

  it('refuses removing the service charge when only a discount was approved', () => {
    expect(
      purposeAllowsPayment(purpose, at(meta({ serviceChargeAmount: 0 }))),
    ).toBe(false);
    expect(
      purposeAllowsPayment(
        { ...purpose, serviceChargeRemoved: true },
        at(meta({ serviceChargeAmount: 0 })),
      ),
    ).toBe(true);
  });

  it('gives a retry the same fingerprint and another payment a new one', () => {
    const a = paymentApprovalFingerprint(settings, meta());
    expect(paymentApprovalFingerprint(settings, meta())).toBe(a);
    expect(
      paymentApprovalFingerprint(settings, meta({ discountValue: 100 })),
    ).not.toBe(a);
    expect(
      paymentApprovalFingerprint(settings, meta({ totalBefore: 7 })),
    ).not.toBe(a);
    expect(
      paymentApprovalFingerprint(settings, meta({ serviceChargeAmount: 0 })),
    ).not.toBe(a);
  });
});
