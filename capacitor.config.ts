import type { CapacitorConfig } from '@capacitor/cli';

// Optional dev server. To run with live reload on a real device:
//   1. pnpm dev:mobile        (starts Vite on :5174, host:true)
//   2. CAP_SERVER_URL=http://<your-mac-ip>:5174 pnpm cap:run:ios
const devServerUrl = process.env.CAP_SERVER_URL || '';

const config: CapacitorConfig = {
  appId: 'com.codeorbit.waiter',
  appName: 'Code Orbit Waiter',
  webDir: 'dist/mobile',
  bundledWebRuntime: false,
  ios: {
    contentInset: 'always',
    // Allow plain http to LAN backends (self-signed / local IPs).
    // For production you should ship a valid HTTPS endpoint and remove this.
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    // Allow plain http to LAN backends in development.
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
    // When CAP_SERVER_URL is set, the app loads from the dev server instead
    // of the bundled webDir. Useful for hot-reload during development.
    ...(devServerUrl
      ? { url: devServerUrl, cleartext: devServerUrl.startsWith('http://') }
      : {}),
  },
  plugins: {
    SplashScreen: {
      // We hide the splash from JS in mobileShell.ts as soon as the renderer
      // mounts. Disabling auto-hide kills the "SplashScreen was automatically
      // hidden after default timeout" warning and avoids a flash if the JS
      // bundle takes more than ~500ms to parse on a cold start.
      launchAutoHide: false,
      backgroundColor: '#111827',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    Keyboard: {
      // Hide the iOS "shortcut bar" above the keyboard. Removes the noisy
      // UIModernBarButton auto-layout warnings and gives waiters a cleaner
      // input UX (we don't need the system shortcuts inside a POS).
      resize: 'native',
      style: 'dark',
    },
  },
};

export default config;
