import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileLog,
  formatLogLine,
  logFilePath,
  readLogTail,
  redactLogText,
  teeConsoleToFileLog,
} from './fileLog';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-log-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('redactLogText', () => {
  it('masks PINs, tokens, keys and the pairing code', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwicm9sZSI6IkFETUlOIn0.c2lnbmF0dXJlLXZhbHVl';
    const out = redactLogText(
      `login {"userId":1,"pin":"482913"} pin: '7' token=${jwt} ` +
        `Authorization: Bearer abc.def.ghi pairingCode=123456 ` +
        `key POS1.eyJjaWQiOiJjdXNfMSJ9.bWFj recoveryKey: "ABCD-EFGH" ` +
        `{ authToken: 'tok-123', managerApprovalToken: "x" }`,
    );
    for (const secret of [
      '482913',
      "'7'",
      jwt,
      'abc.def.ghi',
      '123456',
      'POS1.',
      'ABCD-EFGH',
      'tok-123',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('"userId":1');
    expect(out).toContain('[redacted]');
  });

  it('leaves ordinary text alone', () => {
    const line = 'Printed receipt for Main Hall T4: 2 x Espresso, total 3.00';
    expect(redactLogText(line)).toBe(line);
  });
});

describe('formatLogLine', () => {
  it('stamps the time and level, and formats like the console', () => {
    const line = formatLogLine(
      'warn',
      ['[print] %s failed', 'T4', { code: 'ECONNREFUSED' }],
      new Date('2026-11-13T10:00:00.000Z'),
    );
    expect(line).toBe(
      "2026-11-13T10:00:00.000Z WARN  [print] T4 failed { code: 'ECONNREFUSED' }\n",
    );
  });
});

describe('createFileLog', () => {
  it('appends to the file and rotates it, keeping a fixed number', () => {
    const log = createFileLog({ dir, name: 'pos', maxBytes: 200, keep: 2 });
    for (let i = 0; i < 20; i++)
      log.write('info', [`line ${i} ${'x'.repeat(40)}`]);
    log.close();
    expect(fs.existsSync(logFilePath(dir, 'pos'))).toBe(true);
    expect(fs.existsSync(logFilePath(dir, 'pos', 1))).toBe(true);
    expect(fs.existsSync(logFilePath(dir, 'pos', 2))).toBe(true);
    expect(fs.existsSync(logFilePath(dir, 'pos', 3))).toBe(false);
    for (const g of [0, 1, 2]) {
      expect(fs.statSync(logFilePath(dir, 'pos', g)).size).toBeLessThanOrEqual(
        200,
      );
    }
    expect(fs.readFileSync(logFilePath(dir, 'pos'), 'utf8')).toContain(
      'line 19',
    );
  });

  it('carries on from an existing file after a restart', () => {
    fs.writeFileSync(logFilePath(dir, 'pos'), 'before\n');
    const log = createFileLog({ dir, name: 'pos' });
    log.write('error', ['after']);
    log.close();
    const text = fs.readFileSync(logFilePath(dir, 'pos'), 'utf8');
    expect(text.startsWith('before\n')).toBe(true);
    expect(text).toContain('ERROR after');
  });

  it('never throws when the file cannot be written', () => {
    const log = createFileLog({ dir, name: 'pos' });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a folder');
    expect(() => log.write('info', ['x'])).not.toThrow();
    log.close();
    fs.rmSync(dir, { force: true });
    fs.mkdirSync(dir);
  });
});

describe('teeConsoleToFileLog', () => {
  it('copies console output to the file and can be undone', () => {
    const log = createFileLog({ dir, name: 'pos' });
    const target = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const undo = teeConsoleToFileLog(log, target as any);
    target.error('[fiscal] refused', { pin: '1234' });
    target.log('ready');
    undo();
    target.warn('not logged');
    log.close();
    const text = fs.readFileSync(log.path, 'utf8');
    expect(text).toContain('ERROR [fiscal] refused');
    expect(text).toContain('INFO  ready');
    expect(text).not.toContain('1234');
    expect(text).not.toContain('not logged');
  });
});

describe('readLogTail', () => {
  it('returns the newest part, across rotated files, from a whole line', () => {
    const log = createFileLog({ dir, name: 'pos', maxBytes: 300, keep: 3 });
    for (let i = 0; i < 30; i++) log.write('info', [`line-${i}`]);
    log.close();
    const tail = readLogTail(dir, 'pos', 400);
    expect(tail.endsWith('line-29\n')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(400);
    expect(/^\d{4}-\d\d-\d\dT/.test(tail)).toBe(true);
    const idx = tail
      .split('\n')
      .filter(Boolean)
      .map((l) => Number(l.split('line-')[1]));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(readLogTail(path.join(dir, 'none'), 'pos', 100)).toBe('');
  });
});
