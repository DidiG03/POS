import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationPollIsSlow } from './notificationPoll';

describe('notificationPollIsSlow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stays fast until the till announces notification events', () => {
    vi.stubGlobal('window', {});
    expect(notificationPollIsSlow()).toBe(false);
    vi.stubGlobal('window', { __POS_SSE_FEATURES__: { notifications: true } });
    expect(notificationPollIsSlow()).toBe(true);
  });
});
