import fs from 'node:fs';
import path from 'node:path';
import type { WrappedKey } from './crypto';

export const VAULT_VERSION = 2 as const;

export type VaultUnlockMode = 'os' | 'passphrase';

export type VaultOsWrap = {
  provider: 'safeStorage';
  blob: string;
};

export type VaultFile = {
  version: 1 | typeof VAULT_VERSION;
  passphrase?: WrappedKey;
  recovery: WrappedKey;
  unlockMode?: VaultUnlockMode;
  os?: VaultOsWrap;
};

export function vaultFilePath(userData: string): string {
  return path.join(userData, 'vault.json');
}

function isWrapped(value: unknown): value is WrappedKey {
  if (!value || typeof value !== 'object') return false;
  const row = value as WrappedKey;
  return Boolean(row.ct && row.iv && row.kdf?.salt);
}

export function effectiveUnlockMode(vault: VaultFile): VaultUnlockMode {
  if (vault.unlockMode === 'passphrase' || vault.unlockMode === 'os') {
    return vault.unlockMode;
  }
  return 'os';
}

export function readVaultFile(userData: string): VaultFile | null {
  const file = vaultFilePath(userData);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as VaultFile;
    if (parsed?.version !== 1 && parsed?.version !== 2) return null;
    if (!isWrapped(parsed.recovery)) return null;
    if (parsed.version === 1 && !isWrapped(parsed.passphrase)) return null;
    if (parsed.passphrase && !isWrapped(parsed.passphrase)) return null;
    const os =
      parsed.os?.provider === 'safeStorage' && parsed.os.blob
        ? { provider: 'safeStorage' as const, blob: String(parsed.os.blob) }
        : undefined;
    return {
      version: parsed.version,
      passphrase: parsed.passphrase,
      recovery: parsed.recovery,
      unlockMode: parsed.unlockMode,
      os,
    };
  } catch {
    return null;
  }
}

export function writeVaultFile(userData: string, vault: VaultFile): void {
  const file = vaultFilePath(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: VaultFile = {
    version: VAULT_VERSION,
    recovery: vault.recovery,
    unlockMode: effectiveUnlockMode(vault),
  };
  if (vault.passphrase) body.passphrase = vault.passphrase;
  if (vault.os?.blob) body.os = vault.os;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
}
