/**
 * Lines a waiter asked a colleague to add to their table (QA round 6, #6).
 *
 * The requested lines stayed on the requester's phone after the owner
 * approved (or rejected) them, and the Request button came back, so the
 * same items could be asked for and added twice. The phone now reads its
 * own requests for the table (`requests.listMine`): a line in a pending
 * request keeps the button locked; a line in a decided one leaves the
 * phone (approved lines are on the owner's bill now).
 */

export type MyRequest = { id: number; status: string; lineIds: string[] };

export type RequestedLinesState = {
  /** Staged line ids waiting in a PENDING request. */
  pending: Set<string>;
  /** Staged line ids whose request was decided, with the decision. */
  decided: Map<string, 'APPROVED' | 'REJECTED'>;
};

export function requestedLinesState(
  stagedIds: readonly string[],
  requests: readonly MyRequest[] | null | undefined,
): RequestedLinesState {
  const pending = new Set<string>();
  const decided = new Map<string, 'APPROVED' | 'REJECTED'>();
  const statusOf = new Map<string, string>();
  // Newest first: a line's latest request decides.
  for (const r of Array.isArray(requests) ? requests : []) {
    for (const id of Array.isArray(r?.lineIds) ? r.lineIds : []) {
      if (!statusOf.has(id)) statusOf.set(id, String(r.status || ''));
    }
  }
  for (const id of stagedIds) {
    const status = statusOf.get(id);
    if (!status) continue;
    if (status === 'PENDING') pending.add(id);
    else if (status === 'REJECTED') decided.set(id, 'REJECTED');
    else decided.set(id, 'APPROVED'); // APPROVED or APPLIED
  }
  return { pending, decided };
}
