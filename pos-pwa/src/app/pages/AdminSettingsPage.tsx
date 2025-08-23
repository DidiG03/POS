import { useEffect, useState } from 'react';
import { api } from '../../api';

type Section =
  | { key: 'printer'; label: string }
  | { key: 'areas'; label: string }
  | { key: 'sync'; label: string }
  | { key: 'about'; label: string };

const sections: Section[] = [
  { key: 'printer', label: 'Printer' },
  { key: 'areas', label: 'Table Areas' },
  { key: 'sync', label: 'Data Sync' },
  { key: 'about', label: 'About' },
];

export default function AdminSettingsPage() {
  const [selected, setSelected] = useState<Section['key']>('printer');
  return (
    <div className="h-full grid grid-cols-2 gap-4 min-h-0">
      <div className="bg-gray-800 rounded overflow-auto">
        <ul className="divide-y divide-gray-700">
          {sections.map((s) => (
            <li key={s.key}>
              <button
                className={`w-full px-4 py-3 hover:bg-gray-700 ${selected === s.key ? 'bg-gray-700' : ''}`}
                onClick={() => setSelected(s.key)}
              >
                <div className="flex items-center justify-between">
                  <span>{s.label}</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="w-4 h-4 opacity-70"
                    aria-hidden
                  >
                    <path fillRule="evenodd" d="M9.22 4.22a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L14.94 12 9.22 5.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                  </svg>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="bg-gray-800 rounded p-4 overflow-auto">
        {selected === 'printer' && <PrinterSettings />}
        {selected === 'areas' && <AreasSettings />}
        {selected === 'sync' && <SyncSettings />}
        {selected === 'about' && <AboutSettings />}
      </div>
    </div>
  );
}

function PrinterSettings() {
  const [ip, setIp] = useState('');
  const [testing, setTesting] = useState(false);
  return (
    <div>
      <div className="text-lg font-semibold mb-3">Printer</div>
      <div className="flex items-center gap-2 mb-3">
        <input className="bg-gray-700 rounded px-3 py-2 flex-1" placeholder="Printer IP" value={ip} onChange={(e) => setIp(e.target.value)} />
        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
          onClick={async () => {
            setTesting(true);
            await api.settings.testPrint();
            setTesting(false);
          }}
        >
          {testing ? 'Printing…' : 'Test'}
        </button>
      </div>
      <div className="text-xs opacity-70">Configure ESC/POS network printer IP.</div>
    </div>
  );
}

function AreasSettings() {
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  useEffect(() => {
    (async () => {
      const s = await api.settings.get();
      setAreas(s.tableAreas || []);
    })();
  }, []);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-lg font-semibold">Table Areas</div>
        <button className="text-blue-500 cursor-pointer" onClick={() => setAreas(arr => [...arr, { name: 'New Area', count: 4 }])}>+</button>
      </div>

      <div className="space-y-2">
        {areas.map((a, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <input className="bg-gray-700 rounded px-2 py-1 flex-1" value={a.name} onChange={(e) => setAreas(arr => arr.map((x, i) => i===idx? { ...x, name: e.target.value }: x))} />
            <input className="w-24 bg-gray-700 rounded px-2 py-1" type="number" min={0} value={a.count} onChange={(e) => setAreas(arr => arr.map((x, i) => i===idx? { ...x, count: Number(e.target.value) }: x))} />
            <button className="p-1 rounded bg-red-600 hover:bg-red-700 cursor-pointer" onClick={() => setAreas(arr => arr.filter((_, i) => i!==idx))}>x</button>
          </div>
        ))}
        <div>
          <button
            className="mt-2 px-3 py-2 rounded bg-emerald-700 w-full"
            onClick={async () => {
              await api.settings.update({ tableAreas: areas });
            }}
          >
            Save Areas
          </button>
        </div>
      </div>
    </div>
  );
}

function SyncSettings() {
  return (
    <div>
      <div className="text-lg font-semibold mb-3">Data Sync</div>
      <div className="space-x-2">
        <button className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600" onClick={() => api.auth.syncStaffFromApi()}>Sync Staff</button>
        <button className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600" onClick={() => api.menu.syncFromUrl({ url: 'https://ullishtja-agroturizem.com/api/pos-menu?lang=en' })}>Sync Menu</button>
      </div>
    </div>
  );
}

function AboutSettings() {
  return (
    <div>
      <div className="text-lg font-semibold mb-3">About</div>
      <div className="opacity-80">Ullishtja POS — Admin Settings</div>
    </div>
  );
}


