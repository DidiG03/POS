/** Decide whether an open table with no live ticket lines should stay occupied. */

export function hasLocalCovers(covers: number | null | undefined): boolean {
  return typeof covers === 'number' && covers > 0;
}

export function shouldKeepCoversOnlyTableOpen(opts: {
  latestHadLines: boolean;
  suppressClose?: boolean;
  localCovers?: number | null;
  serverCovers?: number | null;
}): boolean {
  if (opts.suppressClose) return true;
  if (opts.latestHadLines) return false;
  return hasLocalCovers(opts.localCovers) || hasLocalCovers(opts.serverCovers);
}

export function cacheLooksLikeCurrentSession(
  cached: { createdAt?: string | null } | null | undefined,
  openedAt?: string | null,
): boolean {
  if (!cached) return false;
  if (!openedAt) return false;
  const cacheAt = new Date(String(cached.createdAt || '')).getTime();
  const sessionAt = new Date(openedAt).getTime();
  if (!Number.isFinite(cacheAt) || !Number.isFinite(sessionAt)) return false;
  return cacheAt >= sessionAt - 2000;
}
