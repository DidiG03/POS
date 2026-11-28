import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: {} as any,
  store: new Map<string, any>(),
  made: [] as string[],
  notices: [] as string[],
  dir: '',
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: async ({ where }: any) =>
        h.store.has(where.key) ? { valueJson: h.store.get(where.key) } : null,
      upsert: async ({ where, create, update }: any) => {
        h.store.set(
          where.key,
          h.store.has(where.key) ? update.valueJson : create.valueJson,
        );
        return {};
      },
    },
  },
}));
vi.mock('./core', () => ({
  coreServices: { readSettings: async () => h.settings },
}));
vi.mock('./adminAlerts', () => ({
  notifyAdminsAndActor: async ({ message }: any) => {
    h.notices.push(message);
  },
}));
vi.mock('./dbBackups', () => ({
  getBackupsDir: () => h.dir,
  createDbBackupNow: async ({ prefix }: any) => {
    const name = `${prefix}-2026112${h.made.length}-000000.db`;
    const file = join(h.dir, name);
    fs.writeFileSync(file, 'SQLite format 3\0');
    h.made.push(file);
    return { ok: true, file };
  },
  copyBackupTo: async (file: string, folder: string) => {
    const dest = join(folder, file.split('/').pop()!);
    fs.copyFileSync(file, dest);
    return { ok: true, file: dest };
  },
}));

import {
  autoBackupConfig,
  autoBackupWarning,
  AUTO_BACKUP_STATUS_KEY,
  backupsToPrune,
  readAutoBackupStatus,
  runAutoBackup,
  scheduledBackupDue,
} from './autoBackup';
import { assertSettingsPatch } from './settingsValidation';

beforeEach(() => {
  h.store.clear();
  h.made = [];
  h.notices = [];
  h.dir = fs.mkdtempSync(join(os.tmpdir(), 'pos-auto-'));
  h.settings = {};
});

const H = 3_600_000;

describe('automatic backups', () => {
  it('are off unless switched on, with sensible defaults', () => {
    expect(autoBackupConfig({})).toEqual({
      enabled: false,
      onZ: true,
      everyHours: 6,
      folder: '',
      keep: 30,
    });
    expect(
      autoBackupConfig({ backups: { auto: true, everyHours: 99, keep: 0 } }),
    ).toMatchObject({
      enabled: true,
      everyHours: 24,
      keep: 1,
    });
  });

  it('do nothing when off, even at a Z', async () => {
    expect(await runAutoBackup('z')).toBeNull();
    expect(h.made).toEqual([]);
  });

  it('on: a Z writes a backup, copies it to the folder and records it', async () => {
    const usb = fs.mkdtempSync(join(os.tmpdir(), 'pos-usb-'));
    h.settings = { backups: { auto: true, folder: usb } };
    const s = await runAutoBackup('z');
    expect(s).toMatchObject({ ok: true, reason: 'z' });
    expect(fs.readdirSync(usb)).toHaveLength(1);
    expect((await readAutoBackupStatus())?.lastOkAt).toBe(s!.at);
  });

  it('a folder that cannot be reached fails visibly, and admins are told once', async () => {
    h.settings = { backups: { auto: true, folder: '/nonexistent/usb' } };
    const s = await runAutoBackup('schedule');
    expect(s).toMatchObject({ ok: false });
    expect(s!.error).toMatch(/cannot be reached/);
    await runAutoBackup('schedule');
    expect(h.notices).toHaveLength(1);
    expect(
      autoBackupWarning({
        config: autoBackupConfig(h.settings),
        status: h.store.get(AUTO_BACKUP_STATUS_KEY),
        now: Date.now(),
      }),
    ).toMatch(/last automatic backup failed/i);
  });

  it('keeps the newest N automatic backups only, never manual ones', () => {
    const names = [
      'pos-auto-20261101-000000.db',
      'pos-auto-20261103-000000.db',
      'pos-auto-20261102-000000.db',
      'pos-backup-20261101-000000.db',
      'notes.txt',
    ];
    expect(backupsToPrune(names, 2)).toEqual(['pos-auto-20261101-000000.db']);
  });

  it('is due every N hours, and retries a failure after 15 minutes', () => {
    const config = autoBackupConfig({ backups: { auto: true, everyHours: 6 } });
    const now = 100 * H;
    expect(scheduledBackupDue({ config, now })).toBe(true);
    expect(
      scheduledBackupDue({
        config,
        now,
        lastOkAt: new Date(now - 5 * H).toISOString(),
      }),
    ).toBe(false);
    expect(
      scheduledBackupDue({
        config,
        now,
        lastOkAt: new Date(now - 7 * H).toISOString(),
      }),
    ).toBe(true);
    expect(
      scheduledBackupDue({
        config,
        now,
        lastOkAt: new Date(now - 7 * H).toISOString(),
        lastAttemptAt: new Date(now - 5 * 60_000).toISOString(),
      }),
    ).toBe(false);
  });

  it('warns when the last good backup is over a day old', () => {
    const config = autoBackupConfig({ backups: { auto: true } });
    const now = 100 * H;
    expect(
      autoBackupWarning({
        config,
        now,
        status: {
          at: '',
          ok: true,
          reason: 'z',
          lastOkAt: new Date(now - 25 * H).toISOString(),
        },
      }),
    ).toMatch(/25 hours/);
    expect(
      autoBackupWarning({
        config,
        now,
        status: {
          at: '',
          ok: true,
          reason: 'z',
          lastOkAt: new Date(now - 2 * H).toISOString(),
        },
      }),
    ).toBeNull();
  });

  it('settings: refuses a folder that is not there, and out-of-range numbers', () => {
    expect(() =>
      assertSettingsPatch({ backups: { folder: '/nonexistent/usb' } }, {}),
    ).toThrow(/cannot be reached/);
    expect(() =>
      assertSettingsPatch({ backups: { everyHours: 0 } }, {}),
    ).toThrow();
    expect(() =>
      assertSettingsPatch({ backups: { keep: 1000 } }, {}),
    ).toThrow();
    expect(() =>
      assertSettingsPatch({ backups: { auto: true, folder: h.dir } }, {}),
    ).not.toThrow();
  });
});
