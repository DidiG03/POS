import { createHash } from 'node:crypto';

/** Weak validator for waiter GETs so a phone can skip re-parsing unchanged JSON. */
export function weakEtag(body: string): string {
  const digest = createHash('sha1')
    .update(body)
    .digest('base64url')
    .slice(0, 22);
  return `W/"${digest}"`;
}

export function ifNoneMatchHits(header: unknown, etag: string): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  const got = String(raw || '').trim();
  if (!got) return false;
  return got.split(',').some((part) => part.trim() === etag);
}
