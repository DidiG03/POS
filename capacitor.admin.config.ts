import type { CapacitorConfig } from '@capacitor/cli';

// Optional live reload for the Admin iOS app:
//   1. pnpm dev:mobile:admin     (Vite on :5175, host:true)
//   2. CAP_SERVER_URL=http://<your-mac-ip>:5175 pnpm cap:admin:run:ios
const devServerUrl = process.env.CAP_SERVER_URL || '';

/**
 * Capacitor 8 has no `--config` flag. This module is selected from
 * `capacitor.config.ts` when `CAP_APP=admin` (see `scripts/capAdmin.mjs`).
 *
 * iOS-only: `android.path` points at unused `android-admin` so a bare
 * `cap sync` cannot overwrite the Waiter Android project. Never create
 * that directory.
 */
export const adminCapacitorConfig: CapacitorConfig = {
  appId: 'com.codeorbit.admin',
  appName: 'OneTap Admin',
  webDir: 'dist/mobile-admin',
  bundledWebRuntime: false,
  ios: {
    path: 'ios-admin',
    contentInset: 'never',
    backgroundColor: '#0b1220',
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    path: 'android-admin',
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'http',
    ...(devServerUrl
      ? { url: devServerUrl, cleartext: devServerUrl.startsWith('http://') }
      : {}),
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#0b1220',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    Keyboard: {
      resize: 'native',
      style: 'dark',
    },
  },
};
