/**
 * Bumps against an in-memory kitchen: one card, its station rows, and a
 * `$transaction` that runs one transaction at a time like the real
 * database client (`@db/client` serialises transactions with every write).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Card = { id: number; itemsJson: any[]; order: any };
type StationRow = {
  ticketId: number;
  station: string;
  status: string;
  bumpedAt?: Date | null;
  bumpedById?: number | null;
};

const db: { cards: Map<number, Card>; stations: StationRow[] } = {
  cards: new Map(),
  stations: [],
};

const tick = () => new Promise((r) => setTimeout(r, 0));

const tx = {
  kdsTicket: {
    async findUnique({ where }: any) {
      await tick();
      const c = db.cards.get(where.id);
      return c ? structuredClone(c) : null;
    },
    async update({ where, data }: any) {
      await tick();
      const c = db.cards.get(where.id)!;
      c.itemsJson = structuredClone(data.itemsJson);
      return c;
    },
  },
  kdsTicketStation: {
    async updateMany({ where, data }: any) {
      let count = 0;
      for (const r of db.stations) {
        if (
          r.ticketId === where.ticketId &&
          r.station === where.station &&
          r.status === where.status
        ) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    },
  },
  user: {
    findUnique: async ({ where }: any) => (where.id === 7 ? { id: 7 } : null),
  },
};

let chain: Promise<unknown> = Promise.resolve();
const $transaction = vi.fn((fn: (t: any) => Promise<unknown>) => {
  const run = chain.then(() => fn(tx));
  chain = run.catch(() => undefined);
  return run;
});

vi.mock('@db/client', () => ({
  prisma: { $transaction: (fn: any) => $transaction(fn) },
}));
vi.mock('./kdsList', () => ({ notifyKdsTicketChanged: vi.fn() }));

import { bumpKdsItem, bumpKdsTicket } from './kdsBump';

function seed(items: any[], stations: string[] = ['KITCHEN']) {
  db.cards = new Map([
    [1, { id: 1, itemsJson: items, order: { area: 'A', tableLabel: 'T1' } }],
  ]);
  db.stations = stations.map((station) => ({
    ticketId: 1,
    station,
    status: 'NEW',
  }));
}

const card = () => db.cards.get(1)!.itemsJson;
const row = (station: string) =>
  db.stations.find((r) => r.station === station)!;

/** A Send adding a line to the card, as `kdsCreateTicket.ts` merges it. */
function appendLine(line: any) {
  return $transaction(async (t: any) => {
    const c = await t.kdsTicket.findUnique({ where: { id: 1 } });
    await t.kdsTicket.update({
      where: { id: 1 },
      data: { itemsJson: [...c.itemsJson, line] },
    });
  });
}

