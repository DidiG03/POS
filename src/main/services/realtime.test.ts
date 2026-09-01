import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

import { writeSseToClients } from './realtime';

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
