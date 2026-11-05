/** QA v0.2.104 #12: a hanging fiscal service must not hold every payment 20 s. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FISCAL_BREAKER_PROBE_MS,
  FISCAL_BREAKER_TRIP_AFTER,
  __resetFiscalBreakerForTests,
  fiscalBreakerOpen,
  probeFiscalHealthIfOpen,
  recordFiscalAnswer,
  recordFiscalTimeout,
} from './circuit';

beforeEach(() => __resetFiscalBreakerForTests());

describe('fiscal circuit breaker', () => {
  it(`opens after ${FISCAL_BREAKER_TRIP_AFTER} timeouts in a row, not before`, () => {
    for (let i = 1; i < FISCAL_BREAKER_TRIP_AFTER; i++) {
      recordFiscalTimeout(1000);
      expect(fiscalBreakerOpen()).toBe(false);
    }
    recordFiscalTimeout(1000);
    expect(fiscalBreakerOpen()).toBe(true);
  });

  it('an answer in between resets the count', () => {
    recordFiscalTimeout();
    recordFiscalTimeout();
    recordFiscalAnswer();
    recordFiscalTimeout();
    expect(fiscalBreakerOpen()).toBe(false);
  });

  it('closes when a health probe succeeds, probing at most every 30 s', async () => {
    for (let i = 0; i < FISCAL_BREAKER_TRIP_AFTER; i++) recordFiscalTimeout(0);
    const probe = vi.fn(async () => false);
    expect(await probeFiscalHealthIfOpen(probe, 1_000)).toBe('skipped');
    expect(await probeFiscalHealthIfOpen(probe, FISCAL_BREAKER_PROBE_MS)).toBe(
      'still-down',
    );
    expect(fiscalBreakerOpen()).toBe(true);
    probe.mockResolvedValue(true);
    expect(
      await probeFiscalHealthIfOpen(probe, FISCAL_BREAKER_PROBE_MS + 1_000),
    ).toBe('skipped');
    expect(
      await probeFiscalHealthIfOpen(probe, 2 * FISCAL_BREAKER_PROBE_MS),
    ).toBe('healthy');
    expect(fiscalBreakerOpen()).toBe(false);
    expect(await probeFiscalHealthIfOpen(probe)).toBe('closed');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a probe that throws counts as still down', async () => {
    for (let i = 0; i < FISCAL_BREAKER_TRIP_AFTER; i++) recordFiscalTimeout(0);
    expect(
      await probeFiscalHealthIfOpen(async () => {
        throw new Error('timed out');
      }, FISCAL_BREAKER_PROBE_MS),
    ).toBe('still-down');
    expect(fiscalBreakerOpen()).toBe(true);
  });
});
