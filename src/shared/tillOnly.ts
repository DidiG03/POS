/**
 * A few actions replace or remove the whole ledger, or the app itself.
 * The till answers them only from its own machine (`lanPolicy.ts`); any
 * other device gets this code and is told to do it on the till.
 */
export const TILL_ONLY = 'TILL_ONLY';

/** Fallback wording for a client that does not translate the code. */
export const TILL_ONLY_MESSAGE =
  'This can only be done on the till itself. Open Admin on the till.';

/** True for the error (or `{ code }` answer) of a till-only refusal. */
export function isTillOnly(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { code?: unknown }).code === TILL_ONLY
  );
}
