import { useEffect, useState } from 'react';

export default function SettingsPage() {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [vat, setVat] = useState(0.2);
  const [printerIp, setPrinterIp] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();
      setName(s.restaurantName);
      setCurrency(s.currency);
      setVat(s.defaultVatRate);
      setPrinterIp(s.printer?.ip || '');
    })();
  }, []);

  const onSave = async () => {
    await window.api.settings.update({
      restaurantName: name,
      currency,
      defaultVatRate: vat,
      printer: { ip: printerIp, port: 9100 },
    });
    setStatus('Saved');
    setTimeout(() => setStatus(null), 1500);
  };

  const onTestPrint = async () => {
    const ok = await window.api.settings.testPrint();
    setStatus(ok ? 'Test print sent' : 'Test print failed');
    setTimeout(() => setStatus(null), 2000);
  };

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <label className="block text-sm mb-1">Restaurant name</label>
        <input className="w-full p-2 bg-gray-700 rounded" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm mb-1">Currency</label>
          <input className="w-full p-2 bg-gray-700 rounded" value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm mb-1">Default VAT</label>
          <input type="number" step="0.01" className="w-full p-2 bg-gray-700 rounded" value={vat} onChange={(e) => setVat(Number(e.target.value))} />
        </div>
      </div>
      <div>
        <label className="block text-sm mb-1">Printer IP</label>
        <input className="w-full p-2 bg-gray-700 rounded" value={printerIp} onChange={(e) => setPrinterIp(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button className="bg-emerald-600 px-3 py-2 rounded" onClick={onSave}>Save</button>
        <button className="bg-gray-700 px-3 py-2 rounded" onClick={onTestPrint}>Test Print</button>
      </div>
      {status && <div className="text-sm text-gray-400">{status}</div>}
    </div>
  );
}


