/**
 * What a saved floor layout must satisfy, for the Admin editor and the till.
 *
 * The till stored any node list it was sent, so a table could have 0 or -3
 * seats, or two tables in Garden could both be "G5" — after which orders,
 * payments and transfers for G5 could land on either one.
 */

export type FloorLayoutProblem =
  | { code: 'NO_LABEL'; index: number }
  | { code: 'BAD_SEATS'; label: string; seats: unknown }
  | { code: 'DUPLICATE_LABEL'; label: string };

function isTableNode(n: any): boolean {
  const kind = String(n?.kind || '').toUpperCase();
  return !kind || kind === 'TABLE';
}

/** First problem with `nodes`, or `null` when the layout can be saved. */
export function floorLayoutProblem(nodes: unknown): FloorLayoutProblem | null {
  if (!Array.isArray(nodes)) return null;
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as any;
    if (!n || typeof n !== 'object' || !isTableNode(n)) continue;
    const label = String(n.label ?? '').trim();
    if (!label) return { code: 'NO_LABEL', index: i };
    if (n.seats != null) {
      const seats = Number(n.seats);
      if (!Number.isFinite(seats) || seats < 1 || !Number.isInteger(seats)) {
        return { code: 'BAD_SEATS', label, seats: n.seats };
      }
    }
    // Names are compared the way staff read them: "g5" and "G5 " are G5.
    const key = label.toLowerCase();
    if (seen.has(key)) return { code: 'DUPLICATE_LABEL', label };
    seen.add(key);
  }
  return null;
}

/** English sentence for the till's error response. */
export function describeFloorLayoutProblem(p: FloorLayoutProblem): string {
  if (p.code === 'NO_LABEL') return 'Every table needs a name.';
  if (p.code === 'BAD_SEATS') {
    return `Table ${p.label} needs at least 1 seat (whole number).`;
  }
  return `Two tables are called ${p.label}. Give each table its own name.`;
}
