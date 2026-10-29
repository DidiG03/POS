/**
 * Every line on a bill has its own id (`lineId`), set by the till.
 *
 * Voids used to pick their line by name, item code and price. With two
 * Espressos on the bill (one voided, one just ordered) the till could not
 * tell them apart, and a keyless Send that ordered the second one was folded
 * into the voided first: printed, never billed. A void now names the line
 * it takes off, and only that line.
 *
 * Bills written before line ids existed get ids derived from their row
 * (`L<rowId>.<index>`), so the same bill always shows the same ids until
 * its next version is written, which keeps them.
 */

type WithLineId = { lineId?: unknown };

export function lineIdOf(line: unknown): string {
  const raw = (line as WithLineId | null | undefined)?.lineId;
  return typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
}

let counter = 0;

/** A fresh line id. Unique within one till process and across restarts. */
export function newTicketLineId(): string {
  counter = (counter + 1) % 1_000_000;
  return `ln-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * `items` with a unique `lineId` on every line. Lines without one get
 * `L<seed>.<index>` when a seed (the TicketLog row id) is given, else a new
 * id. A line repeating an id already used above it (a split line, or a
 * device sending one twice) gets a new id. Returns `items` itself when
 * nothing changed.
 */
export function withLineIds<T>(
  items: readonly T[],
  opts: { seed?: string | number | null; newId?: () => string } = {},
): T[] {
  const newId = opts.newId ?? newTicketLineId;
  const seed =
    opts.seed != null && String(opts.seed).trim() ? String(opts.seed) : null;
  const seen = new Set<string>();
  let changed = false;
  const out = items.map((line, index) => {
    if (!line || typeof line !== 'object') return line;
    let id = lineIdOf(line);
    if (id && !seen.has(id)) {
      seen.add(id);
      if (id === (line as WithLineId).lineId) return line;
    } else {
      id = !id && seed ? `L${seed}.${index}` : newId();
      while (seen.has(id)) id = newId();
      seen.add(id);
    }
    changed = true;
    return { ...(line as object), lineId: id } as T;
  });
  return changed ? out : (items as T[]);
}

export function findLineIndexById(
  items: readonly unknown[] | null | undefined,
  lineId: string,
): number {
  const id = String(lineId || '').trim();
  if (!id || !Array.isArray(items)) return -1;
  return items.findIndex((l) => lineIdOf(l) === id);
}
