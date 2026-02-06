export type QueryValue = string | number | boolean | null | undefined;

export function toQueryString(entries: Array<[key: string, value: QueryValue]>): string {
  const q = new URLSearchParams();
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') {
      if (v) q.set(k, '1');
      continue;
    }
    q.set(k, String(v));
  }
  return q.toString();
}

