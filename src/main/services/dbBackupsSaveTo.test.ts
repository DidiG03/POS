import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ verdictOk: true, saved: null as any }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('@db/client', () => ({
  getOpenSqliteMode: () => 'plain',
  prisma: {
    syncState: {
      upsert: async (args: any) => {
        h.saved = args.update.valueJson;
        return {};
      },
      findUnique: async () => (h.saved ? { valueJson: h.saved } : null),
    },
  },
}));
vi.mock('./ledgerFileCheck', () => ({
  checkLedgerFile: async () =>
    h.verdictOk
      ? { ok: true }
      : { ok: false, reason: 'damaged', detail: 'bad' },
}));
vi.mock('./vault/lifecycle', () => ({ openLedgerEncryptionKey: () => null }));

import { readBackupSavedElsewhere, saveBackupTo } from './dbBackups';

let dir: string;
let src: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-save-'));
  src = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pos-src-')),
    'pos-backup-1.db',
  );
  fs.writeFileSync(src, 'ledger bytes');
  h.verdictOk = true;
  h.saved = null;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('saveBackupTo', () => {
  const makeBackup = async () => ({ ok: true, file: src });

  it('copies a checked backup into the folder and remembers when', async () => {
    const r = await saveBackupTo(dir, { makeBackup });
    expect(r).toEqual({ ok: true, file: path.join(dir, 'pos-backup-1.db') });
    expect(fs.readFileSync(r.file!, 'utf8')).toBe('ledger bytes');
    const saved = await readBackupSavedElsewhere();
    expect(saved?.file).toBe(r.file);
  });

  it('removes a copy that fails its check, and remembers nothing', async () => {
    h.verdictOk = false;
    const r = await saveBackupTo(dir, { makeBackup });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('did not pass its check');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await readBackupSavedElsewhere()).toBeNull();
  });

  it('says so when the folder cannot be written', async () => {
    const r = await saveBackupTo(path.join(dir, 'missing', 'deeper'), {
      makeBackup,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('could not be written');
  });

  it('passes on a backup that could not be made', async () => {
    const r = await saveBackupTo(dir, {
      makeBackup: async () => ({ ok: false, error: 'disk full' }),
    });
    expect(r).toEqual({ ok: false, error: 'disk full' });
  });
});
