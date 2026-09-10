/**
 * Cash balance declarations.
 *
 * The tax service wants the opening cash float declared once per business
 * day per fiscal device, before the first cash invoice of that day. Get it
 * wrong and cash invoices come back with the "daily balance not reported"
 * fault — which the old code recognised (`isDailyBalanceCashWarning`) and
 * then handled by printing a receipt with a warning telling staff to go and
 * declare the balance in easyPos by hand. So every cash sale before someone
 * remembered was filed with an NSLF and no NIVF: not registered, but
 * recorded locally as a completed sale.
 *
 * Two things this deliberately does NOT do.
 *
 * It is not tied to the POS' own shift concept. A shift is an app idea;
 * a business day is the tax service's, and a venue that runs two shifts a
 * day must not declare two opening balances. The day key is the local
 * calendar date, matching how the rest of this codebase closes a day.
 *
 * It does not close the balance. The API has no balance-close route, so
 * there is nothing to call at end of day and no state machine that waits
 * for one. Deposits and withdrawals are independent events.
 */

import type { SettingsDTO } from '@shared/ipc';
import { prisma } from '@db/client';
import { roundMoney } from '@shared/pricing';
import { DEFAULT_CURRENCY, type BalanceRequest } from './apiTypes';
import { assertValidDocId, newDocId } from './docId';
import {
  postBalanceDeposit,
  postBalanceInitiate,
  postBalanceWithdraw,
  withDocIdLock,
  type FiscalHttpResult,
} from './client';
import { assessCompletion, type FiscalIdentifiers } from './completion';
import { classifyFiscalAttempt, isNotFoundStatus } from './classify';
import { backoffDelayMs, defaultSleep, type Sleep } from './backoff';
import { fiscalConfig } from './config';
import { dayKeyLocal } from '../kdsRetention';

const KEY_PREFIX = 'fiscal:balance:';

export type BalanceOperation = 'initiate' | 'deposit' | 'withdraw';

/**
 * A balance operation's durable record.
 *
 * Written BEFORE the POST, exactly like an invoice claim, so the docId is
 * recoverable after a crash and a retry reuses it instead of declaring a
 * second opening float.
 */
export interface BalanceRecord {
  operation: BalanceOperation;
  docId: string;
  dayKey: string;
  deviceKey: string;
  amount: number;
  state: 'PENDING' | 'COMPLETE' | 'FAILED';
  /** The fiscal cash deposit code. Present only when COMPLETE. */
  fcdc?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  /**
   * When the automatic cash path last tried this, so it can be throttled.
   * Absent on a declaration an admin triggered by hand.
   */
  lastAutoAttemptAt?: string;
  /** When admins were last told this day's declaration is not in place. */
  alertedAt?: string;
}

/**
 * Which fiscal device a balance belongs to.
 *
 * Balances are per device, so two tills in one venue each declare their
 * own. The operator code is the closest stable per-device identifier we
 * hold, which is why it is required for cloud configuration.
 */
export function deviceKeyOf(settings: SettingsDTO): string {
  const { operatorCode, environment } = fiscalConfig(settings);
  return `${environment}:${operatorCode || 'unknown'}`;
}

/** Storage key for the once-per-day opening balance. */
export function initiateKey(deviceKey: string, dayKey: string): string {
  return `${KEY_PREFIX}initiate:${deviceKey}:${dayKey}`;
}

function movementKey(docId: string): string {
  return `${KEY_PREFIX}movement:${docId}`;
}

async function readRecord(key: string): Promise<BalanceRecord | null> {
  const row = await prisma.syncState
    .findUnique({ where: { key } })
    .catch(() => null);
  const value = (row as any)?.valueJson;
  if (!value || typeof value !== 'object') return null;
  return value as BalanceRecord;
}

