/**
 * The LAN policy table is only a control if it covers every route `api.ts`
 * serves. Unlisted routes are denied at runtime, which is the safe default but
 * a terrible way to discover a gap — so this reads the routes out of the source
 * and checks both directions.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LAN_ROUTE_POLICIES, authorizeLanRoute } from './lanPolicy';

const API_SOURCE = path.resolve(__dirname, '..', 'api.ts');

/** Pull `req.method === 'X' && pathname === '/y'` pairs out of the dispatcher. */
function routesFromSource(): string[] {
  const source = fs.readFileSync(API_SOURCE, 'utf8').replace(/\s+/g, ' ');
  const re = /req\.method === '(\w+)' && pathname === '([^']+)'/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) found.add(`${m[1]} ${m[2]}`);
  return [...found].sort();
}

describe('LAN policy coverage', () => {
  const routes = routesFromSource();

  it('finds the route dispatch in api.ts', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it('declares a policy for every route api.ts serves', () => {
    const missing = routes.filter((r) => !(r in LAN_ROUTE_POLICIES));
    expect(missing).toEqual([]);
  });

  it('has no policies for routes that no longer exist', () => {
    const stale = Object.keys(LAN_ROUTE_POLICIES).filter(
      (r) => !routes.includes(r),
    );
    expect(stale).toEqual([]);
  });
});

describe('LAN policy shape', () => {
  it('keeps the privileged routes admin-only', () => {
    // These are the four that shipped with no role check at all.
    for (const route of [
      'GET /admin/overview',
      'GET /admin/sales-trends',
      'POST /settings/update',
      'POST /print/test',
    ]) {
      expect(LAN_ROUTE_POLICIES[route]?.allow, route).toEqual(['ADMIN']);
    }
  });

  it('requires a reason on every public route', () => {
    // Public routes are the attack surface, so each one has to justify itself
    // in writing. `/offline/status` returns a queue depth and nothing else.
    for (const [route, policy] of Object.entries(LAN_ROUTE_POLICIES)) {
      if (policy.allow !== 'public') continue;
      if (route === 'GET /offline/status') continue;
      expect(policy.note, route).toBeTruthy();
    }
  });
});

describe('authorizeLanRoute', () => {
  it('allows a public route with no role', () => {
    expect(authorizeLanRoute('GET', '/settings', null)).toBe('allow');
  });

  it('rejects an unlisted route even for an admin', () => {
    expect(authorizeLanRoute('POST', '/not/a/route', 'ADMIN')).toBe('unknown');
  });

  it('rejects a missing role on a session route', () => {
    expect(authorizeLanRoute('GET', '/layout/get', null)).toBe(
      'unauthenticated',
    );
  });

  it('accepts any role on a session route', () => {
    expect(authorizeLanRoute('GET', '/layout/get', 'CLEANER')).toBe('allow');
  });

  it('keeps a waiter out of the admin reports', () => {
    expect(authorizeLanRoute('GET', '/admin/sales-trends', 'WAITER')).toBe(
      'forbidden',
    );
  });

  it('keeps a waiter out of settings writes', () => {
    expect(authorizeLanRoute('POST', '/settings/update', 'WAITER')).toBe(
      'forbidden',
    );
  });

  it('lets an admin through', () => {
    expect(authorizeLanRoute('POST', '/settings/update', 'ADMIN')).toBe(
      'allow',
    );
  });

  it('keeps a cook out of the order flow', () => {
    expect(authorizeLanRoute('POST', '/tickets', 'CHEF')).toBe('forbidden');
  });

  it('keeps a waiter out of reservations', () => {
    expect(authorizeLanRoute('POST', '/reservations', 'WAITER')).toBe(
      'forbidden',
    );
  });

  it('lets a host manage reservations', () => {
    expect(authorizeLanRoute('POST', '/reservations', 'HOST')).toBe('allow');
  });

  it('is case-insensitive about the method and the role', () => {
    expect(authorizeLanRoute('post', '/settings/update', 'admin')).toBe(
      'allow',
    );
  });

  it('does not let a path prefix stand in for a route', () => {
    // `/settings` is public; `/settings/update` must not inherit that.
    expect(authorizeLanRoute('GET', '/settings/', null)).toBe('unknown');
  });
});
