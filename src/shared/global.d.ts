import type { Api } from './ipc';

declare global {
  interface Window {
    api: Api;
  }
}

export {};


