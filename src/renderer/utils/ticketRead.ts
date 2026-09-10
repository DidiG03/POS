/**
 * One way to ask the host "what is on this table's bill right now?".
 *
 * Ticket reads go through the SWR cache, and `swr` hands back a stale entry
 * without waiting for the host. The floor snapshot writes into that same
 * key, so a table whose snapshot row carried no lines leaves an empty
 * ticket behind the cache. Every caller that reads zero lines then treats
 * the bill as empty: the panel blanks, and the next Send rewrites the
 * sitting from an empty cart. A guest walks out having paid for one salad.
 *
 * So an empty answer is never taken at face value — it is re-read past the
 * cache first — and a read that fails is reported as such instead of
 * collapsing into "no lines".
 */
import { invalidateTicketCache } from './posReadCache';

export type TicketReadItems = Array<Record<string, unknown>>;

export type TicketRead =
  | { ok: true; items: TicketReadItems; note: string }
  | { ok: false };

export type TicketReadDeps = {
  fetch: (area: string, label: string) => Promise<unknown>;
  invalidate: (area: string, label: string) => void;
};

function defaultDeps(): TicketReadDeps {
  return {
    fetch: (area, label) =>
      (window as any).api.tickets.getLatestForTable(area, label),
    invalidate: invalidateTicketCache,
  };
}

function itemsOf(latest: unknown): TicketReadItems {
  const items = (latest as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? (items as TicketReadItems) : [];
}

function noteOf(latest: unknown): string {
  const note = (latest as { note?: unknown } | null | undefined)?.note;
  return typeof note === 'string' ? note : '';
}

export async function readTicketForTable(
  area: string,
  label: string,
  deps: TicketReadDeps = defaultDeps(),
): Promise<TicketRead> {
  let latest: unknown;
  try {
    latest = await deps.fetch(area, label);
  } catch {
    return { ok: false };
  }
  const items = itemsOf(latest);
  if (items.length > 0) return { ok: true, items, note: noteOf(latest) };

  // Empty is the expensive answer to get wrong: confirm it against the host
  // rather than whatever the cache was holding.
  deps.invalidate(area, label);
  try {
    const confirmed = await deps.fetch(area, label);
    return { ok: true, items: itemsOf(confirmed), note: noteOf(confirmed) };
  } catch {
    return { ok: false };
  }
}
