import { describe, expect, it } from 'vitest';
import { adminMobileLaunchHash } from './adminMobileBoot';

describe('adminMobileLaunchHash', () => {
  it('keeps an existing admin route (PIN, setup, or a nested panel)', () => {
    expect(adminMobileLaunchHash('#/admin', '10.0.0.5')).toBe('#/admin');
    expect(adminMobileLaunchHash('#/admin-setup', '')).toBe('#/admin-setup');
    expect(adminMobileLaunchHash('#/admin/settings', '10.0.0.5')).toBe(
      '#/admin/settings',
    );
  });

  it('opens PIN when a till is saved and setup when it is not', () => {
    expect(adminMobileLaunchHash('', '10.0.0.5')).toBe('#/admin');
    expect(adminMobileLaunchHash('#/', ' 10.0.0.5 ')).toBe('#/admin');
    expect(adminMobileLaunchHash('', '')).toBe('#/admin-setup');
    expect(adminMobileLaunchHash('#/', '   ')).toBe('#/admin-setup');
  });
});
