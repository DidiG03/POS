export type SerialPrinterConfig = {
  path: string;
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
};

export async function listSerialPorts() {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  return (ports || []).map((p: any) => ({
    path: String(p.path),
    manufacturer: p.manufacturer ? String(p.manufacturer) : undefined,
    serialNumber: p.serialNumber ? String(p.serialNumber) : undefined,
    vendorId: p.vendorId ? String(p.vendorId) : undefined,
    productId: p.productId ? String(p.productId) : undefined,
  }));
}

export async function sendToSerialPrinter(cfg: SerialPrinterConfig, data: Buffer): Promise<{ ok: boolean; error?: string }> {
  const { SerialPort } = await import('serialport');
  const port = new SerialPort({
    path: cfg.path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
    autoOpen: false,
  });

  try {
    await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
    await new Promise<void>((resolve, reject) => port.write(data, (err) => (err ? reject(err) : resolve())));
    await new Promise<void>((resolve, reject) => port.drain((err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Serial print failed') };
  } finally {
    try {
      await new Promise<void>((resolve) => port.close(() => resolve()));
    } catch {
      // ignore
    }
  }
}

