import { splitTableKey, tableKey } from '@shared/utils/tableKey';
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
  const keys = open.map((row) => tableKey(row.area, row.label));
  const before = useTicketStore.getState().drafts;
  useTicketStore.getState().dropOrphanLiveBills(keys);
  const after = useTicketStore.getState().drafts;
  for (const key of Object.keys(before || {})) {
    if (after[key]) continue;
    const parts = splitTableKey(key);
    if (parts) invalidateTicketCache(parts.area, parts.label);
  }
}
