import fs from 'node:fs';
import path from 'node:path';

/**
 * Disk protection is on by default in packaged builds. An owner can turn it
 * off from Admin (for Macs where the encrypted engine fails with SQLite
 * disk I/O errors); this marker keeps it off across restarts. entry.ts reads
 * it before deciding POS_VAULT, so it must stay free of Electron/Prisma
 * imports.
 */
export const PROTECTION_OFF_FILE = 'disk-protection-off.json';

export function protectionOffFile(userData: string): string {
  return path.join(userData, PROTECTION_OFF_FILE);
}

export function isDiskProtectionOff(userData: string): boolean {
  try {
    return fs.existsSync(protectionOffFile(userData));
  } catch {
    return false;
  }
}

export function writeDiskProtectionOff(
  userData: string,
  info: { at: string; encryptedBackup?: string; vaultBackup?: string },
): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    protectionOffFile(userData),
    JSON.stringify({ v: 1, ...info }, null, 2),
  );
}

export function clearDiskProtectionOff(userData: string): void {
  try {
    fs.unlinkSync(protectionOffFile(userData));
  } catch {
    // already gone
  }
}
