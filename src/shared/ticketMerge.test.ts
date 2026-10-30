import { describe, expect, it } from 'vitest';
import {
  firedLinesOfSend,
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
  it('appends the lines a Send fires to the bill', () => {
    const latest = [line('Kafe', 1, { sendKey: 'k1', lineId: 'a' })];
    const incoming = [
      line('Kafe', 1, { sendKey: 'k1', lineId: 'a' }),
      line('Uje', 2, { sendKey: 'k2' }),
    ];
    const out = mergeTicketSend({
      incoming,
      latest,
      sendKey: 'k2',
      addedItems: [incoming[1]],
    });
    expect(out.mode).toBe('appended');
    expect(live(out.items)).toEqual({ Kafe: 1, Uje: 2 });
    expect(out.items[1].sendKey).toBe('k2');
  });

  it('starts a new bill with the fired lines', () => {
    const incoming = [line('Kafe', 1, { sendKey: 'k1' })];
    const out = mergeTicketSend({
      incoming,
      latest: [],
      sendKey: 'k1',
      addedItems: incoming,
    });
    expect(out.mode).toBe('as-sent');
    expect(live(out.items)).toEqual({ Kafe: 1 });
  });

  it('a Send already on the bill adds nothing', () => {
    const latest = [line('Kafe', 1, { sendKey: 'k1' })];
    const out = mergeTicketSend({
      incoming: latest,
      latest,
      sendKey: 'k1',
      addedItems: latest,
    });
    expect(out.mode).toBe('already-included');
    expect(out.items).toEqual(latest);
  });

  it('keeps every bill line a Send leaves out (a phone that sends only new lines)', () => {
    const latest = [
      line('Kafe', 1, { sendKey: 'k1', lineId: 'a' }),
      line('Uje', 1, { sendKey: 'k2', lineId: 'b' }),
    ];
    const incoming = [line('Birre', 1, { sendKey: 'k3' })];
    const out = mergeTicketSend({ incoming, latest, sendKey: 'k3' });
    expect(live(out.items)).toEqual({ Kafe: 1, Uje: 1, Birre: 1 });
  });

  it('never un-voids or un-pays a bill line, whatever the Send says', () => {
    const latest = [
      line('Kafe', 1, { sendKey: 'k1', lineId: 'a', voided: true }),
      line('Uje', 1, { sendKey: 'k2', lineId: 'b', paid: true }),
    ];
    const incoming = [
      line('Kafe', 1, { sendKey: 'k1', lineId: 'a' }),
      line('Uje', 1, { sendKey: 'k2', lineId: 'b' }),
      line('Birre', 1, { sendKey: 'k3' }),
    ];
    const out = mergeTicketSend({ incoming, latest, sendKey: 'k3' });
    expect(out.items.find((l) => l.lineId === 'a')?.voided).toBe(true);
    expect(out.items.find((l) => l.lineId === 'b')?.paid).toBe(true);
    expect(live(out.items)).toEqual({ Birre: 1 });
  });

  it('a Send cannot void: a voided flag on a bill line it names is ignored', () => {
    const latest = [line('Kafe', 1, { sendKey: 'k1', lineId: 'a' })];
    const incoming = [
      line('Kafe', 1, { sendKey: 'k1', lineId: 'a', voided: true }),
      line('Uje', 1, { sendKey: 'k2' }),
    ];
    const out = mergeTicketSend({ incoming, latest, sendKey: 'k2' });
    expect(live(out.items)).toEqual({ Kafe: 1, Uje: 1 });
  });

  it('keeps lines written before courses existed (no fired flag)', () => {
    const latest = [
      { ...line('Kafe', 1, { sendKey: 'k1' }), fired: undefined },
    ];
    const out = mergeTicketSend({
      incoming: [line('Uje', 1)],
      latest,
      sendKey: 'k2',
    });
    expect(out.items[0].fired).toBe(true);
    expect(live(out.items)).toEqual({ Kafe: 1, Uje: 1 });
  });
});

