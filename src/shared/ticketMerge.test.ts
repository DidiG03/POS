import { describe, expect, it } from 'vitest';
import {
  capVoidsToBill,
  carryVoidAndPaid,
  keylessSendLines,
  mergeTicketSend,
  type MergeLine,
} from './ticketMerge';

const line = (
  name: string,
  qty: number,
  extra: Partial<MergeLine> = {},
): MergeLine => ({
  sku: name.toUpperCase(),
  name,
  qty,
  unitPrice: 100,
  fired: true,
  ...extra,
});

const live = (items: MergeLine[]) =>
  items
    .filter((l) => l.voided !== true && l.paid !== true)
    .reduce<Record<string, number>>((acc, l) => {
      acc[l.name] = (acc[l.name] || 0) + Number(l.qty);
      return acc;
    }, {});

describe('mergeTicketSend', () => {
  it('writes a normal Send as it came', () => {
    const latest = [line('Kafe', 1, { sendKey: 'k1' })];
    const incoming = [
      line('Kafe', 1, { sendKey: 'k1' }),
      line('Uje', 2, { sendKey: 'k2' }),
    ];
    const out = mergeTicketSend({
      incoming,
      latest,
      stale: false,
      sendKey: 'k2',
      addedItems: [incoming[1]],
    });
    expect(out.mode).toBe('as-sent');
    expect(out.items).toBe(incoming);
  });

  it('a queued Send replayed after a newer one only adds its own lines', () => {
    // S1 (Kafe) queued offline; S2 went out live with Kafe + Birre.
    const latest = [
      line('Kafe', 1, { sendKey: 's1' }),
      line('Birre', 1, { sendKey: 's2' }),
    ];
    const out = mergeTicketSend({
      incoming: [line('Kafe', 1, { sendKey: 's1' })],
      latest,
      stale: true,
      sendKey: 's1',
      addedItems: [line('Kafe', 1, { sendKey: 's1' })],
    });
    // S2 already carried S1's coffee: nothing is added twice, Birre stays.
    expect(out.mode).toBe('already-included');
    expect(live(out.items)).toEqual({ Kafe: 1, Birre: 1 });
  });

  it('a stale Send from another device adds its lines without dropping the bill', () => {
    const latest = [
      line('Kafe', 1, { sendKey: 'a' }),
      line('Birre', 2, { sendKey: 'b' }),
    ];
    const out = mergeTicketSend({
      incoming: [
        line('Kafe', 1, { sendKey: 'a' }),
        line('Tave', 1, { sendKey: 'c' }),
      ],
      latest,
      stale: true,
      sendKey: 'c',
      addedItems: [line('Tave', 1)],
    });
    expect(out.mode).toBe('stale-delta');
    expect(live(out.items)).toEqual({ Kafe: 1, Birre: 2, Tave: 1 });
    expect(out.items.find((l) => l.name === 'Tave')?.sendKey).toBe('c');
  });

  it('puts back lines a stale cart lost, counting the new ones separately', () => {
    // Host holds 3 water; this cart lost them and adds 1 more.
    const out = mergeTicketSend({
      incoming: [line('Uje', 1, { sendKey: 'n' })],
      latest: [line('Uje', 3, { sendKey: 'old' })],
      stale: false,
      sendKey: 'n',
    });
    expect(out.mode).toBe('restored');
    expect(live(out.items)).toEqual({ Uje: 4 });
  });

  it('never brings back a voided line', () => {
    const out = mergeTicketSend({
      incoming: [line('Kafe', 2), line('Birre', 1)],
      latest: [
        line('Kafe', 1, { voided: true }),
        line('Kafe', 1),
        line('Birre', 1),
      ],
      stale: false,
    });
    expect(live(out.items)).toEqual({ Kafe: 1, Birre: 1 });
    expect(out.items.filter((l) => l.voided).map((l) => l.qty)).toEqual([1]);
  });

  it('never charges a paid line again', () => {
    const out = mergeTicketSend({
      incoming: [line('Pizza', 2)],
      latest: [line('Pizza', 1, { paid: true }), line('Pizza', 1)],
      stale: false,
    });
    expect(live(out.items)).toEqual({ Pizza: 1 });
    expect(out.items.filter((l) => l.paid).length).toBe(1);
  });

  it('keeps lines written before courses existed (no fired flag)', () => {
    const legacy: MergeLine = {
      name: 'Sallate',
      sku: 'S',
      qty: 1,
      unitPrice: 50,
    };
    const out = mergeTicketSend({
      incoming: [line('Kafe', 1)],
      latest: [legacy],
      stale: false,
    });
    expect(live(out.items)).toEqual({ Kafe: 1, Sallate: 1 });
  });

  it('starts a new bill as sent', () => {
    const incoming = [line('Kafe', 1)];
    expect(mergeTicketSend({ incoming, latest: [], stale: true }).items).toBe(
      incoming,
    );
  });
});

