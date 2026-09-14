/**
 * Open a URL in the system browser without dropping CIS hash query params.
 *
 * `shell.openExternal` on macOS can hand NSWorkspace a URL whose `#/verify?…`
 * fragment is stripped, which is how InvoiceCheck ends up on `#/noData`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';

const execFileAsync = promisify(execFile);

const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

export function sanitizeExternalUrl(raw: string): string | null {
  const url = String(raw || '').trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!ALLOWED.has(parsed.protocol)) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export async function openExternalUrl(raw: string): Promise<boolean> {
  const safe = sanitizeExternalUrl(raw);
  if (!safe) return false;
  if (process.platform === 'darwin') {
    await execFileAsync('open', [safe]);
    return true;
  }
  await shell.openExternal(safe);
  return true;
}
