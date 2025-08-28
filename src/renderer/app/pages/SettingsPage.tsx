import { useEffect, useState } from 'react';

export default function SettingsPage() {
  const [printerIp, setPrinterIp] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();
      setPrinterIp(s.printer?.ip || '');
    })();
  }, []);

  const onTestPrint = async () => {
    const ok = await window.api.settings.testPrint();
    setStatus(ok ? 'Test print sent' : 'Test print failed');
    setTimeout(() => setStatus(null), 2000);
  };

  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex gap-2">
        <button className="bg-gray-700 px-3 py-2 rounded" onClick={onTestPrint}>Test Print</button>
      </div>
      {status && <div className="text-sm text-gray-400">{status}</div>}
    </div>
  );
}


