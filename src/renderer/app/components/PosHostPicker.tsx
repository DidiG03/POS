import type { DiscoveredPosHost } from '@shared/posHostDiscovery';

export function PosHostPicker({
  hosts,
  selectedHost,
  selectedPort,
  scanning,
  onSelect,
  onRescan,
  labels,
}: {
  hosts: DiscoveredPosHost[];
  selectedHost: string;
  selectedPort: string | number;
  scanning: boolean;
  onSelect: (host: DiscoveredPosHost) => void;
  onRescan: () => void;
  labels: {
    title: string;
    scanning: string;
    empty: string;
    rescan: string;
  };
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium opacity-90">{labels.title}</div>
        <button
          type="button"
          disabled={scanning}
          onClick={onRescan}
          className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-xs disabled:opacity-60"
        >
          {scanning ? labels.scanning : labels.rescan}
        </button>
      </div>
      <div className="rounded border border-gray-700 divide-y divide-gray-700 max-h-56 overflow-y-auto">
        {scanning && hosts.length === 0 ? (
          <div className="p-3 text-sm opacity-70">{labels.scanning}</div>
        ) : hosts.length === 0 ? (
          <div className="p-3 text-sm opacity-70">{labels.empty}</div>
        ) : (
          hosts.map((h) => {
            const selected =
              selectedHost === h.host &&
              String(selectedPort) === String(h.httpPort);
            return (
              <button
                key={`${h.host}:${h.httpPort}`}
                type="button"
                onClick={() => onSelect(h)}
                className={`w-full text-left p-3 hover:bg-gray-700/60 ${
                  selected ? 'bg-emerald-900/30' : ''
                }`}
              >
                <div className="text-sm font-medium truncate">{h.name}</div>
                <div className="text-xs opacity-70 font-mono">
                  {h.host}:{h.httpPort}
                </div>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
