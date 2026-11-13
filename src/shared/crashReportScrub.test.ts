import { describe, expect, it } from 'vitest';
import {
  crashReportsAllowed,
  scrubBreadcrumb,
  scrubCrashEvent,
} from './crashReportScrub';

describe('scrubCrashEvent', () => {
  it('keeps the error and drops names, phones and secrets', () => {
    const out = scrubCrashEvent({
      message: 'login failed {"pin":"482913"}',
      exception: {
        values: [{ type: 'Error', value: 'Bearer abc.def.ghi expired' }],
      },
      user: {
        id: 7,
        username: 'Ana Kola',
        role: 'WAITER',
        ip_address: '10.0.0.5',
      },
      extra: {
        payload: {
          area: 'Main',
          tableLabel: 'T4',
          userName: 'Ana Kola',
          items: [{ name: 'Espresso', qty: 2 }],
          meta: { customerPhone: '+355 69 000 0000', total: 3 },
        },
      },
      breadcrumbs: [
        {
          message: 'token=eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl',
          data: { displayName: 'Ana' },
        },
      ],
    });
    const text = JSON.stringify(out);
    for (const secret of [
      '482913',
      'abc.def.ghi',
      'Ana Kola',
      '+355',
      'eyJhbGciOiJI',
      '10.0.0.5',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(out.user).toEqual({ id: '7', role: 'WAITER' });
    expect(out.extra.payload.tableLabel).toBe('T4');
    expect(out.extra.payload.meta.total).toBe(3);
    expect(out.exception.values[0].type).toBe('Error');
  });

  it('cleans a breadcrumb on its own', () => {
    expect(
      scrubBreadcrumb({ message: 'pin: 1234', data: { customerName: 'X' } }),
    ).toEqual({
      message: 'pin: [redacted]',
      data: { customerName: '[removed]' },
    });
  });

  it('sends unless the venue turned reports off', () => {
    expect(crashReportsAllowed({})).toBe(true);
    expect(crashReportsAllowed({ privacy: { crashReports: false } })).toBe(
      false,
    );
  });
});
