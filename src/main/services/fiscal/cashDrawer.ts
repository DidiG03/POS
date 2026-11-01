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
import {
  depositCash,
  initiateDailyBalance,
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

export async function declareCash(
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
      outcome = await initiateDailyBalance(settings, { amount });
    } else if (kind === 'deposit' || kind === 'withdraw') {
      const docId = docIdFrom(input.requestKey);
      outcome = await (kind === 'deposit' ? depositCash : withdrawCash)(
        settings,
        { amount, ...(docId ? { docId } : {}) },
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
