import { describe, expect, it } from 'vitest';
import {
  groupNotifications,
  notificationHref,
  notificationWhere,
  parseNotification,
} from './notificationDisplay';

describe('parseNotification', () => {
  it('turns a fiscal cancel dump into a short card with the table and error tucked away', () => {
    const parsed = parseNotification(
      'Corrective fiscal invoice required for Salla Table T7: Cancellation invoice required: per qef (-1400) · Cancellation was not filed: easyPos refused the payload (HTTP 400): Unknown fields found, please remove them: correctiveInvoice.type:CANCELLATION. · NIVF 6d23 · NSLF 82A8 · docId edd9bb46 · Issue the correction in easyPos, then mark it done in Settings › Fiskalizimi.',
    );
    expect(parsed.kind).toBe('fiscal');
    expect(parsed.titleKey).toBe('inbox.fiscalCancelTitle');
    expect(parsed.where).toBe('Salla T7');
    expect(parsed.area).toBe('Salla');
    expect(parsed.tableLabel).toBe('T7');
    expect(parsed.docId).toBe('edd9bb46');
    expect(parsed.nslf).toBe('82A8');
    expect(parsed.summaryKey).toBe('inbox.fiscalCancelSummary');
    expect(parsed.detail).toMatch(/easyPos refused/i);
    expect(parsed.tone).toBe('danger');
    const href = notificationHref(parsed);
    expect(href?.pathname).toBe('/admin/settings');
    expect(href?.search).toContain('section=fiscal');
    expect(href?.search).toContain('table=T7');
    expect(href?.search).toContain('doc=edd9bb46');
  });

  it('classifies an unreachable tax service without repeating the wall of text as the title', () => {
    const parsed = parseNotification(
      'Fiskalizimi is unreachable. Sales are still being taken and will be sent automatically when the connection is back (48-hour window). The request never reached easyPos (no network, connection refused, or host not resolved), so nothing was filed.',
    );
    expect(parsed.kind).toBe('fiscal');
    expect(parsed.titleKey).toBe('inbox.fiscalUnreachableTitle');
    expect(parsed.detail).toMatch(/never reached easyPos/i);
  });

  it('classifies a wrong PIN', () => {
    const parsed = parseNotification('Wrong PIN attempt on your account');
    expect(parsed).toMatchObject({
      kind: 'security',
      titleKey: 'inbox.pinTitle',
    });
    expect(notificationHref(parsed)?.pathname).toBe('/admin');
    expect(notificationHref(parsed)?.search).toContain('focus=staff');
  });

  it('pulls the discount figures out of the audit sentence', () => {
    const parsed = parseNotification(
      'Discount applied (50.00) on Salla Table T7: -50.00 (total 1100.00 → 1050.00) · method CASH · reason: Per qef · approved by: Admin',
    );
    expect(parsed.kind).toBe('ticket');
    expect(parsed.titleKey).toBe('inbox.discountTitle');
    expect(parsed.where).toBe('Salla T7');
    expect(parsed.summaryParams).toMatchObject({
      amount: '50.00',
      before: '1100.00',
      after: '1050.00',
    });
    expect(parsed.summaryParams?.extras).toMatch(/CASH/);
    expect(parsed.summaryParams?.extras).toMatch(/Per qef/);
    const href = notificationHref(parsed, {
      createdAt: '2026-09-10T19:00:00.000Z',
      admin: true,
    });
    expect(href?.pathname).toBe('/admin/tickets');
    expect(href?.search).toContain('table=T7');
    expect(href?.search).toContain('area=Salla');
  });

  it('sends waiters to the floor instead of admin settings', () => {
    const parsed = parseNotification(
      'Fiskalizimi needs a cancellation on Bar Table 4. File it in Settings › Fiskalizimi.',
    );
    const href = notificationHref(parsed, { admin: false });
    expect(href?.pathname).toBe('/app/tables');
    expect(href?.search).toContain('table=4');
    expect(href?.search).toContain('area=Bar');
  });

  it('sends unusual void activity to tickets for that day', () => {
    const parsed = parseNotification(
      'Unusual activity (auto-check): several voids in a short window.',
    );
    expect(parsed.titleKey).toBe('inbox.unusualTitle');
    const href = notificationHref(parsed, {
      createdAt: '2026-09-10T19:00:00.000Z',
      admin: true,
    });
    expect(href?.pathname).toBe('/admin/tickets');
    expect(href?.search).toContain('start=');
  });
});

describe('groupNotifications', () => {
  it('keeps fiscal alerts above discounts and PIN checks in their own sections', () => {
    const groups = groupNotifications([
      {
        id: 1,
        message:
          'Discount applied (1.00) on Bar Table 1: -1.00 (total 2.00 → 1.00)',
      },
      { id: 2, message: 'Wrong PIN attempt on your account' },
      {
        id: 3,
        message:
          'Fiskalizimi needs a cancellation on Bar Table 4. File it in Settings › Fiskalizimi.',
      },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['fiscal', 'security', 'ticket']);
    expect(groups[0].items[0].id).toBe(3);
  });
});

describe('notificationWhere', () => {
  it('drops the word Table from the label', () => {
    expect(notificationWhere('void on Garden Table 12: x')).toBe('Garden 12');
  });
});
