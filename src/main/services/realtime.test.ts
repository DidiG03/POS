import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('./floorSnapshot', () => ({
  invalidateFloorSnapshotCache: () => undefined,
}));

import {
  formatSseEvent,
  resetSseEventIdForTests,
  advanceSseEventIdForTests,
  sseCatchupIfMissed,
  writeSseToClients,
} from './realtime';

describe('writeSseToClients', () => {
  it('drops clients whose write throws', () => {
    const dead = {
      res: {
        write: () => {
          throw new Error('EPIPE');
        },
      },
    };
    const live = { res: { write: () => true } };
    const clients = new Set([dead, live]);
    writeSseToClients(clients, 'event: ping\ndata: {}\n\n');
    expect(clients.has(dead)).toBe(false);
    expect(clients.has(live)).toBe(true);
  });

  it('drops sockets that already ended', () => {
    const ended = { res: { write: () => true, writableEnded: true } };
    const clients = new Set([ended]);
    writeSseToClients(clients, 'x');
    expect(clients.size).toBe(0);
  });
});

describe('sse event ids', () => {
  beforeEach(() => {
    resetSseEventIdForTests();
  });

  it('prefixes named events with an id for Last-Event-ID reconnects', () => {
    expect(formatSseEvent('tables', { open: true }, 4)).toBe(
      'id: 4\nevent: tables\ndata: {"open":true}\n\n',
    );
  });

  it('asks a reconnecting tablet to refetch when it missed events', () => {
    expect(sseCatchupIfMissed(0)).toBe(null);
    advanceSseEventIdForTests(4);
    expect(sseCatchupIfMissed(2)).toContain('event: catchup');
    expect(sseCatchupIfMissed(4)).toBe(null);
  });
});
