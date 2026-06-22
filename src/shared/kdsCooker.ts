/**
 * "Cooker" two-stage kitchen workflow.
 *
 * When cooker mode is enabled on the POS host (`settings.kds.cookerEnabled`),
 * KITCHEN items flow through two displays instead of one:
 *
 *   1. The COOKER screen (a KDS device flagged as the cooker) shows the raw
 *      KITCHEN items. The cook bumps each line when it's cooked, which marks
 *      the item `cookerBumped` (NOT the final `bumped`).
 *   2. The MAIN kitchen screen shows the same items, but a line stays LOCKED
 *      (greyed-out, not selectable) until the cook has bumped it. Once cooked
 *      it turns "ready" (green) and the waiter/expo can do the final bump,
 *      which sets `bumped` and — when nothing is left — completes the station.
 *
 * Only the KITCHEN station is two-staged. BAR/DESSERT screens, and any setup
 * where cooker mode is off, keep the original single-bump behaviour untouched.
 *
 * This module is intentionally pure (no Prisma / no Electron) so the same
 * decisions run identically in the IPC handlers, the LAN HTTP routes, the KDS
 * renderer, and unit tests.
 */

/** The only station that participates in the two-stage cook → pass flow. */
export const COOKER_STATION = 'KITCHEN';

export type CookerTab = 'NEW' | 'DONE';

export function isTwoStageKitchen(
  station: string,
  cookerEnabled: boolean | undefined,
): boolean {
  return (
    Boolean(cookerEnabled) &&
    String(station || '').toUpperCase() === COOKER_STATION
  );
}

function isKitchenItem(it: any): boolean {
  return String(it?.station || '').toUpperCase() === COOKER_STATION;
}

/** Cook bumps a whole ticket: mark every active KITCHEN line `cookerBumped`. */
export function cookerBumpAllKitchenItems(items: any[], at: string): any[] {
  return (Array.isArray(items) ? items : []).map((it) => {
    if (!isKitchenItem(it) || it?.voided || it?.cookerBumped) return it;
    return { ...it, cookerBumped: true, cookerBumpedAt: at };
  });
}

/** Cook bumps a single line: mark that KITCHEN item `cookerBumped`. */
export function cookerBumpSingleKitchenItem(
  items: any[],
  idx: number,
  at: string,
): any[] {
  const next = (Array.isArray(items) ? items : []).slice();
  const it = next[idx];
  if (!it || !isKitchenItem(it) || it?.voided || it?.cookerBumped) return next;
  next[idx] = { ...it, cookerBumped: true, cookerBumpedAt: at };
  return next;
}

/**
 * Main whole-ticket bump in two-stage mode: only finalise the KITCHEN lines
 * the cook already finished (`cookerBumped`). Locked lines stay untouched.
 */
export function bumpReadyKitchenItems(items: any[], at: string): any[] {
  return (Array.isArray(items) ? items : []).map((it) => {
    if (!isKitchenItem(it) || it?.voided || it?.bumped) return it;
    if (!it?.cookerBumped) return it; // locked — cook hasn't finished it yet
    return { ...it, bumped: true, bumpedAt: at };
  });
}

/** True when the main screen must block the final bump for this item. */
export function isItemLockedForMain(it: any): boolean {
  return !it?.voided && !it?.bumped && !it?.cookerBumped;
}

/**
 * Filter + decorate one ticket's already-station-filtered items for a given
 * view. Returns the lines to display (with `locked`/`ready` flags added for
 * the main view), or an empty array when the ticket should be hidden here.
 */
export function viewKitchenItemsForCooker(
  stationItems: any[],
  opts: { cooker: boolean; tab: CookerTab },
): any[] {
  const list = Array.isArray(stationItems) ? stationItems : [];
  if (opts.cooker) {
    if (opts.tab === 'NEW') {
      // Still to cook; keep voided lines visible (struck through) until bumped.
      return list.filter((it) => !it?.cookerBumped);
    }
    // Cooked, but waiting on the waiter's final pickup bump (recall lives here).
    return list.filter((it) => !it?.voided && it?.cookerBumped && !it?.bumped);
  }
  // Main view.
  if (opts.tab === 'NEW') {
    // Show everything not yet finally bumped, including voided lines.
    return list
      .filter((it) => !it?.bumped)
      .map((it) => ({
        ...it,
        cookerBumped: Boolean(it?.cookerBumped),
        ready: Boolean(it?.cookerBumped) && !it?.voided,
        locked: !it?.voided && !it?.cookerBumped,
      }));
  }
  // Main DONE: handled by the existing station-DONE query + struck rendering.
  return list;
}
