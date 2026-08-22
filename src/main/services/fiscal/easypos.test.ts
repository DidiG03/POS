/**
 * Classification of failed registrations.
 *
 * `fiscalizePaymentOnce` decides whether a payment may be retried purely
 * from the tag these errors carry, so getting the tag wrong is the
 * difference between a stuck payment and a duplicate tax document.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import {
  createEasyPosSale,
  fiscalOutcomeOf,
  isFiscalRetryable,
} from './easypos';

const settings = {
  fiscal: {
    enabled: true,
    provider: 'easypos',
    baseUrl: 'http://127.0.0.1:8080',
    authToken: 'token',
  },
} as unknown as SettingsDTO;

const draft = {
  app: 'Code Orbit POS',
  docId: 'doc-1',
  articles: [
    {
      articleId: 'ESP',
      vatCode: 'B',
      name: 'Espresso',
      soldIn: 'XPP',
      price: 150,
      units: 2,
    },
  ],
  payment: { type: 'CARD', amount: 300 },
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fiscalOutcomeOf', () => {
  it('assumes an unclassified error may have registered', () => {
    // Conservative by design: guessing "not registered" is what creates
    // duplicate invoices.
    expect(fiscalOutcomeOf(new Error('something odd'))).toBe('unknown');
    expect(fiscalOutcomeOf(null)).toBe('unknown');
  });

  it('honours an explicit tag', () => {
    const err: any = new Error('rejected');
    err.fiscalOutcome = 'not-registered';
    expect(fiscalOutcomeOf(err)).toBe('not-registered');
  });
});

describe('isFiscalRetryable', () => {
  it('assumes an unclassified error is worth retrying', () => {
    expect(isFiscalRetryable(new Error('socket hang up'))).toBe(true);
    expect(isFiscalRetryable(null)).toBe(true);
  });

  it('marks a refused payload as hopeless until it changes', async () => {
    // A bad articleId is not a blip. Retrying it forever hides the
    // configuration error behind a payment that never completes.
    fetchMock.mockResolvedValue(
      jsonResponse(400, { message: 'Artikulli nuk gjendet' }),
    );
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => isFiscalRetryable(e) === false,
    );
  });

  it('keeps a server-side failure retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => isFiscalRetryable(e) === true,
    );
  });

  it('keeps a refused connection retryable', async () => {
    const err: any = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    fetchMock.mockRejectedValue(err);
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => isFiscalRetryable(e) === true,
    );
  });
});

describe('reading the provider response', () => {
  it('refuses to call a body with no NSLF and no NIVF a success', async () => {
    // This used to come back as `status: 'accepted'` on the strength of an
    // echoed docId, printing a receipt that claimed fiskalizimi with blank
    // numbers and filing an audit row saying the sale was declared.
    fetchMock.mockResolvedValue(jsonResponse(200, { docId: 'doc-1' }));
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => fiscalOutcomeOf(e) === 'unknown',
    );
  });

  it('will not say accepted on an NSLF alone', async () => {
    // The tax service has not issued the invoice number yet.
    fetchMock.mockResolvedValue(
      jsonResponse(200, { response: { nslf: 'A1' } }),
    );
    const out = await createEasyPosSale(settings, draft as any);
    expect(out.status).toBe('pending');
    expect(out.nslf).toBe('A1');
  });

  it('says accepted once the invoice number is there', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { response: { nslf: 'A1', nivf: 'B2' } }),
    );
    const out = await createEasyPosSale(settings, draft as any);
    expect(out.status).toBe('accepted');
  });

  it('honours an explicit pending status even with both identifiers', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { status: 2, response: { nslf: 'A1', nivf: 'B2' } }),
    );
    const out = await createEasyPosSale(settings, draft as any);
    expect(out.status).toBe('pending');
  });
});

describe('createEasyPosSale error classification', () => {
  it('treats a 4xx rejection as nothing filed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { message: 'Artikulli nuk gjendet' }),
    );
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => fiscalOutcomeOf(e) === 'not-registered',
    );
  });

  it('treats a 5xx as indeterminate', async () => {
    // The provider may have filed the invoice and then failed to answer.
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => fiscalOutcomeOf(e) === 'unknown',
    );
  });

  it('treats a refused connection as nothing filed', async () => {
    const err: any = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    fetchMock.mockRejectedValue(err);
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => fiscalOutcomeOf(e) === 'not-registered',
    );
  });

  it('treats an aborted request as indeterminate', async () => {
    const err: any = new Error('The operation was aborted');
    err.name = 'AbortError';
    fetchMock.mockRejectedValue(err);
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => fiscalOutcomeOf(e) === 'unknown',
    );
  });

  it('treats an ambiguous transport failure as indeterminate', async () => {
    // "fetch failed" with no cause could be a reset after the request was
    // already on the wire.
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => fiscalOutcomeOf(e) === 'unknown',
    );
  });

  it('never re-posts a registration after a gateway error', async () => {
    // A 504 means the upstream may already have filed the invoice.
    // Sending it again is precisely how a sale ends up fiscalized twice,
    // so this must surface as unknown rather than retry.
    fetchMock.mockResolvedValue(jsonResponse(504, { message: 'gateway' }));

    await expect(createEasyPosSale(settings, draft as any)).rejects.toSatisfy(
      (e: any) => fiscalOutcomeOf(e) === 'unknown',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a successful registration', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { iic: 'NSLF-1', fic: 'NIVF-1' }),
    );
    const result = await createEasyPosSale(settings, draft as any);
    expect(result.nslf).toBe('NSLF-1');
    expect(result.nivf).toBe('NIVF-1');
    expect(result.status).toBe('accepted');
  });
});
