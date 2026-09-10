export const POS_OPEN_SERVER_SCAN = 'pos:openServerScan';

/** Open the Scan overlay so a LAN client can pick a different POS host. */
export function openPosServerScan(): void {
  try {
    window.dispatchEvent(new Event(POS_OPEN_SERVER_SCAN));
  } catch {
    // ignore
  }
}
