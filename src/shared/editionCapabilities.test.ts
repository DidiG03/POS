import { describe, expect, it } from 'vitest';
import {
  editionAllowsStaffRole,
  editionHasKds,
  editionHasReservations,
  editionHasTables,
  ensureStoreCounterSelected,
  formatSaleLocation,
  isStoreCounterArea,
  normalizeLicenseEdition,
  resolveActiveLicenseEdition,
  staffPosHomePath,
  staffRolesForEdition,
  storeCounterTable,
} from './editionCapabilities';

describe('editionCapabilities', () => {
  it('treats store as having no reservations', () => {
    expect(editionHasReservations('STORE')).toBe(false);
    expect(editionHasReservations('store')).toBe(false);
  });

  it('keeps reservations for restaurant and unknown editions', () => {
    expect(editionHasReservations('RESTAURANT')).toBe(true);
    expect(editionHasReservations(undefined)).toBe(true);
    expect(editionHasReservations(null)).toBe(true);
    expect(editionHasReservations('')).toBe(true);
  });

  it('treats store as having no tables', () => {
    expect(editionHasTables('STORE')).toBe(false);
    expect(editionHasTables('RESTAURANT')).toBe(true);
    expect(editionHasTables(undefined)).toBe(true);
  });

  it('treats store as having no kitchen display', () => {
    expect(editionHasKds('STORE')).toBe(false);
    expect(editionHasKds('RESTAURANT')).toBe(true);
    expect(editionHasKds(undefined)).toBe(true);
  });

  it('sends store staff to the till sale, not the floor', () => {
    expect(staffPosHomePath({ hasTables: false })).toBe('/app/order');
    expect(staffPosHomePath({ hasTables: true })).toBe('/app/tables');
    expect(staffPosHomePath({ hasTables: false, clockOnly: true })).toBe(
      '/app/clock',
    );
    expect(staffPosHomePath({ hasTables: false, kds: true })).toBe(
      '/app/order',
    );
    expect(staffPosHomePath({ hasTables: true, kds: true })).toBe('/kds');
  });

  it('binds each cashier to their own till counter', () => {
    expect(storeCounterTable(4)).toEqual({
      id: 4,
      area: 'Store',
      label: 'Till 4',
    });
    const calls: unknown[] = [];
    ensureStoreCounterSelected({
      hasTables: false,
      userId: 4,
      selectedTable: null,
      setSelectedTable: (t) => calls.push(t),
    });
    expect(calls).toEqual([{ id: 4, area: 'Store', label: 'Till 4' }]);
    ensureStoreCounterSelected({
      hasTables: true,
      userId: 4,
      selectedTable: null,
      setSelectedTable: (t) => calls.push(t),
    });
    expect(calls).toHaveLength(1);
  });

  it('limits store staff to till roles', () => {
    expect(staffRolesForEdition('STORE')).toEqual([
      'CASHIER',
      'ADMIN',
      'CLEANER',
    ]);
    expect(editionAllowsStaffRole('STORE', 'CASHIER')).toBe(true);
    expect(editionAllowsStaffRole('STORE', 'WAITER')).toBe(false);
    expect(staffRolesForEdition('RESTAURANT')).toContain('WAITER');
    expect(staffRolesForEdition('RESTAURANT')).toContain('HOST');
    expect(staffRolesForEdition(undefined)).toContain('CHEF');
  });

  it('prints till labels without the synthetic Store area', () => {
    expect(isStoreCounterArea('Store')).toBe(true);
    expect(isStoreCounterArea('Garden')).toBe(false);
    expect(
      formatSaleLocation({
        diningFloor: false,
        area: 'Store',
        tableLabel: 'Till 3',
      }),
    ).toBe('Till 3');
    expect(
      formatSaleLocation({
        diningFloor: true,
        area: 'Garden',
        tableLabel: '12',
      }),
    ).toBe('Garden - 12');
    expect(
      formatSaleLocation({
        diningFloor: true,
        area: 'Store',
        tableLabel: 'Till 3',
      }),
    ).toBe('Till 3');
  });

  it('normalizes edition strings', () => {
    expect(normalizeLicenseEdition('STORE')).toBe('STORE');
    expect(normalizeLicenseEdition(' restaurant ')).toBe('RESTAURANT');
    expect(normalizeLicenseEdition('other')).toBeUndefined();
  });

  it('lets unpackaged env override the stored license', () => {
    expect(
      resolveActiveLicenseEdition({
        unpackaged: true,
        envEdition: 'STORE',
        storedEdition: 'RESTAURANT',
      }),
    ).toBe('STORE');
  });

  it('ignores env overrides when packaged', () => {
    expect(
      resolveActiveLicenseEdition({
        unpackaged: false,
        envEdition: 'STORE',
        storedEdition: 'RESTAURANT',
      }),
    ).toBe('RESTAURANT');
    expect(
      resolveActiveLicenseEdition({
        unpackaged: false,
        envEdition: 'STORE',
        storedEdition: undefined,
      }),
    ).toBeUndefined();
  });
});
