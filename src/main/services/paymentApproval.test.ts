import { describe, expect, it } from 'vitest';
import {
  checkPaymentApproval,
  paymentApprovalsNeeded,
} from './paymentApproval';

const settings = {
  security: { approvals: {} },
  preferences: { serviceCharge: { enabled: true, mode: 'PERCENT', value: 10 } },
};
const pay = (extra: Record<string, unknown> = {}) => ({
  kind: 'PAYMENT',
  baseTotal: 1800,
  serviceChargeAmount: 180,
  discountAmount: 0,
  ...extra,
});
const valid = async (token: string, id: number) => token === 'good' && id === 1;

describe('paymentApprovalsNeeded', () => {
  it('a plain payment needs nothing', () => {
    expect(paymentApprovalsNeeded(settings, pay())).toEqual([]);
  });

  it('a discount and a removed service charge need a manager', () => {
    expect(
      paymentApprovalsNeeded(
        settings,
        pay({ discountAmount: 1980, serviceChargeAmount: 0 }),
      ),
    ).toEqual(['discount', 'serviceChargeRemoval']);
  });

  it('follows the venue settings', () => {
    const off = {
      ...settings,
      security: {
        approvals: {
          requireManagerPinForDiscount: false,
          requireManagerPinForServiceChargeRemoval: false,
        },
      },
    };
    expect(
      paymentApprovalsNeeded(
        off,
        pay({ discountAmount: 5, serviceChargeAmount: 0 }),
      ),
    ).toEqual([]);
  });

  it('reprints and kitchen slips are not payments', () => {
    expect(
      paymentApprovalsNeeded(
        settings,
        pay({ discountAmount: 5, reprint: true }),
      ),
    ).toEqual([]);
    expect(
      paymentApprovalsNeeded(settings, { kind: 'ORDER', discountAmount: 5 }),
    ).toEqual([]);
  });
});

describe('checkPaymentApproval', () => {
  const base = { settings, actorIsAdmin: false, approvalIsValid: valid };

  it('refuses a discount carrying only an admin id', async () => {
    expect(
      await checkPaymentApproval({
        ...base,
        meta: pay({ discountAmount: 1980, managerApprovedById: 1 }),
      }),
    ).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED', permanent: true });
  });

  it('refuses a token for a different admin', async () => {
    expect(
      await checkPaymentApproval({
        ...base,
        meta: pay({
          discountAmount: 5,
          managerApprovedById: 2,
          managerApprovalToken: 'good',
        }),
      }),
    ).toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('accepts a signed approval', async () => {
    expect(
      await checkPaymentApproval({
        ...base,
        meta: pay({
          discountAmount: 5,
          managerApprovedById: 1,
          managerApprovalToken: 'good',
        }),
      }),
    ).toBeNull();
  });

  it('an admin paying needs no second approval', async () => {
    expect(
      await checkPaymentApproval({
        ...base,
        actorIsAdmin: true,
        meta: pay({ discountAmount: 5 }),
      }),
    ).toBeNull();
  });
});

describe('taking a payment fiskalizimi refused (QA F2)', () => {
  it('always needs a manager, whatever the venue settings', async () => {
    const meta = { kind: 'PAYMENT', fiscalRefusalDefer: true };
    const relaxed = {
      security: {
        approvals: {
          requireManagerPinForDiscount: false,
          requireManagerPinForServiceChargeRemoval: false,
        },
      },
    };
    expect(paymentApprovalsNeeded(relaxed, meta)).toEqual([
      'fiscalRefusalDefer',
    ]);
    const refused = await checkPaymentApproval({
      settings: relaxed,
      meta,
      actorIsAdmin: false,
      approvalIsValid: async () => false,
    });
    expect(refused?.code).toBe('APPROVAL_REQUIRED');
    expect(
      await checkPaymentApproval({
        settings: relaxed,
        meta: {
          ...meta,
          managerApprovalToken: 'tok',
          managerApprovedById: 1,
        },
        actorIsAdmin: false,
        approvalIsValid: async () => true,
      }),
    ).toBeNull();
  });
});
