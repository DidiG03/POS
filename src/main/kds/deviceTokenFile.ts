import fs from 'node:fs';
import { dirname } from 'node:path';

/**
 * The pairing token, kept by the main process in its own file
 * (QA v0.2.104, #13). It used to live only in the page's localStorage,
 * which Chromium writes to disk lazily: the kiosk auto-update restarts the
 * app with `quitAndInstall`, and a display paired shortly before lost its
 * pairing. Its own file, so saving a new host config cannot drop it.
 */
export function readKdsDeviceTokenFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const t = JSON.parse(fs.readFileSync(file, 'utf-8'))?.token;
    return typeof t === 'string' && t.length >= 10 ? t : null;
  } catch {
    return null;
  }
}

export function writeKdsDeviceTokenFile(
  token: string | null,
  file: string,
): void {
  if (!token) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
    return;
  }
  fs.mkdirSync(dirname(file), { recursive: true });
  // Written whole, then renamed: a crash mid-write never leaves half a token.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token }), 'utf-8');
  fs.renameSync(tmp, file);
}
