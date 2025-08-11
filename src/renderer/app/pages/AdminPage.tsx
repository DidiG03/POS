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
};

export default function AdminPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const data = await window.api.admin.getOverview();
      setOv(data);
      const s = await window.api.settings.get();
      setAreas(s.tableAreas ?? [
        { name: 'Main Hall', count: s.tableCountMainHall ?? 8 },
        { name: 'Terrace', count: s.tableCountTerrace ?? 4 },
      ]);
    })();
  }, []);

  return (
    <div className="grid gap-4 grid-cols-3">
      <Stat title="Active Users" value={ov?.activeUsers} />
      <Stat title="Open Shifts" value={ov?.openShifts} />
      <Stat title="Open Orders" value={ov?.openOrders} />
      <Stat title="Low Stock Items" value={ov?.lowStockItems} />
      <Stat title="Queued Print Jobs" value={ov?.queuedPrintJobs} />
      <div className="bg-gray-800 rounded p-4 col-span-3">
        <div className="text-sm opacity-70">System</div>
        <div className="mt-2 grid grid-cols-3 gap-4 text-sm">
          <div>Last Menu Sync: {ov?.lastMenuSync ?? '—'}</div>
          <div>Last Staff Sync: {ov?.lastStaffSync ?? '—'}</div>
          <div>Printer IP: {ov?.printerIp ?? '—'}</div>
        </div>
        <div className="mt-2 text-xs opacity-70">App v{ov?.appVersion}</div>
      </div>
      <div className="bg-gray-800 rounded p-4 col-span-3">
        <div className="text-sm opacity-70 mb-2">Quick Actions</div>
        <div className="flex gap-2">
          <button className="bg-gray-700 px-3 py-2 rounded" onClick={() => window.api.auth.syncStaffFromApi()}>Sync Staff</button>
          <button className="bg-gray-700 px-3 py-2 rounded" onClick={() => window.api.settings.testPrint()}>Test Printer</button>
        </div>
      </div>
      <div className="bg-gray-800 rounded p-4 col-span-3">
        <div className="text-sm opacity-70 mb-2">Table Areas</div>
        <div className="space-y-2">
          {areas.map((a, idx) => (
            <div key={idx} className="flex items-center gap-3">
              <input
                className="bg-gray-700 rounded px-2 py-1 flex-1"
                value={a.name}
                onChange={(e) => setAreas((arr) => arr.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))}
              />
              <input
                type="number" min={0}
                className="w-24 bg-gray-700 rounded px-2 py-1"
                value={a.count}
                onChange={(e) => setAreas((arr) => arr.map((x, i) => (i === idx ? { ...x, count: Number(e.target.value) } : x)))}
              />
              <button
                className="px-2 py-1 rounded bg-red-600 hover:bg-red-700"
                onClick={() => setAreas((arr) => arr.filter((_, i) => i !== idx))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            className="px-3 py-2 rounded bg-gray-700"
            onClick={() => setAreas((arr) => [...arr, { name: 'New Area', count: 4 }])}
          >
            Add Area
          </button>
        </div>
        <div className="flex gap-2 mt-3">
          <button
            className="px-3 py-2 rounded bg-emerald-700"
            onClick={async () => {
              await window.api.settings.update({ tableAreas: areas });
              const s = await window.api.settings.get();
              setAreas(s.tableAreas ?? []);
              setSavedMsg('Saved');
              setTimeout(() => setSavedMsg(null), 1500);
            }}
          >
            Save Areas
          </button>
          {savedMsg && <span className="text-sm opacity-70">{savedMsg}</span>}
        </div>
        <div className="text-xs opacity-70 mt-2">These areas and counts drive the circular default layout; users can still save personal layouts per area.</div>
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


