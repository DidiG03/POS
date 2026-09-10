/** USB scanners type a code then Enter. Used only on Store tills. */

export function normalizeProductCode(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/[\s-]/g, '')
    .toUpperCase();
}

export function isPlausibleScanCode(code: string): boolean {
  const c = normalizeProductCode(code);
  return c.length >= 4 && c.length <= 64 && /^[A-Z0-9]+$/.test(c);
}

export function findItemByProductCode<T extends { sku?: string | null }>(
  items: T[],
  code: string,
): T | undefined {
  const needle = normalizeProductCode(code);
  if (!needle) return undefined;
  return items.find(
    (item) => normalizeProductCode(String(item.sku || '')) === needle,
  );
}

export function createHidBarcodeBuffer(opts?: {
  maxGapMs?: number;
  minLength?: number;
  maxDurationMs?: number;
}) {
  const maxGapMs = opts?.maxGapMs ?? 50;
  const minLength = opts?.minLength ?? 4;
  const maxDurationMs = opts?.maxDurationMs ?? 400;
  let buf = '';
  let lastAt: number | null = null;
  let startAt: number | null = null;

  function reset() {
    buf = '';
    lastAt = null;
    startAt = null;
  }

  return {
    reset,
    push(key: string, nowMs: number): { swallow: boolean; commit?: string } {
      if (key === 'Enter') {
        const code = buf;
        const elapsed =
          startAt == null ? Number.POSITIVE_INFINITY : nowMs - startAt;
        reset();
        if (
          code.length >= minLength &&
          elapsed <= maxDurationMs &&
          isPlausibleScanCode(code)
        ) {
          return { swallow: true, commit: normalizeProductCode(code) };
        }
        return { swallow: false };
      }
      if (key.length !== 1 || key < ' ') {
        return { swallow: false };
      }
      if (lastAt != null && nowMs - lastAt > maxGapMs) {
        buf = '';
        startAt = nowMs;
      }
      if (!buf) startAt = nowMs;
      buf += key;
      lastAt = nowMs;
      return { swallow: buf.length >= 2 };
    },
  };
}
