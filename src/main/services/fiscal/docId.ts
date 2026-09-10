/**
 * docId discipline.
 *
 * The docId is the only thing that lets us ask "did this document get
 * filed?" after a lost response, so its rules are not bookkeeping:
 *
 *   - generated ONCE per business document,
 *   - persisted BEFORE the POST that uses it,
 *   - reused unchanged on every retry and replay,
 *   - never reused for a *different* business document — a cancellation is
 *     a new document and needs a new docId.
 *
 * A docId minted on retry is a docId the provider has never seen, which
 * turns the status check into a guaranteed "not found" and the replay into
 * a second invoice. That failure mode is silent and only surfaces at an
 * audit, so this module refuses to generate one where a caller should have
 * supplied it.
 */

import crypto from 'node:crypto';
import { DOC_ID_MAX_LENGTH, DOC_ID_MIN_LENGTH } from './apiTypes';

export type DocIdPurpose = 'invoice' | 'cancellation' | 'balance';

const PREFIX: Record<DocIdPurpose, string> = {
  invoice: 'inv',
  cancellation: 'cnl',
  balance: 'bal',
};

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

export interface DocIdValidation {
  ok: boolean;
  docId: string;
  error?: string;
}

/**
 * Check a docId against the API's 5–200 character rule.
 *
 * Enforced client-side so the failure is a clear local message rather than
 * an opaque 400 after the payment has already been taken.
 */
export function validateDocId(raw: unknown): DocIdValidation {
  const docId = String(raw ?? '').trim();
  if (!docId) {
    return { ok: false, docId, error: 'docId is required.' };
  }
  if (docId.length < DOC_ID_MIN_LENGTH) {
    return {
      ok: false,
      docId,
      error: `docId must be at least ${DOC_ID_MIN_LENGTH} characters (got ${docId.length}).`,
    };
  }
  if (docId.length > DOC_ID_MAX_LENGTH) {
    return {
      ok: false,
      docId,
      error: `docId must be at most ${DOC_ID_MAX_LENGTH} characters (got ${docId.length}).`,
    };
  }
  return { ok: true, docId };
}

export function assertValidDocId(raw: unknown): string {
  const check = validateDocId(raw);
  if (!check.ok) throw new Error(check.error);
  return check.docId;
}

/**
 * Mint a docId for a brand-new business document.
 *
 * Call sites must persist the result before sending anything. The purpose
 * prefix is there so a docId found in a provider log can be traced back to
 * the kind of document it belongs to.
 */
export function newDocId(purpose: DocIdPurpose): string {
  const candidate = `${PREFIX[purpose]}-${randomId()}`;
  // The generated form is 40 chars; the guard is here so a future change to
  // the prefix or the id cannot silently produce something the API rejects.
  return assertValidDocId(candidate);
}

/**
 * Adapt an existing key (a payment's idempotency key) into a valid docId.
 *
 * Reuses the caller's key when it already satisfies the API, because that
 * key is what the rest of the POS stores and searches by. Only pads when
 * the key is too short to be legal, and never truncates silently — a
 * truncated docId would collide with its neighbours.
 */
export function docIdFromKey(
  key: string,
  purpose: DocIdPurpose = 'invoice',
): string {
  const raw = String(key || '').trim();
  if (!raw) return newDocId(purpose);
  if (raw.length > DOC_ID_MAX_LENGTH) {
    throw new Error(
      `Cannot use "${raw.slice(0, 24)}…" as a docId: it is ${raw.length} characters and the API allows ${DOC_ID_MAX_LENGTH}.`,
    );
  }
  if (raw.length >= DOC_ID_MIN_LENGTH) return raw;
  // Deterministic so a retry with the same short key produces the same
  // docId. A random pad here would defeat the whole mechanism.
  return `${PREFIX[purpose]}-${raw}`;
}

/**
 * Guard against a cancellation being filed under the invoice's own docId.
 *
 * The API treats docId as the identity of a business document; sending the
 * cancellation under the original's docId either collides with it or, worse,
 * is accepted and leaves two documents indistinguishable in recovery.
 */
export function assertDistinctCancellationDocId(input: {
  cancellationDocId: string;
  originalDocId?: string;
}): string {
  const docId = assertValidDocId(input.cancellationDocId);
  const original = String(input.originalDocId || '').trim();
  if (original && docId === original) {
    throw new Error(
      `A cancellation must use a new docId. "${docId}" is the docId of the invoice being cancelled.`,
    );
  }
  return docId;
}
