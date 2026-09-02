import { withTimeout } from './services/withTimeout';

export type SerialPrinterConfig = {
  path: string;
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
};

/**
 * How long any single serial step may take. A USB-to-serial adapter whose
 * printer was switched off (or whose cable was pulled mid-service) opens fine
 * and then never completes the write. Without a deadline that promise never
 * settles, the print queue's current tick never finishes, and every subsequent
 * receipt on the terminal silently stops until the app is restarted.
 */
const SERIAL_STEP_TIMEOUT_MS = 8000;
const SERIAL_CLOSE_TIMEOUT_MS = 2000;

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

export async function sendToSerialPrinter(
  cfg: SerialPrinterConfig,
  data: Buffer,
): Promise<{ ok: boolean; error?: string }> {
  const { SerialPort } = await import('serialport');
  const port = new SerialPort({
    path: cfg.path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
    autoOpen: false,
  });

  // A serial port is an EventEmitter: an asynchronous 'error' (device
  // unplugged mid-write) with no listener is re-thrown and takes the whole
  // main process down. Capture it and let the step below report it instead.
  let asyncError: Error | null = null;
  port.on('error', (err: Error) => {
    asyncError = err;
  });

  const step = <T>(label: string, run: () => Promise<T>) =>
    withTimeout(run(), SERIAL_STEP_TIMEOUT_MS, label);

  try {
    await step(
      'Serial open',
      () =>
        new Promise<void>((resolve, reject) =>
          port.open((err) => (err ? reject(err) : resolve())),
        ),
    );
    await step(
      'Serial write',
      () =>
        new Promise<void>((resolve, reject) =>
          port.write(data, (err) => (err ? reject(err) : resolve())),
        ),
    );
    await step(
      'Serial drain',
      () =>
        new Promise<void>((resolve, reject) =>
          port.drain((err) => (err ? reject(err) : resolve())),
        ),
    );
    if (asyncError) throw asyncError;
    return { ok: true };
  } catch (e: any) {
    return {
      ok: false,
      error: String(e?.message || e || 'Serial print failed'),
    };
  } finally {
    // Closing a wedged port can hang for the same reason writing did, so the
    // cleanup gets its own deadline; a leaked handle is better than a frozen
    // queue.
    await withTimeout(
      new Promise<void>((resolve) => port.close(() => resolve())),
      SERIAL_CLOSE_TIMEOUT_MS,
      'Serial close',
    ).catch(() => undefined);
  }
}