async function writeRecord(key: string, record: BalanceRecord): Promise<void> {
  await prisma.syncState.upsert({
    where: { key },
    create: { key, valueJson: record as any },
    update: { valueJson: record as any },
  });
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

const POST_BY_OPERATION: Record<
  BalanceOperation,
  (settings: SettingsDTO, request: BalanceRequest) => Promise<FiscalHttpResult>
> = {
  initiate: postBalanceInitiate,
  deposit: postBalanceDeposit,
  withdraw: postBalanceWithdraw,
};

export type BalanceOutcome =
  | {
      kind: 'complete';
      docId: string;
      fcdc: string;
      identifiers: FiscalIdentifiers;
    }
  /** Already declared today. No request was sent. */
  | { kind: 'already-declared'; docId: string; fcdc?: string }
  | { kind: 'rejected'; docId: string; message: string }
  | { kind: 'unresolved'; docId: string; message: string };

export interface BalanceOptions {
  maxAttempts?: number;
  sleep?: Sleep;
  random?: () => number;
}

/**
 * Send one balance operation and recover an ambiguous outcome.
 *
 * Completion is `fcdc`, not HTTP 200. Recovery is narrower than for an
 * invoice because there is no `/balance/status` route: an ambiguous
 * outcome may only be retried under the SAME docId, and if it stays
 * ambiguous it goes to a human rather than being sent again with a new
 * one. Re-declaring an opening float under a fresh docId would be a second
 * declaration, which is exactly what the once-per-day rule forbids.
 */
async function sendBalance(
  settings: SettingsDTO,
  operation: BalanceOperation,
  record: BalanceRecord,
  storageKey: string,
  options?: BalanceOptions,
): Promise<BalanceOutcome> {
  const sleep = options?.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const request: BalanceRequest = {
    docId: record.docId,
    amount: record.amount,
    ...(fiscalConfig(settings).operatorCode
      ? { operatorCode: fiscalConfig(settings).operatorCode }
      : {}),
  };

  let lastMessage = 'The cash balance operation did not complete.';
  let lastMustCheckStatus = true;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await sleep(
        backoffDelayMs(
          attempt - 1,
          options?.random ? { random: options.random } : undefined,
        ),
      );
    }
    let result: FiscalHttpResult | undefined;
    let error: unknown;
    try {
      result = await POST_BY_OPERATION[operation](settings, request);
    } catch (e) {
      error = e;
    }

    // Assessed once. The reason is reused for the "not found" message and
    // for the classification below, which used to call `assessCompletion` a
    // further two times on the same body and cast away the result to reach
    // a `reason` that is always present by then.
    const verdict = result ? assessCompletion('balance', result.data) : null;

    if (result && verdict) {
      if (verdict.complete) {
        const fcdc = String(verdict.identifiers.fcdc || '');
        await writeRecord(storageKey, {
          ...record,
          state: 'COMPLETE',
          fcdc,
          updatedAt: new Date().toISOString(),
          lastError: undefined,
        }).catch(() => undefined);
        return {
          kind: 'complete',
          docId: record.docId,
          fcdc,
          identifiers: verdict.identifiers,
        };
      }
      // A "not found" here would be about the docId we just sent, which
      // means the request was refused outright rather than half-applied.
      if (
        isNotFoundStatus({ httpStatus: result.httpStatus, data: result.data })
      ) {
        lastMessage = verdict.reason;
        continue;
      }
    }

    const classification = classifyFiscalAttempt(
      result
        ? {
            httpStatus: result.httpStatus,
            data: result.data,
            incomplete: true,
            // Complete was returned above, so a verdict here is always the
            // incomplete one and always carries a reason.
            incompleteReason: verdict?.complete ? undefined : verdict?.reason,
          }
        : { error },
    );
    lastMessage = classification.message;
    lastMustCheckStatus = classification.mustCheckStatus;

    if (!classification.retryable) {
      await writeRecord(storageKey, {
        ...record,
        state: 'FAILED',
        updatedAt: new Date().toISOString(),
        lastError: classification.message,
      }).catch(() => undefined);
      return {
        kind: 'rejected',
        docId: record.docId,
        message: classification.message,
      };
    }
  }

  await writeRecord(storageKey, {
    ...record,
    state: 'PENDING',
    updatedAt: new Date().toISOString(),
    lastError: lastMessage,
  }).catch(() => undefined);
  return {
    kind: 'unresolved',
    docId: record.docId,
    message: lastMustCheckStatus
      ? `${lastMessage} docId ${record.docId} must be checked in easyPos before another ${operation} is sent.`
      : `${lastMessage} Nothing was filed. The same declaration will be retried automatically.`,
  };
}

/* ------------------------------------------------------------------ *
 * Opening balance
 * ------------------------------------------------------------------ */

export interface InitiateBalanceInput {
  /** Opening cash float, in ALL. */
  amount: number;
  /** Defaults to today's local calendar date. */
  dayKey?: string;
  /** Force a re-send of a PENDING declaration under its original docId. */
  resume?: boolean;
}

/**
 * Declare the opening cash balance for a business day, at most once.
 *
 * Idempotent by construction: the storage key is the device plus the day,
 * so a second call on the same day finds the first record and returns it
 * instead of declaring again. A PENDING record is resumed under its
 * original docId — never replaced with a new one.
 */
