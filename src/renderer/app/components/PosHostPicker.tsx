import type { DiscoveredPosHost } from '@shared/posHostDiscovery';

export function PosHostPicker({
  hosts,
  scanning,
  scanned,
  busyHost,
  onSelect,
  onScan,
  labels,
}: {
  hosts: DiscoveredPosHost[];
  scanning: boolean;
  scanned: boolean;
  busyHost?: string | null;
  onSelect: (host: DiscoveredPosHost) => void;
  onScan: () => void;
  labels: {
    scan: string;
    scanning: string;
    empty: string;
  };
}) {
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
        <div className="overflow-hidden rounded-xl border border-white/10 divide-y divide-white/8">
          {hosts.map((h) => {
            const busy = busyHost === h.host;
            return (
              <button
                key={`${h.host}:${h.httpPort || 3333}`}
                type="button"
                disabled={scanning || Boolean(busyHost)}
                onClick={() => onSelect(h)}
                className="w-full px-4 py-3 text-left hover:bg-white/6 disabled:opacity-60"
              >
                <div className="truncate text-[15px] font-medium text-gray-100">
                  {h.name}
                </div>
                <div className="font-mono text-[13px] text-gray-400">
                  {h.host}
                </div>
                {busy ? (
                  <div className="mt-1 text-[12px] text-gray-500">
                    {labels.scanning}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : scanned && !scanning ? (
        <div className="text-center text-sm text-gray-500">{labels.empty}</div>
      ) : null}
    </div>
  );
}
