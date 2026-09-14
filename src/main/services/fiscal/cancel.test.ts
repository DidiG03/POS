import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createEasyPosCancellation, cancelInvoiceWithRecovery, fiscalConfig } =
  vi.hoisted(() => ({
    createEasyPosCancellation: vi.fn(),
    cancelInvoiceWithRecovery: vi.fn(),
    fiscalConfig: vi.fn(() => ({
      cloud: true,
      operatorCode: 'gh537ez280',
    })),
  }));

vi.mock('./easypos', () => ({
  createEasyPosCancellation,
  fiscalOutcomeOf: (e: any) => e?.fiscalOutcome || 'unknown',
  isFiscalRetryable: (e: any) => e?.fiscalRetryable !== false,
}));

vi.mock('./recover', () => ({
  cancelInvoiceWithRecovery,
}));

vi.mock('./config', () => ({
  fiscalConfig,
}));

import { buildCancellation, cancelInvoice } from './cancel';

beforeEach(() => {
  createEasyPosCancellation.mockReset();
  cancelInvoiceWithRecovery.mockReset();
  fiscalConfig.mockReturnValue({
    cloud: true,
    operatorCode: 'gh537ez280',
  });
});

describe('buildCancellation', () => {
  it('references the original by IIC only — type and issueDateTimeRef are refused', () => {
    const request = buildCancellation({
      docId: 'cancel-doc-1',
      originalDocId: 'sale-doc-1',
      target: {
        iic: 'NSLF-1',
        issueDateTime: '2026-09-10T19:05:13.876Z',
      },
    });
    expect(request.correctiveInvoice).toEqual({ iicRef: 'NSLF-1' });
    expect(request).not.toHaveProperty('invoiceType');
  });
});

describe('cancelInvoice', () => {
  it('uses POST /invoice/cancel recovery on cloud', async () => {
    cancelInvoiceWithRecovery.mockResolvedValueOnce({
      kind: 'complete',
      docId: 'c1',
      identifiers: { fic: 'NIVF-C' },
      via: 'register',
      sendAttempts: 1,
      statusPolls: 0,
    });

    const out = await cancelInvoice({} as any, {
      docId: 'cancel-doc-1',
      originalDocId: 'sale-doc-1',
      target: { iic: 'NSLF-1' },
    });

    expect(cancelInvoiceWithRecovery).toHaveBeenCalledTimes(1);
    expect(createEasyPosCancellation).not.toHaveBeenCalled();
    expect(out.kind).toBe('complete');
  });

  it('posts invoiceType CANCEL on the local middleware', async () => {
    fiscalConfig.mockReturnValue({
      cloud: false,
      operatorCode: '',
    });
    createEasyPosCancellation.mockResolvedValueOnce({
      nslf: 'NSLF-C',
      nivf: 'NIVF-C',
      link: '',
      status: 'accepted',
    });

    const out = await cancelInvoice({} as any, {
      docId: 'cancel-doc-2',
      originalDocId: 'sale-doc-2',
      target: { iic: 'NSLF-1' },
    });

    expect(createEasyPosCancellation).toHaveBeenCalledTimes(1);
    expect(cancelInvoiceWithRecovery).not.toHaveBeenCalled();
    const body = createEasyPosCancellation.mock.calls[0][1];
    expect(body.correctiveInvoice).toEqual({ iicRef: 'NSLF-1' });
    expect(out).toMatchObject({
      kind: 'complete',
      identifiers: { fic: 'NIVF-C' },
    });
  });
});
