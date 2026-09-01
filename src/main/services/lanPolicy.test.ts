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
const RENDERER_MAIN = path.resolve(__dirname, '../../renderer/main.tsx');

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

  it('lets any logged-in role merge tables (host floor tokens are often waiter JWTs)', () => {
    expect(authorizeLanRoute('GET', '/layout/merges', 'HOST')).toBe('allow');
    expect(authorizeLanRoute('POST', '/layout/merges', 'HOST')).toBe('allow');
    expect(authorizeLanRoute('GET', '/reservations/merges', 'HOST')).toBe(
      'allow',
    );
    expect(authorizeLanRoute('POST', '/reservations/merges', 'HOST')).toBe(
      'allow',
    );
    expect(authorizeLanRoute('POST', '/layout/merges', 'WAITER')).toBe('allow');
    expect(authorizeLanRoute('POST', '/reservations/merges', 'WAITER')).toBe(
      'allow',
    );
    expect(authorizeLanRoute('POST', '/reservations/merges', null)).toBe(
      'unauthenticated',
    );
  });

  it('lets a host read open POS tickets without opening or transferring them', () => {
    expect(authorizeLanRoute('GET', '/tables/open', 'HOST')).toBe('allow');
    expect(authorizeLanRoute('GET', '/tickets/tooltip', 'HOST')).toBe('allow');
    expect(authorizeLanRoute('POST', '/tables/open', 'HOST')).toBe('forbidden');
    expect(authorizeLanRoute('POST', '/tables/transfer', 'HOST')).toBe(
      'forbidden',
    );
    expect(authorizeLanRoute('GET', '/tickets/tooltip', 'WAITER')).toBe(
      'allow',
    );
  });

  it('lets a waiter read their own notifications', () => {
    expect(authorizeLanRoute('GET', '/notifications', 'WAITER')).toBe('allow');
  });

  it('lets the waiter shell poll billing status before login', () => {
    expect(authorizeLanRoute('GET', '/billing/status', null)).toBe('allow');
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

function publicPathsFromApi(): string[] {
  const source = fs.readFileSync(API_SOURCE, 'utf8');
  const start = source.indexOf('const publicPaths = new Set<string>([');
  if (start < 0) return [];
  const end = source.indexOf(']);', start);
  const block = source.slice(start, end);
  return [...block.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]);
}

function clientLanRoutes(): { method: string; path: string }[] {
  const collapsed = fs.readFileSync(RENDERER_MAIN, 'utf8').replace(/\s+/g, ' ');
  const found: { method: string; path: string }[] = [];
  const re = /goLan\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(collapsed))) {
    const raw = m[1] || m[2] || m[3] || '';
    const pathname = raw.split('?')[0];
    if (!pathname.startsWith('/')) continue;
    const after = collapsed.slice(m.index + m[0].length).trimStart();
    let method = 'GET';
    if (after.startsWith(',')) {
      const mm = after
        .slice(1)
        .trimStart()
        .match(/^\{\s*method:\s*['"](\w+)['"]/);
      if (mm) method = mm[1].toUpperCase();
    }
    found.push({ method, path: pathname });
  }
  return found;
}

describe('tablet client vs LAN policy', () => {
  it('finds goLan calls in the browser shim', () => {
    expect(clientLanRoutes().length).toBeGreaterThan(20);
  });

  it('declares a policy for every path the tablet actually calls', () => {
    // This is the check that would have caught the waiter logout: AppLayout
    // called /billing/status and /notifications, but api.ts had no handlers,
    // so authorizeLanRoute returned unknown → 403 → forceLogout.
    const missing = clientLanRoutes()
      .map((c) => `${c.method} ${c.path}`)
      .filter((route, i, all) => all.indexOf(route) === i)
      .filter((route) => !(route in LAN_ROUTE_POLICIES));
    expect(missing).toEqual([]);
  });

  it('keeps publicPaths in step with public policies', () => {
    const publicPaths = publicPathsFromApi();
    expect(publicPaths.length).toBeGreaterThan(5);
    const uncovered = publicPaths.filter((p) => {
      return !Object.entries(LAN_ROUTE_POLICIES).some(
        ([key, policy]) => key.endsWith(` ${p}`) && policy.allow === 'public',
      );
    });
    expect(uncovered).toEqual([]);

    const policyPublicPaths = Object.entries(LAN_ROUTE_POLICIES)
      .filter(([, policy]) => policy.allow === 'public')
      .map(([key]) => key.slice(key.indexOf(' ') + 1));
    const missingFromGate = [...new Set(policyPublicPaths)].filter(
      (p) => !publicPaths.includes(p),
    );
    expect(missingFromGate).toEqual([]);
  });

  it('lets a waiter through every call the waiter shell makes after PIN', () => {
    const waiterBoot = [
      'GET /billing/status',
      'GET /notifications',
      'GET /settings',
      'GET /shifts/get-open',
      'GET /requests/list-for-owner',
      'GET /auth/users',
      'GET /tables/open',
      'GET /tables/floor-snapshot',
      'GET /layout/get',
      'GET /reservations/merges',
      'GET /tickets/latest',
      'GET /covers/last',
      'POST /tickets',
      'POST /tables/open',
      'POST /print/ticket',
    ];
    for (const route of waiterBoot) {
      const [method, pathname] = route.split(' ');
      expect(authorizeLanRoute(method, pathname, 'WAITER'), route).toBe(
        'allow',
      );
    }
  });

  it('lets a cashier load their own reports on a tablet', () => {
    for (const reportPath of [
      '/reports/my/overview',
      '/reports/my/active-tickets',
      '/reports/my/paid-tickets',
      '/reports/my/voided-tickets',
    ]) {
      expect(authorizeLanRoute('GET', reportPath, 'CASHIER'), reportPath).toBe(
        'allow',
      );
    }
  });
});
