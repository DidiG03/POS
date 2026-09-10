/**
 * The error decision table.
 *
 * The two ways to get this wrong are not symmetric. Calling a filed
 * invoice "not registered" files it twice and needs a corrective document
 * to unwind; calling an unfiled one "unknown" strands a sale in a review
 * queue. So the bias is toward `unknown` + a status check, and the cases
 * that are allowed to claim `not-registered` are the ones that can prove
 * it.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyFiscalAttempt,
  isAnotherRequestProcessing,
  isNotFoundStatus,
} from './classify';

const cis = (faultEnv: string, faultString = 'boom') => ({
  error: { cisError: { faultEnv, faultString } },
});

describe('not retryable — the request itself must change', () => {
  it('a 400 validation failure', () => {
    const c = classifyFiscalAttempt({
      httpStatus: 400,
      data: { message: 'docId is required' },
    });
    expect(c.action).toBe('fix-request');
    expect(c.retryable).toBe(false);
    expect(c.outcome).toBe('not-registered');
  });

  it('a cisError blamed on the client', () => {
    const c = classifyFiscalAttempt({
      httpStatus: 200,
      data: cis('env:CLIENT'),
    });
    expect(c.action).toBe('fix-request');
    expect(c.retryable).toBe(false);
  });

  it('reads env:CLIENT regardless of case, and on a 4xx too', () => {
    expect(
      classifyFiscalAttempt({ httpStatus: 400, data: cis('ENV:CLIENT') })
        .retryable,
    ).toBe(false);
    expect(
      classifyFiscalAttempt({ httpStatus: 500, data: cis('env:client') })
        .retryable,
    ).toBe(false);
  });

  it('a 404, which is a wrong base URL rather than a transient fault', () => {
    const c = classifyFiscalAttempt({ httpStatus: 404, data: null });
    expect(c.action).toBe('fix-request');
    expect(c.message).toMatch(/fiscalisation-service\/v1/);
  });
});

describe('retryable — but only through a status check', () => {
  it('a cisError blamed on the tax service', () => {
    const c = classifyFiscalAttempt({
      httpStatus: 200,
      data: cis('env:SERVER'),
    });
    expect(c.action).toBe('check-status');
    expect(c.retryable).toBe(true);
    expect(c.outcome).toBe('unknown');
    expect(c.mustCheckStatus).toBe(true);
  });

  it('an otherError', () => {
    const c = classifyFiscalAttempt({
      httpStatus: 200,
      data: { error: { otherError: { message: 'upstream unavailable' } } },
    });
    expect(c.action).toBe('check-status');
    expect(c.retryable).toBe(true);
  });

  it.each([502, 503, 504])('HTTP %i', (httpStatus) => {
    const c = classifyFiscalAttempt({ httpStatus, data: null });
    expect(c.action).toBe('check-status');
    expect(c.outcome).toBe('unknown');
    expect(c.retryable).toBe(true);
  });

  it('a timeout', () => {
    const err: any = new Error('The operation was aborted');
    err.name = 'AbortError';
    const c = classifyFiscalAttempt({ error: err });
    expect(c.action).toBe('check-status');
    expect(c.outcome).toBe('unknown');
  });

  it('an incomplete 200 with nothing else to go on', () => {
    const c = classifyFiscalAttempt({
      httpStatus: 200,
      data: { iic: 'A1' },
      incomplete: true,
      incompleteReason: 'no NIVF',
    });
    expect(c.action).toBe('check-status');
    expect(c.outcome).toBe('unknown');
    expect(c.message).toBe('no NIVF');
  });

  it('an unclassified transport failure', () => {
    // "fetch failed" with no cause could be a reset after the request was
    // already on the wire, so it cannot claim nothing happened.
    const c = classifyFiscalAttempt({ error: new Error('fetch failed') });
    expect(c.outcome).toBe('unknown');
    expect(c.mustCheckStatus).toBe(true);
  });
});

describe('retryable, and provably nothing was filed', () => {
  it('a refused connection', () => {
    const err: any = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    const c = classifyFiscalAttempt({ error: err });
    expect(c.action).toBe('retry');
    expect(c.outcome).toBe('not-registered');
    expect(c.mustCheckStatus).toBe(false);
  });

  it('an unresolvable host', () => {
    const err: any = new Error('fetch failed');
    err.cause = { code: 'ENOTFOUND' };
    expect(classifyFiscalAttempt({ error: err }).outcome).toBe(
      'not-registered',
    );
  });

  it('a downed network, which is what a till sees when wifi is off', () => {
    // ENETUNREACH used to fall through as an unclassified transport
    // failure, which parked the sale in review as if an invoice might
    // already exist and then refused to retry it when the network came back.
    const err: any = new Error('fetch failed');
    err.cause = { code: 'ENETUNREACH' };
    const c = classifyFiscalAttempt({ error: err });
    expect(c.action).toBe('retry');
    expect(c.outcome).toBe('not-registered');
    expect(c.mustCheckStatus).toBe(false);
  });

  it('reads ENETUNREACH off an AggregateError, which is how Node fetch reports it', () => {
    const err: any = new Error('fetch failed');
    err.cause = {
      name: 'AggregateError',
      errors: [{ code: 'ENETUNREACH', message: 'connect ENETUNREACH' }],
    };
    expect(classifyFiscalAttempt({ error: err }).outcome).toBe(
      'not-registered',
    );
  });

  it('a connect timeout, before any HTTP request left the machine', () => {
    const err: any = new Error('Connect Timeout Error');
    err.code = 'UND_ERR_CONNECT_TIMEOUT';
    const c = classifyFiscalAttempt({ error: err });
    expect(c.outcome).toBe('not-registered');
    expect(c.mustCheckStatus).toBe(false);
  });

  it('still treats a reset after connect as indeterminate', () => {
    // The request may already have been on the wire.
    const err: any = new Error('fetch failed');
    err.cause = { code: 'ECONNRESET' };
    const c = classifyFiscalAttempt({ error: err });
    expect(c.outcome).toBe('unknown');
    expect(c.mustCheckStatus).toBe(true);
  });

  it('a rate limit', () => {
    const c = classifyFiscalAttempt({ httpStatus: 429, data: null });
    expect(c.action).toBe('retry');
    expect(c.outcome).toBe('not-registered');
  });
});

describe('auth', () => {
  it('a 401 asks for a renewal and keeps the docId', () => {
    const c = classifyFiscalAttempt({ httpStatus: 401, data: null });
    expect(c.action).toBe('renew-token');
    expect(c.retryable).toBe(true);
    expect(c.outcome).toBe('not-registered');
    expect(c.message).toMatch(/same docId/);
  });

  it('a 403 is a permission problem, not a stale token', () => {
    const c = classifyFiscalAttempt({ httpStatus: 403, data: null });
    // Renewing cannot widen what this integration app may call, and the
    // recovery sequence only allows one renewal per document.
    expect(c.action).toBe('fix-request');
    expect(c.retryable).toBe(false);
    expect(c.outcome).toBe('not-registered');
    expect(c.message).toMatch(/not permitted/);
  });
});

describe('"another request is processing"', () => {
  it('wins over the 400 it arrives with', () => {
    // Classified as a validation error, this would abandon a document that
    // is in the middle of being created.
    const c = classifyFiscalAttempt({
      httpStatus: 400,
      data: { message: 'Another request is processing for this document' },
    });
    expect(c.action).toBe('wait-and-poll');
    expect(c.retryable).toBe(true);
    expect(c.outcome).toBe('unknown');
  });

  it('is recognised in Albanian too', () => {
    expect(
      isAnotherRequestProcessing({
        error: {
          cisError: { faultString: 'Një kërkesë tjetër është në proces' },
        },
      }),
    ).toBe(true);
  });

  it('does not fire on unrelated text', () => {
    expect(
      isAnotherRequestProcessing({ message: 'Artikulli nuk gjendet' }),
    ).toBe(false);
    expect(isAnotherRequestProcessing({})).toBe(false);
  });
});

describe('isNotFoundStatus — the only green light for a replay', () => {
  it('accepts an explicit not-found about the document', () => {
    expect(isNotFoundStatus({ httpStatus: 404 })).toBe(true);
    expect(
      isNotFoundStatus({
        httpStatus: 200,
        data: { message: 'Document not found' },
      }),
    ).toBe(true);
    expect(
      isNotFoundStatus({
        httpStatus: 200,
        data: { message: 'docId not found' },
      }),
    ).toBe(true);
    expect(
      isNotFoundStatus({
        httpStatus: 200,
        data: { error: { cisError: { faultString: 'Dokumenti nuk gjendet' } } },
      }),
    ).toBe(true);
    expect(
      isNotFoundStatus({
        httpStatus: 200,
        data: { message: 'No such invoice for this docId' },
      }),
    ).toBe(true);
  });

  it('accepts a machine-readable code', () => {
    expect(
      isNotFoundStatus({
        httpStatus: 200,
        data: { error: { otherError: { code: 'DOC_NOT_FOUND' } } },
      }),
    ).toBe(true);
    expect(
      isNotFoundStatus({ httpStatus: 200, data: { status: 'NOT_FOUND' } }),
    ).toBe(true);
  });

  it('refuses an empty or silent body', () => {
    // The dangerous one: an empty status response means "could not tell
    // you", not "does not exist". Replaying on it files a second invoice
    // for a sale that is already registered.
    expect(isNotFoundStatus({ httpStatus: 200, data: {} })).toBe(false);
    expect(isNotFoundStatus({ httpStatus: 200, data: null })).toBe(false);
    expect(isNotFoundStatus({ httpStatus: 500, data: null })).toBe(false);
  });

  it('refuses a not-found about something other than the document', () => {
    // "Operator not found" is a bad operatorCode in our request. Reading
    // it as an absent document would replay the invoice and file it twice.
    expect(
      isNotFoundStatus({
        httpStatus: 200,
        data: { error: { cisError: { faultString: 'Operatori nuk gjendet' } } },
      }),
    ).toBe(false);
    expect(
      isNotFoundStatus({
        httpStatus: 200,
        data: { error: { cisError: { faultString: 'Artikulli nuk gjendet' } } },
      }),
    ).toBe(false);
    expect(
      isNotFoundStatus({
        httpStatus: 200,
        data: { message: 'Unknown operator code' },
      }),
    ).toBe(false);
  });

  it('refuses a bare "not found" with no subject', () => {
    // Too ambiguous to bet a duplicate invoice on.
    expect(
      isNotFoundStatus({ httpStatus: 200, data: { message: 'not found' } }),
    ).toBe(false);
  });
});
