/**
 * The recovery sequence against a simulated easyPos that misbehaves at
 * random: timeouts after the invoice was stored, 5xx with and without a
 * stored invoice, 401/429, refused connections, status calls that fail.
 *
 * The example tests in recover.test.ts pin individual sequences. This one
 * runs thousands of seeded sequences and checks the rules every one of them
 * must keep, whatever happened:
 *
 *   1. A register body never reaches easyPos once it already holds that
 *      docId. (One sale, one invoice.)
 *   2. `complete` only when easyPos really holds the invoice, with its codes.
 *   3. `rejected`, or `not-registered` without `checkStatusFirst`, only when
 *      easyPos holds nothing — callers resend those blindly.
 *   4. When easyPos holds the invoice and we did not learn it, the result is
 *      `unresolved` or carries `checkStatusFirst`, never a plain retry.
 *
 * A failing seed is printed so it can be replayed by hand.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./transport', () => ({
  easyPosFetch: (url: string, init: unknown) =>
    (globalThis as any).fetch(url, init),
  warmEasyPosConnection: async () => undefined,
}));
import type { SettingsDTO } from '@shared/ipc';
import { __resetDocIdLocks, FISCAL_ROUTES } from './client';
import { registerInvoiceWithRecovery, type RecoveryResult } from './recover';
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
  docId: 'inv-fuzz-1',
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

/** mulberry32: small, seeded, good enough to shuffle failure modes. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const refused = () =>
  Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const unreachable = () =>
  Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' } });
const aborted = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

const CODES = { iic: 'NSLF-FUZZ', fic: 'NIVF-FUZZ' };

interface World {
  /** easyPos holds the invoice for this docId. */
  filed: boolean;
  /** Register bodies that arrived while easyPos already held the docId. */
  duplicates: number;
  /** Register bodies that arrived at all. */
  arrivals: number;
  trace: string[];
}

/**
 * One fetch against the simulated provider. `pick` chooses the failure
 * mode; the world decides what is actually stored.
 */
function simulate(world: World, random: () => number) {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  return async (url: string): Promise<Response> => {
    const route = String(url).slice(String(url).lastIndexOf('/v1') + 3);

    if (route === FISCAL_ROUTES.register) {
      const mode = pick([
        'ok',
        'ok',
        'stored-then-timeout',
        'lost-timeout',
        'refused',
        'unreachable',
        'stored-500',
        'lost-500',
        'stored-502',
        'lost-503',
        'stored-pending',
        '401',
        '429',
        'stored-429',
      ] as const);
      world.trace.push(`register:${mode}`);
      const arrives =
        mode !== 'refused' && mode !== 'unreachable' && mode !== 'lost-timeout';
      if (arrives) {
        world.arrivals += 1;
        if (world.filed) world.duplicates += 1;
      }
      const stores = mode === 'ok' || mode.startsWith('stored-');
      if (stores) world.filed = true;

      switch (mode) {
        case 'ok':
          return json(200, CODES);
        case 'stored-then-timeout':
        case 'lost-timeout':
          throw aborted();
        case 'refused':
          throw refused();
        case 'unreachable':
          throw unreachable();
        case 'stored-500':
        case 'lost-500':
          return json(500, { message: 'Internal Server Error' });
        case 'stored-502':
          return json(502, { message: 'Bad Gateway' });
        case 'lost-503':
          return json(503, { message: 'Service Unavailable' });
        case 'stored-pending':
          // NSLF without NIVF: stored, CIS has not answered yet.
          return json(200, { iic: CODES.iic });
        case '401':
          return json(401, { message: 'Unauthorized' });
        case '429':
        case 'stored-429':
          return json(429, { message: 'Too Many Requests' });
      }
    }

    if (route === FISCAL_ROUTES.status) {
      const mode = pick([
        'answer',
        'answer',
        'answer',
        'refused',
        'timeout',
        '500',
        '401',
        '429',
      ] as const);
      world.trace.push(
        `status:${mode}${mode === 'answer' ? (world.filed ? '=filed' : '=absent') : ''}`,
      );
      switch (mode) {
        case 'answer':
          return world.filed
            ? json(200, CODES)
            : json(200, { message: 'Document not found' });
        case 'refused':
          throw refused();
        case 'timeout':
          throw aborted();
        case '500':
          return json(500, { message: 'Internal Server Error' });
        case '401':
          return json(401, { message: 'Unauthorized' });
        case '429':
          return json(429, { message: 'Too Many Requests' });
      }
    }

    throw new Error(`unexpected route ${route}`);
  };
}

