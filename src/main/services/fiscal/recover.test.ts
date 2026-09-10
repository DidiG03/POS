/**
 * The recovery sequence.
 *
 * These are the duplicate-invoice tests. Each case asks the same question
 * from a different angle: after an ambiguous answer, does the code send a
 * second `/invoice/register`, and was it entitled to?
 *
 * The rule being enforced is that a replay requires the provider to have
 * said, explicitly, that it has never seen this docId. Anything less polls
 * again or gives up to a human.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import { __resetDocIdLocks, FISCAL_ROUTES } from './client';
import { registerInvoiceWithRecovery } from './recover';
import type { RegisterInvoiceRequest } from './apiTypes';

const settings = {
  fiscal: {
    enabled: true,
    provider: 'easypos',
    baseUrl: 'https://api.dev.easypos.al/fiscalisation-service/v1',
    authToken: 'jwt',
    integrationApp: 'generic',
    defaultOperatorId: 'gh537ez280',
  },
} as unknown as SettingsDTO;

const request: RegisterInvoiceRequest = {
  docId: 'inv-recovery-1',
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
  payment: [{ type: 'CASH', amount: 300 }],
};

/**
 * An electronic invoice needs a process and a buyer to be a legal request
 * at all, so the recovery tests that exercise the `fic`+`eic` contract have
 * to send a complete one — otherwise they never reach the transport.
 */
const eInvoiceRequest: RegisterInvoiceRequest = {
  ...request,
  isEinvoice: true,
  selectedProcess: 'P1',
  buyer: {
    buyerIDType: 'NUIS',
    buyerID: 'L41323029B',
    name: 'Buyer sh.p.k.',
  },
};

/** No real waiting, and a deterministic jitter. */
const fast = {
  sleep: async () => undefined,
  random: () => 0.5,
};

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Which routes were hit, in order. */
function routesCalled(): string[] {
  return fetchMock.mock.calls.map((call) => {
    const url = String(call[0]);
    return url.slice(url.lastIndexOf('/v1') + 3);
  });
}

function countOf(route: string): number {
  return routesCalled().filter((r) => r === route).length;
}

beforeEach(() => {
  __resetDocIdLocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('the happy path', () => {
  it('registers once and asks nothing else', async () => {
    fetchMock.mockResolvedValue(json(200, { iic: 'A1', fic: 'B2' }));
    const out = await registerInvoiceWithRecovery(settings, request, fast);

    expect(out.kind).toBe('complete');
    if (out.kind !== 'complete') throw new Error('unreachable');
    expect(out.via).toBe('register');
    expect(out.identifiers.fic).toBe('B2');
    expect(countOf(FISCAL_ROUTES.register)).toBe(1);
    expect(countOf(FISCAL_ROUTES.status)).toBe(0);
  });
});

describe('an ambiguous outcome goes through the status check', () => {
  it('a timeout that turns out to have been filed is NOT re-registered', async () => {
    // The whole point. The invoice exists; sending it again would file a
    // second tax document for one sale.
    fetchMock
      .mockRejectedValueOnce(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      )
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, request, fast);

    expect(out.kind).toBe('complete');
    if (out.kind !== 'complete') throw new Error('unreachable');
    expect(out.via).toBe('status');
    expect(countOf(FISCAL_ROUTES.register)).toBe(1);
    expect(countOf(FISCAL_ROUTES.status)).toBe(1);
    expect(routesCalled()).toEqual([
      FISCAL_ROUTES.register,
      FISCAL_ROUTES.status,
    ]);
  });

  it('a 502 that turns out to have been filed is NOT re-registered', async () => {
    fetchMock
      .mockResolvedValueOnce(json(502, { message: 'bad gateway' }))
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, request, fast);
    expect(out.kind).toBe('complete');
    expect(countOf(FISCAL_ROUTES.register)).toBe(1);
  });

  it('replays only after the provider says it never saw the docId', async () => {
    fetchMock
      .mockResolvedValueOnce(json(503, { message: 'unavailable' }))
      .mockResolvedValueOnce(json(200, { message: 'Document not found' }))
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, request, fast);

    expect(out.kind).toBe('complete');
    if (out.kind !== 'complete') throw new Error('unreachable');
    expect(out.via).toBe('replay');
    expect(routesCalled()).toEqual([
      FISCAL_ROUTES.register,
      FISCAL_ROUTES.status,
      FISCAL_ROUTES.register,
    ]);
  });

  it('replays the byte-identical body under the same docId', async () => {
    fetchMock
      .mockResolvedValueOnce(json(504, {}))
      .mockResolvedValueOnce(json(200, { message: 'docId not found' }))
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    await registerInvoiceWithRecovery(settings, request, fast);

    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(FISCAL_ROUTES.register))
      .map(([, init]) => String((init as any).body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[1]!).docId).toBe('inv-recovery-1');
  });

  it('keeps polling when the status is itself inconclusive', async () => {
    fetchMock
      .mockResolvedValueOnce(json(502, {}))
      // An empty status body is "cannot tell you", not "does not exist".
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, request, fast);
    expect(out.kind).toBe('complete');
    expect(countOf(FISCAL_ROUTES.register)).toBe(1);
    expect(countOf(FISCAL_ROUTES.status)).toBe(2);
  });

  it('gives up to a human rather than replay on a silent status', async () => {
    fetchMock
      .mockResolvedValueOnce(json(502, {}))
      .mockResolvedValue(json(200, {}));

    const out = await registerInvoiceWithRecovery(settings, request, {
      ...fast,
      maxStatusPolls: 2,
    });

    expect(out.kind).toBe('unresolved');
    if (out.kind !== 'unresolved') throw new Error('unreachable');
    expect(out.message).toMatch(/must be checked in easyPos/);
    // Never sent twice.
    expect(countOf(FISCAL_ROUTES.register)).toBe(1);
  });

  it('does not replay when the fault was about the operator, not the document', async () => {
    // "Operatori nuk gjendet" is a bad operatorCode in our own request.
    fetchMock.mockResolvedValueOnce(json(502, {})).mockResolvedValue(
      json(200, {
        error: { cisError: { faultString: 'Operatori nuk gjendet' } },
      }),
    );

    const out = await registerInvoiceWithRecovery(settings, request, {
      ...fast,
      maxStatusPolls: 2,
    });

    expect(out.kind).toBe('unresolved');
    expect(countOf(FISCAL_ROUTES.register)).toBe(1);
  });
});

