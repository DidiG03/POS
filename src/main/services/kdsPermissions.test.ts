/** QA round 6, #8: who may work the kitchen display, and the record of it. */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ log: null as any }));
vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: vi.fn(async () =>
        store.log ? { valueJson: store.log } : null,
      ),
      upsert: vi.fn(async ({ update }: any) => {
        store.log = update.valueJson;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === 7
          ? { displayName: 'Ana (manager)' }
          : { displayName: 'Bledi' },
      ),
    },
  },
}));
vi.mock('./security', () => ({ logSecurityEvent: vi.fn() }));

import { authorizeLanRoute } from './lanPolicy';
import {
  kdsActionAllowed,
  kdsClearAllowedWithoutPin,
  listKdsActions,
  recordKdsAction,
} from './kdsPermissions';

describe('who may bump, recall and clear', () => {
  it.each(['/kds/bump', '/kds/bump-item', '/kds/recall', '/kds/clear-done'])(
    'a waiter is refused %s; kitchen staff and a paired display are not',
    (route) => {
      expect(authorizeLanRoute('POST', route, 'WAITER')).not.toBe('allow');
      expect(authorizeLanRoute('POST', route, 'HOST')).not.toBe('allow');
      expect(authorizeLanRoute('POST', route, 'CHEF')).toBe('allow');
      expect(authorizeLanRoute('POST', route, 'BARTENDER')).toBe('allow');
      expect(authorizeLanRoute('POST', route, 'KDS')).toBe('allow');
      expect(authorizeLanRoute('POST', route, 'ADMIN')).toBe('allow');
      expect(authorizeLanRoute('POST', route, null)).toBe('unauthenticated');
    },
  );

  it('clearing needs a manager: only an admin session skips the PIN', () => {
    expect(kdsClearAllowedWithoutPin('ADMIN')).toBe(true);
    for (const role of ['KDS', 'CHEF', 'HEAD_CHEF', 'CASHIER', 'WAITER']) {
      expect(kdsClearAllowedWithoutPin(role)).toBe(false);
    }
    expect(kdsActionAllowed('waiter')).toBe(false);
    expect(kdsActionAllowed('kp')).toBe(true);
  });

  it('only admins read the action log', () => {
    expect(authorizeLanRoute('GET', '/kds/action-log', 'ADMIN')).toBe('allow');
    expect(authorizeLanRoute('GET', '/kds/action-log', 'KDS')).not.toBe(
      'allow',
    );
    expect(authorizeLanRoute('GET', '/kds/action-log', 'CHEF')).not.toBe(
      'allow',
    );
  });

  it('both clear routes check for a manager before deleting anything', () => {
    const root = path.resolve(__dirname, '../../..');
    const api = fs.readFileSync(path.join(root, 'src/main/api.ts'), 'utf8');
    const lan = api.slice(api.indexOf("pathname === '/kds/clear-done'"));
    expect(lan.indexOf('kdsClearAllowedWithoutPin(')).toBeGreaterThan(-1);
    expect(lan.indexOf('kdsClearAllowedWithoutPin(')).toBeLessThan(
      lan.indexOf('purgeKdsDoneTicketsForStation('),
    );
    const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
    const ipc = main.slice(main.indexOf("ipcHandle('kds:clearDone'"));
    expect(ipc.indexOf('kdsClearAllowedWithoutPin(')).toBeLessThan(
      ipc.indexOf('purgeKdsDoneTicketsForStation('),
    );
  });
});

describe('the kitchen action log', () => {
  beforeEach(() => {
    store.log = null;
  });

  it('records who did each action, and the manager who approved a clear', async () => {
    await Promise.all([
      recordKdsAction({
        action: 'bump',
        station: 'kitchen',
        ticketId: 12,
        itemIdx: null,
        actorUserId: 3,
        via: 'staff',
        result: 'ok',
      }),
      recordKdsAction({
        action: 'recall',
        station: 'BAR',
        ticketId: 9,
        itemIdx: 1,
        actorUserId: null,
        via: 'display',
      }),
      recordKdsAction({
        action: 'clear-done',
        station: 'KITCHEN',
        ticketId: null,
        itemIdx: null,
        actorUserId: null,
        via: 'display',
        approvedById: 7,
        result: '4 cleared',
      }),
    ]);
    const log = await listKdsActions();
    // Newest first, none lost to the concurrent writes.
    expect(log.map((e) => e.action)).toEqual(['clear-done', 'recall', 'bump']);
    expect(log[2]).toMatchObject({
      station: 'KITCHEN',
      ticketId: 12,
      actorUserId: 3,
      actorName: 'Bledi',
      via: 'staff',
    });
    expect(log[1]).toMatchObject({ actorUserId: null, via: 'display' });
    expect(log[0]).toMatchObject({
      approvedById: 7,
      approvedByName: 'Ana (manager)',
      result: '4 cleared',
    });
  });
});
