import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { POS_SENTRY_DSN } from './sentryDsn';

describe('sentryDsn', () => {
  it('points at the Sentry ingest host', () => {
    expect(POS_SENTRY_DSN).toMatch(
      /^https:\/\/.+@o\d+\.ingest\.de\.sentry\.io\/\d+$/,
    );
  });

  it('sends packaged Electron crashes instead of treating missing NODE_ENV as dev', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../main/services/sentry.ts'),
      'utf8',
    );
    expect(src).toContain('isUnpackagedElectron');
    expect(src).not.toContain("NODE_ENV !== 'production'");
  });
});
