/**
 * `/utilities/get-taxpayers` and `/utilities/get-operators`.
 *
 * Both are lookups, and the important part is what they are NOT.
 *
 * `get-taxpayers` is autofill. It returns no active/inactive field, so it
 * cannot answer "is this NUIS a valid, currently registered taxpayer?" —
 * a name coming back is not confirmation that the business is in good
 * standing, and using it as a tax-status check would be a compliance claim
 * the data does not support. Callers get the records and a note saying so.
 *
 * `get-operators` is the source of valid `operatorCode` values. Hardcoding
 * one is how a demo typo ended up filed on live invoices.
 */

import type { SettingsDTO } from '@shared/ipc';
import {
  TAXPAYER_SEARCH_MAX_LENGTH,
  TAXPAYER_SEARCH_MIN_LENGTH,
  type OperatorRecord,
  type TaxpayerRecord,
} from './apiTypes';
import {
  postGetOperators,
  postGetTaxpayers,
  readOperators,
  readTaxpayers,
} from './client';
import { classifyFiscalAttempt } from './classify';
import { isValidOperatorCode } from './config';

export type LookupOutcome<T> =
  | { kind: 'ok'; items: T[] }
  | { kind: 'error'; message: string; retryable: boolean };

/** How long to hold keystrokes before asking. */
export const TAXPAYER_SEARCH_DEBOUNCE_MS = 400;

export function validateTaxpayerSearchTerm(raw: string): {
  ok: boolean;
  searchTerm: string;
  error?: string;
} {
  const searchTerm = String(raw || '').trim();
  if (searchTerm.length < TAXPAYER_SEARCH_MIN_LENGTH) {
    return {
      ok: false,
      searchTerm,
      error: `Type at least ${TAXPAYER_SEARCH_MIN_LENGTH} characters to search taxpayers.`,
    };
  }
  if (searchTerm.length > TAXPAYER_SEARCH_MAX_LENGTH) {
    return {
      ok: false,
      searchTerm,
      error: `Search term must be at most ${TAXPAYER_SEARCH_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, searchTerm };
}

/**
 * Look up taxpayers for autofill.
 *
 * Debouncing is the caller's job — see `createDebouncedTaxpayerSearch`,
 * which exists so no UI is tempted to call this per keystroke.
 */
export async function searchTaxpayers(
  settings: SettingsDTO,
  searchTerm: string,
): Promise<LookupOutcome<TaxpayerRecord>> {
  const check = validateTaxpayerSearchTerm(searchTerm);
  if (!check.ok) {
    return { kind: 'error', message: check.error!, retryable: false };
  }
  try {
    const result = await postGetTaxpayers(settings, {
      searchTerm: check.searchTerm,
    });
    if (!result.ok) {
      const classification = classifyFiscalAttempt({
        httpStatus: result.httpStatus,
        data: result.data,
      });
      return {
        kind: 'error',
        message: classification.message,
        retryable: classification.retryable,
      };
    }
    return { kind: 'ok', items: readTaxpayers(result.data) };
  } catch (e) {
    const classification = classifyFiscalAttempt({ error: e });
    return {
      kind: 'error',
      message: classification.message,
      retryable: classification.retryable,
    };
  }
}

/**
 * A debounced wrapper, so a search box cannot fire one request per
 * keystroke. Resolves the pending promise with the latest term's result;
 * superseded calls resolve to the same outcome rather than hanging.
 */
export function createDebouncedTaxpayerSearch(
  settings: SettingsDTO,
  delayMs = TAXPAYER_SEARCH_DEBOUNCE_MS,
): (searchTerm: string) => Promise<LookupOutcome<TaxpayerRecord>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiters: Array<(value: LookupOutcome<TaxpayerRecord>) => void> = [];

  return (searchTerm: string) =>
    new Promise((resolve) => {
      waiters.push(resolve);
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = null;
          const pending = waiters;
          waiters = [];
          void searchTaxpayers(settings, searchTerm).then((outcome) => {
            for (const waiter of pending) waiter(outcome);
          });
        },
        Math.max(0, delayMs),
      );
    });
}

/**
 * Explicitly not a tax-status check.
 *
 * Kept as a named export so the intent is documented at the call site
 * rather than inferred from a comment somewhere else.
 */
export const TAXPAYER_LOOKUP_IS_NOT_STATUS_VERIFICATION =
  'get-taxpayers returns no active/inactive field. A match means the NUIS is known, not that the taxpayer is currently registered or in good standing.';

/** Fetch the operator codes this token is allowed to use. */
export async function listOperators(
  settings: SettingsDTO,
): Promise<LookupOutcome<OperatorRecord>> {
  try {
    const result = await postGetOperators(settings, {});
    if (!result.ok) {
      const classification = classifyFiscalAttempt({
        httpStatus: result.httpStatus,
        data: result.data,
      });
      return {
        kind: 'error',
        message: classification.message,
        retryable: classification.retryable,
      };
    }
    return { kind: 'ok', items: readOperators(result.data) };
  } catch (e) {
    const classification = classifyFiscalAttempt({ error: e });
    return {
      kind: 'error',
      message: classification.message,
      retryable: classification.retryable,
    };
  }
}

/** The valid, well-formed operator codes from `/utilities/get-operators`. */
export function operatorCodesOf(items: OperatorRecord[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const code = String(item?.operatorCode || '').trim();
    if (code && isValidOperatorCode(code)) seen.add(code);
  }
  return [...seen];
}

/**
 * Check a configured operator code against what the API says this token
 * may use, so a bad code is caught in settings rather than on a sale.
 */
export async function verifyOperatorCode(
  settings: SettingsDTO,
  operatorCode: string,
): Promise<{ ok: boolean; message?: string; known?: string[] }> {
  const code = String(operatorCode || '').trim();
  if (!isValidOperatorCode(code)) {
    return {
      ok: false,
      message: `"${code}" is not in the operator code format (two letters, three digits, two letters, three digits).`,
    };
  }
  const outcome = await listOperators(settings);
  if (outcome.kind === 'error') {
    // Could not check. Not the same as invalid — say so rather than
    // blocking a configuration that may be perfectly good.
    return {
      ok: true,
      message: `Could not verify against easyPos: ${outcome.message}`,
    };
  }
  const known = operatorCodesOf(outcome.items);
  if (known.length === 0) {
    return {
      ok: true,
      message: 'easyPos returned no operators to check against.',
      known,
    };
  }
  if (!known.includes(code)) {
    return {
      ok: false,
      message: `Operator code "${code}" is not one this token may use. Available: ${known.join(', ')}.`,
      known,
    };
  }
  return { ok: true, known };
}
