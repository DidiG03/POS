/**
 * The gate both payment paths call before fiscalizing, and proof that they
 * do call it — the till (IPC) and the phones (LAN) drifting apart is how
 * most of this module's past duplicate-invoice bugs happened.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { check, adopt } = vi.hoisted(() => ({
  check: vi.fn(),
  adopt: vi.fn(async () => undefined),
}));

vi.mock('./sitting', () => ({
  checkSittingBeforePayment: check,
  adoptFiscalInvoice: adopt,
}));
vi.mock('@db/client', () => ({ prisma: {} }));

import { sittingFiscalGate } from './index';

const on = { fiscal: { enabled: true } } as any;
const base = {
  settings: on,
  area: 'Salla',
  tableLabel: 'T4',
  meta: { totalAfter: 25, userId: 7 },
  idempotencyKey: 'pay-new',
};

beforeEach(() => {
  check.mockReset();
  adopt.mockClear();
});

describe('sittingFiscalGate', () => {
  it('stays out of the way when fiskalizimi is off', async () => {
    expect(
      await sittingFiscalGate({ ...base, settings: { fiscal: {} } as any }),
    ).toEqual({ kind: 'proceed' });
    expect(check).not.toHaveBeenCalled();
  });

  it('checks the sitting with the authoritative total', async () => {
    check.mockResolvedValue({ kind: 'clear' });
    expect(await sittingFiscalGate(base)).toEqual({ kind: 'proceed' });
    expect(check).toHaveBeenCalledWith({
      area: 'Salla',
      tableLabel: 'T4',
      total: 25,
      method: 'CASH',
      idempotencyKey: 'pay-new',
    });
  });

  it('makes the payment wait only while another send is in flight', async () => {
    check.mockResolvedValue({
      kind: 'blocked',
      code: 'FISCAL_SITTING_BUSY',
      message: 'being sent',
      docId: 'pay-x',
      retryable: true,
    });
    expect(await sittingFiscalGate(base)).toEqual({
      kind: 'blocked',
      code: 'FISCAL_SITTING_BUSY',
      message: 'being sent',
      retryable: true,
    });
  });

  it('takes the payment and holds only its invoice when the sitting needs a look (QA H1)', async () => {
    check.mockResolvedValue({
      kind: 'hold',
      docId: 'pay-lost',
      message: 'mismatch',
    });
    expect(await sittingFiscalGate(base)).toEqual({
      kind: 'proceed',
      holdReason: 'mismatch',
    });
  });

  it('records the payment under an unconfirmed docId instead of refusing it (QA H1)', async () => {
    check.mockResolvedValue({
      kind: 'adopt',
      docId: 'pay-unknown',
      unconfirmed: true,
    });
    expect(await sittingFiscalGate(base)).toEqual({
      kind: 'proceed',
      adoptDocId: 'pay-unknown',
    });
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'pay-unknown', unconfirmed: true }),
    );
  });

  it('links and reuses a lost invoice', async () => {
    check.mockResolvedValue({ kind: 'adopt', docId: 'pay-lost', nivf: 'F' });
    expect(await sittingFiscalGate(base)).toEqual({
      kind: 'proceed',
      adoptDocId: 'pay-lost',
    });
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'pay-lost', saleKey: 'pay-new' }),
    );
  });

  it('holds the payment when the check itself cannot run', async () => {
    check.mockRejectedValue(new Error('database is locked'));
    expect(await sittingFiscalGate(base)).toMatchObject({
      kind: 'blocked',
      code: 'FISCAL_SITTING_BUSY',
      retryable: true,
    });
  });
});

describe('wiring', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

  it('both payment paths run the gate before fiscalizing and pass the reused docId', () => {
    for (const file of ['index.ts', 'api.ts']) {
      const src = read(file);
      const gate = src.indexOf('await sittingFiscalGate(');
      const fiscalize = src.indexOf('await fiscalizePaymentOnce(');
      expect(gate, file).toBeGreaterThan(0);
      expect(fiscalize, file).toBeGreaterThan(gate);
      expect(src.slice(fiscalize, fiscalize + 400), file).toContain(
        'adoptDocId: sitting.adoptDocId',
      );
      expect(src.slice(fiscalize, fiscalize + 400), file).toContain(
        'holdReason: sitting.holdReason',
      );
    }
  });

  it('both settings paths audit the fiskalizimi switch', () => {
    for (const file of ['index.ts', 'api.ts']) {
      expect(read(file), file).toContain('await auditFiscalToggle(');
    }
  });

  it('the auto-void tells admins what it erased', () => {
    const src = read('index.ts');
    const loop = src.slice(
      src.indexOf('function startAutoVoidStaleTicketsLoop'),
    );
    expect(loop).toContain('notifyAutoVoidedTable(');
    expect(loop).toContain('findLatestTicketLogForCurrentSession(');
  });

  it('the auto-void voids under the table lock and keeps paid lines', () => {
    const src = read('index.ts');
    const start = src.indexOf('function startAutoVoidStaleTicketsLoop');
    const loop = src.slice(
      start,
      src.indexOf('function stopAutoVoidStaleTicketsLoop'),
    );
    expect(loop).toContain('await voidWholeTicket(');
    expect(loop).toContain('idempotencyKey: `auto-void:');
    expect(loop).not.toMatch(/ticketLog\s*\.update\(/);
  });
});
