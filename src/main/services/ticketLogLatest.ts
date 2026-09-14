/**
 * Floor snapshot used to `ORDER BY createdAt DESC LIMIT 800`. On a full
 * floor the 800 newest fires can all belong to the busiest tables, so a
 * quiet occupied table dropped out of the payload and showed a stale or
 * empty bill.
 *
 * Auto-increment `id` is monotonic, so `MAX(id) GROUP BY table` is the
 * latest row even when DateTime storage mixes ISO and epoch ms.
 */

export const LATEST_ID_IN_CHUNK = 400;

export type TablePair = { area: string; label: string };

export type LatestIdRow = {
  area: string;
  tableLabel: string;
  id: number;
};

function cleanPairs(pairs: TablePair[]): TablePair[] {
  const out: TablePair[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const area = String(p?.area || '').trim();
    const label = String(p?.label || '').trim();
    if (!area || !label) continue;
    const key = `${area}\0${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ area, label });
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Parameterized WHERE for `(area, label)` groups. One clause per area so
 * a 300-table floor stays under SQLite's ~999 variable limit when chunked.
 */
export function latestIdWhereSql(
  pairs: TablePair[],
  labelColumn: 'tableLabel' | 'label',
  chunkSize = LATEST_ID_IN_CHUNK,
): Array<{ sql: string; params: string[] }> {
  const cleaned = cleanPairs(pairs);
  const byArea = new Map<string, string[]>();
  for (const p of cleaned) {
    const list = byArea.get(p.area) || [];
    list.push(p.label);
    byArea.set(p.area, list);
  }
  const out: Array<{ sql: string; params: string[] }> = [];
  for (const [area, labels] of byArea) {
    for (const group of chunk(labels, chunkSize)) {
      out.push({
        sql: `(area = ? AND ${labelColumn} IN (${group.map(() => '?').join(', ')}))`,
        params: [area, ...group],
      });
    }
  }
  return out;
}

export function latestTicketIdSelectSql(where: {
  sql: string;
  params: string[];
}): { sql: string; params: string[] } {
  return {
    sql: `SELECT area, tableLabel, MAX(id) AS id FROM TicketLog WHERE ${where.sql} GROUP BY area, tableLabel`,
    params: where.params,
  };
}

export function latestCoverIdSelectSql(where: {
  sql: string;
  params: string[];
}): { sql: string; params: string[] } {
  return {
    sql: `SELECT area, label AS tableLabel, MAX(id) AS id FROM Covers WHERE ${where.sql} GROUP BY area, label`,
    params: where.params,
  };
}

export function asPositiveId(value: unknown): number | null {
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseLatestIdRows(rows: unknown): LatestIdRow[] {
  if (!Array.isArray(rows)) return [];
  const out: LatestIdRow[] = [];
  for (const row of rows) {
    const area = String((row as any)?.area || '').trim();
    const tableLabel = String(
      (row as any)?.tableLabel || (row as any)?.label || '',
    ).trim();
    const id = asPositiveId((row as any)?.id);
    if (!area || !tableLabel || id == null) continue;
    out.push({ area, tableLabel, id });
  }
  return out;
}

export function mergeLatestIdRows(chunks: LatestIdRow[][]): LatestIdRow[] {
  const best = new Map<string, LatestIdRow>();
  for (const chunkRows of chunks) {
    for (const row of chunkRows) {
      const key = `${row.area}\0${row.tableLabel}`;
      const prev = best.get(key);
      if (!prev || row.id > prev.id) best.set(key, row);
    }
  }
  return [...best.values()];
}