export async function initiateDailyBalance(
  settings: SettingsDTO,
  input: InitiateBalanceInput,
  options?: BalanceOptions,
): Promise<BalanceOutcome> {
  const dayKey = String(input.dayKey || dayKeyLocal());
  const deviceKey = deviceKeyOf(settings);
  const storageKey = initiateKey(deviceKey, dayKey);
  const amount = assertAllAmount(input.amount, 'initiate');

  const existing = await readRecord(storageKey);
  if (existing?.state === 'COMPLETE') {
    return {
      kind: 'already-declared',
      docId: existing.docId,
      fcdc: existing.fcdc,
    };
  }

  // Reuse the stored docId when resuming, so recovery is possible. A record
  // without one is not a resumable declaration — it is the marker written
  // when admins were alerted before anything was ever sent — so it gets a
  // fresh docId rather than posting an empty one.
  const record: BalanceRecord = existing
    ? {
        ...existing,
        docId: existing.docId || newDocId('balance'),
        amount,
        state: 'PENDING',
        updatedAt: new Date().toISOString(),
      }
    : {
        operation: 'initiate',
        docId: newDocId('balance'),
        dayKey,
        deviceKey,
        amount,
        state: 'PENDING',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

  // Persisted BEFORE the POST.
  await writeRecord(storageKey, record);
  return withDocIdLock(record.docId, () =>
    sendBalance(settings, 'initiate', record, storageKey, options),
  );
}

/** Whether today's opening balance has been declared on this device. */
export async function isDailyBalanceDeclared(
  settings: SettingsDTO,
  dayKey = dayKeyLocal(),
): Promise<boolean> {
  const record = await readRecord(initiateKey(deviceKeyOf(settings), dayKey));
  return record?.state === 'COMPLETE';
}

/**
 * How long the automatic cash path waits before trying a declaration that
 * did not stick.
 *
 * Without it, a declaration that keeps being refused — a bad operator code,
 * an expired token — would add a doomed POST to the front of every single
 * cash sale for the rest of the day, on the one screen where latency is
 * most visible. A minute is short enough that the first cash sale after
 * someone fixes the configuration goes through, and long enough that a
 * busy till is not paying for the same refusal over and over.
 *
 * Deliberately not applied to `initiateDailyBalance` itself: an admin
 * pressing a button has just changed something and expects it to be tried.
 */
export const AUTO_DECLARE_RETRY_COOLDOWN_MS = 60_000;

/** A balance operation that reached the tax service and stuck. */
export type SettledBalanceOutcome = Extract<
  BalanceOutcome,
  { kind: 'complete' | 'already-declared' }
>;

/**
 * A type predicate rather than a boolean, so the failing branch narrows to
 * the two outcomes that actually carry a `message` to report.
 */
export function isBalanceSettled(
  outcome: BalanceOutcome,
): outcome is SettledBalanceOutcome {
  return outcome.kind === 'complete' || outcome.kind === 'already-declared';
}

/**
 * Ensure the opening balance exists before the first cash invoice.
 *
 * Called on the cash path so the ordering rule is enforced by the code
 * rather than by staff remembering. Returns the outcome so a caller can
 * decide whether to proceed; it does not throw, because a balance problem
 * should not by itself destroy a sale that may be card-paid.
 */
export async function ensureDailyBalanceForCash(
  settings: SettingsDTO,
  input: { openingFloat: number },
  options?: BalanceOptions & { now?: () => number },
): Promise<BalanceOutcome> {
  const dayKey = dayKeyLocal();
  const storageKey = initiateKey(deviceKeyOf(settings), dayKey);
  const existing = await readRecord(storageKey);

  if (existing?.state === 'COMPLETE') {
    return {
      kind: 'already-declared',
      docId: existing.docId,
      fcdc: existing.fcdc,
    };
  }

  const now = options?.now ?? Date.now;
  const lastAttempt = Date.parse(String(existing?.lastAutoAttemptAt || ''));
  if (
    Number.isFinite(lastAttempt) &&
    now() - lastAttempt < AUTO_DECLARE_RETRY_COOLDOWN_MS
  ) {
    return {
      kind: 'unresolved',
      docId: existing?.docId || '',
      message:
        existing?.lastError ||
        "Today's opening cash balance has not been declared and the last attempt failed.",
    };
  }

  const outcome = await initiateDailyBalance(
    settings,
    { amount: input.openingFloat },
    // One attempt, not the default three.
    //
    // This runs inline on the first cash sale of the day, with a waiter and
    // a guest waiting on it. Three attempts against an unresponsive easyPos
    // is 3 × the 20s request timeout plus backoff — around a minute of dead
    // time before the invoice is even attempted, on top of the register
    // call's own recovery budget. Retrying is the cooldown's job: the next
    // cash sale a minute later picks it up under the same docId, and the
    // sale itself is never blocked on the outcome either way.
    { maxAttempts: 1, ...options },
  );

  // Stamped after the attempt rather than before it, so the very first
  // declaration of the day — which has no record to stamp yet — starts the
  // cooldown too. Doing it before meant sale one created the record and
  // sale two immediately retried.
  if (!isBalanceSettled(outcome)) {
    const latest = await readRecord(storageKey);
    if (latest) {
      await writeRecord(storageKey, {
        ...latest,
        lastAutoAttemptAt: new Date(now()).toISOString(),
      }).catch(() => undefined);
    }
  }

  return outcome;
}

/**
 * Record that admins have been told about today's missing declaration, and
 * report whether this is the first time.
 *
 * The check runs on the cash path, so without a marker every cash sale for
 * the rest of the day would raise the same alert.
 */
export async function markDailyBalanceAlerted(
  settings: SettingsDTO,
  dayKey = dayKeyLocal(),
): Promise<boolean> {
  const storageKey = initiateKey(deviceKeyOf(settings), dayKey);
  const existing = await readRecord(storageKey);
  if (existing?.alertedAt) return false;
  await writeRecord(storageKey, {
    ...(existing || {
      operation: 'initiate' as const,
      docId: '',
      dayKey,
      deviceKey: deviceKeyOf(settings),
      amount: 0,
      state: 'FAILED' as const,
      createdAt: new Date().toISOString(),
    }),
    updatedAt: new Date().toISOString(),
    alertedAt: new Date().toISOString(),
  }).catch(() => undefined);
  return true;
}

/* ------------------------------------------------------------------ *
 * Movements
 * ------------------------------------------------------------------ */

/**
 * Balance amounts are always in ALL, whatever currency the POS displays.
 * A float declared in EUR would be read as ALL and be wrong by two orders
 * of magnitude, so the check is explicit rather than assumed.
 */
function assertAllAmount(amount: unknown, operation: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    throw new Error(`Cash balance ${operation} needs a numeric amount in ALL.`);
  }
  if (n < 0) {
    throw new Error(
      `Cash balance ${operation} amount must not be negative (use withdraw to take cash out).`,
    );
  }
  return roundMoney(n);
}

