import { describe, expect, it } from 'vitest';
import { POS_SENTRY_DSN } from './sentryDsn';

describe('sentryDsn', () => {
  it('points at the Sentry ingest host', () => {
    expect(POS_SENTRY_DSN).toMatch(
      /^https:\/\/.+@o\d+\.ingest\.de\.sentry\.io\/\d+$/,
    );
  });
});
