/**
 * Cash declared to the tax service from Admin (QA round 6, fiscal).
 *
 * The balance routes were implemented (`balance.ts`) but nothing called
 * the deposit and withdraw ones: cash put into or taken out of the drawer
 * during the day was never declared, and the opening float was always the
 * fixed `openingFloat` setting, declared automatically before the first
 * cash sale. An admin can now declare:
 *   - the opening float as counted, before the first cash sale of the day
 *     (the setting stays the fallback when nobody does);
 *   - cash put in, and cash taken out, as they happen.
 * Amounts are in lekë, as filed.
 */
import type { SettingsDTO } from '@shared/ipc';
import { prisma } from '@db/client';
import {
  depositCash,
  initiateDailyBalance,
  readDailyBalanceRecord,
  withdrawCash,
  type BalanceOutcome,
} from './balance';
import { isFiscalEnabled } from './index';

export type CashDeclaration = 'opening' | 'deposit' | 'withdraw';

export type CashDeclarationResult =
  | { ok: true; kind: BalanceOutcome['kind']; docId: string; fcdc?: string }
  | { ok: false; error: string; docId?: string };

/** A key the screen sends once per declaration, so a retry declares once. */
function docIdFrom(requestKey: unknown): string | undefined {
  const key = String(requestKey ?? '')
    .trim()
    .replace(/[^A-Za-z0-9-]/g, '')
    .slice(0, 60);
  return key.length >= 5 ? `cash-${key}` : undefined;
}

/** Every declaration asked for, kept on the till (QA v0.2.103, #9). */
export const CASH_DECLARATION_LOG_KEY = 'fiscal:cashDeclarations';
const CASH_LOG_LIMIT = 2000;

export type CashDeclarationLogEntry = {
  at: string;
  kind: string;
  amount: number | null;
  requestKey: string | null;
  actorUserId: number | null;
  ok: boolean;
  outcome: string;
  docId?: string;
  fcdc?: string;
  error?: string;
};

/** The local record, newest last. */
export async function listCashDeclarations(): Promise<
  CashDeclarationLogEntry[]
> {
  const row = await prisma.syncState
    .findUnique({ where: { key: CASH_DECLARATION_LOG_KEY } })
    .catch(() => null);
  const entries = (row?.valueJson as any)?.entries;
  return Array.isArray(entries) ? entries : [];
}

let logWrites: Promise<void> = Promise.resolve();

/** Append one entry. Serialised, and never fails the declaration itself. */
function recordDeclaration(entry: CashDeclarationLogEntry): Promise<void> {
  logWrites = logWrites
    .then(async () => {
      const entries = [...(await listCashDeclarations()), entry].slice(
        -CASH_LOG_LIMIT,
      );
      const valueJson = { entries } as any;
      await prisma.syncState.upsert({
        where: { key: CASH_DECLARATION_LOG_KEY },
        create: { key: CASH_DECLARATION_LOG_KEY, valueJson },
        update: { valueJson },
      });
    })
    .catch((e) => {
      console.warn('[fiscal] could not record a cash declaration:', e);
    });
  return logWrites;
}

export async function declareCash(
  settings: SettingsDTO,
  input: {
    kind: unknown;
    amount: unknown;
    requestKey?: unknown;
    /** Who asked (the session's user), for the local record. */
    actorUserId?: unknown;
  },
): Promise<CashDeclarationResult> {
  const result = await declareCashUnrecorded(settings, input);
  const amount = Number(input.amount);
  await recordDeclaration({
    at: new Date().toISOString(),
    kind: String(input.kind || ''),
    amount: Number.isFinite(amount) ? amount : null,
    requestKey: String(input.requestKey ?? '').trim() || null,
    actorUserId: Number(input.actorUserId || 0) || null,
    ok: result.ok,
    outcome: result.ok ? result.kind : 'refused',
    ...(result.docId ? { docId: result.docId } : {}),
    ...(result.ok && result.fcdc ? { fcdc: result.fcdc } : {}),
    ...(!result.ok ? { error: result.error } : {}),
  });
  return result;
}

async function declareCashUnrecorded(
  settings: SettingsDTO,
  input: { kind: unknown; amount: unknown; requestKey?: unknown },
): Promise<CashDeclarationResult> {
  if (!isFiscalEnabled(settings)) {
    return { ok: false, error: 'Fiscalization is off.' };
  }
  const kind = String(input.kind || '') as CashDeclaration;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    return { ok: false, error: 'Enter the amount in lekë.' };
  }
  if (kind !== 'opening' && amount <= 0) {
    return { ok: false, error: 'The amount must be more than 0.' };
  }
  let outcome: BalanceOutcome;
  try {
    if (kind === 'opening') {
      // easyPos takes one opening float a day, and the till declares it on
      // its own before the first cash sale. A float entered after that was
      // answered "already declared" and reported as done, while the amount
      // entered went nowhere (QA v0.2.103, #9). Say so instead.
      const declared = await readDailyBalanceRecord(settings).catch(() => null);
      if (
        declared?.state === 'COMPLETE' &&
        Math.abs(Number(declared.amount) - amount) >= 0.005
      ) {
        const at = new Date(declared.updatedAt || declared.createdAt);
        const when = Number.isFinite(at.getTime())
          ? ` at ${at.toLocaleTimeString()}`
          : '';
        const diff = amount - Number(declared.amount);
        return {
          ok: false,
          docId: declared.docId,
          error:
            `Today's opening float was already declared: ${Number(declared.amount).toFixed(2)} lekë${when}` +
            ' (the till declares it automatically before the first cash sale). easyPos accepts one opening float a day,' +
            ` so ${amount.toFixed(2)} lekë was not declared. Declare the difference as ${diff > 0 ? `cash in (${diff.toFixed(2)} lekë)` : `cash out (${(-diff).toFixed(2)} lekë)`} instead.`,
        };
      }
      outcome = await initiateDailyBalance(settings, { amount });
    } else if (kind === 'deposit' || kind === 'withdraw') {
      // One document per request key: without one a retry declared the
      // same cash twice, so a request without one is not sent at all.
      const docId = docIdFrom(input.requestKey);
      if (!docId) {
        return {
          ok: false,
          error:
            'This cash declaration came without a request key, so a retry could declare it twice. It was not sent; update the app and try again.',
        };
      }
      outcome = await (kind === 'deposit' ? depositCash : withdrawCash)(
        settings,
        { amount, docId },
      );
    } else {
      return { ok: false, error: 'Unknown cash declaration.' };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
  if (outcome.kind === 'complete' || outcome.kind === 'already-declared') {
    return {
      ok: true,
      kind: outcome.kind,
      docId: outcome.docId,
      ...(outcome.fcdc ? { fcdc: outcome.fcdc } : {}),
    };
  }
  return { ok: false, error: outcome.message, docId: outcome.docId };
}