describe('bumpKdsItem', () => {
  beforeEach(() => {
    chain = Promise.resolve();
  });

  it('keeps a line a Send added while the bump was running', async () => {
    seed([{ name: 'Beer', station: 'BAR' }], ['BAR']);
    await Promise.all([
      bumpKdsItem({ ticketId: 1, station: 'BAR', itemIdx: 0 }),
      appendLine({ name: 'Wine', station: 'BAR' }),
    ]);
    expect(card().map((l) => l.name)).toEqual(['Beer', 'Wine']);
    expect(card()[0].bumped).toBe(true);
  });

  it('keeps a void that landed while the bump was running', async () => {
    seed(
      [
        { name: 'Beer', station: 'BAR' },
        { name: 'Wine', station: 'BAR' },
      ],
      ['BAR'],
    );
    const voidWine = $transaction(async (t: any) => {
      const c = await t.kdsTicket.findUnique({ where: { id: 1 } });
      c.itemsJson[1] = { ...c.itemsJson[1], voided: true };
      await t.kdsTicket.update({
        where: { id: 1 },
        data: { itemsJson: c.itemsJson },
      });
    });
    await Promise.all([
      voidWine,
      bumpKdsItem({ ticketId: 1, station: 'BAR', itemIdx: 0 }),
    ]);
    expect(card()[1].voided).toBe(true);
    // Nothing left to do on the bar: the card is done.
    expect(row('BAR').status).toBe('DONE');
  });

  it('two-stage kitchen: the pass cannot finish a line the cook has not', async () => {
    seed([{ name: 'Steak', station: 'KITCHEN' }]);
    expect(
      await bumpKdsItem({ ticketId: 1, station: 'KITCHEN', itemIdx: 0 }),
    ).toBe('locked');
    expect(
      await bumpKdsItem({
        ticketId: 1,
        station: 'KITCHEN',
        itemIdx: 0,
        cooker: true,
      }),
    ).toBe('ok');
    expect(card()[0].cookerBumped).toBe(true);
    expect(row('KITCHEN').status).toBe('NEW');
    expect(
      await bumpKdsItem({
        ticketId: 1,
        station: 'KITCHEN',
        itemIdx: 0,
        bumpedById: 7,
      }),
    ).toBe('ok');
    expect(row('KITCHEN')).toMatchObject({ status: 'DONE', bumpedById: 7 });
  });

  it('a line on another station, or past the end, is invalid', async () => {
    seed([{ name: 'Beer', station: 'BAR' }], ['BAR']);
    expect(
      await bumpKdsItem({ ticketId: 1, station: 'KITCHEN', itemIdx: 0 }),
    ).toBe('invalid');
    expect(await bumpKdsItem({ ticketId: 1, station: 'BAR', itemIdx: 3 })).toBe(
      'invalid',
    );
    expect(await bumpKdsItem({ ticketId: 2, station: 'BAR', itemIdx: 0 })).toBe(
      'not-found',
    );
  });
});

describe('bumpKdsTicket', () => {
  beforeEach(() => {
    chain = Promise.resolve();
  });

  it('bumping a card that is already done is ok (second screen, bump bar repeat)', async () => {
    seed([{ name: 'Beer', station: 'BAR' }], ['BAR']);
    expect(await bumpKdsTicket({ ticketId: 1, station: 'BAR' })).toBe('ok');
    expect(row('BAR').status).toBe('DONE');
    expect(await bumpKdsTicket({ ticketId: 1, station: 'BAR' })).toBe('ok');
  });

  it('keeps a line a Send added while the whole-card bump was running', async () => {
    seed([{ name: 'Beer', station: 'BAR' }], ['BAR']);
    await Promise.all([
      bumpKdsTicket({ ticketId: 1, station: 'BAR' }),
      appendLine({ name: 'Wine', station: 'BAR' }),
    ]);
    expect(card().map((l) => l.name)).toEqual(['Beer', 'Wine']);
  });

  it('two-stage kitchen: the pass finishes only cooked lines', async () => {
    seed([
      { name: 'Steak', station: 'KITCHEN', cookerBumped: true },
      { name: 'Fish', station: 'KITCHEN' },
    ]);
    await bumpKdsTicket({ ticketId: 1, station: 'KITCHEN' });
    expect(card()[0].bumped).toBe(true);
    expect(card()[1].bumped).toBeUndefined();
    expect(row('KITCHEN').status).toBe('NEW');

    await bumpKdsTicket({ ticketId: 1, station: 'KITCHEN', cooker: true });
    expect(card()[1].cookerBumped).toBe(true);
    await bumpKdsTicket({ ticketId: 1, station: 'KITCHEN' });
    expect(row('KITCHEN').status).toBe('DONE');
  });

  it('a bump by someone who is not a user records no one', async () => {
    seed([{ name: 'Beer', station: 'BAR' }], ['BAR']);
    await bumpKdsTicket({ ticketId: 1, station: 'BAR', bumpedById: 99 });
    expect(row('BAR').bumpedById).toBeUndefined();
  });
});
