import { describe, expect, it } from 'vitest';
import { isUnpackagedElectron } from './electronDev';

describe('isUnpackagedElectron', () => {
  it('treats an installed app as production even when NODE_ENV is missing', () => {
    expect(isUnpackagedElectron(true, undefined)).toBe(false);
    expect(isUnpackagedElectron(true, '')).toBe(false);
  });

  it('still allows an explicit ELECTRON_IS_DEV override', () => {
    expect(isUnpackagedElectron(true, '1')).toBe(true);
    expect(isUnpackagedElectron(false, undefined)).toBe(true);
  });
});
