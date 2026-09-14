import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: {
    isPackaged: false,
    isReady: () => false,
    getPath: () => '/tmp',
  },
  net: { fetch: vi.fn() },
}));

import {
  encodeEscposText,
  escposQrCode,
  formatTwoCol,
  receiptLayout,
  receiptPaperMm,
} from './escposEncode';
import { buildEscposTicket, buildHtmlReceipt } from './print';

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
    expect(receiptLayout(80).fontBCols).toBe(64);
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
    expect(text).toContain('Salla Brenda - T1');
    expect(text).toContain('Waiter: Sefrid');
    expect(text).toContain('Covers: 2');
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

  it('prints a store till as Cashier without covers', () => {
    const buf = buildEscposTicket(
      {
        area: 'Store',
        tableLabel: 'Till 3',
        covers: 1,
        userName: 'Ana',
        items: [{ name: 'Coffee', qty: 1, unitPrice: 200 }],
        meta: { kind: 'PAYMENT' as const, method: 'CASH', totalAfter: 200 },
      },
      {
        restaurantName: 'Shop',
        currency: 'EUR',
      } as any,
    );
    const text = buf.toString('latin1');
    expect(text).toContain('Till 3');
    expect(text).not.toContain('Store - Till 3');
    expect(text).toContain('Cashier: Ana');
    expect(text).not.toContain('Waiter:');
    expect(text).not.toContain('Covers:');
  });

  it('prints a compact kitchen ORDER slip with waiter and time at the foot', () => {
    const kitchen = buildEscposTicket(
      {
        area: 'Salla Brenda',
        tableLabel: 'T1',
        covers: 4,
        userName: 'Sefrid',
        items: [{ name: 'Steak', qty: 1, unitPrice: 0, station: 'KITCHEN' }],
        meta: { kind: 'ORDER' as const, courseLabel: 'Course 2' },
      },
      { restaurantName: 'Test Bistro', currency: 'EUR' } as any,
    );
    const text = kitchen.toString('latin1');
    expect(text).toContain('Salla Brenda - T1');
    expect(text).toContain('1 x Steak');
    expect(text).toContain('Waiter: Sefrid');
    expect(text.indexOf('1 x Steak')).toBeLessThan(
      text.indexOf('Waiter: Sefrid'),
    );
    expect(text).not.toContain('COURSE 2');
    expect(text).not.toContain('ORDER');
    expect(text).not.toContain('Covers:');
    expect(text).not.toContain('Test Bistro');
  });
});

describe('buildEscposTicket language', () => {
  const payload = {
    area: 'Salla Brenda',
    tableLabel: 'T1',
    covers: 2,
    userName: 'Sefrid',
    note: 'Pa qepë',
    items: [{ name: 'Antipastë e shtëpisë', qty: 2, unitPrice: 1200 }],
    meta: {
      kind: 'PAYMENT' as const,
      method: 'CASH',
      totalAfter: 2400,
      serviceChargeAmount: 240,
      serviceChargeMode: 'PERCENT',
      serviceChargeValue: 10,
    },
  };

  function slip(buf: Buffer) {
    return buf.toString('latin1');
  }
  function has(buf: Buffer, s: string) {
    expect(slip(buf)).toContain(encodeEscposText(s).toString('latin1'));
  }
  function lacks(buf: Buffer, s: string) {
    expect(slip(buf)).not.toContain(encodeEscposText(s).toString('latin1'));
  }

  it('prints Albanian labels when the venue language is sq', () => {
    const buf = buildEscposTicket(payload, {
      restaurantName: 'Test',
      currency: 'EUR',
      preferences: { language: 'sq' },
    } as any);
    has(buf, 'Kamarier: Sefrid');
    has(buf, 'Të ftuar: 2');
    has(buf, 'Nëntotali');
    has(buf, 'Shërbimi (10%)');
    has(buf, 'TOTALI');
    has(buf, 'E PAGUAR');
    has(buf, 'Metoda: PARA');
    has(buf, 'Shënim:');
    has(buf, 'Faleminderit!');
    lacks(buf, 'Waiter:');
    lacks(buf, 'Covers:');
    lacks(buf, 'Thank you!');
    lacks(buf, 'Method: CASH');
  });

  it('prints English labels by default', () => {
    const buf = buildEscposTicket(payload, {
      restaurantName: 'Test',
      currency: 'EUR',
    } as any);
    has(buf, 'Waiter: Sefrid');
    has(buf, 'Covers: 2');
    has(buf, 'Thank you!');
    lacks(buf, 'Kamarier:');
    lacks(buf, 'Faleminderit!');
  });

  it('prints Albanian HTML receipts too', () => {
    const html = buildHtmlReceipt(payload, {
      restaurantName: 'Test',
      currency: 'EUR',
      preferences: { language: 'sq' },
    } as any);
    expect(html).toContain('Kamarier: Sefrid');
    expect(html).toContain('Të ftuar: 2');
    expect(html).toContain('Nëntotali');
    expect(html).toContain('E PAGUAR');
    expect(html).toContain('Metoda: PARA');
    expect(html).toContain('Faleminderit!');
    expect(html).not.toContain('Thank you!');
  });
});

