import { useEffect, useState } from 'react';

type Overview = {
  activeUsers: number;
  openShifts: number;
  openOrders: number;
  lowStockItems: number;
  queuedPrintJobs: number;
  lastMenuSync?: string | null;
  lastStaffSync?: string | null;
  printerIp?: string | null;
  appVersion: string;
  revenueTodayNet?: number;
  revenueTodayVat?: number;
};

type AdminShift = {
  id: number;
  userId: number;
  userName: string;
  openedAt: string;
  closedAt: string | null;
  durationHours: number;
  isOpen: boolean;
};

export default function AdminPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [shifts, setShifts] = useState<AdminShift[]>([]);
  const [sortKey, setSortKey] = useState<'userName' | 'openedAt' | 'durationHours'>('openedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [topSelling, setTopSelling] = useState<{ name: string; qty: number; revenue: number } | null>(null);
  // Simplified view: hide sales trends entirely

  useEffect(() => {
    (async () => {
      const data = await window.api.admin.getOverview();
      setOv(data);
      const s = await window.api.settings.get();
      setAreas(s.tableAreas ?? [
        { name: 'Main Hall', count: s.tableCountMainHall ?? 8 },
        { name: 'Terrace', count: s.tableCountTerrace ?? 4 },
      ]);
      const sh = await window.api.admin.listShifts();
      setShifts(sh);
      const top = await window.api.admin.getTopSellingToday();
      setTopSelling(top);
    })();
  }, []);

  // Removed sales trends fetch for simplified overview

  return (
    <div className="grid gap-4 grid-cols-2">
      <Stat title="Active Users" value={ov?.activeUsers} />
      <Stat title="Open Shifts" value={ov?.openShifts} />
      <Stat title="Open Orders" value={ov?.openOrders} />
      <Stat title="Revenue Today (net)" value={ov ? (ov.revenueTodayNet ?? 0) : '—'} />
      <Stat title="VAT Today" value={ov ? (ov.revenueTodayVat ?? 0) : '—'} />
      <div className="bg-gray-800 rounded p-4">
        <div className="text-sm opacity-70">Top Selling Today</div>
        <div className="mt-1 text-lg font-semibold">{topSelling ? topSelling.name : '—'}</div>
        {topSelling && (
          <div className="text-sm opacity-80">Qty: {topSelling.qty} • Revenue: {topSelling.revenue}</div>
        )}
      </div>
      {/* <div className="bg-gray-800 rounded p-4 col-span-3">
        <div className="text-sm opacity-70">System</div>
        <div className="mt-2 grid grid-cols-3 gap-4 text-sm">
          <div>Last Menu Sync: {ov?.lastMenuSync ?? '—'}</div>
          <div>Last Staff Sync: {ov?.lastStaffSync ?? '—'}</div>
          <div>Printer IP: {ov?.printerIp ?? '—'}</div>
        </div>
        <div className="mt-2 text-xs opacity-70">App v{ov?.appVersion}</div>
      </div> */}
        {/* <div className="bg-gray-800 rounded p-4 col-span-3">
          <div className="text-sm opacity-70 mb-2">Quick Actions</div>
          <div className="flex gap-2">
            <button className="bg-gray-700 px-3 py-2 rounded" onClick={() => window.api.auth.syncStaffFromApi()}>Sync Staff</button>
            <button className="bg-gray-700 px-3 py-2 rounded" onClick={() => window.api.settings.testPrint()}>Test Printer</button>
          </div>
        </div> */}
      <div className="bg-gray-800 rounded p-4 col-span-2">
        <div className="text-sm opacity-70 mb-2">Open Shifts</div>
        <div className="grid grid-cols-2 gap-3">
          {shifts.filter((s) => s.isOpen).length === 0 && (
            <div className="opacity-70">No open shifts</div>
          )}
          {shifts.filter((s) => s.isOpen).map((s) => (
            <div key={s.id} className="bg-gray-900 rounded p-3">
              <div className="text-lg font-semibold">{s.userName}</div>
              <div className="text-sm opacity-80">Opened: {new Date(s.openedAt).toLocaleTimeString()}</div>
              <div className="text-sm">Hours: {s.durationHours}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ title, value }: { title: string; value: any }) {
  return (
    <div className="bg-gray-800 rounded p-4">
      <div className="text-sm opacity-70">{title}</div>
      <div className="text-2xl font-semibold mt-1">{value ?? '—'}</div>
    </div>
  );
}

function Chart({ title, points }: { title: string; points: { label: string; value: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="bg-gray-900 rounded p-3">
      <div className="text-sm opacity-70 mb-2">{title}</div>
      <div className="h-40 flex items-end gap-1">
        {points.map((p, i) => (
          <div key={i} className="flex-1 flex flex-col items-center">
            <div className="w-full bg-emerald-600" style={{ height: `${(p.value / max) * 100}%` }} />
            <div className="mt-1 text-[10px] opacity-70 truncate w-full text-center">{p.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}


