import { app } from 'electron';

/** Restart the till shortly after the caller has answered its request. */
export function relaunchTillSoon(delayMs = 800): void {
  setTimeout(() => {
    try {
      if (app.isPackaged) app.relaunch();
    } catch {
      // ignore
    }
    app.exit(0);
  }, delayMs);
}
