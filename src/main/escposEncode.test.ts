import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

import {
  encodeEscposText,
  formatTwoCol,
  receiptLayout,
  receiptPaperMm,
} from './escposEncode';
import { buildEscposTicket } from './print';

describe('encodeEscposText', () => {
  it('keeps ASCII intact', () => {
    expect(encodeEscposText('TOTAL 7700.00\n').toString('latin1')).toBe(
      'TOTAL 7700.00\n',
    );
  });

  it('encodes Albanian ë/Ë/ç as PC850, not question marks', () => {
    const bytes = encodeEscposText('Antipastë e shtëpisë CASARECCA kërpudhë');
    const latin = bytes.toString('latin1');
    expect(latin).not.toContain('?');
    // PC850: ë = 0x89
    expect(bytes.includes(0x89)).toBe(true);
    expect(encodeEscposText('Ë')[0]).toBe(0xd3);
    expect(encodeEscposText('ç')[0]).toBe(0x87);
    expect(encodeEscposText('Ç')[0]).toBe(0x80);
  });

  it('folds unknown letters instead of turning the whole word into ???', () => {
    expect(encodeEscposText('gjalpë').includes(0x3f)).toBe(false);
  });
});

describe('receiptLayout', () => {
  it('uses 48 columns on 80mm paper so Font A fills the roll', () => {
    expect(receiptPaperMm(undefined)).toBe(80);
    expect(receiptLayout(80).cols).toBe(48);
    expect(receiptLayout(80).sep).toHaveLength(48);
  });

  it('keeps 32 columns for 58mm paper', () => {
    expect(receiptLayout(58).cols).toBe(32);
  });

  it('puts the price at the right edge of the paper', () => {
    const line = formatTwoCol(
      '2 x Antipastë e shtëpisë',
      '2400.00',
      receiptLayout(80),
    );
    expect(line.split('\n')[0]).toHaveLength(48);
    expect(line.endsWith('2400.00')).toBe(true);
  });
});

describe('buildEscposTicket width', () => {
  const payload = {
    area: 'Salla Brenda',
    tableLabel: 'T1',
    covers: 2,
    userName: 'Sefrid',
    items: [{ name: 'Antipastë e shtëpisë', qty: 2, unitPrice: 1200 }],
    meta: { kind: 'PAYMENT' as const, method: 'CASH', totalAfter: 2400 },
  };

  it('prints a 48-char rule on 80mm paper', () => {
    const buf = buildEscposTicket(payload, {
      restaurantName: 'Code Orbit Agroturizem',
      currency: 'EUR',
      printers: [{ id: 'p1', name: 'Till', paperWidthMm: 80 }],
    } as any);
    const text = buf.toString('latin1');
    expect(text).toMatch(/\n-{48}\n/);
    expect(text).not.toMatch(/\n-{32}\n/);
  });

  it('puts ë on the slip instead of ?', () => {
    const buf = buildEscposTicket(payload, {
      restaurantName: 'Test',
      currency: 'EUR',
    } as any);
    expect(buf.includes(0x89)).toBe(true);
    const ascii = buf.toString('ascii');
    expect(ascii).not.toMatch(/Antipast\?/);
  });
});
