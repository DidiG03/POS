/**
 * The claim store driven by thousands of seeded random histories: payment
 * retries, sends that succeed, fail, time out or die with the till, offline
 * queueing, the sweep that requeues interrupted sends, and voids.
 *
 * A simulated easyPos records whether it really holds the invoice. Whatever
 * the order of events, the claim must keep these rules:
 *
 *   1. A send is let through (`proceed`) while easyPos may hold the invoice
 *      only if the claim makes it ask `/invoice/status` first.
 *   2. Never two sends at once: no `proceed` while another send is live.
 *   3. Once a registration is stored, every later decision replays its NIVF
 *      or asks a person — never another send, never "withdrawn".
 *   4. A void never withdraws an invoice easyPos holds.
 */

import { describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({
  store: new Map<string, { valueJson: any; updatedAt: Date }>(),
}));

vi.mock('@db/client', () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => []),
    syncState: {
      create: vi.fn(async ({ data }: any) => {
        if (store.has(data.key)) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        store.set(data.key, {
          valueJson: JSON.parse(JSON.stringify(data.valueJson)),
          updatedAt: new Date(),
        });
        return { key: data.key };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = store.get(where.key);
        store.set(where.key, {
          valueJson: JSON.parse(
            JSON.stringify(existing ? update.valueJson : create.valueJson),
          ),
          updatedAt: new Date(),
        });
        return { key: where.key };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = store.get(where.key);
        return row ? { key: where.key, ...row } : null;
      }),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    user: { findMany: vi.fn(async () => []) },
    notification: { create: vi.fn(async () => ({})) },
  },
}));

import {
  abandonUnsentFiscalClaimUnlocked,
  claimFiscalRegistration,
  commitRegisteredFiscalClaim,
  fiscalClaimKey,
  parkUnconfirmedClaimUnlocked,
  PROCESS_STARTED_AT,
  readFiscalClaim,
  requeueDeadDeferredDraftUnlocked,
  settleFiscalClaimDeferred,
  settleFiscalClaimFailed,
  settleFiscalClaimUnknown,
} from './claims';

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

const KEY = 'pay-prop';
const NIVF = 'NIVF-PROP';
const DRAFT = { docId: KEY, articles: [], payment: [] };
const noSleep = { sleep: async () => undefined };

/** The till died: this claim was written by an earlier run. */
function crashClock(): void {
  const row = store.get(fiscalClaimKey(KEY));
  if (!row) return;
  const before = new Date(PROCESS_STARTED_AT - 1_000).toISOString();
  store.set(fiscalClaimKey(KEY), {
    ...row,
    valueJson: { ...row.valueJson, createdAt: before, updatedAt: before },
  });
}

interface Attempt {
  id: string;
  live: boolean;
  /** The send carried a status check, so it cannot file a duplicate. */
  checked: boolean;
}

describe('fiscal claim histories (seeded)', () => {
  it('never lets a sale be filed twice or a filed invoice be withdrawn', async () => {
    for (let seed = 1; seed <= 3_000; seed++) {
      store.clear();
      const random = rng(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
      const coin = () => random() < 0.5;

      let filed = false;
      let registeredStored = false;
      let duplicates = 0;
      const attempts: Attempt[] = [];
      const trace: string[] = [];
      const where = () => `seed ${seed}: ${trace.join(' → ')}`;

      for (let step = 0; step < 14; step++) {
        const live = attempts.find((a) => a.live);
        const op = live
          ? pick([
              'send-ok',
              'send-ok',
              'defer',
              'defer-unsure',
              'fail',
              'unknown',
              'crash',
              'retry',
            ] as const)
          : pick(['retry', 'retry', 'sweep', 'void', 'void-checked'] as const);
        trace.push(op);

        if (op === 'retry') {
          const before = await readFiscalClaim(KEY);
          const d = await claimFiscalRegistration(KEY, { area: 'Bar' });
          trace.push(`=${d.outcome}`);
          if (registeredStored) {
            // 3.
            expect(['replay', 'needs-review'], where()).toContain(d.outcome);
            if (d.outcome === 'replay') {
              expect(d.result.nivf, where()).toBe(NIVF);
            }
          }
          if (d.outcome === 'proceed') {
            // 2.
            expect(live, where()).toBeUndefined();
            expect([undefined, 'FAILED', 'DEFERRED'], where()).toContain(
              before?.state,
            );
            const after = await readFiscalClaim(KEY);
            const checked = after?.checkStatusFirst === true;
            // 1.
            if (filed) expect(checked, where()).toBe(true);
            attempts.push({ id: d.attemptId, live: true, checked });
          }
          continue;
        }

        if (live) {
          live.live = false;
          switch (op) {
            case 'send-ok': {
              // A checked send finds an existing invoice instead of
              // posting it again.
              if (filed && !live.checked) duplicates += 1;
              filed = true;
              const stored = await commitRegisteredFiscalClaim(
                KEY,
                live.id,
                { nivf: NIVF, nslf: 'NSLF-PROP' },
                noSleep,
              );
              if (stored.ok) registeredStored = true;
              break;
            }
            case 'defer':
              // Never reached easyPos.
              await settleFiscalClaimDeferred(
                KEY,
                live.id,
                'offline',
                DRAFT,
                new Date().toISOString(),
              );
              break;
            case 'defer-unsure':
              // Reached it, outcome unconfirmed: queued with a status check.
              if (coin()) {
                if (filed && !live.checked) duplicates += 1;
                filed = true;
              }
              await settleFiscalClaimDeferred(
                KEY,
                live.id,
                'status unavailable',
                DRAFT,
                new Date().toISOString(),
                { checkStatusFirst: true },
              );
              break;
            case 'fail':
              // Refused outright: nothing stored.
              await settleFiscalClaimFailed(KEY, live.id, 'rejected');
              break;
            case 'unknown':
              if (coin()) {
                if (filed && !live.checked) duplicates += 1;
                filed = true;
              }
              await settleFiscalClaimUnknown(KEY, live.id, 'timeout');
              break;
            case 'crash':
              if (coin()) {
                if (filed && !live.checked) duplicates += 1;
                filed = true;
              }
              crashClock();
              break;
          }
          continue;
        }

        if (op === 'sweep') {
          const requeued = await requeueDeadDeferredDraftUnlocked(KEY);
          if (requeued) {
            expect(
              (await readFiscalClaim(KEY))?.checkStatusFirst,
              where(),
            ).toBe(true);
          }
          continue;
        }

        if (op === 'void' || op === 'void-checked') {
          const record = await readFiscalClaim(KEY);
          let withdrawn = false;
          if (op === 'void-checked' && record?.checkStatusFirst) {
            // The admin path asks easyPos first.
            if (filed) {
              await parkUnconfirmedClaimUnlocked(KEY, 'voided; easyPos has it');
            } else {
              withdrawn = await abandonUnsentFiscalClaimUnlocked(
                KEY,
                'voided',
                {
                  statusConfirmedAbsent: true,
                },
              );
            }
          } else {
            withdrawn = await abandonUnsentFiscalClaimUnlocked(KEY, 'voided');
            if (!withdrawn) await parkUnconfirmedClaimUnlocked(KEY, 'voided');
          }
          trace.push(`=${withdrawn ? 'withdrawn' : 'kept'}`);
          // 4.
          if (withdrawn) expect(filed, where()).toBe(false);
          continue;
        }
      }

      expect(duplicates, where()).toBe(0);
    }
  });
});
