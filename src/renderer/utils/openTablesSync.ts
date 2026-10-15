import { splitTableKey } from '@shared/utils/tableKey';
import { useTableStatus } from '../stores/tableStatus';
import { useTicketStore } from '../stores/ticket';
import { invalidateTicketCache } from './posReadCache';

/** Host occupancy is the source of truth: free tables must not keep a sent bill. */
export function applyHostOpenTables(
  entries: Array<{ area?: string; label?: string }> | null | undefined,
): void {
  const open = (entries || [])
    .map((row) => ({
      area: String(row?.area || '').trim(),
      label: String(row?.label || '').trim(),
    }))
    .filter((row) => row.area && row.label);
  useTableStatus.getState().setAll(open);
  // The merged map, not `open`: a poll that left before a transfer landed
  // would otherwise wipe the destination's bill inside the optimistic window.
  const keys = Object.entries(useTableStatus.getState().openMap)
    .filter(([, isOpen]) => isOpen)
    .map(([key]) => key);
  const before = useTicketStore.getState().drafts;
  useTicketStore.getState().dropOrphanLiveBills(keys);
  const after = useTicketStore.getState().drafts;
  for (const key of Object.keys(before || {})) {
    if (after[key]) continue;
    const parts = splitTableKey(key);
    if (parts) invalidateTicketCache(parts.area, parts.label);
  }
}
