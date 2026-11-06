/**
 * Audit M3: a payment held the table lock through the receipt print, so a
 * slow printer made every other device's Send to that table fail with
 * TABLE_BUSY. The print now runs after the lock is released.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./tableOpen', () => ({ applyTableOpenState: async () => undefined }));

import { withTableLock } from './core';
import {
  afterPaymentLock,
  finishAfterPaymentLock,
  withPaymentLockThen,
} from './paymentSettle';

describe('withPaymentLockThen', () => {
  it('releases the table before the after-lock work (the print) runs', async () => {
    const events: string[] = [];
    let releasePrinter!: () => void;
    const printer = new Promise<void>((r) => (releasePrinter = r));
    const pay = withPaymentLockThen('Salla', 'T7', async () => {
      events.push('sale recorded, table settled');
      return afterPaymentLock(async () => {
        events.push('printing');
        await printer; // a slow printer
        events.push('printed');
        return 'answer';
      });
    });
    // Another phone sends to the same table while the receipt prints.
    await new Promise((r) => setTimeout(r, 5));
    const send = await withTableLock(
      'Salla',
      'T7',
      async () => {
        events.push('other send');
        return 'sent';
      },
      200,
    );
    expect(send).toBe('sent');
    releasePrinter();
    expect(await pay).toBe('answer');
    expect(events).toEqual([
      'sale recorded, table settled',
      'printing',
      'other send',
      'printed',
    ]);
  });

  it('passes plain results (refusals, replays) straight through', async () => {
    expect(await withPaymentLockThen('Salla', 'T8', async () => 409)).toBe(409);
    expect(await finishAfterPaymentLock('x')).toBe('x');
  });
});

describe('payment paths print after the lock', () => {
  // Both entry points (LAN and the till's IPC) must keep the receipt print
  // inside the after-lock work, after the sale is recorded and settled.
  for (const file of ['../api.ts', '../index.ts']) {
    it(file, () => {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const after = src.indexOf('return afterPaymentLock(async () => {');
      expect(after).toBeGreaterThan(0);
      const before = src.slice(Math.max(0, after - 1500), after);
      expect(before).toMatch(/persist(?:Lan)?Audit\('SENT'\)/);
      expect(before).toContain('settleTableAfterPayment');
      expect(before).not.toContain('dispatchTicket(');
      const inside = src.slice(after, after + 800);
      expect(inside).toContain('dispatchTicket(');
      expect(inside).toContain('markReceiptPrintFailed');
    });
  }
});