export interface BalanceMovementInput {
  /** Amount in ALL. */
  amount: number;
  /**
   * Stable per operation. Supply the caller's own key (a till-drawer event
   * id) so a retry recovers instead of moving the cash twice; omit only for
   * a genuinely new movement.
   */
  docId?: string;
}

async function movement(
  settings: SettingsDTO,
  operation: 'deposit' | 'withdraw',
  input: BalanceMovementInput,
  options?: BalanceOptions,
): Promise<BalanceOutcome> {
  const amount = assertAllAmount(input.amount, operation);
  if (amount <= 0) {
    throw new Error(`A cash ${operation} must be greater than zero.`);
  }
  const docId = input.docId
    ? assertValidDocId(input.docId)
    : newDocId('balance');
  const storageKey = movementKey(docId);

  const existing = await readRecord(storageKey);
  if (existing?.state === 'COMPLETE') {
    return { kind: 'already-declared', docId, fcdc: existing.fcdc };
  }

  const record: BalanceRecord = {
    operation,
    docId,
    dayKey: existing?.dayKey || dayKeyLocal(),
    deviceKey: deviceKeyOf(settings),
    amount,
    state: 'PENDING',
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeRecord(storageKey, record);
  return withDocIdLock(docId, () =>
    sendBalance(settings, operation, record, storageKey, options),
  );
}

export function depositCash(
  settings: SettingsDTO,
  input: BalanceMovementInput,
  options?: BalanceOptions,
): Promise<BalanceOutcome> {
  return movement(settings, 'deposit', input, options);
}

export function withdrawCash(
  settings: SettingsDTO,
  input: BalanceMovementInput,
  options?: BalanceOptions,
): Promise<BalanceOutcome> {
  return movement(settings, 'withdraw', input, options);
}

export const BALANCE_CURRENCY = DEFAULT_CURRENCY;
