import { describe, expect, it } from 'vitest';
import {
  CIS_INVOICE_VERIFY_URL,
  fiscalOriginalVerifyUrl,
  fiscalVerificationQr,
  fiscalVoidVerifyUrl,
  formatCisIssueDate,
  formatCisPrice,
  isFiscalPending,
  isFiscalRegistered,
} from './fiscalReceipt';

describe('fiscalVerificationQr', () => {
  it('prefers a complete provider verification link', () => {
    expect(
      fiscalVerificationQr({
        link: 'https://easypos.al/v/ABC',
        nslf: 'IIC-1',
      }),
    ).toBe('https://easypos.al/v/ABC');
  });

  it('builds the official CIS URL with iic, tin, crtd and prc', () => {
    const issuedAt = new Date('2026-09-10T17:59:05.000Z');
    const url = fiscalVerificationQr({
      nslf: 'AEEED62862AD0F62B7C376FF72C97966',
      tin: 'L12345678A',
      issuedAt,
      total: 1600,
    });
    expect(url).toContain(`${CIS_INVOICE_VERIFY_URL}?iic=`);
    expect(url).toContain('iic=AEEED62862AD0F62B7C376FF72C97966');
    expect(url).toContain('tin=L12345678A');
    expect(url).toContain(
      `crtd=${encodeURIComponent(formatCisIssueDate(issuedAt))}`,
    );
    expect(url).toContain('prc=1600.00');
  });

  it('does not send an iic-only CIS link — InvoiceCheck treats that as noData', () => {
    expect(fiscalVerificationQr({ nslf: 'A1B2' })).toBeUndefined();
  });

  it('does not encode a base64 image dump as the QR payload', () => {
    expect(
      fiscalVerificationQr({
        qrCode: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        nslf: 'A1B2',
        tin: 'L12345678A',
        issuedAt: '2026-09-10T19:59:05+02:00',
        total: 10,
      }),
    ).toContain('iic=A1B2');
  });

  it('returns nothing when the invoice has not been issued', () => {
    expect(fiscalVerificationQr({})).toBeUndefined();
  });
});

describe('fiscalVoidVerifyUrl', () => {
  it('builds the CIS check URL for a voided fiscalized sale', () => {
    const url = fiscalVoidVerifyUrl({
      status: 'VOID',
      fiscalNslf: 'AEEED62862AD0F62B7C376FF72C97966',
      fiscalTin: 'L12345678A',
      closedAt: '2026-09-10T19:59:05+02:00',
      total: 1600,
    });
    expect(url).toContain('iic=AEEED62862AD0F62B7C376FF72C97966');
    expect(url).toContain('tin=L12345678A');
    expect(url).toContain('prc=1600.00');
  });

  it('opens the cancellation invoice IIC, not the original cash invoice', () => {
    const url = fiscalVoidVerifyUrl({
      status: 'VOID',
      fiscalNslf: 'ORIGINAL-IIC',
      fiscalTin: 'L12345678A',
      closedAt: '2026-09-10T19:59:05+02:00',
      total: 1600,
      corrections: [
        {
          kind: 'CANCEL',
          correctionNslf: 'CANCEL-IIC',
          filedAt: '2026-09-10T20:05:00+02:00',
          amountDelta: -1600,
        },
      ],
    });
    expect(url).toContain('iic=CANCEL-IIC');
    expect(url).not.toContain('iic=ORIGINAL-IIC');
  });

  it('is absent on a paid ticket, a void without an IIC, or a void missing NIPT', () => {
    expect(
      fiscalVoidVerifyUrl({
        status: 'PAID',
        fiscalNslf: 'A1B2',
        fiscalTin: 'L1',
        closedAt: '2026-09-10T19:59:05+02:00',
        total: 10,
      }),
    ).toBeUndefined();
    expect(fiscalVoidVerifyUrl({ status: 'VOID' })).toBeUndefined();
    expect(
      fiscalVoidVerifyUrl({
        status: 'VOID',
        fiscalNslf: 'A1B2',
        closedAt: '2026-09-10T19:59:05+02:00',
        total: 10,
      }),
    ).toBeUndefined();
  });
});

describe('fiscalOriginalVerifyUrl', () => {
  it('builds the CIS check URL for a paid fiscalized sale', () => {
    expect(
      fiscalOriginalVerifyUrl({
        fiscalNslf: 'A1B2',
        fiscalTin: 'L1',
        closedAt: '2026-09-10T19:59:05+02:00',
        total: 10,
      }),
    ).toContain('iic=A1B2');
  });
});

describe('CIS formatting', () => {
  it('formats price with two decimals', () => {
    expect(formatCisPrice(1600)).toBe('1600.00');
    expect(formatCisPrice(12.5)).toBe('12.50');
  });
});

describe('receipt status', () => {
  it('treats NIVF as registered', () => {
    expect(isFiscalRegistered({ fiscalNivf: 'NIVF-1' })).toBe(true);
    expect(isFiscalRegistered({ fiscalNslf: 'IIC-1' })).toBe(false);
  });

  it('treats a deferred sale as pending, not fiscalized', () => {
    expect(
      isFiscalPending({
        fiscalStatus: 'pending',
        fiscalWarning: 'unreachable',
      }),
    ).toBe(true);
    expect(
      isFiscalPending({ fiscalNivf: 'NIVF-1', fiscalStatus: 'accepted' }),
    ).toBe(false);
  });
});
