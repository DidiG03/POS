import { describe, expect, it, vi } from 'vitest';

const { rows } = vi.hoisted(() => ({ rows: new Map<string, any>() }));
vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findMany: vi.fn(async () =>
        [...rows.entries()].map(([key, valueJson]) => ({ key, valueJson })),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        rows.set(where.key, data.valueJson);
        return {};
      }),
    },
  },
}));

import {
  isLeftoverTestWork,
  sameFiscalEnvironment,
  tagUntaggedFiscalWork,
} from './environment';

describe('fiscal environment', () => {
  it('stamps untagged queued work with the service it was made on', async () => {
    rows.set('fiscal:claim:a', { state: 'DEFERRED', context: { area: 'Bar' } });
    rows.set('fiscal:claim:b', {
      state: 'DEFERRED',
      context: { environment: 'prod' },
    });
    rows.set('fiscal:correction-retry:1:2', { kind: 'CANCEL' });
    expect(await tagUntaggedFiscalWork('dev')).toBe(2);
    expect(rows.get('fiscal:claim:a').context).toEqual({
      area: 'Bar',
      environment: 'dev',
    });
    expect(rows.get('fiscal:claim:b').context.environment).toBe('prod');
    expect(rows.get('fiscal:correction-retry:1:2').environment).toBe('dev');
  });

  it('only drops test-service work, never live work', () => {
    expect(isLeftoverTestWork('dev', 'prod')).toBe(true);
    expect(isLeftoverTestWork('prod', 'dev')).toBe(false);
    expect(sameFiscalEnvironment('prod', 'dev')).toBe(false);
    expect(sameFiscalEnvironment(undefined, 'prod')).toBe(true);
  });
});
