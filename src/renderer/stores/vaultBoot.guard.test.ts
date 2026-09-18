import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('vault boot guards', () => {
  it('does not mount settings/theme sync until the vault gate opens', () => {
    const src = read('src/renderer/app/BootRoot.tsx');
    const gated = between(src, '<VaultGate>', '</VaultGate>');
    expect(gated).toContain('<LocaleSync>');
    expect(gated).toContain('<ThemeSync>');
    expect(src.indexOf('<LocaleSync>')).toBeGreaterThan(
      src.indexOf('<VaultGate>'),
    );
  });

  it('does not treat a correct passphrase as failed when host boot throws', () => {
    const gate = read('src/renderer/app/components/VaultGate.tsx');
    expect(gate).toContain('busyRef');
    expect(gate).toContain("if (e.key === 'Enter' && !busy) void onUnlock()");
    expect(gate).toContain('if (busyRef.current) return');

    const main = read('src/main/index.ts');
    expect(main).toContain('[vault] boot after open failed:');
    expect(main).toContain('hostDatabaseStarting');
    expect(main).toContain('ensureLanApiStarted().catch(');

    const life = read('src/main/services/vault/lifecycle.ts');
    expect(life).toContain('persist after unlock failed');
    expect(life).toContain('function withVaultOp');
  });

  it('settings:get and auth:listUsers stay quiet while the vault is locked', () => {
    const src = read('src/main/index.ts');
    const settingsGet = between(
      src,
      "ipcHandle('settings:get'",
      "ipcHandle('settings:update'",
    );
    expect(settingsGet).toContain('isSqliteLocked()');
    expect(src).toContain('bootstrapVault');
    const listUsers = between(
      src,
      "ipcHandle('auth:listUsers'",
      "ipcHandle('auth:updateUser'",
    );
    expect(listUsers).toContain('isSqliteLocked()');
  });
});

describe('sqlite boot guards', () => {
  it('applies pragmas on the unextended client so query extensions cannot OOM', () => {
    const src = read('src/db/client.ts');
    expect(src).toContain('let raw: any = null');
    expect(src).toContain('const client = raw;');
    expect(src).toContain('await client.$queryRawUnsafe(sql)');
    expect(src.indexOf('sqliteConfigured = true')).toBeLessThan(
      src.indexOf('await applyPragmas()'),
    );
    expect(src).toContain("openMode === 'encrypted' ? ENCRYPTED_PRAGMAS");
    expect(src).toContain("'PRAGMA mmap_size=0;'");
    expect(src).toContain('concurrency: 1');
  });
});
