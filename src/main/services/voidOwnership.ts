/**
 * A waiter may void only the table they opened. An admin, or a verified
 * manager approval, may void anyone's table.
 */
export function voidBlockedByOtherOwner(input: {
  actorIsAdmin: boolean;
  actorUserId: number;
  ownerId: number | null;
  approvalLifts: boolean;
}): boolean {
  if (input.actorIsAdmin || input.approvalLifts) return false;
  return input.ownerId !== null && input.ownerId !== Number(input.actorUserId);
}