describe('an incomplete 200 is not a success', () => {
  it('treats an IIC with no FIC as ambiguous and checks the status', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { iic: 'A1' }))
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, request, fast);
    expect(out.kind).toBe('complete');
    expect(countOf(FISCAL_ROUTES.status)).toBe(1);
  });

  it('requires the EIC too for an electronic invoice', async () => {
    // FIC present, EIC absent: filed for tax, not delivered as an
    // e-invoice. Not done.
    fetchMock.mockResolvedValue(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, eInvoiceRequest, {
      ...fast,
      maxStatusPolls: 1,
    });
    expect(out.kind).toBe('unresolved');
  });

  it('completes an electronic invoice once the EIC arrives', async () => {
    fetchMock.mockResolvedValue(json(200, { iic: 'A1', fic: 'B2', eic: 'E3' }));
    const out = await registerInvoiceWithRecovery(
      settings,
      eInvoiceRequest,
      fast,
    );
    expect(out.kind).toBe('complete');
    if (out.kind !== 'complete') throw new Error('unreachable');
    expect(out.identifiers.eic).toBe('E3');
  });
});

describe('failures that must not be retried', () => {
  it('stops dead on a 400', async () => {
    fetchMock.mockResolvedValue(json(400, { message: 'articles is required' }));
    const out = await registerInvoiceWithRecovery(settings, request, fast);

    expect(out.kind).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops dead on cisError env:CLIENT', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        error: {
          cisError: { faultEnv: 'env:CLIENT', faultString: 'Bad NUIS' },
        },
      }),
    );
    const out = await registerInvoiceWithRecovery(settings, request, fast);

    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') throw new Error('unreachable');
    expect(out.message).toMatch(/env:CLIENT/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a cisError env:SERVER through the status route', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          error: {
            cisError: { faultEnv: 'env:SERVER', faultString: 'CIS down' },
          },
        }),
      )
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, request, fast);
    expect(out.kind).toBe('complete');
  });
});

/**
 * The gate exists because the path every real sale takes assembles its
 * request by hand and never called the builders that used to hold these
 * checks. A rule the API enforces is only worth writing down once nothing
 * can go around it.
 */
describe('validation before the first POST', () => {
  it('never contacts easyPos when the payment does not match the articles', async () => {
    const out = await registerInvoiceWithRecovery(
      settings,
      { ...request, payment: [{ type: 'CASH', amount: 250 }] },
      fast,
    );

    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') throw new Error('unreachable');
    expect(out.message).toMatch(/250\.00.*300\.00/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects rather than spending a docId on a short one', async () => {
    const out = await registerInvoiceWithRecovery(
      settings,
      { ...request, docId: 'abc' },
      fast,
    );

    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') throw new Error('unreachable');
    expect(out.message).toMatch(/docId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an electronic invoice with no process or buyer', async () => {
    const out = await registerInvoiceWithRecovery(
      settings,
      { ...request, isEinvoice: true },
      fast,
    );

    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') throw new Error('unreachable');
    expect(out.message).toMatch(/selectedProcess/);
    expect(out.message).toMatch(/buyer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a rejection as nothing sent, so the docId stays usable', async () => {
    const out = await registerInvoiceWithRecovery(
      settings,
      { ...request, articles: [] },
      fast,
    );

    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') throw new Error('unreachable');
    expect(out.sendAttempts).toBe(0);
    expect(out.statusPolls).toBe(0);
    expect(out.docId).toBe(request.docId);
  });

  it('lets a valid request straight through', async () => {
    fetchMock.mockResolvedValue(json(200, { iic: 'A1', fic: 'B2' }));
    const out = await registerInvoiceWithRecovery(settings, request, fast);
    expect(out.kind).toBe('complete');
  });
});

describe('a 403 is not a stale token', () => {
  it('stops instead of spending the one token renewal it is allowed', async () => {
    fetchMock.mockResolvedValue(json(403, { message: 'forbidden' }));
    const onTokenRenew = vi.fn(async () => 'fresh-token');

    const out = await registerInvoiceWithRecovery(settings, request, {
      ...fast,
      onTokenRenew,
    });

    expect(out.kind).toBe('rejected');
    expect(onTokenRenew).not.toHaveBeenCalled();
    expect(countOf(FISCAL_ROUTES.register)).toBe(1);
  });
});

describe('"another request is processing"', () => {
  it('waits and polls instead of sending again', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(400, {
          message: 'Another request is processing for this document',
        }),
      )
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, request, fast);

    expect(out.kind).toBe('complete');
    expect(countOf(FISCAL_ROUTES.register)).toBe(1);
    expect(countOf(FISCAL_ROUTES.status)).toBe(1);
  });
});

