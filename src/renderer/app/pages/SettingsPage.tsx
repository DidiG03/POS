import { useEffect, useState } from 'react';

export default function SettingsPage() {
  const [printerIp, setPrinterIp] = useState('');
  const [printerPort, setPrinterPort] = useState('9100');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();
      setPrinterIp(s.printer?.ip || '');
      setPrinterPort(String(s.printer?.port || 9100));
    })();
  }, []);

  const onTestPrint = async () => {
    const verbose = window.api.settings.testPrintVerbose ? await window.api.settings.testPrintVerbose() : { ok: await window.api.settings.testPrint() };
    if (verbose.ok) {
      setStatus('Test print sent');
    } else {
      setStatus(`Test print failed${verbose.error ? ': ' + verbose.error : ''}`);
    }
    setTimeout(() => setStatus(null), 3000);
  };

  const onSave = async () => {
    const ip = printerIp.trim();
    const port = Number(printerPort);
    await window.api.settings.setPrinter({ ip, port: Number.isFinite(port) ? port : undefined });
    setStatus('Printer settings saved');
    setTimeout(() => setStatus(null), 1500);
  };

  return (
    <div className="space-y-4 max-w-xl">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
        <div>
          <label className="block text-sm mb-1">Printer IP</label>
          <input className="w-full bg-gray-700 rounded px-3 py-2" value={printerIp} onChange={(e) => setPrinterIp(e.target.value)} placeholder="192.168.1.50" />
        </div>
        <div>
          <label className="block text-sm mb-1">Port</label>
          <input className="w-full bg-gray-700 rounded px-3 py-2" value={printerPort} onChange={(e) => setPrinterPort(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <button className="bg-emerald-600 px-3 py-2 rounded flex-1" onClick={onSave}>Save</button>
          <button className="bg-gray-700 px-3 py-2 rounded flex-1" onClick={onTestPrint}>Test Print</button>
        </div>
      </div>
      {status && <div className="text-sm text-gray-400">{status}</div>}
    </div>
  );
}


