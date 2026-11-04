/** QA v0.2.104 #13: a kitchen display keeps its pairing across an update. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readKdsDeviceTokenFile,
  writeKdsDeviceTokenFile,
} from './deviceTokenFile';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kds-token-'));
const file = path.join(dir, 'nested', 'kds.device.json');
afterEach(() =>
  fs.rmSync(path.join(dir, 'nested'), { recursive: true, force: true }),
);

describe('KDS pairing token file', () => {
  it('survives a restart: written whole, read back', () => {
    expect(readKdsDeviceTokenFile(file)).toBeNull();
    writeKdsDeviceTokenFile('tok-1234567890', file);
    expect(readKdsDeviceTokenFile(file)).toBe('tok-1234567890');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('is removed on un-pair, and a damaged file reads as unpaired', () => {
    writeKdsDeviceTokenFile('tok-1234567890', file);
    writeKdsDeviceTokenFile(null, file);
    expect(readKdsDeviceTokenFile(file)).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"tok');
    expect(readKdsDeviceTokenFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ token: 'short' }));
    expect(readKdsDeviceTokenFile(file)).toBeNull();
  });
});
