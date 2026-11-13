/**
 * The app's log file (`fileLog.ts`), in the folder the operating system
 * keeps app logs in:
 *   Windows  %APPDATA%\<app>\logs
 *   macOS    ~/Library/Logs/<app>
 *   Linux    ~/.config/<app>/logs
 */
import { app, shell } from 'electron';
import path from 'node:path';
import {
  createFileLog,
  readLogTail,
  teeConsoleToFileLog,
  type FileLog,
} from './fileLog';

let current: { log: FileLog; dir: string; name: string } | null = null;

function logsDir(): string {
  try {
    return app.getPath('logs');
  } catch {
    return path.join(app.getPath('userData'), 'logs');
  }
}

/** Start writing the console to `<logs>/<name>.log`. Call once, early. */
export function startAppLog(name: string): string | null {
  if (current) return current.log.path;
  try {
    const dir = logsDir();
    const log = createFileLog({ dir, name });
    teeConsoleToFileLog(log);
    current = { log, dir, name };
    console.log(
      `[log] ${app.getName()} ${app.getVersion()} started (${process.platform} ${process.arch}, Electron ${process.versions.electron})`,
    );
    app.once('will-quit', () => {
      console.log('[log] quitting');
      current?.log.close();
    });
    return log.path;
  } catch (e) {
    // No log file is no reason not to start.
    console.warn('[log] could not open the log file', e);
    return null;
  }
}

export function appLogPath(): string | null {
  return current?.log.path ?? null;
}

/** Open the logs folder in Finder / Explorer. */
export async function openAppLogFolder(): Promise<boolean> {
  const dir = current?.dir ?? logsDir();
  const err = await shell.openPath(dir).catch((e) => String(e));
  return !err;
}

/** The newest part of this app's log, for support. */
export function appLogTail(maxBytes: number): {
  name: string;
  text: string;
} | null {
  if (!current) return null;
  return {
    name: current.name,
    text: readLogTail(current.dir, current.name, maxBytes),
  };
}