describe('fiscal receipt block', () => {
  it('prints FISKALIZUAR and a CIS QR once NIVF is present', () => {
    const buf = buildEscposTicket(
      {
        area: 'Salla',
        tableLabel: 'T1',
        items: [{ name: 'Coffee', qty: 1, unitPrice: 150 }],
        meta: {
          kind: 'PAYMENT',
          method: 'CASH',
          totalAfter: 150,
          fiscalEnabled: true,
          fiscalNivf: 'NIVF-99',
          fiscalNslf: 'IIC-99',
        },
      },
      { restaurantName: 'Test', currency: 'ALL' } as any,
    );
    const text = buf.toString('latin1');
    expect(text).toContain('FISKALIZUAR');
    expect(text).toContain('NIVF: NIVF-99');
    expect(text).not.toContain('FISKALIZIMI NE PRITJE');
  });

  it('does not claim fiskalizimi on a deferred sale', () => {
    const buf = buildEscposTicket(
      {
        area: 'Salla',
        tableLabel: 'T1',
        items: [{ name: 'Coffee', qty: 1, unitPrice: 150 }],
        meta: {
          kind: 'PAYMENT',
          method: 'CASH',
          totalAfter: 150,
          fiscalEnabled: true,
          fiscalStatus: 'pending',
          fiscalWarning: 'unreachable',
        },
      },
      { restaurantName: 'Test', currency: 'ALL' } as any,
    );
    const text = buf.toString('latin1');
    expect(text).toContain('FISKALIZIMI NE PRITJE');
    expect(text).not.toContain('FISKALIZUAR');
  });

  it('prints a Model 2 QR that phones can read, not Model 1', () => {
    const buf = buildEscposTicket(
      {
        area: 'Salla',
        tableLabel: 'T1',
        items: [{ name: 'Coffee', qty: 1, unitPrice: 150 }],
        meta: {
          kind: 'PAYMENT',
          method: 'CASH',
          totalAfter: 150,
          fiscalEnabled: true,
          fiscalNivf: 'NIVF-99',
          fiscalNslf: 'IIC-99',
          fiscalTin: 'L12345678A',
          paidAt: '2026-09-10T19:59:05+02:00',
        },
      },
      {
        restaurantName: 'Test',
        currency: 'ALL',
        printers: [{ id: 'p1', name: 'Till', paperWidthMm: 80 }],
      } as any,
    );
    // GS ( k 04 00 31 41 32 00 = select QR Model 2
    expect(
      buf.includes(
        Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
      ),
    ).toBe(true);
    // Old bug: center-align byte 49 sent as Model 1
    expect(
      buf.includes(
        Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x41, 0x31]),
      ),
    ).toBe(false);
  });
});

describe('escposQrCode', () => {
  it('uses at least 5-dot modules so cameras can resolve it', () => {
    const buf = escposQrCode('https://example.test/q', { paperMm: 80 });
    const idx = buf.indexOf(
      Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43]),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(buf[idx + 7]).toBeGreaterThanOrEqual(5);
  });
});
