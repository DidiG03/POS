/**
 * The completion contract.
 *
 * Every case here is a body easyPos returns with HTTP 200. The question is
 * only ever which of them mean a document exists, because the previous
 * implementation answered "most of them" and recorded revenue against
 * invoices the tax service had never accepted.
 */

import { describe, expect, it } from 'vitest';
import {
  assessCompletion,
  readFaultText,
  readIdentifiers,
  targetForInvoice,
} from './completion';

describe('assessCompletion — invoice', () => {
  it('completes on a FIC', () => {
    const verdict = assessCompletion('invoice', { iic: 'A1', fic: 'B2' });
    expect(verdict.complete).toBe(true);
    expect(verdict.identifiers.fic).toBe('B2');
  });

  it('refuses an IIC on its own', () => {
    // The fiscal device allocates the IIC locally, before the tax service
    // is contacted. It is not evidence of a registration.
    const verdict = assessCompletion('invoice', { iic: 'A1' });
    expect(verdict.complete).toBe(false);
    if (verdict.complete) throw new Error('unreachable');
    expect(verdict.missing).toEqual(['fic']);
    expect(verdict.reason).toMatch(/NSLF A1/);
    expect(verdict.reason).toMatch(/not registered/i);
  });

  it('refuses an empty body', () => {
    expect(assessCompletion('invoice', {}).complete).toBe(false);
    expect(assessCompletion('invoice', null).complete).toBe(false);
  });

  it('refuses a body that only echoes the request', () => {
    // This one used to pass, on the strength of the echoed docId.
    const verdict = assessCompletion('invoice', {
      docId: 'inv-1',
      status: 0,
      message: 'OK',
    });
    expect(verdict.complete).toBe(false);
  });

  it('reads identifiers whether they are nested or top level', () => {
    expect(
      assessCompletion('invoice', { response: { fic: 'B2' } }).complete,
    ).toBe(true);
    expect(assessCompletion('invoice', { fic: 'B2' }).complete).toBe(true);
  });

  it('still reads the legacy Albanian field names', () => {
    const ids = readIdentifiers({ response: { nslf: 'A1', nivf: 'B2' } });
    expect(ids.iic).toBe('A1');
    expect(ids.fic).toBe('B2');
  });

  it('treats whitespace as absent', () => {
    expect(assessCompletion('invoice', { fic: '   ' }).complete).toBe(false);
  });

  it('surfaces the provider fault as the reason when there is one', () => {
    const verdict = assessCompletion('invoice', {
      iic: 'A1',
      error: { cisError: { faultString: 'Balanca ditore nuk raportohet' } },
    });
    expect(verdict.complete).toBe(false);
    if (verdict.complete) throw new Error('unreachable');
    expect(verdict.reason).toBe('Balanca ditore nuk raportohet');
  });
});

describe('assessCompletion — electronic invoice', () => {
  it('needs both FIC and EIC', () => {
    expect(
      assessCompletion('electronic-invoice', { fic: 'B2', eic: 'E3' }).complete,
    ).toBe(true);
  });

  it('refuses a FIC without an EIC, and says why it matters', () => {
    const verdict = assessCompletion('electronic-invoice', {
      iic: 'A1',
      fic: 'B2',
    });
    expect(verdict.complete).toBe(false);
    if (verdict.complete) throw new Error('unreachable');
    expect(verdict.missing).toEqual(['eic']);
    expect(verdict.reason).toMatch(/not been delivered as an e-invoice/);
  });

  it('refuses an EIC without a FIC', () => {
    const verdict = assessCompletion('electronic-invoice', { eic: 'E3' });
    expect(verdict.complete).toBe(false);
    if (verdict.complete) throw new Error('unreachable');
    expect(verdict.missing).toEqual(['fic']);
  });
});

describe('assessCompletion — balance and pdf', () => {
  it('completes a balance operation on FCDC only', () => {
    expect(assessCompletion('balance', { fcdc: 'C9' }).complete).toBe(true);
    expect(assessCompletion('balance', { fic: 'B2' }).complete).toBe(false);
  });

  it('completes a PDF on base64 only', () => {
    expect(assessCompletion('pdf', { base64: 'JVBER...' }).complete).toBe(true);
    expect(assessCompletion('pdf', { base64: '' }).complete).toBe(false);
    expect(assessCompletion('pdf', { fic: 'B2' }).complete).toBe(false);
  });
});

describe('targetForInvoice', () => {
  it('picks the stricter contract from the request itself', () => {
    // Read off the request so a caller cannot forget to ask for it.
    expect(targetForInvoice({ isEinvoice: true })).toBe('electronic-invoice');
    expect(targetForInvoice({ isEinvoice: false })).toBe('invoice');
    expect(targetForInvoice({})).toBe('invoice');
  });
});

describe('readFaultText', () => {
  it('reads a CIS fault, including code and environment when present', () => {
    expect(
      readFaultText({
        error: {
          cisError: {
            faultString: 'Bad NUIS',
            faultCode: '12',
            faultEnv: 'env:CLIENT',
          },
        },
      }),
    ).toBe('Bad NUIS · code 12 · env:CLIENT');
  });

  it('does not stringify an error envelope as [object Object]', () => {
    // The old easypos extractor did `String(obj.error)` and reported that.
    expect(
      readFaultText({ error: { otherError: { message: 'rate limited' } } }),
    ).toBe('rate limited');
  });

  it('reads a nested response.text and a string body', () => {
    expect(readFaultText({ response: { text: 'Operatori nuk gjendet' } })).toBe(
      'Operatori nuk gjendet',
    );
    expect(readFaultText('not authorized')).toBe('not authorized');
  });
});
