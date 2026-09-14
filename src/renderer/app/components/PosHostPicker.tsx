import type { DiscoveredPosHost } from '@shared/posHostDiscovery';
import { cn } from '../../components/ui';

export function PosHostPicker({
  hosts,
  scanning,
  scanned,
  busyHost,
  currentHost,
  currentPort,
  onSelect,
  onScan,
  labels,
}: {
  hosts: DiscoveredPosHost[];
  scanning: boolean;
  scanned: boolean;
  busyHost?: string | null;
  currentHost?: string | null;
  currentPort?: number | string | null;
  onSelect: (host: DiscoveredPosHost) => void;
  onScan: () => void;
  labels: {
    scan: string;
    scanning: string;
    empty: string;
  };
}) {
  const currentPortNum = Number(currentPort) || 3333;

  return (
    <div className="w-full space-y-3">
      <button
        type="button"
        disabled={scanning || Boolean(busyHost)}
        onClick={onScan}
        className="pos-btn-primary w-full disabled:opacity-60"
      >
        {scanning ? labels.scanning : labels.scan}
      </button>
      {hosts.length > 0 ? (
        <div className="space-y-1.5">
          {hosts.map((h) => {
            const port = Number(h.httpPort) || 3333;
            const busy = busyHost === h.host;
            const current =
              Boolean(currentHost) &&
              h.host === currentHost &&
              port === currentPortNum;
            return (
              <button
                key={`${h.host}:${port}`}
                type="button"
                disabled={scanning || Boolean(busyHost)}
                onClick={() => onSelect(h)}
                className={cn(
                  'pos-staff-tile',
                  current && 'pos-staff-tile--active',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium text-[color:var(--pos-fg)]">
                    {h.name}
                  </span>
                  <span className="mt-0.5 block font-mono text-[12px] text-[color:var(--pos-fg-muted)]">
                    {h.host}
                    {port !== 3333 ? `:${port}` : ''}
                  </span>
                  {busy ? (
                    <span className="mt-0.5 block text-[12px] text-[color:var(--pos-fg-muted)]">
                      {labels.scanning}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : scanned && !scanning ? (
        <div className="rounded-md border border-dashed border-[var(--pos-border-strong)] bg-[var(--pos-surface-2)] px-3 py-6 text-center text-sm text-[color:var(--pos-fg-muted)]">
          {labels.empty}
        </div>
      ) : null}
    </div>
  );
}
