import { describe, expect, it } from 'vitest';
import { githubLatestDownloadUrl, resolveUpdateFeed } from './updateFeed';

describe('resolveUpdateFeed', () => {
  it('prefers an explicit generic server URL', () => {
    expect(
      resolveUpdateFeed({
        githubOwner: 'DidiG03',
        githubRepo: 'POS',
        updateServerUrl: 'https://updates.example.com/pos',
        channel: 'kds',
      }),
    ).toEqual({
      provider: 'generic',
      url: 'https://updates.example.com/pos/',
      channel: 'kds',
    });
  });

  it('uses GitHub latest/download so Windows and macOS skip the API', () => {
    expect(
      resolveUpdateFeed({
        githubOwner: 'DidiG03',
        githubRepo: 'POS',
      }),
    ).toEqual({
      provider: 'generic',
      url: 'https://github.com/DidiG03/POS/releases/latest/download/',
    });
    expect(githubLatestDownloadUrl('DidiG03', 'POS')).toBe(
      'https://github.com/DidiG03/POS/releases/latest/download/',
    );
  });

  it('keeps the KDS/Admin channel so kds.yml / admin.yml / *-mac.yml resolve', () => {
    expect(
      resolveUpdateFeed({
        githubOwner: 'DidiG03',
        githubRepo: 'POS',
        channel: 'kds',
      }),
    ).toEqual({
      provider: 'generic',
      url: 'https://github.com/DidiG03/POS/releases/latest/download/',
      channel: 'kds',
    });
  });

  it('returns null when no feed is configured (bundled app-update.yml)', () => {
    expect(resolveUpdateFeed({})).toBeNull();
    expect(resolveUpdateFeed({ githubOwner: 'DidiG03' })).toBeNull();
  });
});
