import { describe, expect, it } from 'vitest';
import { TILL_ONLY, isTillOnly } from './tillOnly';

describe('isTillOnly', () => {
  it('recognises the refusal by its code', () => {
    expect(isTillOnly({ ok: false, code: TILL_ONLY })).toBe(true);
    expect(isTillOnly(Object.assign(new Error('x'), { code: TILL_ONLY }))).toBe(
      true,
    );
  });

  it('ignores every other failure', () => {
    expect(isTillOnly(new Error('offline'))).toBe(false);
    expect(isTillOnly({ ok: false, error: 'confirm-required' })).toBe(false);
    expect(isTillOnly(null)).toBe(false);
    expect(isTillOnly('TILL_ONLY')).toBe(false);
  });
});
