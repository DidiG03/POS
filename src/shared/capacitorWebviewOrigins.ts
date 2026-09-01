/**
 * Origins Capacitor WebViews send on CORS preflight when talking to the
 * POS LAN API. Keep this list in step with `capacitor.config.ts`
 * (`androidScheme`) and the iOS custom scheme.
 */
export const CAPACITOR_WEBVIEW_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
  // Capacitor 5–7 Android sometimes includes the bundled port.
  'http://localhost:8080',
  'https://localhost:8080',
  'http://127.0.0.1',
  'http://127.0.0.1:8080',
] as const;
