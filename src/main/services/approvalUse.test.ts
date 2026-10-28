import { beforeEach, describe, expect, it } from 'vitest';
import {
  __clearApprovalUses,
  approvalScope,
  claimApprovalUse,
  releaseApprovalUse,
  voidLineIdentity,
} from './approvalUse';
import {
  __clearApprovalTokens,
  claimApprovalFor,
  issueApprovalToken,
} from './approvalTokens';

const T0 = 1_790_000_000_000;
const EXP = T0 + 5 * 60_000;

describe('one approval, one action', () => {
  beforeEach(() => {
    __clearApprovalUses();
    __clearApprovalTokens();
  });

  const line = (name: string) =>
    approvalScope('VOID_ITEM', 'Main', 'T1', voidLineIdentity({ name }));

  it('refuses the same approval for a second, different void', () => {
    const claim = (scope: string, key: string) =>
      claimApprovalUse({
        tokenId: 'tok',
        scope,
        idempotencyKey: key,
        expiresAt: EXP,
        now: T0,
      });
    expect(claim(line('Water'), 'k1')).toBe(true);
    expect(claim(line('Wine'), 'k2')).toBe(false);
    expect(claim(line('Beer'), 'k3')).toBe(false);
  });

  it('refuses a second void of the same line with a new request', () => {
    const base = { tokenId: 'tok', expiresAt: EXP, now: T0 };
    expect(
      claimApprovalUse({ ...base, scope: line('Water'), idempotencyKey: 'a' }),
    ).toBe(true);
    expect(
      claimApprovalUse({ ...base, scope: line('Water'), idempotencyKey: 'b' }),
    ).toBe(false);
    expect(claimApprovalUse({ ...base, scope: line('Water') })).toBe(false);
  });

  it('accepts a retry of the same void (offline queue replay)', () => {
    const base = {
      tokenId: 'tok',
      expiresAt: EXP,
      now: T0,
      idempotencyKey: 'a',
    };
    expect(claimApprovalUse({ ...base, scope: line('Water') })).toBe(true);
    expect(claimApprovalUse({ ...base, scope: line('Water') })).toBe(true);
  });

  it('a released claim can be used again', () => {
    const base = { tokenId: 'tok', expiresAt: EXP, now: T0 };
    expect(
      claimApprovalUse({ ...base, scope: line('Water'), idempotencyKey: 'a' }),
    ).toBe(true);
    releaseApprovalUse('tok', line('Water'));
    expect(
      claimApprovalUse({ ...base, scope: line('Wine'), idempotencyKey: 'b' }),
    ).toBe(true);
  });

  it('a payment approval covers retries of that bill only', () => {
    const pay = (table: string, key: string) =>
      claimApprovalUse({
        tokenId: 'tok',
        scope: approvalScope('PAYMENT', 'Main', table),
        idempotencyKey: key,
        expiresAt: EXP,
        now: T0,
        anyKeyInScope: true,
      });
    expect(pay('T1', 'a')).toBe(true);
    expect(pay('T1', 'b')).toBe(true);
    expect(pay('T2', 'c')).toBe(false);
  });

  it('till tokens are claimed the same way', () => {
    const tok = issueApprovalToken(1, 'ADMIN');
    expect(claimApprovalFor(tok, 1, line('Water'), 'a')).toBe(true);
    expect(claimApprovalFor(tok, 1, line('Wine'), 'b')).toBe(false);
    // Wrong admin named: refused before any claim.
    const other = issueApprovalToken(1, 'ADMIN');
    expect(claimApprovalFor(other, 2, line('Wine'), 'b')).toBe(false);
    expect(claimApprovalFor(other, 1, line('Wine'), 'b')).toBe(true);
  });
});
