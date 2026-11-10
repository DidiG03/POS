import { describe, expect, it } from 'vitest';
import {
  MAX_DETAILS_CHARS,
  MAX_ROWS_PER_WINDOW,
  WINDOW_MS,
  createSecurityEventStore,
  storableDetails,
  type SecurityEventRow,
} from './securityEventStore';

function fakeDb() {
  const rows: Array<SecurityEventRow & { id: number }> = [];
  let failNext = false;
  return {
    rows,
    failOnce() {
      failNext = true;
    },
    securityEvent: {
      create: async ({ data }: { data: SecurityEventRow }) => {
        if (failNext) {
          failNext = false;
          throw new Error('database is locked');
        }
        rows.push({ ...data, id: rows.length + 1 });
      },
      findMany: async (args: any) =>
        [...rows].sort((a, b) => b.id - a.id).slice(0, args.take),
      deleteMany: async (args: any) => {
        const cutoff: Date = args.where.createdAt.lt;
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.createdAt < cutoff) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

function setup(opts: { ready?: () => boolean } = {}) {
  const db = fakeDb();
  let t = 1_800_000_000_000;
  const errors: unknown[] = [];
  const store = createSecurityEventStore({
    db: () => db,
    ready: opts.ready ?? (() => true),
    now: () => t,
    onError: (e) => errors.push(e),
  });
  return {
    db,
    store,
    errors,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('security event store', () => {
  it('writes an event and reads it back newest first', async () => {
    const { store, advance } = setup();
    await store.record('lan_login_failed', { remoteIp: '10.0.0.9' });
    advance(1000);
    await store.record('tickets_erased', { userId: 1 });
    const list = await store.list(10);
    expect(list.map((e) => e.event)).toEqual([
      'tickets_erased',
      'lan_login_failed',
    ]);
    expect(list[1]!.details).toEqual({ remoteIp: '10.0.0.9' });
    expect(list[0]!.timestamp - list[1]!.timestamp).toBe(1000);
  });

  it('holds events while the ledger is locked and writes them after', async () => {
    let ready = false;
    const { store, db } = setup({ ready: () => ready });
    await store.record('lan_denied', { pathname: '/admin/overview' });
    expect(db.rows).toHaveLength(0);
    expect(store.pendingCount()).toBe(1);
    ready = true;
    await store.record('lan_login_failed', {});
    expect(db.rows.map((r) => r.event)).toEqual([
      'lan_denied',
      'lan_login_failed',
    ]);
  });

  it('keeps an event whose write failed and retries it in order', async () => {
    const { store, db, errors } = setup();
    db.failOnce();
    await store.record('first', {});
    expect(db.rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    await store.record('second', {});
    expect(db.rows.map((r) => r.event)).toEqual(['first', 'second']);
  });

  it('caps a flood and says how many events were left out', async () => {
    const { store, db, advance } = setup();
    for (let i = 0; i < MAX_ROWS_PER_WINDOW + 40; i++) {
      await store.record('lan_host_refused', { i });
    }
    expect(db.rows).toHaveLength(MAX_ROWS_PER_WINDOW);
    advance(WINDOW_MS);
    await store.record('lan_login_failed', {});
    const tail = db.rows.slice(-2);
    expect(tail[0]!.event).toBe('security_log_suppressed');
    expect((tail[0]!.detailsJson as any).count).toBe(40);
    expect(tail[1]!.event).toBe('lan_login_failed');
  });

  it('prunes by age', async () => {
    const { store, db, advance } = setup();
    await store.record('old', {});
    advance(400 * 86_400_000);
    await store.record('new', {});
    expect(await store.prune(365)).toBe(1);
    expect(db.rows.map((r) => r.event)).toEqual(['new']);
  });
});

describe('storableDetails', () => {
  it('cuts oversized details and survives values JSON cannot hold', () => {
    const big = storableDetails({ text: 'x'.repeat(MAX_DETAILS_CHARS * 2) });
    expect((big as any).truncated).toBe(true);
    expect((big as any).text.length).toBe(MAX_DETAILS_CHARS);
    const loop: any = {};
    loop.self = loop;
    expect(storableDetails(loop)).toEqual({
      note: 'details could not be saved',
    });
    expect(storableDetails(undefined)).toBeNull();
    expect(storableDetails({ a: 1 })).toEqual({ a: 1 });
  });
});
