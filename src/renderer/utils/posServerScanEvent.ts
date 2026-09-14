export const POS_OPEN_SERVER_SCAN = 'pos:openServerScan';
export const POS_BACKEND_HOST_CHANGED = 'pos:backendHostChanged';

/** Open the Scan overlay so a LAN client can pick a different POS host. */
export function openPosServerScan(): void {
  try {
    window.dispatchEvent(new Event(POS_OPEN_SERVER_SCAN));
  } catch {
    // ignore
  }
}

/** Hot-swap the saved LAN host without reloading the WebView. */
export function notifyBackendHostChanged(): void {
  try {
    window.dispatchEvent(new Event(POS_BACKEND_HOST_CHANGED));
  } catch {
    // ignore
  }
}