describe('a repeat order after a void (QA round 5, #2)', () => {
  const voided = line('Espresso', 1, {
    sendKey: 'k1',
    lineId: 'a',
    voided: true,
  });

  for (const [shape, extra] of [
    ['with addedItems', { addedItems: true }],
    ['without addedItems', { addedItems: false }],
  ] as const) {
    it(`a new Espresso is a new live line (${shape})`, () => {
      const fresh = line('Espresso', 1, { sendKey: 'k2' });
      const out = mergeTicketSend({
        incoming: [fresh],
        latest: [voided],
        sendKey: 'k2',
        addedItems: extra.addedItems ? [fresh] : null,
      });
      expect(out.items).toHaveLength(2);
      expect(out.items[0]).toMatchObject({ lineId: 'a', voided: true });
      expect(out.items[1]).toMatchObject({ sendKey: 'k2' });
      expect(out.items[1].voided).not.toBe(true);
    });
  }

  it('a line without a Send key or id is new, not the voided one', () => {
    const out = mergeTicketSend({
      incoming: [line('Espresso', 1)],
      latest: [voided],
      sendKey: 'srv-1',
    });
    expect(live(out.items)).toEqual({ Espresso: 1 });
    expect(out.items[1].sendKey).toBe('srv-1');
  });

  it('three Sends of the same item are three lines', () => {
    let bill: MergeLine[] = [voided];
    for (const k of ['k2', 'k3', 'k4']) {
      bill = mergeTicketSend({
        incoming: [line('Espresso', 1)],
        latest: bill,
        sendKey: k,
      }).items;
    }
    expect(live(bill)).toEqual({ Espresso: 3 });
    expect(bill.filter((l) => l.voided)).toHaveLength(1);
  });

  it('a live Espresso on the bill does not absorb a new one', () => {
    const out = mergeTicketSend({
      incoming: [line('Espresso', 1)],
      latest: [line('Espresso', 1, { sendKey: 'k1', lineId: 'a' })],
      sendKey: 'k2',
    });
    expect(live(out.items)).toEqual({ Espresso: 2 });
  });
});

describe('firedLinesOfSend', () => {
  const bill = [
    line('Kafe', 1, { sendKey: 'k1', lineId: 'a' }),
    line('Uje', 1, { sendKey: 'k2', lineId: 'b' }),
  ];

  it('lines naming the bill by id or Send key are the bill, not orders', () => {
    const out = firedLinesOfSend({
      incoming: [
        line('Kafe', 1, { lineId: 'a' }),
        line('Uje', 1, { sendKey: 'k2' }),
        line('Birre', 1),
      ],
      latest: bill,
      sendKey: 'k3',
    });
    expect(out.map((l) => l.name)).toEqual(['Birre']);
    expect(out[0]).toMatchObject({ sendKey: 'k3', fired: true });
  });

  it('ignores lines sent as voided, paid or held', () => {
    const out = firedLinesOfSend({
      incoming: [
        line('Kafe', 1, { voided: true }),
        line('Uje', 1, { paid: true }),
        line('Birre', 1, { fired: false }),
      ],
      latest: [],
      sendKey: 'k3',
    });
    expect(out).toEqual([]);
  });

  it('trusts the device list of fired lines when it sends one', () => {
    const added = [line('Kafe', 1, { sendKey: 'other' })];
    const out = firedLinesOfSend({
      incoming: [...bill, ...added],
      latest: bill,
      sendKey: 'k3',
      addedItems: added,
    });
    expect(out).toEqual([{ ...added[0], sendKey: 'k3' }]);
  });
});

describe('held course lines', () => {
  it('a held line is added held, and firing it later fires that line', () => {
    const held = line('Biftek', 1, { fired: false, lineId: 'h1' });
    const first = mergeTicketSend({
      incoming: [line('Kafe', 1, { sendKey: 'k1' }), held],
      latest: [],
      sendKey: 'k1',
      addedItems: [line('Kafe', 1, { sendKey: 'k1' })],
    }).items;
    expect(first.find((l) => l.name === 'Biftek')?.fired).toBe(false);

    const fire = { ...held, fired: true, sendKey: 'k2' };
    const out = mergeTicketSend({
      incoming: [...first, fire],
      latest: first,
      sendKey: 'k2',
      addedItems: [fire],
    }).items;
    expect(out.filter((l) => l.name === 'Biftek')).toEqual([
      expect.objectContaining({ lineId: 'h1', fired: true, sendKey: 'k2' }),
    ]);
  });

  it('fires part of a held line by item and adds the rest', () => {
    const latest = [line('Biftek', 1, { fired: false })];
    const out = mergeTicketSend({
      incoming: [line('Biftek', 2)],
      latest,
      sendKey: 'k2',
      addedItems: [line('Biftek', 2)],
    }).items;
    expect(out.filter((l) => l.fired !== false)).toHaveLength(2);
    expect(live(out)).toEqual({ Biftek: 2 });
  });

  it('a held line already on the bill is not added again', () => {
    const latest = [line('Biftek', 1, { fired: false, lineId: 'h1' })];
    const out = mergeTicketSend({
      incoming: [line('Biftek', 1, { fired: false })],
      latest,
      sendKey: 'k2',
    });
    expect(out.mode).toBe('already-included');
  });

  it('firing a line that was already sent never adds it twice', () => {
    const latest = [line('Kafe', 1, { sendKey: 'k1', lineId: 'a' })];
    const out = mergeTicketSend({
      incoming: latest,
      latest,
      sendKey: 'k2',
      addedItems: [line('Kafe', 1, { lineId: 'a' })],
    });
    expect(live(out.items)).toEqual({ Kafe: 1 });
  });
});
