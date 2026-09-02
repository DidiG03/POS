import { beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_TOKEN_TTL_MS,
  __clearApprovalTokens,
  isApprovalValidFor,
  issueApprovalToken,
  verifyApprovalToken,
} from './approvalTokens';

describe('approval tokens', () => {
  beforeEach(() => {
    __clearApprovalTokens();
  });

  it('resolves a freshly issued token to its admin', () => {
    const token = issueApprovalToken(7);
    expect(verifyApprovalToken(token)).toMatchObject({
      userId: 7,
      role: 'ADMIN',
    });
  });

  it('issues unguessable, unique tokens', () => {
    const a = issueApprovalToken(7);
    const b = issueApprovalToken(7);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('rejects an unknown or empty token', () => {
    expect(verifyApprovalToken('made-up')).toBeNull();
    expect(verifyApprovalToken('')).toBeNull();
    expect(verifyApprovalToken(null)).toBeNull();
    expect(verifyApprovalToken(undefined)).toBeNull();
  });

  it('expires a token after its window', () => {
    const t0 = 1_000_000;
    const token = issueApprovalToken(7, 'ADMIN', t0);
    expect(
      verifyApprovalToken(token, t0 + APPROVAL_TOKEN_TTL_MS - 1),
    ).not.toBeNull();
    expect(verifyApprovalToken(token, t0 + APPROVAL_TOKEN_TTL_MS)).toBeNull();
  });

  it('stays valid for a repeat use inside the window', () => {
    const token = issueApprovalToken(7);
    expect(isApprovalValidFor(token, 7)).toBe(true);
    expect(isApprovalValidFor(token, 7)).toBe(true);
  });

  it('does not accept an approval attributed to a different admin', () => {
    const token = issueApprovalToken(7);
    expect(isApprovalValidFor(token, 8)).toBe(false);
  });

  it('does not accept an admin id with no token at all', () => {
    expect(isApprovalValidFor('', 7)).toBe(false);
    expect(isApprovalValidFor(undefined, 7)).toBe(false);
  });

  it('does not accept a non-admin grant', () => {
    const token = issueApprovalToken(7, 'WAITER');
    expect(isApprovalValidFor(token, 7)).toBe(false);
  });

  it('drops expired tokens from the store instead of growing forever', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) issueApprovalToken(i + 1, 'ADMIN', t0);
    const live = issueApprovalToken(
      99,
      'ADMIN',
      t0 + APPROVAL_TOKEN_TTL_MS + 1,
    );
    const store = (globalThis as any).__approvalTokensLocal as Map<
      string,
      unknown
    >;
    expect(store.size).toBe(1);
    expect(
      verifyApprovalToken(live, t0 + APPROVAL_TOKEN_TTL_MS + 2),
    ).not.toBeNull();
  });
});