function checkInvariants(
  world: World,
  out: RecoveryResult,
  label: string,
): void {
  const where = `${label} · ${world.trace.join(' → ')} ⇒ ${out.kind}${
    (out as any).checkStatusFirst ? '+check' : ''
  }`;
  // 1. One sale, one invoice.
  expect(world.duplicates, where).toBe(0);

  // 2. Complete means stored, with the codes easyPos gave.
  if (out.kind === 'complete') {
    expect(world.filed, where).toBe(true);
    expect(out.identifiers.fic, where).toBe(CODES.fic);
  }

  // 3. Results a caller may resend blindly must mean "nothing stored".
  if (
    out.kind === 'rejected' ||
    (out.kind === 'not-registered' && !out.checkStatusFirst)
  ) {
    expect(world.filed, where).toBe(false);
  }

  // 4. Stored but not learned: a person or a status-first retry.
  if (world.filed && out.kind !== 'complete') {
    expect(
      out.kind === 'unresolved' ||
        (out.kind === 'not-registered' && out.checkStatusFirst === true),
      where,
    ).toBe(true);
  }
}

const fast = { sleep: async () => undefined };

describe('recovery under a misbehaving easyPos (seeded fuzz)', () => {
  beforeEach(() => {
    __resetDocIdLocks();
  });

  it('never files a second invoice, and never calls a stored invoice unsent', async () => {
    for (let seed = 1; seed <= 2_500; seed++) {
      __resetDocIdLocks();
      const random = rng(seed);
      const world: World = {
        filed: false,
        duplicates: 0,
        arrivals: 0,
        trace: [],
      };
      vi.stubGlobal('fetch', vi.fn(simulate(world, random)));
      const out = await registerInvoiceWithRecovery(settings, request, {
        ...fast,
        random,
      });
      checkInvariants(world, out, `seed ${seed}`);
    }
  });

  it('keeps the rules when an earlier attempt may already have filed it', async () => {
    // statusFirst: the till died mid-send, or a status check never got an
    // answer. Half the time easyPos already has the invoice.
    for (let seed = 1; seed <= 2_500; seed++) {
      __resetDocIdLocks();
      const random = rng(seed * 7919);
      const world: World = {
        filed: random() < 0.5,
        duplicates: 0,
        arrivals: 0,
        trace: [],
      };
      world.trace.push(world.filed ? 'already-filed' : 'never-arrived');
      vi.stubGlobal('fetch', vi.fn(simulate(world, random)));
      const out = await registerInvoiceWithRecovery(settings, request, {
        ...fast,
        random,
        statusFirst: true,
      });
      checkInvariants(world, out, `statusFirst seed ${seed}`);
    }
  });

  it('keeps the rules across a chain of retries until the invoice is settled', async () => {
    // What the deferred loop does: retry until complete, carrying the
    // status-check mark from one attempt to the next as callers must.
    for (let seed = 1; seed <= 600; seed++) {
      const random = rng(seed * 104729);
      const world: World = {
        filed: false,
        duplicates: 0,
        arrivals: 0,
        trace: [],
      };
      vi.stubGlobal('fetch', vi.fn(simulate(world, random)));
      let statusFirst = false;
      let settled = false;
      for (let round = 0; round < 12 && !settled; round++) {
        __resetDocIdLocks();
        const out = await registerInvoiceWithRecovery(settings, request, {
          ...fast,
          random,
          ...(statusFirst ? { statusFirst: true } : {}),
        });
        checkInvariants(world, out, `chain seed ${seed} round ${round}`);
        if (out.kind === 'not-registered') {
          statusFirst = statusFirst || out.checkStatusFirst === true;
          continue;
        }
        // complete, rejected, unresolved: the loop stops retrying.
        settled = true;
        if (out.kind === 'complete') {
          expect(world.filed).toBe(true);
        }
      }
      expect(
        world.duplicates,
        `chain seed ${seed}: ${world.trace.join(' → ')}`,
      ).toBe(0);
    }
  });
});
