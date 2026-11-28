import { describe, expect, it, vi } from 'vitest';

const review = [
  {
    idempotencyKey: 'a',
    record: { state: 'UNKNOWN', attempts: 1, createdAt: '', updatedAt: '' },
  },
  {
    idempotencyKey: 'b',
    record: {
      state: 'DEFERRED',
      holdReason: 'refused',
      holdKind: 'rejected',
      attempts: 1,
      createdAt: '',
      updatedAt: '',
    },
  },
  {
    idempotencyKey: 'c',
    record: {
      state: 'CORRECTION_REQUIRED',
      attempts: 1,
      createdAt: '',
      updatedAt: '',
    },
  },
];
const deferred = [
  {
    idempotencyKey: 'q',
    record: {
      state: 'DEFERRED',
      attempts: 1,
      createdAt: '2026-11-28T10:00:00Z',
      updatedAt: '',
    },
  },
];
vi.mock('./fiscal', () => ({
  listFiscalClaimsNeedingReview: async () => review,
  listFiscalClaimsDeferred: async () => deferred,
  readFiscalClaim: async () => null,
  resolveFiscalClaim: async () => ({ ok: true }),
}));
vi.mock('./fiscal/claims', () => ({
  heldClaimIsDefinitelyNotFiled: () => true,
}));
vi.mock('./fiscal/reviewRetry', () => ({
  retryFiscalReview: async () => ({ ok: true }),
}));
vi.mock('./fiscal/deferred', () => ({
  stampFiscalIdentifiersOnSale: async () => undefined,
}));
vi.mock('./core', () => ({ coreServices: { readSettings: async () => ({}) } }));

import { listFiscalReviewsForAdmin } from './fiscalReviews';

describe('the review badge', () => {
  it('counts exactly the sales the review dialog lists', async () => {
    const rows = await listFiscalReviewsForAdmin();
    const shown = rows.filter((r) => r.kind !== 'deferred');
    // The badge is `listFiscalClaimsNeedingReview().length` (`statusLightsRead`).
    expect(shown).toHaveLength(review.length);
    expect(shown.map((r) => r.idempotencyKey)).toEqual(['a', 'b', 'c']);
  });
});
