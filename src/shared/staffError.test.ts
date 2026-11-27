import { describe, expect, it } from 'vitest';
import {
  isDatabaseError,
  staffSafeMessage,
  TILL_BUSY_MESSAGE,
  TILL_BUSY_MESSAGE_GENERIC,
} from './staffError';

const raw =
  'Invalid `prisma.syncState.create()` invocation:\n\nSocket timeout (the database failed to respond to a query within the configured timeout — see https://pris.ly/d/sqlite-connector)';

describe('staff-safe errors', () => {
  it('recognises database stalls by error, code or text', () => {
    expect(isDatabaseError(raw)).toBe(true);
    expect(
      isDatabaseError(Object.assign(new Error('x'), { code: 'P2024' })),
    ).toBe(true);
    expect(
      isDatabaseError(
        Object.assign(new Error('busy'), {
          name: 'PrismaClientUnknownRequestError',
        }),
      ),
    ).toBe(true);
    expect(isDatabaseError(new Error('SQLITE_BUSY: database is locked'))).toBe(
      true,
    );
    // A unique-key race is an answer, not a stall.
    expect(
      isDatabaseError(
        Object.assign(new Error('Unique constraint'), {
          name: 'PrismaClientKnownRequestError',
          code: 'P2002',
        }),
      ),
    ).toBe(false);
    expect(isDatabaseError(new Error('This table is already paid.'))).toBe(
      false,
    );
  });

  it('never shows the ORM text to staff', () => {
    expect(staffSafeMessage(raw, { payment: true })).toBe(TILL_BUSY_MESSAGE);
    expect(staffSafeMessage(raw)).toBe(TILL_BUSY_MESSAGE_GENERIC);
    expect(TILL_BUSY_MESSAGE).toMatch(/payment was not taken/);
  });

  it('cuts stack traces, keeps ordinary sentences', () => {
    expect(
      staffSafeMessage('Printer offline\n    at send (/app/print.js:10:5)'),
    ).toBe('Printer offline');
    expect(staffSafeMessage('This table is already paid.')).toBe(
      'This table is already paid.',
    );
  });
});
