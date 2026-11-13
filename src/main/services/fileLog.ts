/**
 * A log file on the machine, for support.
 *
 * The apps had no log file: the main process wrote to the console, which
 * an installed app sends nowhere, so "it didn't print" or "the sale is
 * missing" left nothing to look at. Everything the main process writes to
 * the console now also goes, with a timestamp, to `<name>.log` in the
 * app's logs folder. The file rotates at `maxBytes`, keeping `keep` older
 * files, so it never fills the disk.
 *
 * Secrets are masked before anything is written (`redactLogText`): PINs,
 * tokens, the pairing code, licence and recovery keys.
 *
 * Electron-free so it can be tested with plain Node; `appLog.ts` wires it
 * into the apps.
 */
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP_FILES = 5;

export { redactLogText } from '@shared/redactSecrets';
import { redactLogText } from '@shared/redactSecrets';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function formatLogLine(
  level: LogLevel,
  args: unknown[],
  now: Date = new Date(),
): string {
  const text = util.formatWithOptions(
    { depth: 4, breakLength: Infinity, colors: false },
    ...(args as [unknown, ...unknown[]]),
  );
  return `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${redactLogText(text)}\n`;
}

/** `<dir>/<name>.log`, then `<name>.1.log` (newest) … `<name>.<keep>.log`. */
export function logFilePath(dir: string, name: string, generation = 0): string {
  return path.join(
    dir,
    generation ? `${name}.${generation}.log` : `${name}.log`,
  );
}

export interface FileLog {
  readonly path: string;
  write(level: LogLevel, args: unknown[]): void;
  /** Flush what is buffered and stop writing. */
  close(): void;
}

export function createFileLog(opts: {
  dir: string;
  name: string;
  maxBytes?: number;
  keep?: number;
  now?: () => Date;
}): FileLog {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const keep = Math.max(1, opts.keep ?? LOG_KEEP_FILES);
  const file = logFilePath(opts.dir, opts.name);
  fs.mkdirSync(opts.dir, { recursive: true });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  let fd: number | null = null;
  let closed = false;
  let broken = false;

  const open = () => {
    if (fd == null) fd = fs.openSync(file, 'a', 0o600);
    return fd;
  };

  const rotate = () => {
    if (fd != null) {
      fs.closeSync(fd);
      fd = null;
    }
    for (let g = keep; g >= 1; g--) {
      const from = logFilePath(opts.dir, opts.name, g - 1);
      const to = logFilePath(opts.dir, opts.name, g);
      try {
        if (g === keep) fs.rmSync(to, { force: true });
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        // A file in use (Windows) stays where it is; the next rotation
        // tries again.
      }
    }
    size = 0;
  };

  return {
    path: file,
    write(level, args) {
      if (closed || broken) return;
      try {
        const line = formatLogLine(level, args, opts.now?.());
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) rotate();
        // Synchronous on purpose: the last lines before a crash are the
        // ones that matter, and a till logs a few lines a minute.
        fs.writeSync(open(), line);
        size += bytes;
      } catch {
        // A log that cannot be written must never take the app down; stop
        // trying rather than fail on every line.
        broken = true;
      }
    },
    close() {
      closed = true;
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        fd = null;
      }
    },
  };
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
const LEVEL_OF: Record<ConsoleMethod, LogLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

/**
 * Copy everything written to `target` (normally `console`) into `log`.
 * The console keeps working as before. Returns a function that undoes it.
 */
export function teeConsoleToFileLog(
  log: FileLog,
  target: Pick<Console, ConsoleMethod> = console,
): () => void {
  const originals = {} as Record<ConsoleMethod, (...a: unknown[]) => void>;
  for (const method of Object.keys(LEVEL_OF) as ConsoleMethod[]) {
    const original = target[method].bind(target);
    originals[method] = original;
    (target as any)[method] = (...args: unknown[]) => {
      log.write(LEVEL_OF[method], args);
      original(...args);
    };
  }
  return () => {
    for (const method of Object.keys(originals) as ConsoleMethod[]) {
      (target as any)[method] = originals[method];
    }
  };
}

/**
 * The newest `maxBytes` of the log, oldest line first, across the current
 * file and the ones rotated before it. Starts on a whole line.
 */
export function readLogTail(
  dir: string,
  name: string,
  maxBytes: number,
): string {
  const parts: string[] = [];
  let budget = maxBytes;
  for (let g = 0; g <= LOG_KEEP_FILES && budget > 0; g++) {
    let text: string;
    try {
      const file = logFilePath(dir, name, g);
      const { size } = fs.statSync(file);
      const start = Math.max(0, size - budget);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
    } catch {
      break;
    }
    parts.unshift(text);
    budget -= Buffer.byteLength(text);
  }
  return parts.join('');
}
