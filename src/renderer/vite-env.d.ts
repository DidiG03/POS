/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOBILE_TARGET?: string;
  readonly VITE_ADMIN_MOBILE_TARGET?: string;
  readonly VITE_DEFAULT_BACKEND_HOST?: string;
  readonly VITE_DEFAULT_BACKEND_HTTP?: string;
  readonly VITE_DEFAULT_BACKEND_HTTPS?: string;
}
