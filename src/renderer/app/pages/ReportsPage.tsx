import { useEffect, useMemo, useState } from 'react';

type TrendRange = 'daily' | 'weekly' | 'monthly';

type Overview = {
  activeUsers: number;
  openShifts: number;
  openOrders: number;
  lowStockItems: number;
  queuedPrintJobs: number;
  revenueTodayNet?: number;
  revenueTodayVat?: number;
};

type SalesPoint = { label: string; total: number; orders: number };

export default function ReportsPage() {
  const [loading, setLoading] = useState<boolean>(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [topSelling, setTopSelling] = useState<{ name: string; qty: number; revenue: number } | null>(null);
  const [range, setRange] = useState<TrendRange>('daily');
  const [points, setPoints] = useState<SalesPoint[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [ov, top, trend] = await Promise.all([
          window.api.admin.getOverview(),
          window.api.admin.getTopSellingToday(),
          window.api.admin.getSalesTrends({ range }),
        ]);
        setOverview(ov as any);
        setTopSelling(top as any);
        setPoints((trend as any)?.points || []);
      } finally {
        setLoading(false);
      }
    })();
  }, [range]);

  const fmtCurrency = useMemo(() =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }),
  []);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Reports</h2>
        <div className="flex items-center gap-2">
          <button
            className={`px-2 py-1 rounded text-sm ${range === 'daily' ? 'bg-gray-700' : 'bg-gray-800 hover:bg-gray-700'}`}
            onClick={() => setRange('daily')}
          >
            Last 14 days
          </button>
          <button
            className={`px-2 py-1 rounded text-sm ${range === 'weekly' ? 'bg-gray-700' : 'bg-gray-800 hover:bg-gray-700'}`}
            onClick={() => setRange('weekly')}
          >
            12 weeks
          </button>
          <button
            className={`px-2 py-1 rounded text-sm ${range === 'monthly' ? 'bg-gray-700' : 'bg-gray-800 hover:bg-gray-700'}`}
            onClick={() => setRange('monthly')}
          >
            12 months
          </button>
        </div>
      </div>

      {loading && (
        <div className="opacity-70">Loading statistics…</div>
      )}

      {!loading && overview && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          <StatCard title="Revenue (today, net)" value={fmtCurrency.format(overview.revenueTodayNet || 0)} />
          <StatCard title="VAT (today)" value={fmtCurrency.format(overview.revenueTodayVat || 0)} />
          <StatCard title="Open orders" value={String(overview.openOrders)} />
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 p-3 rounded bg-gray-800 border border-gray-700">
            <div className="font-medium mb-2">Sales trend ({range})</div>
            {points.length === 0 ? (
              <div className="opacity-70 text-sm">No data</div>
            ) : (
              <ul className="space-y-2">
                {points.map((p) => (
                  <li key={p.label} className="flex items-center justify-between text-sm">
                    <span className="opacity-80 w-16">{p.label}</span>
                    <div className="flex-1 mx-3 h-2 rounded bg-gray-700 overflow-hidden">
                      <div
                        className="h-2 bg-blue-600"
                        style={{ width: `${Math.min(100, Math.round((p.total / Math.max(1, Math.max(...points.map(x => x.total)))) * 100))}%` }}
                      />
                    </div>
                    <span className="w-28 text-right">{fmtCurrency.format(p.total)}</span>
                    <span className="w-16 text-right opacity-80">{p.orders} tkt</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="p-3 rounded bg-gray-800 border border-gray-700">
            <div className="font-medium mb-2">Top selling (today)</div>
            {!topSelling ? (
              <div className="opacity-70 text-sm">No data</div>
            ) : (
              <div className="text-sm">
                <div className="font-semibold">{topSelling.name}</div>
                <div className="opacity-80">Qty: {topSelling.qty}</div>
                <div>Revenue: {fmtCurrency.format(topSelling.revenue)}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="p-3 rounded bg-gray-800 border border-gray-700">
      <div className="text-xs opacity-70">{title}</div>
      <div className="text-lg mt-1">{value}</div>
    </div>
  );
}
