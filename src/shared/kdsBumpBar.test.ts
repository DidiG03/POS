import { describe, expect, it } from 'vitest';
import { kdsBumpBarActionFromKeyInput } from './kdsBumpBar';

describe('kdsBumpBarActionFromKeyInput', () => {
  it('maps J to showSettings', () => {
    expect(kdsBumpBarActionFromKeyInput({ key: 'j', code: 'KeyJ' })).toEqual({
      type: 'showSettings',
    });
    expect(kdsBumpBarActionFromKeyInput({ key: 'J', code: 'KeyJ' })).toEqual({
      type: 'showSettings',
    });
  });

  it('maps A to showTicketSummary', () => {
    expect(kdsBumpBarActionFromKeyInput({ key: 'a', code: 'KeyA' })).toEqual({
      type: 'showTicketSummary',
    });
    expect(kdsBumpBarActionFromKeyInput({ key: 'A', code: 'KeyA' })).toEqual({
      type: 'showTicketSummary',
    });
  });
});
