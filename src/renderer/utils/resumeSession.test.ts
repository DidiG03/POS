import { describe, expect, it } from 'vitest';
import { PERSIST_HYDRATION_WAIT_MS } from './resumeSession';

describe('resumeMainProcessSession', () => {
  it('waits long enough for persisted PIN state before binding IPC', () => {
    expect(PERSIST_HYDRATION_WAIT_MS).toBeGreaterThanOrEqual(4000);
  });
});
