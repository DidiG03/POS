/**
 * Where electron-updater should look for latest.yml / latest-mac.yml.
 *
 * GitHub's *provider* talks to the Releases API (60 unauthenticated calls
 * per hour, easy 403s on a till). The generic feed hits
 * `/releases/latest/download/` instead, which is a static file and is what
 * Windows (`latest.yml`) and macOS (`latest-mac.yml`) both publish.
 */

export type ResolvedUpdateFeed = {
  provider: 'generic';
  url: string;
  channel?: string;
};

export function githubLatestDownloadUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/releases/latest/download/`;
}

export function resolveUpdateFeed(input: {
  githubOwner?: string;
  githubRepo?: string;
  updateServerUrl?: string;
  channel?: string;
}): ResolvedUpdateFeed | null {
  const custom = String(input.updateServerUrl || '').trim();
  if (custom) {
    const feed: ResolvedUpdateFeed = {
      provider: 'generic',
      url: custom.endsWith('/') ? custom : `${custom}/`,
    };
    if (input.channel) feed.channel = input.channel;
    return feed;
  }

  const owner = String(input.githubOwner || '').trim();
  const repo = String(input.githubRepo || '').trim();
  if (!owner || !repo) return null;

  const feed: ResolvedUpdateFeed = {
    provider: 'generic',
    url: githubLatestDownloadUrl(owner, repo),
  };
  if (input.channel) feed.channel = input.channel;
  return feed;
}
