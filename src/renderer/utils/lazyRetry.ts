/**
 * Capacitor / Wi-Fi tablets often fail the first `import()` after a wake or
 * a host upgrade. Retry once before surfacing the React Router error page.
 */

export function isChunkLoadError(err: unknown): boolean {
  const name = String((err as { name?: unknown })?.name || '');
  const msg = `${(err as { message?: unknown })?.message || err || ''}`;
  if (name === 'ChunkLoadError') return true;
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|loading chunk \d+|failed to load module script/i.test(
    msg,
  );
}

export async function retryLazyImport<T>(
  importer: () => Promise<T>,
  retries = 2,
): Promise<T> {
  try {
    return await importer();
  } catch (err) {
    if (!isChunkLoadError(err) || retries < 1) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return retryLazyImport(importer, retries - 1);
  }
}