describe('a refused connection', () => {
  it('retries the same docId directly, since nothing was sent', async () => {
    const refused = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    fetchMock
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    const out = await registerInvoiceWithRecovery(settings, request, fast);

    expect(out.kind).toBe('complete');
    // No status check needed: the request provably never left the machine.
    expect(countOf(FISCAL_ROUTES.status)).toBe(0);
    expect(countOf(FISCAL_ROUTES.register)).toBe(2);
  });

  it('reports not-registered once the attempts are spent', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );
    const out = await registerInvoiceWithRecovery(settings, request, {
      ...fast,
      maxSendAttempts: 2,
    });
    expect(out.kind).toBe('not-registered');
    expect(countOf(FISCAL_ROUTES.register)).toBe(2);
  });

  it('treats a downed network the same way — nothing was filed', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('fetch failed'), {
        cause: { code: 'ENETUNREACH' },
      }),
    );
    const out = await registerInvoiceWithRecovery(settings, request, {
      ...fast,
      maxSendAttempts: 2,
    });
    expect(out.kind).toBe('not-registered');
    expect(countOf(FISCAL_ROUTES.status)).toBe(0);
    expect(countOf(FISCAL_ROUTES.register)).toBe(2);
  });
});

describe('token renewal', () => {
  it('renews for the environment and repeats the same docId', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { message: 'unauthorized' }))
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));
    const onTokenRenew = vi.fn(async () => 'fresh-jwt');

    const out = await registerInvoiceWithRecovery(settings, request, {
      ...fast,
      onTokenRenew,
    });

    expect(out.kind).toBe('complete');
    expect(onTokenRenew).toHaveBeenCalledWith('dev');
    const second = fetchMock.mock.calls[1]![1] as any;
    expect(second.headers.Authorization).toBe('Bearer fresh-jwt');
    // Same docId, same body.
    expect(JSON.parse(String(second.body)).docId).toBe('inv-recovery-1');
  });

  it('does not loop when renewal is impossible', async () => {
    fetchMock.mockResolvedValue(json(401, {}));
    const out = await registerInvoiceWithRecovery(settings, request, fast);
    expect(out.kind).toBe('not-registered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('serialisation by docId', () => {
  it('never runs two attempts for one docId at the same time', async () => {
    // Two tablets retrying the same payment. If they interleave, one can
    // ask for a status while the other is mid-register — and get a "not
    // found" for an invoice that is being written as it asks.
    let concurrent = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return json(200, { iic: 'A1', fic: 'B2' });
    });

    await Promise.all([
      registerInvoiceWithRecovery(settings, request, fast),
      registerInvoiceWithRecovery(settings, request, fast),
    ]);

    expect(peak).toBe(1);
  });

  it('lets different docIds proceed in parallel', async () => {
    let concurrent = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return json(200, { iic: 'A1', fic: 'B2' });
    });

    await Promise.all([
      registerInvoiceWithRecovery(settings, request, fast),
      registerInvoiceWithRecovery(
        settings,
        { ...request, docId: 'inv-recovery-2' },
        fast,
      ),
    ]);

    expect(peak).toBe(2);
  });

  it('releases the lock after a failed attempt', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await registerInvoiceWithRecovery(settings, request, {
      ...fast,
      maxStatusPolls: 0,
    });

    fetchMock.mockResolvedValue(json(200, { iic: 'A1', fic: 'B2' }));
    const out = await registerInvoiceWithRecovery(settings, request, fast);
    expect(out.kind).toBe('complete');
  });
});

describe('the integration-app header', () => {
  it('is sent on the status route too, not just register', async () => {
    fetchMock
      .mockResolvedValueOnce(json(502, {}))
      .mockResolvedValueOnce(json(200, { iic: 'A1', fic: 'B2' }));

    await registerInvoiceWithRecovery(settings, request, fast);

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as any).headers['integration-app']).toBe('generic');
      expect((init as any).headers.Authorization).toBe('Bearer jwt');
    }
  });
});
