/**
 * The policy table is only a security control if it actually covers every
 * channel the main process registers. `ipcHandle` throws at boot on a missing
 * policy, but "the app crashes on launch" is a bad way to find out — so this
 * suite reads the registrations straight out of the source and checks both
 * directions statically.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_POLICIES } from './ipcPolicy';

const MAIN_INDEX = path.resolve(__dirname, '..', 'index.ts');

function registeredChannelsFromSource(): string[] {
  const source = fs.readFileSync(MAIN_INDEX, 'utf8');
  const found = new Set<string>();
  // Matches `ipcHandle('channel'` with or without a line break after the paren.
  const re = /\bipcHandle\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) found.add(m[1]);
  return [...found].sort();
}

describe('IPC policy coverage', () => {
  const registered = registeredChannelsFromSource();

  it('finds the handler registrations in the main process', () => {
    // A refactor that renames `ipcHandle` would otherwise make this whole
    // suite silently vacuous.
    expect(registered.length).toBeGreaterThan(100);
  });

  it('declares a policy for every registered channel', () => {
    const missing = registered.filter((c) => !(c in IPC_POLICIES));
    expect(missing).toEqual([]);
  });

  it('has no policies for channels that no longer exist', () => {
    // Stale entries are how an allow-list rots into something nobody trusts.
    const stale = Object.keys(IPC_POLICIES)
      .filter((c) => !registered.includes(c))
      // Exposed through the preload bridge but handled elsewhere.
      .filter((c) => c !== 'settings:testPrintProfile');
    expect(stale).toEqual([]);
  });
});

describe('IPC policy shape', () => {
  it('only grants public access to channels needed before login', () => {
    // Locking this list down means adding a new public channel requires
    // editing the test too, which is exactly the friction we want.
    const expectedPublic = [
      'admin:openWindow',
      'auth:createUser',
      'auth:endSession',
      'auth:listUsers',
      'auth:loginWithPin',
      'auth:logoutAdmin',
      'auth:resumeSession',
      'billing:getStatus',
      'license:activateKey',
      'license:activateSession',
      'license:createCheckout',
      'license:getPlans',
      'license:getStatus',
      'license:restore',
      'network:getIps',
      'offline:getStatus',
      'reservations:openWindow',
      'settings:get',
      'shifts:listOpen',
      'updater:getStatus',
    ];
    const actualPublic = Object.entries(IPC_POLICIES)
      .filter(([, p]) => p.allow === 'public')
      .map(([channel]) => channel)
      .sort();
    expect(actualPublic).toEqual(expectedPublic);
  });

  it('gates every destructive back-office channel on ADMIN', () => {
    const mustBeAdmin = [
      'auth:deleteUser',
      'auth:syncStaffFromApi',
      'auth:updateUser',
      'backups:create',
      'backups:restore',
      'layout:save',
      'menu:deleteCategory',
      'menu:deleteItem',
      'settings:setPrinter',
    ];
    for (const channel of mustBeAdmin) {
      expect(IPC_POLICIES[channel]?.allow, channel).toEqual(['ADMIN']);
    }
  });

  it('never grants an admin channel to a window without a session', () => {
    // `windows` bypasses the session check, so it must never appear on a
    // channel whose whole point is that only an admin may call it.
    for (const [channel, policy] of Object.entries(IPC_POLICIES)) {
      if (!policy.windows?.length) continue;
      const adminOnly =
        Array.isArray(policy.allow) &&
        policy.allow.length === 1 &&
        policy.allow[0] === 'ADMIN';
      // kds:debug is the one exception: the kitchen display's own diagnostics
      // endpoint, which the KDS window calls during its boot check.
      if (channel === 'kds:debug') continue;
      expect(adminOnly, `${channel} bypasses auth via windows`).toBe(false);
    }
  });

  it('lets the reservations window merge tables', () => {
    expect(IPC_POLICIES['layout:setMerges']?.allow).toBe('session');
    expect(IPC_POLICIES['layout:setMerges']?.windows).toEqual(['reservations']);
    expect(IPC_POLICIES['layout:getMerges']?.windows).toEqual(['reservations']);
  });

  it('lets the host floor read open POS tickets', () => {
    expect(IPC_POLICIES['tables:listOpen']?.allow).toEqual([
      'ADMIN',
      'CASHIER',
      'WAITER',
      'HOST',
    ]);
    expect(IPC_POLICIES['tables:listOpen']?.windows).toEqual(['reservations']);
    expect(IPC_POLICIES['tickets:getTableTooltip']?.allow).toEqual([
      'ADMIN',
      'CASHIER',
      'WAITER',
      'HOST',
    ]);
    expect(IPC_POLICIES['tickets:getTableTooltip']?.windows).toEqual([
      'reservations',
    ]);
    expect(IPC_POLICIES['tickets:listPaidTables']?.allow).toEqual([
      'ADMIN',
      'CASHIER',
      'WAITER',
      'HOST',
    ]);
    expect(IPC_POLICIES['tickets:listPaidTables']?.windows).toEqual([
      'reservations',
    ]);
    expect(IPC_POLICIES['tables:setOpen']?.allow).toEqual([
      'ADMIN',
      'CASHIER',
      'WAITER',
    ]);
  });

  it('uses only known roles', () => {
    const knownRoles = new Set([
      'ADMIN',
      'CASHIER',
      'WAITER',
      'KP',
      'CHEF',
      'HEAD_CHEF',
      'FOOD_RUNNER',
      'HOST',
      'BUSSER',
      'BARTENDER',
      'BARBACK',
      'CLEANER',
    ]);
    for (const [channel, policy] of Object.entries(IPC_POLICIES)) {
      if (!Array.isArray(policy.allow)) continue;
      for (const role of policy.allow) {
        expect(knownRoles.has(role), `${channel}: ${role}`).toBe(true);
      }
    }
  });
});
