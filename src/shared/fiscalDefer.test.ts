import { describe, expect, it } from 'vitest';
import {
  dueFiscalDeferAlert,
  FISCAL_TRANSMIT_WINDOW_MS,
  fiscalDeferRemainingMs,
} from './fiscalDefer';

describe('dueFiscalDeferAlert', () => {
  const issued = '2026-09-10T00:00:00.000Z';
  const t0 = Date.parse(issued);

  it('is silent inside the first six hours', () => {
    expect(
      dueFiscalDeferAlert(issued, undefined, t0 + 3 * 3600_000),
    ).toBeNull();
  });

  it('escalates once per threshold', () => {
    expect(dueFiscalDeferAlert(issued, undefined, t0 + 6 * 3600_000)).toBe(
      '6h',
    );
    expect(dueFiscalDeferAlert(issued, '6h', t0 + 6 * 3600_000)).toBeNull();
    expect(dueFiscalDeferAlert(issued, '6h', t0 + 24 * 3600_000)).toBe('24h');
    expect(
      dueFiscalDeferAlert(issued, '47h', t0 + FISCAL_TRANSMIT_WINDOW_MS),
    ).toBe('overdue');
    expect(
      dueFiscalDeferAlert(issued, 'overdue', t0 + FISCAL_TRANSMIT_WINDOW_MS),
    ).toBeNull();
  });

  it('counts down to the 48-hour deadline', () => {
    expect(fiscalDeferRemainingMs(issued, t0 + 40 * 3600_000)).toBe(
      8 * 3600_000,
    );
  });
});
