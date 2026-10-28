import { describe, expect, it } from 'vitest';
import { decideBackAction } from './nativeBack';

const base = {
  dialogOpen: false,
  route: '/app/tables',
  homeRoute: '/app/tables',
  unsentCount: 0,
};

describe('decideBackAction', () => {
  it('closes an open dialog first', () => {
    expect(
      decideBackAction({
        ...base,
        dialogOpen: true,
        route: '/app/order',
        unsentCount: 3,
      }),
    ).toBe('close-dialog');
  });
  it('asks before leaving an order with unsent items', () => {
    expect(
      decideBackAction({ ...base, route: '/app/order', unsentCount: 2 }),
    ).toBe('confirm-leave-order');
  });
  it('goes back to the floor plan from any other screen', () => {
    expect(decideBackAction({ ...base, route: '/app/order' })).toBe('go-home');
    expect(decideBackAction({ ...base, route: '/app/reports' })).toBe(
      'go-home',
    );
  });
  it('never exits from the floor plan or login, only backgrounds', () => {
    expect(decideBackAction(base)).toBe('minimize');
    expect(decideBackAction({ ...base, route: '/' })).toBe('minimize');
  });
});
