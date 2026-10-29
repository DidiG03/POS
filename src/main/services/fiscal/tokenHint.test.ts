import { describe, expect, it } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import { getFiscalTokenHint } from './easypos';

const withToken = (authToken: string) =>
  ({ fiscal: { authToken } }) as unknown as SettingsDTO;

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64url');

describe('getFiscalTokenHint (QA F10)', () => {
  it('shows at most the last 4 characters of the token and its ids', () => {
    const jwt = `${b64({ alg: 'HS256' })}.${b64({
      tokenId: 'tok-1234567890',
      deviceId: 'dev-abcdefghij',
    })}.signature-ABCDEFGH`;
    const hint = getFiscalTokenHint(withToken(jwt));
    expect(hint).toEqual({
      configured: true,
      suffix: 'EFGH',
      tokenId: '7890',
      deviceTail: 'ghij',
    });
  });

  it('says only "set" for a short token, and nothing when unset', () => {
    expect(getFiscalTokenHint(withToken('abc123'))).toEqual({
      configured: true,
    });
    expect(getFiscalTokenHint(withToken(''))).toEqual({ configured: false });
  });

  it('handles a token that is not a JWT', () => {
    expect(getFiscalTokenHint(withToken('x'.repeat(30) + 'WXYZ'))).toEqual({
      configured: true,
      suffix: 'WXYZ',
    });
  });
});
