import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({
  prisma: {
    area: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('./googleCalendarOAuth', () => ({
  getGoogleOAuthClientConfig: () => ({ configured: true }),
}));

import { presentSettingsForClient } from './settingsPresent';

describe('presentSettingsForClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips secrets and flags configured fiscal / calendar state', async () => {
    const presented = await presentSettingsForClient(
      {
        tableAreas: [{ name: 'Salla', count: 8 }],
        security: { apiSecret: 'x', pairingCode: '123456' },
        fiscal: { enabled: true, authToken: 'secret-token' },
        googleCalendar: {
          enabled: true,
          icalUrl: 'https://example/cal.ics',
          oauth: {
            refreshToken: 'rt',
            accessToken: 'at',
            accessTokenExpiresAt: '2099-01-01',
          },
        },
      },
      { includePairingCode: false },
    );
    expect(presented.security.apiSecret).toBeUndefined();
    expect(presented.security.pairingCode).toBeUndefined();
    expect(presented.fiscal.authToken).toBeUndefined();
    expect(presented.fiscal.authTokenConfigured).toBe(true);
    expect(presented.googleCalendar.icalUrl).toBeUndefined();
    expect(presented.googleCalendar.icalUrlConfigured).toBe(true);
    expect(presented.googleCalendar.oauth.refreshToken).toBeUndefined();
    expect(presented.googleCalendar.oauthConnected).toBe(true);
    expect(presented.googleCalendarOAuthConfigured).toBe(true);
  });

  it('returns the pairing code only to admins', async () => {
    const presented = await presentSettingsForClient(
      { security: { pairingCode: '654321' } },
      { includePairingCode: true },
    );
    expect(presented.security.pairingCode).toBe('654321');
  });
});