describe('carryVoidAndPaid', () => {
  it('splits a line when only part of it was voided', () => {
    const { items, changed } = carryVoidAndPaid(
      [line('Uje', 3)],
      [line('Uje', 2), line('Uje', 1, { voided: true })],
    );
    expect(changed).toBe(true);
    expect(items).toEqual([
      expect.objectContaining({ name: 'Uje', qty: 1, voided: true }),
      expect.objectContaining({ name: 'Uje', qty: 2 }),
    ]);
  });

  it('handles weighed quantities', () => {
    const { items } = carryVoidAndPaid(
      [line('Djathe', 0.75)],
      [line('Djathe', 0.25, { paid: true })],
    );
    expect(items.map((l) => [l.qty, l.paid === true])).toEqual([
      [0.25, true],
      [0.5, false],
    ]);
  });

  it('leaves the result alone when it already holds the voids', () => {
    const result = [line('Kafe', 1, { voided: true })];
    expect(carryVoidAndPaid(result, result)).toEqual({
      items: result,
      changed: false,
    });
  });
});

describe('a Send cannot void', () => {
  it('keeps a line live when only the snapshot says it is voided', () => {
    // The till refused the void (no manager PIN); the next Send must not
    // slip it through.
    const out = mergeTicketSend({
      incoming: [line('Verë', 1, { voided: true }), line('Kafe', 1)],
      latest: [line('Verë', 1), line('Kafe', 1)],
      stale: false,
    });
    expect(live(out.items)).toEqual({ Verë: 1, Kafe: 1 });
  });

  it('keeps voids the bill already records', () => {
    const out = mergeTicketSend({
      incoming: [line('Verë', 1, { voided: true }), line('Kafe', 1)],
      latest: [line('Verë', 1, { voided: true }), line('Kafe', 1)],
      stale: false,
    });
    expect(live(out.items)).toEqual({ Kafe: 1 });
  });

  it('un-voids only the quantity beyond the recorded void', () => {
    const { items, changed } = capVoidsToBill(
      [line('Uje', 3, { voided: true })],
      [line('Uje', 1, { voided: true }), line('Uje', 2)],
    );
    expect(changed).toBe(true);
    expect(items.map((l) => [l.qty, l.voided === true])).toEqual([
      [1, true],
      [2, false],
    ]);
  });
});

describe('firing a held course from a stale Send', () => {
  it('fires the held line instead of adding a second copy', () => {
    const out = mergeTicketSend({
      incoming: [line('Tave', 2, { sendKey: 'f2' })],
      latest: [
        line('Sallate', 1, { sendKey: 'f1' }),
        line('Tave', 2, { fired: false }),
        line('Birre', 1, { sendKey: 'x' }),
      ],
      stale: true,
      sendKey: 'f2',
      addedItems: [line('Tave', 2)],
    });
    expect(live(out.items)).toEqual({ Sallate: 1, Tave: 2, Birre: 1 });
    expect(out.items.find((l) => l.name === 'Tave')).toMatchObject({
      fired: true,
      sendKey: 'f2',
    });
  });

  it('fires part of a held line and adds the rest', () => {
    const out = mergeTicketSend({
      incoming: [],
      latest: [line('Tave', 1, { fired: false })],
      stale: true,
      sendKey: 'f3',
      addedItems: [line('Tave', 3)],
    });
    expect(live(out.items)).toEqual({ Tave: 3 });
    expect(out.items.every((l) => l.fired === true)).toBe(true);
  });
});

describe('keylessSendLines', () => {
  const kafe = { sku: 'K', name: 'Kafe', qty: 1, unitPrice: 1, fired: true };

  it('orders what the snapshot has beyond the live bill, as its own line', () => {
    const bill = [{ ...kafe, lineId: 'a', sendKey: 's1' }];
    expect(keylessSendLines([{ ...kafe, qty: 2 }], bill)).toEqual([
      { ...kafe, qty: 1, voided: false, paid: false },
    ]);
  });

  it('a voided line on the bill does not absorb a new order', () => {
    const bill = [{ ...kafe, lineId: 'a', voided: true }];
    expect(keylessSendLines([kafe], bill)).toEqual([
      { ...kafe, voided: false, paid: false },
    ]);
  });

  it('lines named by id or Send key are the bill, not new orders', () => {
    const bill = [
      { ...kafe, lineId: 'a', sendKey: 's1' },
      { ...kafe, lineId: 'b', sendKey: 's2' },
    ];
    expect(
      keylessSendLines(
        [
          { ...kafe, lineId: 'a' },
          { ...kafe, sendKey: 's2' },
        ],
        bill,
      ),
    ).toEqual([]);
  });

  it('ignores lines sent as voided, paid or held', () => {
    expect(
      keylessSendLines(
        [
          { ...kafe, voided: true },
          { ...kafe, paid: true },
          { ...kafe, fired: false },
        ],
        [],
      ),
    ).toEqual([]);
  });
});

describe("mergeTicketSend keeps this Send's lines live", () => {
  it('does not carry a bill void onto the line this Send fires', () => {
    const kafe = { sku: 'K', name: 'Kafe', qty: 1, unitPrice: 1, fired: true };
    const out = mergeTicketSend({
      incoming: [{ ...kafe, sendKey: 'k2' }],
      latest: [{ ...kafe, sendKey: 'k1', voided: true }],
      stale: false,
      sendKey: 'k2',
      addedItems: [{ ...kafe, sendKey: 'k2' }],
    });
    expect(out.items.find((l) => l.sendKey === 'k2')?.voided).not.toBe(true);
    expect(out.items.find((l) => l.sendKey === 'k1')?.voided).toBe(true);
  });
});
